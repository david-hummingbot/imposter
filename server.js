const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const QRCodeSVG = require('qrcode-svg');
const game = require('./game');
const persistence = require('./persistence');

// ─── Input validation (limits, sanitization) ───
const MAX_NAME_LEN = 20;
const MAX_DESC_LEN = 500;
const MAX_PLAYER_ID_LEN = 128;
const MAX_NONCE_LEN = 64;
const ROOM_CODE_REGEX = /^\d{6}$/;

// Names that mean something special to a JavaScript object. The maps keyed by
// playerId are prototype-safe now, but rejecting these outright means a client
// cannot pick an id whose behaviour differs from every other id.
const RESERVED_PLAYER_IDS = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty']);

function sanitisePlayerId(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_PLAYER_ID_LEN) return null;
    // Allow URL-safe characters only — UUIDs, opaque tokens, etc.
    if (!/^[A-Za-z0-9_\-]+$/.test(trimmed)) return null;
    if (RESERVED_PLAYER_IDS.has(trimmed)) return null;
    return trimmed;
}

function validateName(name) {
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
    const validatedName = validateName(name);
    if (validatedName.error) return validatedName;
    return { code: trimmedCode, name: validatedName.name };
}

function validateDescription(data) {
    if (typeof data !== 'string') return null;
    const trimmed = data.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > MAX_DESC_LEN) return null;
    return trimmed;
}

const app = express();

// Behind a reverse proxy (nginx, Caddy, Traefik, Render, Fly...) the real client
// IP arrives in X-Forwarded-For. Without this every visitor looks like the proxy
// and they all share one rate-limit bucket — and express-rate-limit v7 flags the
// misconfiguration loudly.
//
// Opt-in on purpose: trusting the header with NO proxy in front would let anyone
// spoof their source IP and sidestep rate limiting entirely. Set TRUST_PROXY to
// the number of proxies in front of the app (usually 1), or an express
// trust-proxy expression.
if (process.env.TRUST_PROXY) {
    const tp = process.env.TRUST_PROXY.trim();
    app.set('trust proxy', /^\d+$/.test(tp) ? Number(tp) : tp);
    console.log(`✦ trust proxy = ${tp}`);
}

// Security headers.
//
// The CSP is built per request so connect-src can name this exact origin's
// WebSocket URL. Hard-coding `ws:` would permit connections to any host, and
// relying on 'self' alone to cover the ws:// upgrade is subtly browser
// dependent — naming it is unambiguous.
//
// style-src keeps 'unsafe-inline' deliberately: the UI sets style attributes
// directly (per-player avatar colours, animation delays, show/hide), which CSP
// counts as inline styles. Style injection is a far smaller problem than script
// injection, and script-src stays strict.
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: false,
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
            imgSrc: ["'self'", 'data:'],
            connectSrc: [
                "'self'",
                (req) => `ws://${req.headers.host || ''}`,
                (req) => `wss://${req.headers.host || ''}`,
            ],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
        },
    },
}));

// Rate limit static/HTTP traffic only. The Socket.IO endpoint is deliberately
// exempt: a group of players behind one NAT (household WiFi) all share a single
// IP, and the reconnect storms that follow phone screen-locks would otherwise
// 429 the handshake — which surfaces to players as "Unable to reconnect".
app.use(rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    skip: (req) => req.path.startsWith('/socket.io/'),
    message: { error: 'Too many requests. Please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
}));

const server = http.createServer(app);

// ─── Origin policy ───
// Browsers always attach an Origin to a WebSocket handshake and a page cannot
// suppress it, so this is what stops an unrelated site from driving the game (or
// brute-forcing room codes) through a visitor's browser.
//
// A missing Origin is allowed: that means a non-browser client (a native app,
// curl, the test suite). Such a caller could spoof any Origin anyway, so
// refusing them would cost compatibility and buy nothing — this check exists
// specifically to constrain hostile *pages*.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',').map(o => o.trim()).filter(Boolean);

function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (ALLOWED_ORIGINS.length) return ALLOWED_ORIGINS.includes(origin);
    // Default with no configuration: same origin. Comparing the Origin's host
    // against the Host header means this just works on localhost, a LAN IP, a
    // tunnel or a real domain, with nothing to set. Set ALLOWED_ORIGINS when a
    // proxy rewrites Host, or when the page is served from another host.
    try {
        const host = req.headers.host;
        return !!host && new URL(origin).host === host;
    } catch {
        return false;
    }
}

// Socket.IO server with lenient heartbeat settings to reduce disconnects on
// flaky or sleeping mobile connections.
const io = new Server(server, {
    pingInterval: 25000,
    pingTimeout: 60000,
    // Socket.IO restores room membership and replays missed broadcasts when a
    // client reconnects inside this window. Belt and braces alongside the
    // playerId-based auto-resume below (which covers longer absences, server
    // restarts, and clients running stale JS).
    connectionStateRecovery: {
        maxDisconnectionDuration: 3 * 60 * 1000,
        skipMiddlewares: false, // keep the auth middleware so socket.playerId is set
    },
    allowRequest: (req, callback) => {
        if (!originAllowed(req)) {
            console.log(`✦ Rejected handshake from origin ${req.headers.origin}`);
            return callback(null, false);
        }
        callback(null, true);
    },
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Join QR code ───
// Rendered server-side so the page needs no client-side QR library — the game
// has to work on a LAN with no internet access. The encoded URL is built from
// the Host header of THIS request, i.e. the origin the player's own browser is
// already using, so the QR stays correct whether they reached the game over
// localhost, a LAN IP, or a tunnel, without the server having to know its own
// externally-visible address.
const QR_HOST_REGEX = /^[A-Za-z0-9.\-]+(:\d{1,5})?$/;

app.get('/qr/:code', (req, res) => {
    const code = String(req.params.code || '');
    if (!ROOM_CODE_REGEX.test(code)) return res.status(400).end();

    const host = req.headers.host;
    if (!host || !QR_HOST_REGEX.test(host)) return res.status(400).end();

    const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const proto = (forwarded || req.protocol) === 'https' ? 'https' : 'http';
    const target = `${proto}://${host}/?join=${code}`;

    const svg = new QRCodeSVG({
        content: target,
        padding: 2,
        width: 240,
        height: 240,
        // Dark modules on a white plate: scanners need the light background,
        // and the surrounding UI is near-black.
        color: '#0b0e17',
        background: '#ffffff',
        ecl: 'M',
        join: true,
    }).svg();

    res.type('image/svg+xml');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(svg);
});

// In-memory rooms store (hydrated from disk on boot, persisted on mutation).
let rooms = {};

// playerId -> room code. This is the authoritative answer to "which room is
// this player in?" and replaces the old `socket.roomCode` field. socket.roomCode
// lived on a single socket object, so after any reconnect (new socket) it was
// undefined and every action the player took was silently dropped by the
// `if (!room) return` guards. Keying off the stable playerId means a freshly
// reconnected socket can act immediately, without waiting for the client to
// re-announce itself.
const playerRooms = new Map();

function indexRoom(room) {
    if (!room || !Array.isArray(room.players)) return;
    room.players.forEach(p => playerRooms.set(p.id, room.code));
}

function rebuildPlayerRooms() {
    playerRooms.clear();
    for (const room of Object.values(rooms)) indexRoom(room);
}

function unindexRoom(room) {
    if (!room || !Array.isArray(room.players)) return;
    room.players.forEach((p) => {
        if (playerRooms.get(p.id) === room.code) playerRooms.delete(p.id);
    });
}

/**
 * Resolve the room a player belongs to, self-healing the index if it points at
 * a room that no longer exists or no longer holds a record for them.
 */
function roomForPlayer(playerId) {
    const code = playerRooms.get(playerId);
    if (!code) return null;
    const room = rooms[code];
    if (!room) { playerRooms.delete(playerId); return null; }
    if (!room.players.some(p => p.id === playerId)) { playerRooms.delete(playerId); return null; }
    return room;
}

// ─── Rate limiting ───
// Keyed on the CLIENT ADDRESS, not on playerId. playerId is chosen by the
// client, so a per-playerId budget is no budget at all: rotating it walked
// straight past a "10 rooms per minute" cap, and made the 6-digit code space
// enumerable at ~400 join attempts/second. The per-playerId counters are kept
// as a second layer to stop one well-behaved client looping.
const RATE_WINDOW_MS = 60 * 1000;
const MAX_JOINS_PER_PLAYER = 40;
const MAX_CREATE_PER_PLAYER = 10;
// Generous enough for a household of players all reconnecting at once, tight
// enough that enumerating a million codes from one address takes days.
const MAX_JOINS_PER_IP = Number(process.env.MAX_JOINS_PER_IP) || 120;
const MAX_CREATE_PER_IP = Number(process.env.MAX_CREATE_PER_IP) || 20;
const MAX_ACTIONS_PER_IP = Number(process.env.MAX_ACTIONS_PER_IP) || 600;
// Backstop against room-spam exhausting memory, disk and the 6-digit code space.
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;
// Keeps a flood of distinct keys from becoming the memory leak it is meant to
// prevent.
const MAX_RATE_KEYS = 20000;

const joinAttempts = new Map();
const createAttempts = new Map();
const joinAttemptsIp = new Map();
const createAttemptsIp = new Map();
const actionAttemptsIp = new Map();

/**
 * The address to bill this socket against. Behind a proxy every socket appears
 * to come from the proxy, so X-Forwarded-For is used — but ONLY when the
 * operator has declared a proxy via TRUST_PROXY, since otherwise any client
 * could set the header and mint itself a fresh budget.
 */
function clientIp(socket) {
    if (process.env.TRUST_PROXY) {
        const xff = socket.handshake.headers['x-forwarded-for'];
        if (xff) {
            const first = String(xff).split(',')[0].trim();
            if (first) return first;
        }
    }
    return socket.handshake.address || 'unknown';
}

function checkRateLimit(map, key, max) {
    if (!key) return true;
    const now = Date.now();
    let record = map.get(key);
    if (!record || now > record.resetAt) {
        if (!record && map.size >= MAX_RATE_KEYS) return false; // shed load rather than grow
        record = { count: 0, resetAt: now + RATE_WINDOW_MS };
        map.set(key, record);
    }
    record.count++;
    return record.count <= max;
}

// ─── Action idempotency ───
// Clients retry actions they could not confirm (see the outbox in app.js). A
// retry carries the same nonce, so replaying it must be a no-op that returns the
// original answer — otherwise a reconnect could double-submit a clue.
const NONCE_TTL_MS = 5 * 60 * 1000;
const seenNonces = new Map(); // `${playerId}:${nonce}` -> { at, result }

function nonceKey(playerId, nonce) { return `${playerId}:${nonce}`; }

function recallNonce(playerId, nonce) {
    const hit = seenNonces.get(nonceKey(playerId, nonce));
    return hit ? hit.result : null;
}

function rememberNonce(playerId, nonce, result) {
    seenNonces.set(nonceKey(playerId, nonce), { at: Date.now(), result });
}

function pruneEphemeral() {
    const now = Date.now();
    for (const map of [joinAttempts, createAttempts, joinAttemptsIp, createAttemptsIp, actionAttemptsIp]) {
        for (const [k, v] of map) if (now > v.resetAt) map.delete(k);
    }
    for (const [k, v] of seenNonces) if (now - v.at > NONCE_TTL_MS) seenNonces.delete(k);
    // Nonces are keyed by a client-chosen playerId, so cap the map outright.
    if (seenNonces.size > MAX_RATE_KEYS) {
        const excess = seenNonces.size - MAX_RATE_KEYS;
        let i = 0;
        for (const k of seenNonces.keys()) { seenNonces.delete(k); if (++i >= excess) break; }
    }
}

setInterval(pruneEphemeral, 60 * 1000);

// When a room becomes empty, we keep it around for a short grace period so that
// mobile clients that briefly lose connectivity (screen lock, network handoff)
// can reconnect without the room being destroyed immediately.
const EMPTY_ROOM_GRACE_MS = 5 * 60 * 1000; // 5 minutes

// How often derived presence is re-evaluated. Presence ages on a clock (see
// game.js), so this is what lets a round waiting on someone who has gone for
// good un-wedge itself with nobody touching their phone.
const PRESENCE_TICK_MS = Number(process.env.PRESENCE_TICK_MS) || 5 * 1000;

// Runtime-only, kept outside the room object so it never reaches disk.
const presenceFingerprints = new Map();

// ─── The single funnel ───

/**
 * Push one snapshot per player. Each player has their own Socket.IO channel
 * (named after their playerId), so this reaches every tab and every socket they
 * hold, including one that reconnected a millisecond ago.
 */
function broadcastState(room) {
    if (!room) return;
    const now = Date.now();
    for (const player of room.players) {
        io.to(player.id).emit('state', game.buildSnapshot(room, player.id, now));
    }
}

/**
 * Advance the room as far as the current facts allow.
 *
 * Loops because one transition can enable the next (resolving a vote starts a
 * round, which could itself already be complete if everyone has gone). Emits
 * nothing — the snapshot carries whatever changed, which is why there is no
 * longer a family of game-started / all-submitted / voting-opened / reveal
 * events to keep in sync.
 */
function advancePhases(room, now) {
    for (let guard = 0; guard < 4; guard++) {
        if (room.gameState === 'description' && game.allSubmitted(room, now)) {
            room.gameState = 'discussion';
            game.clearVotes(room);
            continue;
        }
        if (room.gameState === 'vote' && game.votingComplete(room, now)) {
            const { crewWon } = game.tallyVotes(room, now);
            if (crewWon) {
                room.gameState = 'reveal';
                return;
            }
            // Not enough of them fingered the impostor — another round on the
            // same word.
            const next = game.startNextRound(room);
            if (next.limit) {
                // Out of rounds: end the game rather than growing the clue list
                // for ever.
                room.gameState = 'reveal';
                return;
            }
            // Too few players left to continue: stay put, the host still has
            // Force Reveal.
            if (next.error) return;
            continue;
        }
        return;
    }
}

/**
 * The ONLY way room state reaches players.
 *
 * Every handler and every timer ends here, so the invariants below cannot be
 * forgotten in one branch — which is exactly how the original code came to have
 * a disconnect path that updated the player list but never re-checked whether
 * the round it was blocking could now finish.
 */
function reconcile(room) {
    if (!room) return;
    const now = Date.now();
    game.ensureHost(room, now);
    advancePhases(room, now);
    room.v = (room.v || 0) + 1;
    room.updatedAt = now;
    presenceFingerprints.set(room.code, presenceFingerprint(room, now));
    broadcastState(room);
    persistence.schedulePersist(rooms);
}

function presenceFingerprint(room, now) {
    return room.players.map(p => `${p.id}:${game.presenceOf(p, now)}`).join('|');
}

function bindSocketToPlayer(socket, room, playerId) {
    if (!room || !socket || !playerId) return;
    if (!room.socketByPlayer) room.socketByPlayer = Object.create(null);
    room.socketByPlayer[playerId] = socket.id;
}

/**
 * Attach this socket to an existing player record: mark them present, join the
 * channels, and refresh the index.
 */
/**
 * Grant this socket the seat. The ONLY place a socket becomes authenticated:
 * every caller has already proven the seat (a matching rejoinToken, or having
 * just created the seat itself).
 */
function attachPlayer(socket, room, player) {
    game.markOnline(room, player.id);
    bindSocketToPlayer(socket, room, player.id);
    socket.join(room.code);
    // Per-player snapshots are delivered on this channel, so joining it is what
    // grants sight of the seat's secrets — hence only after authentication.
    socket.join(player.id);
    socket.seatId = player.id;
    playerRooms.set(player.id, room.code);
    room.emptySince = null;
}

/** Find the room holding a seat with this token (for a client whose stored playerId was lost). */
function roomForToken(token) {
    if (!token) return null;
    for (const room of Object.values(rooms)) {
        if (game.findPlayerByRejoinToken(room, token)) return room;
    }
    return null;
}

/** The authenticated seat's room, or null if this socket never proved a seat. */
function authedRoom(socket) {
    if (!socket.seatId) return null;
    return roomForPlayer(socket.seatId);
}

// Rewrite all references from oldPlayerId → newPlayerId in a room. Used by the
// rejoin paths so the stable playerId on the socket replaces whatever the
// dropped slot used to have.
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
    if (playerRooms.get(oldPlayerId) === room.code) playerRooms.delete(oldPlayerId);
    playerRooms.set(newPlayerId, room.code);
}

// ─── Actions ───
// One entry point for every mutating command, so acking, idempotency, host
// gating and reconciliation are handled once instead of per handler.

const HOST_ONLY = new Set([
    'start-game', 'open-voting', 'resolve-round', 'force-discussion',
    'finish-game', 'play-again', 'kick',
]);

function applyAction(room, socket, type, payload) {
    const playerId = socket.seatId; // the proven seat, never the claimed id

    if (HOST_ONLY.has(type) && room.hostId !== playerId) {
        return { ok: false, error: 'Only the host can do that.', code: 'NOT_HOST' };
    }

    switch (type) {
        case 'start-game': {
            if (room.gameState !== 'lobby') return { ok: false, error: 'Game already started.' };
            const r = game.startGame(room);
            if (r.error) return { ok: false, error: r.error };
            console.log(`✦ Game started in room ${room.code}. Word: ${room.targetWord}`);
            return { ok: true };
        }

        case 'continue': {
            game.continuePlayer(room, playerId);
            return { ok: true }; // idempotent: already past it is still success
        }

        case 'submit-description': {
            if (room.gameState !== 'description') return { ok: false, error: 'Not accepting clues right now.' };
            const data = validateDescription(payload.data);
            if (!data) return { ok: false, error: 'Enter a clue (up to 500 characters).' };
            if (!game.submitDescription(room, playerId, 'text', data)) {
                return { ok: false, error: 'You already submitted a clue this round.', code: 'ALREADY_SUBMITTED' };
            }
            return { ok: true };
        }

        case 'cast-vote': {
            if (room.gameState !== 'vote') return { ok: false, error: 'Voting is not open.' };
            if (typeof payload.targetId !== 'string') return { ok: false, error: 'Pick someone to vote for.' };
            if (!game.castVote(room, playerId, payload.targetId)) {
                return { ok: false, error: 'That player is not in this game.' };
            }
            return { ok: true };
        }

        case 'force-discussion': {
            if (room.gameState !== 'description') return { ok: false, error: 'Not in the clue phase.' };
            room.gameState = 'discussion';
            game.clearVotes(room);
            console.log(`✦ Host force-advanced room ${room.code} to discussion (${room.descriptions.length} clue(s))`);
            return { ok: true };
        }

        case 'open-voting': {
            if (room.gameState !== 'discussion') return { ok: false, error: 'Not in the discussion phase.' };
            room.gameState = 'vote';
            game.clearVotes(room);
            console.log(`✦ Host opened voting in room ${room.code}`);
            return { ok: true };
        }

        case 'resolve-round': {
            if (room.gameState !== 'vote') return { ok: false, error: 'Voting is not open.' };
            const { crewWon } = game.tallyVotes(room);
            if (crewWon) {
                room.gameState = 'reveal';
                return { ok: true };
            }
            const next = game.startNextRound(room);
            if (next.limit) {
                room.gameState = 'reveal';
                return { ok: true };
            }
            if (next.error) return { ok: false, error: next.error };
            return { ok: true };
        }

        case 'finish-game': {
            if (room.gameState === 'lobby' || room.gameState === 'reveal') {
                return { ok: false, error: 'Nothing to reveal.' };
            }
            if (!room.players.some(p => p.isImpostor)) {
                return { ok: false, error: 'No round in progress.' };
            }
            room.gameState = 'reveal';
            return { ok: true };
        }

        case 'play-again': {
            game.resetGame(room);
            console.log(`✦ Room ${room.code} reset to lobby`);
            return { ok: true };
        }

        case 'kick': {
            const targetId = payload.playerId;
            if (typeof targetId !== 'string') return { ok: false, error: 'Bad request.' };
            if (targetId === playerId) return { ok: false, error: "You can't remove yourself." };
            const removed = game.kickPlayer(room, targetId);
            if (!removed) return { ok: false, error: 'That player is not in this game.' };
            playerRooms.delete(targetId);
            io.to(targetId).emit('kicked', { code: room.code });
            const sockets = io.sockets.adapter.rooms.get(targetId);
            if (sockets) {
                for (const sid of [...sockets]) {
                    const s = io.sockets.sockets.get(sid);
                    if (s) s.leave(room.code);
                }
            }
            console.log(`✦ Host kicked ${removed.name} from room ${room.code}`);
            return { ok: true };
        }

        case 'leave': {
            socket.seatId = null;
            // "Leave" has to be real on the server. When it was client-only the
            // record lingered in every threshold, and playerId auto-resume would
            // drag the player straight back in on their next load.
            const removed = game.kickPlayer(room, playerId);
            playerRooms.delete(playerId);
            socket.leave(room.code);
            if (removed) console.log(`✦ ${removed.name} left room ${room.code}`);
            return { ok: true, left: true };
        }

        default:
            return { ok: false, error: 'Unknown action.', code: 'UNKNOWN_ACTION' };
    }
}

// ─── Handshake ───
// Two values arrive from the client and they are NOT equivalent:
//
//   playerId    — a public identifier. It appears in every snapshot so players
//                 can be voted for and kicked. Anyone in the room knows it.
//                 It is a HINT ONLY and proves nothing.
//   rejoinToken — the credential. Never included in any snapshot, so only the
//                 owner has it. Required to occupy an existing seat.
//
// Conflating the two is how a player could read another's id out of their own
// snapshot, reconnect as them, and inherit their secret word or host powers.
io.use((socket, next) => {
    const auth = socket.handshake?.auth || {};
    socket.playerId = sanitisePlayerId(auth.playerId) || crypto.randomUUID();
    socket.authToken = typeof auth.rejoinToken === 'string' && auth.rejoinToken.length <= 128
        ? auth.rejoinToken
        : null;
    // Set only once a seat has actually been proven. Until then this socket can
    // create or join a room and nothing else.
    socket.seatId = null;
    next();
});

io.on('connection', (socket) => {
    // NOTE: the socket deliberately does NOT join the channel named after its
    // playerId here. Snapshots are delivered per player on that channel, so
    // joining it before the seat is proven would hand the player's secret word
    // to anyone who guessed their (public) id.
    console.log(`✦ Connected: socket=${socket.id} player=${socket.playerId}${socket.recovered ? ' (recovered)' : ''}`);

    // Let the client check it isn't a stale build talking to a newer server.
    socket.emit('hello', { protocol: game.PROTOCOL });

    // ────── AUTO-RESUME ──────
    // Put a returning socket straight back into its room without waiting for the
    // client to re-announce itself — the reconnect fix that makes a locked phone
    // recoverable. Gated on the handshake credential: the token must match the
    // seat, so a stranger replaying a known playerId gets nothing.
    if (socket.authToken) {
        const resumed = roomForPlayer(socket.playerId)
            || roomForToken(socket.authToken);
        const player = resumed ? game.authenticate(resumed, socket.playerId, socket.authToken) : null;
        if (player) {
            if (player.id !== socket.playerId) rewritePlayerId(resumed, player.id, socket.playerId);
            attachPlayer(socket, resumed, player);
            reconcile(resumed);
            console.log(`✦ ${player.name} auto-resumed room ${resumed.code}`);
        } else if (resumed) {
            console.log(`✦ Rejected resume for player=${socket.playerId} (bad or missing token)`);
        }
    }

    // ────── CREATE ROOM ──────
    socket.on('create-room', ({ name } = {}, callback) => {
        const cb = typeof callback === 'function' ? callback : () => { };
        const ip = clientIp(socket);
        if (!checkRateLimit(createAttemptsIp, ip, MAX_CREATE_PER_IP)
            || !checkRateLimit(createAttempts, socket.playerId, MAX_CREATE_PER_PLAYER)) {
            return cb({ error: 'Too many rooms created. Please wait a minute.' });
        }
        if (Object.keys(rooms).length >= MAX_ROOMS) {
            return cb({ error: 'The server is at capacity. Please try again later.' });
        }
        const validated = validateName(name);
        if (validated.error) return cb({ error: validated.error });

        const created = game.createRoom(socket.playerId, validated.name, (c) => Boolean(rooms[c]));
        if (!created) return cb({ error: 'Could not allocate a game code. Please try again.' });

        const { room, rejoinToken } = created;
        rooms[room.code] = room;
        indexRoom(room);
        attachPlayer(socket, room, room.players[0]);
        // The only time the plaintext credential exists: only its hash is kept.
        cb({ success: true, code: room.code, rejoinToken });
        reconcile(room);
        console.log(`✦ Room ${room.code} created by ${validated.name}`);
    });

    // ────── JOIN ROOM ──────
    socket.on('join-room', ({ code, name, rejoinToken } = {}, callback) => {
        const cb = typeof callback === 'function' ? callback : () => { };
        const ip = clientIp(socket);
        if (!checkRateLimit(joinAttemptsIp, ip, MAX_JOINS_PER_IP)
            || !checkRateLimit(joinAttempts, socket.playerId, MAX_JOINS_PER_PLAYER)) {
            return cb({ error: 'Too many join attempts. Please wait a minute.' });
        }
        const validated = validateJoinRoom(code, name);
        if (validated.error) return cb({ error: validated.error });

        const room = rooms[validated.code];
        if (!room) return cb({ error: 'Room not found. Check the code and try again.' });

        // 1) Returning player: the rejoinToken is the ONLY way back into an
        //    existing seat. There is deliberately no fallback that matches on
        //    playerId or name alone — both are broadcast in every snapshot, so
        //    either one would let anybody in the room take over anybody else's
        //    seat and read their secret word.
        const token = rejoinToken || socket.authToken;
        const seat = token ? game.authenticate(room, socket.playerId, token) : null;
        if (seat) {
            // Normalise the seat onto this socket's playerId. Without this the
            // two can diverge (storage cleared but token kept) and the client's
            // own isHost check would compare mismatched ids.
            if (seat.id !== socket.playerId) rewritePlayerId(room, seat.id, socket.playerId);
            attachPlayer(socket, room, seat);
            // No token echoed back: only its hash is stored, and the client
            // just proved it already has the plaintext. Deliberately NOT
            // rotated on rejoin — a rotation whose ack is lost on a flaky
            // mobile connection would lock the rightful owner out, which is the
            // exact failure this whole effort exists to remove.
            cb({ success: true, rejoined: true });
            reconcile(room);
            console.log(`✦ ${seat.name} rejoined room ${validated.code} (token)`);
            return;
        }

        // 2) Genuinely new player → only allowed in the lobby.
        if (room.gameState !== 'lobby') {
            // Distinguish "you've lost your seat" from "you were never in it",
            // so a player whose storage was wiped gets an honest explanation.
            const claimed = room.players.some(p => p.name === validated.name);
            return cb({
                error: claimed
                    ? 'That name is taken and this game is already in progress. Ask the host to remove the old player so you can rejoin.'
                    : 'Game already in progress.',
            });
        }
        const result = game.addPlayer(room, socket.playerId, validated.name);
        if (result.error) return cb({ error: result.error });

        const player = room.players[room.players.length - 1];
        attachPlayer(socket, room, player);
        cb({ success: true, rejoinToken: result.rejoinToken });
        reconcile(room);
        console.log(`✦ ${validated.name} joined room ${validated.code}`);
    });

    // ────── ACTION ──────
    socket.on('action', (payload, callback) => {
        const cb = typeof callback === 'function' ? callback : () => { };
        if (!payload || typeof payload !== 'object') {
            return cb({ ok: false, error: 'Bad request.' });
        }
        const type = String(payload.type || '');
        const nonce = typeof payload.nonce === 'string' && payload.nonce.length <= MAX_NONCE_LEN
            ? payload.nonce
            : null;

        // A retry of something already applied returns the original answer.
        if (nonce) {
            const previous = recallNonce(socket.playerId, nonce);
            if (previous) return cb(previous);
        }

        if (!checkRateLimit(actionAttemptsIp, clientIp(socket), MAX_ACTIONS_PER_IP)) {
            return cb({ ok: false, error: 'Slow down a moment.', code: 'RATE_LIMITED' });
        }

        // Only a socket that proved its seat may act. Resolving the room from
        // the *authenticated* seat rather than the claimed playerId is what
        // stops a stranger who guessed a (public) playerId from voting, kicking
        // or seizing host.
        const room = authedRoom(socket);
        if (!room) {
            // Deliberately NOT remembered: the client should be free to retry
            // this once it has rejoined.
            return cb({ ok: false, error: 'You are not in a game.', code: 'NO_ROOM' });
        }

        let result;
        try {
            result = applyAction(room, socket, type, payload) || { ok: false, error: 'Bad request.' };
        } catch (e) {
            console.error(`✦ action ${type} failed in room ${room.code}:`, e.message);
            result = { ok: false, error: 'Something went wrong.' };
        }

        if (nonce) rememberNonce(socket.playerId, nonce, result);
        cb(result);

        if (!result.ok) return;

        if (result.left && !room.players.some(p => p.connected)) {
            // They removed themselves and there is nobody left to tell.
            if (!room.emptySince) room.emptySince = Date.now();
            persistence.schedulePersist(rooms);
            return;
        }
        reconcile(room);
    });

    // ────── DISCONNECT ──────
    socket.on('disconnect', () => {
        // An unauthenticated socket never held a seat, so its going away means
        // nothing — and must not be able to mark someone else away.
        const room = authedRoom(socket);
        if (!room) return;

        // Only mark the player away if THIS socket is the one currently mapped
        // to them. Otherwise opening a second tab would look like the active
        // session dropping.
        const currentSocketId = room.socketByPlayer && room.socketByPlayer[socket.seatId];
        if (currentSocketId && currentSocketId !== socket.id) return;

        game.markOffline(room, socket.seatId);
        console.log(`✦ Disconnected: socket=${socket.id} player=${socket.seatId}`);

        if (!room.players.some(p => p.connected)) {
            if (!room.emptySince) room.emptySince = Date.now();
            console.log(`✦ Room ${room.code} is now empty; starting grace period timer`);
        } else {
            room.emptySince = null;
        }
        // They are `away` for now, so nothing is excluded yet — the presence
        // tick promotes them to `offline` and reconciles again, which is what
        // lets a round finish without them if they don't come back.
        reconcile(room);
    });
});

// ─── Presence tick ───
// Presence is derived from elapsed time, so it changes with no event to hang a
// handler off. Re-check periodically and reconcile only rooms where someone
// actually crossed a boundary.
setInterval(() => {
    const now = Date.now();
    for (const room of Object.values(rooms)) {
        if (!room || !Array.isArray(room.players) || room.players.length === 0) continue;
        if (presenceFingerprint(room, now) !== presenceFingerprints.get(room.code)) {
            reconcile(room); // stores the new fingerprint
        }
    }
}, PRESENCE_TICK_MS);

// Periodically sweep and delete rooms that have been empty for longer than the
// configured grace period.
setInterval(() => {
    const now = Date.now();
    let dirty = false;
    for (const [code, room] of Object.entries(rooms)) {
        if (room.emptySince && now - room.emptySince > EMPTY_ROOM_GRACE_MS) {
            unindexRoom(room);
            presenceFingerprints.delete(code);
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
    rebuildPlayerRooms();
    server.listen(PORT, () => {
        console.log(`\n  🎭 Impostor Game server running on http://localhost:${PORT}\n`);
    });
})();
