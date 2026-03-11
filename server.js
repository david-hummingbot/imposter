const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const game = require('./game');

// ─── Input validation (limits, sanitization) ───
const MAX_NAME_LEN = 20;
const MAX_DESC_LEN = 500;
const VALID_TIMER = [30, 60, 90, 120];
const ROOM_CODE_REGEX = /^[A-Z0-9]{6}$/i;

function validateCreateRoom(name) {
    if (!name || typeof name !== 'string') return { error: 'Please enter your name.' };
    const trimmed = name.trim();
    if (trimmed.length === 0) return { error: 'Please enter your name.' };
    if (trimmed.length > MAX_NAME_LEN) return { error: `Name must be ${MAX_NAME_LEN} characters or less.` };
    return { name: trimmed };
}

function validateJoinRoom(code, name) {
    if (!code || typeof code !== 'string') return { error: 'Enter a 6-character game code.' };
    const trimmedCode = code.trim().toUpperCase();
    if (!ROOM_CODE_REGEX.test(trimmedCode)) return { error: 'Enter a 6-character game code.' };
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

function validateTimerDuration(val) {
    const n = Number(val);
    return VALID_TIMER.includes(n) ? n : 60;
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
    // How often to send pings (ms). Default is 25000; we keep it but make
    // timeout more forgiving below.
    pingInterval: 25000,
    // How long the server will wait for a pong before considering the client
    // disconnected. A higher value reduces false disconnects on mobile.
    pingTimeout: 60000,
});

app.use(express.static(path.join(__dirname, 'public')));

// In-memory rooms store
const rooms = {};

// Per-socket rate limiting for join-room (brute-force mitigation)
const JOIN_RATE_WINDOW_MS = 60 * 1000;
const MAX_JOINS_PER_WINDOW = 15;
const MAX_CREATE_PER_WINDOW = 10;
const joinAttempts = new Map();
const createAttempts = new Map();

function checkJoinRateLimit(socketId) {
    const now = Date.now();
    let record = joinAttempts.get(socketId);
    if (!record) {
        record = { count: 0, resetAt: now + JOIN_RATE_WINDOW_MS };
        joinAttempts.set(socketId, record);
    }
    if (now > record.resetAt) {
        record.count = 0;
        record.resetAt = now + JOIN_RATE_WINDOW_MS;
    }
    record.count++;
    return record.count <= MAX_JOINS_PER_WINDOW;
}

function cleanupJoinRateLimit(socketId) {
    joinAttempts.delete(socketId);
    createAttempts.delete(socketId);
}

function checkCreateRateLimit(socketId) {
    const now = Date.now();
    let record = createAttempts.get(socketId);
    if (!record) {
        record = { count: 0, resetAt: now + JOIN_RATE_WINDOW_MS };
        createAttempts.set(socketId, record);
    }
    if (now > record.resetAt) {
        record.count = 0;
        record.resetAt = now + JOIN_RATE_WINDOW_MS;
    }
    record.count++;
    return record.count <= MAX_CREATE_PER_WINDOW;
}

// When a room becomes empty, we keep it around for a short grace period so
// that mobile clients that briefly lose connectivity (screen lock, network
// handoff, etc.) can reconnect without the room being destroyed immediately.
const EMPTY_ROOM_GRACE_MS = 5 * 60 * 1000; // 5 minutes

// Resolve discussion: if everyone voted and majority got the impostor → reveal; else → next round (same word).
function resolveDiscussion(room, io) {
    if (room.gameState !== 'discussion') return;
    const allVoted = game.votingComplete(room);
    const outcome = game.getVoteOutcome(room);
    if (allVoted && outcome && outcome.hasMajority && outcome.guessedImpostor) {
        room.gameState = 'reveal';
        io.to(room.code).emit('reveal', {
            word: room.targetWord,
            impostor: room.players.find(p => p.isImpostor),
            descriptions: room.descriptions,
        });
        io.to(room.code).emit('room-update', game.safeRoom(room));
    } else {
        // Majority didn't vote, or impostor not correctly identified → next round (same word, more descriptions)
        const result = game.startNextRound(room);
        if (result.error) return;
        room.players.forEach((player) => {
            io.to(player.id).emit('game-started', {
                isImpostor: player.isImpostor,
                word: player.isImpostor ? null : room.targetWord,
                round: room.round,
            });
        });
        io.to(room.code).emit('room-update', game.safeRoom(room));
        console.log(`✦ Next round (same word) in room ${room.code}. Word: ${room.targetWord}`);
    }
}

io.on('connection', (socket) => {
    console.log(`✦ Connected: ${socket.id}`);

    // ────── CREATE ROOM ──────
    socket.on('create-room', ({ name }) => {
        if (!checkCreateRateLimit(socket.id)) {
            return socket.emit('error-msg', 'Too many rooms created. Please wait a minute.');
        }
        const validated = validateCreateRoom(name);
        if (validated.error) return socket.emit('error-msg', validated.error);

        const room = game.createRoom(socket.id, validated.name);
        rooms[room.code] = room;
        socket.join(room.code);
        socket.roomCode = room.code;
        const hostToken = room.players[0].rejoinToken;
        socket.emit('room-created', { code: room.code, rejoinToken: hostToken });
        io.to(room.code).emit('room-update', game.safeRoom(room));
        console.log(`✦ Room ${room.code} created by ${validated.name}`);
    });

    // ────── JOIN ROOM ──────
    socket.on('join-room', ({ code, name, rejoinToken }, callback) => {
        if (!checkJoinRateLimit(socket.id)) {
            return callback({ error: 'Too many join attempts. Please wait a minute.' });
        }
        const validated = validateJoinRoom(code, name);
        if (validated.error) return callback({ error: validated.error });

        const room = rooms[validated.code];
        if (!room) {
            return callback({ error: 'Room not found. Check the code and try again.' });
        }

        // Rejoin: must match by rejoinToken (prevents session hijacking by name)
        const existing = rejoinToken ? game.findPlayerByRejoinToken(room, rejoinToken) : null;
        if (existing) {
            existing.id = socket.id;
            existing.connected = true;
            // If this player was the host previously, restore hostId mapping
            if (room.hostId === existing.id || room.hostId === null) {
                room.hostId = existing.id;
            }
            socket.join(validated.code);
            socket.roomCode = validated.code;
            callback({ success: true, rejoined: true });
            io.to(validated.code).emit('room-update', game.safeRoom(room));

            // Send reconnecting client the state they need to restore their screen
            const player = existing;
            const hasVoted = (room.votes || []).some((v) => v.voterId === socket.id);
            const rejoinState = {
                gameState: room.gameState,
                hasSubmitted: player.hasSubmitted,
                hasVoted,
                role:
                    room.gameState === 'assignment' || room.gameState === 'description'
                        ? {
                              isImpostor: player.isImpostor,
                              word: player.isImpostor ? null : room.targetWord,
                              round: room.round,
                          }
                        : undefined,
                descriptions: room.gameState === 'discussion' || room.gameState === 'reveal' ? room.descriptions : undefined,
                timerDuration: room.timerDuration,
                discussionStartedAt: room.discussionStartedAt,
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
            console.log(`✦ ${existing.name} rejoined room ${validated.code}`);
            return;
        }

        // New player: only allow in lobby.
        if (room.gameState !== 'lobby') {
            return callback({ error: 'Game already in progress.' });
        }
        const result = game.addPlayer(room, socket.id, validated.name);
        if (!result) {
            return callback({ error: 'Could not join room.' });
        }
        socket.join(validated.code);
        socket.roomCode = validated.code;
        callback({ success: true, rejoinToken: result.rejoinToken });
        io.to(validated.code).emit('room-update', game.safeRoom(room));
        console.log(`✦ ${validated.name} joined room ${validated.code}`);
    });

    // ────── START GAME ──────
    socket.on('start-game', ({ timerDuration }) => {
        const room = rooms[socket.roomCode];
        if (!room || room.hostId !== socket.id) return;

        const safeDuration = validateTimerDuration(timerDuration);
        const result = game.startGame(room, safeDuration);
        if (result.error) {
            return socket.emit('error-msg', result.error);
        }

        // Send private assignment to each player
        room.players.forEach((player) => {
            io.to(player.id).emit('game-started', {
                isImpostor: player.isImpostor,
                word: player.isImpostor ? null : room.targetWord,
                round: room.round,
            });
        });

        io.to(room.code).emit('room-update', game.safeRoom(room));
        console.log(`✦ Game started in room ${room.code}. Word: ${room.targetWord}`);
    });

    // ────── PLAYER CONTINUES PAST ASSIGNMENT ──────
    socket.on('continue-to-describe', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        room.gameState = 'description';
        io.to(room.code).emit('room-update', game.safeRoom(room));
    });

    // ────── SUBMIT DESCRIPTION ──────
    socket.on('submit-description', ({ type, data }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;

        const validatedData = validateDescription(type, data);
        if (!validatedData) return;

        const submitted = game.submitDescription(room, socket.id, 'text', validatedData);
        if (!submitted) return;

        io.to(room.code).emit('room-update', game.safeRoom(room));

        // If all submitted → go to discussion
        if (game.allSubmitted(room)) {
            room.gameState = 'discussion';
            room.discussionStartedAt = Date.now();
            game.clearVotes(room);
            io.to(room.code).emit('all-submitted', {
                descriptions: room.descriptions,
                timerDuration: room.timerDuration,
            });
            io.to(room.code).emit('room-update', game.safeRoom(room));
            console.log(`✦ All descriptions in for room ${room.code}`);
        }
    });

    // ────── CAST VOTE ──────
    socket.on('cast-vote', ({ targetId }) => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        if (room.gameState !== 'discussion') return;

        const ok = game.castVote(room, socket.id, targetId);
        if (!ok) return;

        // When all connected players have voted, resolve the round.
        if (game.votingComplete(room)) {
            const outcome = game.getVoteOutcome(room);
            if (outcome && outcome.hasMajority && outcome.guessedImpostor) {
                // Majority correctly identified the impostor → end game.
                room.gameState = 'reveal';
                io.to(room.code).emit('reveal', {
                    word: room.targetWord,
                    impostor: room.players.find(p => p.isImpostor),
                    descriptions: room.descriptions,
                });
                io.to(room.code).emit('room-update', game.safeRoom(room));
            } else {
                // No correct majority → automatically move to next round.
                const result = game.startNextRound(room);
                if (result.error) {
                    socket.emit('error-msg', result.error);
                } else {
                    room.players.forEach((player) => {
                        io.to(player.id).emit('game-started', {
                            isImpostor: player.isImpostor,
                            word: player.isImpostor ? null : room.targetWord,
                            round: room.round,
                        });
                    });
                    io.to(room.code).emit('room-update', game.safeRoom(room));
                    console.log(`✦ Next round (auto) in room ${room.code}. Word: ${room.targetWord}`);
                }
            }
            game.clearVotes(room);
        }
    });

    // ────── SKIP TIMER (Host) ──────
    socket.on('skip-timer', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.hostId !== socket.id) return;
        resolveDiscussion(room, io);
    });

    // ────── TIMER EXPIRED ──────
    socket.on('timer-expired', () => {
        const room = rooms[socket.roomCode];
        if (!room) return;
        if (room.gameState === 'reveal') return;
        resolveDiscussion(room, io);
    });

    // ────── NEXT ROUND (Host) ──────
    socket.on('next-round', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.hostId !== socket.id) return;
        if (room.gameState !== 'discussion') return;
        resolveDiscussion(room, io);
    });

    // ────── FINISH GAME (Host) ──────
    socket.on('finish-game', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.hostId !== socket.id) return;

        room.gameState = 'reveal';

        io.to(room.code).emit('reveal', {
            word: room.targetWord,
            impostor: room.players.find(p => p.isImpostor),
            descriptions: room.descriptions,
        });
        io.to(room.code).emit('room-update', game.safeRoom(room));
    });

    // ────── PLAY AGAIN ──────
    socket.on('play-again', () => {
        const room = rooms[socket.roomCode];
        if (!room || room.hostId !== socket.id) return;
        game.resetGame(room);
        io.to(room.code).emit('room-update', game.safeRoom(room));
        io.to(room.code).emit('back-to-lobby');
        console.log(`✦ Room ${room.code} reset to lobby`);
    });

    // ────── DISCONNECT ──────
    socket.on('disconnect', () => {
        cleanupJoinRateLimit(socket.id);
        const room = rooms[socket.roomCode];
        if (room) {
            game.removePlayer(room, socket.id);
            const anyConnected = room.players.some(p => p.connected);
            if (!anyConnected) {
                // Mark when the room first became empty; a periodic sweeper
                // will clean up long-empty rooms after a grace period.
                if (!room.emptySince) {
                    room.emptySince = Date.now();
                }
                console.log(`✦ Room ${socket.roomCode} is now empty; starting grace period timer`);
            } else {
                // At least one player still connected; ensure we don't treat
                // this room as empty anymore.
                room.emptySince = null;
                io.to(room.code).emit('room-update', game.safeRoom(room));
            }
        }
        console.log(`✦ Disconnected: ${socket.id}`);
    });
});

// Periodically sweep and delete rooms that have been empty for longer than
// the configured grace period. This allows short mobile disconnects without
// losing room state, while still reclaiming memory for abandoned rooms.
setInterval(() => {
    const now = Date.now();
    Object.entries(rooms).forEach(([code, room]) => {
        if (room.emptySince && now - room.emptySince > EMPTY_ROOM_GRACE_MS) {
            delete rooms[code];
            console.log(`✦ Room ${code} deleted after being empty for more than ${EMPTY_ROOM_GRACE_MS / 60000} minutes`);
        }
    });
}, 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n  🎭 Impostor Game server running on http://localhost:${PORT}\n`);
});
