const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const game = require('./game');
const persistence = require('./persistence');

// ─── Input validation (limits, sanitization) ───
const MAX_NAME_LEN = 20;
const MAX_DESC_LEN = 500;
const MAX_PLAYER_ID_LEN = 128;
const ROOM_CODE_REGEX = /^\d{6}$/;

function sanitisePlayerId(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_PLAYER_ID_LEN) return null;
    // Allow URL-safe characters only — UUIDs, opaque tokens, etc.
    if (!/^[A-Za-z0-9_\-]+$/.test(trimmed)) return null;
    return trimmed;
}

function validateCreateRoom(name) {
    if (!name || typeof name !== 'string') return { error: 'Please enter your name.' };
    const trimmed = name.trim();
    if (trimmed.length === 0) return { error: 'Please enter your name.' };
    if (trimmed.length > MAX_NAME_LEN) return { error: `Name must be ${MAX_NAME_LEN} characters or less.` };
    return { name: trimmed };
}

function validateJoinRoom(code, name) {
    if (!code || typeof code !== 'string') return { error: 'Enter the 6-digit game code.' };
    const trimmedCode = code.trim().replace(/\D/g, '');
    if (!ROOM_CODE_REGEX.test(trimmedCode)) return { error: 'Enter the 6-digit game code.' };
    if (!name || typeof name !== 'string') return { error: 'Please enter your name.' };
    const trimmedName = name.trim();
    if (trimmedName.length === 0) return { error: 'Please enter your name.' };
    if (trimmedName.length > MAX_NAME_LEN) return { error: `Name must be ${MAX_NAME_LEN} characters or less.` };
    return { code: trimmedCode, name: trimmedName };
}

function validateDescription(type, data) {
    if (type !== 'text') return null;
    if (typeof data !== 'string') return null;
    const trimmed = data.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > MAX_DESC_LEN) return null;
    return trimmed;
}

const app = express();

// Security headers
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled; adjust if you add inline scripts

// Rate limit: 100 req/min per IP (handles static + Socket.IO handshake)
app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: { error: 'Too many requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
}));

const server = http.createServer(app);

// Socket.IO server with slightly more lenient heartbeat settings to reduce
// disconnects on flaky or sleeping mobile connections.
const io = new Server(server, {
    pingInterval: 25000,
    pingTimeout: 60000,
});

app.use(express.static(path.join(__dirname, 'public')));

// In-memory rooms store (hydrated from disk on boot, persisted on mutation).
let rooms = {};

// Per-playerId rate limiting (a misbehaving client can no longer reset its
// limit by churning through socket connections, since playerId is stable).
const JOIN_RATE_WINDOW_MS = 60 * 1000;
const MAX_JOINS_PER_WINDOW = 15;
const MAX_CREATE_PER_WINDOW = 10;
const joinAttempts = new Map();
const createAttempts = new Map();

function checkRateLimit(map, key, max) {
    if (!key) return true;
    const now = Date.now();
    let record = map.get(key);
    if (!record || now > record.resetAt) {
        record = { count: 0, resetAt: now + JOIN_RATE_WINDOW_MS };
        map.set(key, record);
    }
    record.count++;
    return record.count <= max;
}

function pruneRateLimits() {
    const now = Date.now();
    for (const [k, v] of joinAttempts) {
        if (now > v.resetAt) joinAttempts.delete(k);
    }
    for (const [k, v] of createAttempts) {
        if (now > v.resetAt) createAttempts.delete(k);
    }
}

setInterval(pruneRateLimits, 5 * 60 * 1000);

// When a room becomes empty, we keep it around for a short grace period so
// that mobile clients that briefly lose connectivity (screen lock, network
// handoff, etc.) can reconnect without the room being destroyed immediately.
const EMPTY_ROOM_GRACE_MS = 5 * 60 * 1000; // 5 minutes

// ─── Helpers ───

function touchRoom(room) {
    if (room) room.updatedAt = Date.now();
}

function broadcastRoom(room) {
    if (!room) return;
    touchRoom(room);
    io.to(room.code).emit('room-update', game.safeRoom(room));
    persistence.schedulePersist(rooms);
}

function emitToPlayer(playerId, event, payload) {
    if (!playerId) return;
    io.to(playerId).emit(event, payload);
}

function bindSocketToPlayer(socket, room) {
    if (!room || !socket || !socket.playerId) return;
    if (!room.socketByPlayer) room.socketByPlayer = {};
    room.socketByPlayer[socket.playerId] = socket.id;
}

// Resolve the current vote (see plan: connected-player majority threshold).
function resolveDiscussion(room) {
    if (room.gameState !== 'vote') return;

    const impostor = room.players.find(p => p.isImpostor);
    const connectedCount = room.players.filter(p => p.connected !== false).length;
    const threshold = Math.floor(connectedCount / 2); // strictly more than half wins
    const tally = {};
    (room.votes || []).forEach((v) => {
        tally[v.targetId] = (tally[v.targetId] || 0) + 1;
    });
    const impostorVotes = (impostor && tally[impostor.id]) || 0;
    const crewWon = !!impostor && impostorVotes > threshold;

    if (crewWon) {
        room.gameState = 'reveal';
        io.to(room.code).emit('reveal', {
            word: room.targetWord,
            impostor,
            descriptions: room.descriptions,
        });
        broadcastRoom(room);
        return;
    }

    const result = game.startNextRound(room);
    if (result.error) return;
    room.players.forEach((player) => {
        emitToPlayer(player.id, 'game-started', {
            isImpostor: player.isImpostor,
            word: player.isImpostor ? room.impostorDecoyWord : room.targetWord,
            round: room.round,
        });
    });
    broadcastRoom(room);
    console.log(`✦ Next round (same word) in room ${room.code}. Word: ${room.targetWord}`);
}

// ─── Auth: every socket carries its stable playerId via handshake auth. ───
io.use((socket, next) => {
    const auth = socket.handshake?.auth || {};
    const provided = sanitisePlayerId(auth.playerId);
    // Lenient: accept any reasonable string the client sent. Generate one
    // server-side when missing so legacy clients don't break — they just
    // lose the persistence benefits until they update.
    socket.playerId = provided || crypto.randomUUID();
    next();
});

io.on('connection', (socket) => {
    // Each socket joins a private Socket.IO room named after its playerId so
    // we can target this player with `io.to(playerId).emit(...)` regardless
    // of which underlying socketId they currently hold.
    socket.join(socket.playerId);

    console.log(`✦ Connected: socket=${socket.id} player=${socket.playerId}`);

    // ────── CREATE ROOM ──────
    socket.on('create-room', ({ name }) => {
        if (!checkRateLimit(createAttempts, socket.playerId, MAX_CREATE_PER_WINDOW)) {
            return socket.emit('error-msg', 'Too many rooms created. Please wait a minute.');
        }
        const validated = validateCreateRoom(name);
        if (validated.error) return socket.emit('error-msg', validated.error);

        const room = game.createRoom(socket.playerId, validated.name, (c) => Boolean(rooms[c]));
        if (!room) {
            return socket.emit('error-msg', 'Could not allocate a game code. Please try again.');
        }
        rooms[room.code] = room;
        bindSocketToPlayer(socket, room);
        socket.join(room.code);
        socket.roomCode = room.code;
        const hostToken = room.players[0].rejoinToken;
        socket.emit('room-created', { code: room.code, rejoinToken: hostToken });
        broadcastRoom(room);
        console.log(`✦ Room ${room.code} created by ${validated.name}`);
    });

    // ────── JOIN ROOM ──────
    socket.on('join-room', ({ code, name, rejoinToken }, callback) => {
        const cb = typeof callback === 'function' ? callback : () => { };
        if (!checkRateLimit(joinAttempts, socket.playerId, MAX_JOINS_PER_WINDOW)) {
            return cb({ error: 'Too many join attempts. Please wait a minute.' });
        }
        const validated = validateJoinRoom(code, name);
        if (validated.error) return cb({ error: validated.error });

        const room = rooms[validated.code];
        if (!room) {
            return cb({ error: 'Room not found. Check the code and try again.' });
        }

        // 1) Strongest match: rejoinToken (cryptographic, prevents hijacking).
        const existing = rejoinToken ? game.findPlayerByRejoinToken(room, rejoinToken) : null;
        if (existing) {
            adoptExistingPlayer(socket, room, existing);
            cb({ success: true, rejoined: true });
            sendRejoinState(socket, room, existing);
            console.log(`✦ ${existing.name} rejoined room ${validated.code} (token)`);
            return;
        }

        // 2) Implicit identity match: the client's stable playerId already
        //    has a record in the room (e.g. localStorage rejoinToken got
        //    wiped but playerId persisted). Trust playerId here because the
        //    client provided it via handshake auth before any user input.
        const byPlayerId = room.players.find(p => p.id === socket.playerId);
        if (byPlayerId) {
            adoptExistingPlayer(socket, room, byPlayerId);
            cb({ success: true, rejoined: true, rejoinToken: byPlayerId.rejoinToken });
            sendRejoinState(socket, room, byPlayerId);
            console.log(`✦ ${byPlayerId.name} rejoined room ${validated.code} (playerId)`);
            return;
        }

        // 3) Name-match fallback: a disconnected slot with this exact name.
        //    Allowed in any state so a player whose storage was wiped can
        //    still come back mid-game. We rotate their rejoinToken and
        //    reassign the player record's id to this socket's stable
        //    playerId so future reconnects use the strong path above.
        const disconnectedMatch = game.findDisconnectedPlayerByName(room, validated.name);
        if (disconnectedMatch) {
            // Rebind the slot to the new stable playerId, and rewrite any
            // votes/descriptions that referenced the old one.
            const oldPlayerId = disconnectedMatch.id;
            if (oldPlayerId !== socket.playerId) {
                rewritePlayerId(room, oldPlayerId, socket.playerId);
            }
            disconnectedMatch.rejoinToken = crypto.randomUUID();
            adoptExistingPlayer(socket, room, disconnectedMatch);
            cb({ success: true, rejoined: true, rejoinToken: disconnectedMatch.rejoinToken });
            sendRejoinState(socket, room, disconnectedMatch);
            console.log(`✦ ${disconnectedMatch.name} rejoined room ${validated.code} (name fallback)`);
            return;
        }

        // 4) Genuinely new player → only allowed in lobby.
        if (room.gameState !== 'lobby') {
            return cb({ error: 'Game already in progress.' });
        }
        const result = game.addPlayer(room, socket.playerId, validated.name);
        if (!result) {
            return cb({ error: 'Could not join room.' });
        }
        bindSocketToPlayer(socket, room);
        socket.join(validated.code);
        socket.roomCode = validated.code;
        room.emptySince = null;
        cb({ success: true, rejoinToken: result.rejoinToken });
        broadcastRoom(room);
        console.log(`✦ ${validated.name} joined room ${validated.code}`);
    });

    // ────── START GAME ──────
    socket.on('start-game', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.hostId !== socket.playerId) return;

        const result = game.startGame(room);
        if (result.error) {
            return socket.emit('error-msg', result.error);
        }

        room.players.forEach((player) => {
            emitToPlayer(player.id, 'game-started', {
                isImpostor: player.isImpostor,
                word: player.isImpostor ? room.impostorDecoyWord : room.targetWord,
                round: room.round,
            });
        });

        broadcastRoom(room);
        console.log(`✦ Game started in room ${room.code}. Word: ${room.targetWord}`);
    });

    // ────── PLAYER CONTINUES PAST ASSIGNMENT ──────
    socket.on('continue-to-describe', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        if (room.gameState !== 'assignment') return;
        room.gameState = 'description';
        broadcastRoom(room);
    });

    // ────── SUBMIT DESCRIPTION ──────
    socket.on('submit-description', ({ type, data }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        if (room.gameState !== 'description') return;

        const validatedData = validateDescription(type, data);
        if (!validatedData) return;

        const submitted = game.submitDescription(room, socket.playerId, 'text', validatedData);
        if (!submitted) return;

        broadcastRoom(room);

        if (game.allSubmitted(room)) {
            room.gameState = 'discussion';
            game.clearVotes(room);
            io.to(room.code).emit('all-submitted', { descriptions: room.descriptions });
            broadcastRoom(room);
            console.log(`✦ All descriptions in for room ${room.code}`);
        }
    });

    // ────── CAST VOTE ──────
    socket.on('cast-vote', ({ targetId }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        if (room.gameState !== 'vote') return;
        if (typeof targetId !== 'string') return;

        const ok = game.castVote(room, socket.playerId, targetId);
        if (!ok) return;

        broadcastRoom(room);

        if (game.votingComplete(room)) {
            resolveDiscussion(room);
        }
    });

    // ────── FORCE ADVANCE TO DISCUSSION (Host) ──────
    socket.on('force-advance-to-discussion', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.hostId !== socket.playerId) return;
        if (room.gameState !== 'description') return;

        room.gameState = 'discussion';
        game.clearVotes(room);
        io.to(room.code).emit('all-submitted', { descriptions: room.descriptions });
        broadcastRoom(room);
        console.log(`✦ Host force-advanced room ${room.code} to discussion (${room.descriptions.length} clue(s) submitted)`);
    });

    // ────── OPEN VOTING (Host) ──────
    socket.on('open-voting', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.hostId !== socket.playerId) return;
        if (room.gameState !== 'discussion') return;

        room.gameState = 'vote';
        game.clearVotes(room);
        io.to(room.code).emit('voting-opened');
        broadcastRoom(room);
        console.log(`✦ Host opened voting in room ${room.code}`);
    });

    // ────── RESOLVE ROUND (Host) ──────
    socket.on('resolve-round', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.hostId !== socket.playerId) return;
        if (room.gameState !== 'vote') return;
        resolveDiscussion(room);
    });

    // ────── FINISH GAME (Host) ──────
    socket.on('finish-game', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.hostId !== socket.playerId) return;
        if (room.gameState !== 'discussion' && room.gameState !== 'vote') return;

        room.gameState = 'reveal';
        io.to(room.code).emit('reveal', {
            word: room.targetWord,
            impostor: room.players.find(p => p.isImpostor),
            descriptions: room.descriptions,
        });
        broadcastRoom(room);
    });

    // ────── KICK PLAYER (Host) ──────
    socket.on('kick-player', ({ playerId }) => {
        const room = rooms[socket.roomCode];
        if (!room || room.hostId !== socket.playerId) return;
        if (typeof playerId !== 'string') return;
        if (playerId === socket.playerId) return; // host can't kick themselves

        const removed = game.kickPlayer(room, playerId);
        if (!removed) return;

        // Force the kicked player's sockets out of the game room and tell
        // them they've been removed so their UI returns to the login screen.
        io.to(playerId).emit('kicked', { code: room.code });
        const kickedSockets = io.sockets.adapter.rooms.get(playerId);
        if (kickedSockets) {
            for (const sid of kickedSockets) {
                const s = io.sockets.sockets.get(sid);
                if (s && s.roomCode === room.code) {
                    s.leave(room.code);
                    s.roomCode = null;
                }
            }
        }

        broadcastRoom(room);
        console.log(`✦ Host kicked ${removed.name} (${playerId}) from room ${room.code}`);
    });

    // ────── PLAY AGAIN ──────
    socket.on('play-again', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.hostId !== socket.playerId) return;
        game.resetGame(room);
        broadcastRoom(room);
        io.to(room.code).emit('back-to-lobby');
        console.log(`✦ Room ${room.code} reset to lobby`);
    });

    // ────── DISCONNECT ──────
    socket.on('disconnect', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;

        // Only mark the player disconnected if THIS socket is the one
        // currently mapped to them. Otherwise a second tab opening would
        // immediately appear to disconnect the active session.
        const currentSocketId = room.socketByPlayer && room.socketByPlayer[socket.playerId];
        if (currentSocketId && currentSocketId !== socket.id) {
            return;
        }

        game.removePlayer(room, socket.playerId);
        const anyConnected = room.players.some(p => p.connected);
        if (!anyConnected) {
            if (!room.emptySince) room.emptySince = Date.now();
            console.log(`✦ Room ${socket.roomCode} is now empty; starting grace period timer`);
            persistence.schedulePersist(rooms);
        } else {
            room.emptySince = null;
            broadcastRoom(room);
        }
        console.log(`✦ Disconnected: socket=${socket.id} player=${socket.playerId}`);
    });
});

// Adopt an existing player record for the current socket (rebinds room
// membership, marks connected, refreshes socket map).
function adoptExistingPlayer(socket, room, player) {
    player.connected = true;
    bindSocketToPlayer(socket, room);
    socket.join(room.code);
    socket.roomCode = room.code;
    room.emptySince = null;
    broadcastRoom(room);
}

function sendRejoinState(socket, room, player) {
    const hasVoted = (room.votes || []).some((v) => v.voterId === player.id);
    const includeDescriptions =
        room.gameState === 'discussion' ||
        room.gameState === 'vote' ||
        room.gameState === 'reveal';
    const rejoinState = {
        gameState: room.gameState,
        hasSubmitted: player.hasSubmitted,
        hasVoted,
        role:
            room.gameState === 'assignment' || room.gameState === 'description'
                ? {
                    isImpostor: player.isImpostor,
                    word: player.isImpostor ? room.impostorDecoyWord : room.targetWord,
                    round: room.round,
                }
                : undefined,
        descriptions: includeDescriptions ? room.descriptions : undefined,
        reveal:
            room.gameState === 'reveal'
                ? {
                    word: room.targetWord,
                    impostor: room.players.find((p) => p.isImpostor),
                    descriptions: room.descriptions,
                }
                : undefined,
    };
    socket.emit('rejoin-state', rejoinState);
}

// Rewrite all references from oldPlayerId → newPlayerId in a room. Used by
// the name-match rejoin path so the stable playerId on the socket replaces
// whatever the disconnected slot used to have.
function rewritePlayerId(room, oldPlayerId, newPlayerId) {
    if (!room || oldPlayerId === newPlayerId) return;
    room.players.forEach((p) => {
        if (p.id === oldPlayerId) p.id = newPlayerId;
    });
    if (room.hostId === oldPlayerId) room.hostId = newPlayerId;
    if (Array.isArray(room.votes)) {
        room.votes.forEach((v) => {
            if (v.voterId === oldPlayerId) v.voterId = newPlayerId;
            if (v.targetId === oldPlayerId) v.targetId = newPlayerId;
        });
    }
    if (Array.isArray(room.descriptions)) {
        room.descriptions.forEach((d) => {
            if (d.playerId === oldPlayerId) d.playerId = newPlayerId;
        });
    }
    if (room.socketByPlayer && room.socketByPlayer[oldPlayerId]) {
        room.socketByPlayer[newPlayerId] = room.socketByPlayer[oldPlayerId];
        delete room.socketByPlayer[oldPlayerId];
    }
}

// Periodically sweep and delete rooms that have been empty for longer than
// the configured grace period.
setInterval(() => {
    const now = Date.now();
    let dirty = false;
    for (const [code, room] of Object.entries(rooms)) {
        if (room.emptySince && now - room.emptySince > EMPTY_ROOM_GRACE_MS) {
            delete rooms[code];
            dirty = true;
            console.log(`✦ Room ${code} deleted after being empty for more than ${EMPTY_ROOM_GRACE_MS / 60000} minutes`);
        }
    }
    if (dirty) persistence.schedulePersist(rooms);
}, 60 * 1000);

// Persist on graceful shutdown so an in-flight write doesn't lose state.
function shutdown(reason) {
    console.log(`✦ Shutting down (${reason}); flushing persistence...`);
    persistence.flush().finally(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const PORT = process.env.PORT || 3000;

(async function bootstrap() {
    try {
        rooms = await persistence.loadRooms();
        const count = Object.keys(rooms).length;
        if (count > 0) console.log(`✦ Restored ${count} room(s) from disk`);
    } catch (e) {
        console.error('✦ Failed to load persisted rooms; starting fresh.', e.message);
        rooms = {};
    }
    server.listen(PORT, () => {
        console.log(`\n  🎭 Impostor Game server running on http://localhost:${PORT}\n`);
    });
})();
