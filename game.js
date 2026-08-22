const crypto = require('crypto');
const { getRandomWord, getRandomWordExcluding } = require('./words');

// Room structure:
// { code, v, hostId, players, targetWord, impostorDecoyWord, gameState,
//   descriptions, round, votes, socketByPlayer (runtime), updatedAt }
//
// Identity model: every player record uses a STABLE client-generated UUID
// (`playerId`) as `player.id`. Vote and description records reference the same
// playerId, so socket churn during reconnects cannot corrupt state.
//
// State delivery: clients are never sent incremental events they have to
// replay in order. They get whole snapshots from buildSnapshot(), stamped with
// a monotonic `v`. A snapshot is complete and idempotent, so a client that
// missed any number of them self-heals on the next one — which is the whole
// reason a phone that slept through three phase changes can rejoin cleanly.

// Bump when the snapshot/action wire format changes incompatibly. The client
// compares against its own constant and asks the user to reload on mismatch,
// instead of silently misbehaving against a server it doesn't understand.
// 3: the handshake must now carry a rejoinToken to resume a seat.
const PROTOCOL = 3;

// A game that has run this long is already over socially; the cap exists so
// room.descriptions (and the snapshot built from it) cannot grow without bound
// across rounds, on disk as well as in memory.
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS) || 20;

// A room this size is already unplayable as a social game; the cap exists to
// stop an unauthenticated stranger from making the server do O(n^2) work, since
// every reconcile builds one snapshot per player and each snapshot lists every
// player.
const MAX_PLAYERS_PER_ROOM = Number(process.env.MAX_PLAYERS_PER_ROOM) || 20;

// ─── Presence ───
// A boolean `connected` is too coarse. iOS closes the WebSocket the moment the
// screen locks, so an instant "they're gone, exclude them" rule would resolve
// rounds out from under players who are 5 seconds from coming back. Equally, a
// player who is genuinely gone must not hold the round hostage forever.
//
//   online  — socket attached right now
//   away    — dropped less than AWAY_GRACE_MS ago; STILL COUNTED, we wait
//   offline — dropped longer ago; excluded from every threshold
//
// Presence is derived from timestamps rather than stored, so it advances on its
// own; the server re-evaluates it on a timer (see server.js presence tick) and
// a round can therefore un-wedge itself with nobody touching their phone.
// Overridable so tests can compress the window (and so it can be tuned in
// production without a code change).
const AWAY_GRACE_MS = Number(process.env.AWAY_GRACE_MS) || 15 * 1000;

function presenceOf(player, now = Date.now()) {
    if (!player) return 'offline';
    if (player.connected) return 'online';
    const since = Number(player.lastSeen) || 0;
    return (now - since) < AWAY_GRACE_MS ? 'away' : 'offline';
}

/** Players who still count toward submission/vote thresholds. */
function presentPlayers(room, now = Date.now()) {
    if (!room || !Array.isArray(room.players)) return [];
    return room.players.filter(p => presenceOf(p, now) !== 'offline');
}

/** Six-digit string 000000–999999 (leading zeros preserved). */
function generateRoomCode() {
    const n = crypto.randomInt(0, 1_000_000);
    return String(n).padStart(6, '0');
}

/**
 * Only a HASH of each seat's token is kept.
 *
 * The snapshot file is a plain JSON blob on a volume; storing live credentials
 * in it means anyone who can read that file (a stray backup, a shared volume, a
 * debug dump) can take over any seat. The token is a full-entropy UUID, so a
 * single SHA-256 is the right primitive here — this is a random secret, not a
 * guessable password, so there is nothing for a slow KDF to buy.
 *
 * The plaintext is returned to its owner exactly once, when the seat is
 * created, and never exists server-side again.
 */
function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Mint a fresh credential for a seat, storing only its hash. Returns the plaintext. */
function issueToken(player) {
    const token = crypto.randomUUID();
    player.rejoinTokenHash = hashToken(token);
    delete player.rejoinToken; // in case an older persisted seat carried one
    return token;
}

function newPlayer(id, name) {
    return {
        id,
        name,
        isImpostor: false,
        hasSubmitted: false,
        hasContinued: false,
        connected: true,
        lastSeen: Date.now(),
        rejoinTokenHash: null,
    };
}

/**
 * Optional isCodeTaken(code) retries until a free 6-digit code (create flow only).
 * Returns { room, rejoinToken } — the host's plaintext credential, which is the
 * only time it exists — or null if no code could be allocated.
 */
function createRoom(hostPlayerId, hostName, isCodeTaken) {
    let code = generateRoomCode();
    if (typeof isCodeTaken === 'function') {
        for (let attempt = 0; attempt < 100 && isCodeTaken(code); attempt++) {
            code = generateRoomCode();
        }
        if (isCodeTaken(code)) return null;
    }
    const host = newPlayer(hostPlayerId, hostName);
    const rejoinToken = issueToken(host);
    const room = {
        code,
        v: 0,
        hostId: hostPlayerId,
        players: [host],
        targetWord: null,
        impostorDecoyWord: null,
        gameState: 'lobby',
        descriptions: [],
        round: 0,
        votes: [],
        // Prototype-safe: keys are client-supplied playerIds, and "__proto__" on
        // a normal object silently fails to store instead of creating an entry.
        socketByPlayer: Object.create(null),
        updatedAt: Date.now(),
    };
    return { room, rejoinToken };
}

function addPlayer(room, playerId, name) {
    if (room.players.find(p => p.id === playerId)) return { error: 'You are already in this room.' };
    if (room.gameState !== 'lobby') return { error: 'Game already in progress.' };
    if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
        return { error: `This room is full (${MAX_PLAYERS_PER_ROOM} players max).` };
    }
    const player = newPlayer(playerId, name);
    const rejoinToken = issueToken(player);
    room.players.push(player);
    return { rejoinToken };
}

/**
 * Resolve a seat from a rejoinToken.
 *
 * SECURITY: the token is the ONLY credential for an existing seat, and it is
 * never included in a snapshot. `player.id` (the playerId) is broadcast to
 * everyone in the room so they can be voted for and kicked, so it is a public
 * identifier and must never be accepted as proof of identity on its own —
 * otherwise any player could read another's id out of their own snapshot,
 * reconnect as them, and read their secret word or act in their name.
 *
 * Compared in constant time so a token cannot be recovered a byte at a time.
 */
function findPlayerByRejoinToken(room, rejoinToken) {
    if (!rejoinToken || typeof rejoinToken !== 'string') return null;
    const presented = Buffer.from(hashToken(rejoinToken), 'hex');
    for (const p of room.players) {
        if (typeof p.rejoinTokenHash !== 'string' || p.rejoinTokenHash.length !== 64) continue;
        const stored = Buffer.from(p.rejoinTokenHash, 'hex');
        if (stored.length !== presented.length) continue;
        if (crypto.timingSafeEqual(stored, presented)) return p;
    }
    return null;
}

/**
 * Authenticate a socket against a seat: the token must match, and it must
 * belong to the seat the caller claims. Returns the player or null.
 */
function authenticate(room, playerId, rejoinToken) {
    const byToken = findPlayerByRejoinToken(room, rejoinToken);
    if (!byToken) return null;
    // A token identifies its own seat; a claimed playerId may disagree after a
    // storage wipe, in which case the token wins and the seat is rebound.
    if (playerId && byToken.id !== playerId) return byToken;
    return byToken;
}

/** Mark a player present. Their record (votes, clues, host status) is untouched. */
function markOnline(room, playerId) {
    const player = room.players.find(p => p.id === playerId);
    if (!player) return null;
    player.connected = true;
    player.lastSeen = Date.now();
    return player;
}

/**
 * Mark a player as dropped. They enter `away` (still counted) and age into
 * `offline` on their own. Their record is preserved so they resume on
 * reconnect; use kickPlayer() to actually remove someone.
 */
function markOffline(room, playerId) {
    const player = room.players.find(p => p.id === playerId);
    if (!player) return null;
    player.connected = false;
    player.lastSeen = Date.now();
    if (room.socketByPlayer) delete room.socketByPlayer[playerId];
    return player;
}

/**
 * Invariant: whenever someone is reachable, the host must be a player who is
 * actually there.
 *
 * A room could otherwise be left with host controls pinned to someone who has
 * gone — nobody able to open voting, resolve, or reveal, and no way to claim
 * it. Two ways in: the host drops while nobody else is connected, and every
 * server restart (hydration marks all players disconnected before anyone
 * reconnects).
 *
 * Handoff waits for `offline`, not `away`, so a host whose screen locked for a
 * few seconds gets their controls back instead of the role ping-ponging around
 * the room on every network blip.
 *
 * Returns true if the host changed.
 */
function ensureHost(room, now = Date.now()) {
    if (!room || !Array.isArray(room.players) || room.players.length === 0) return false;
    const current = room.players.find(p => p.id === room.hostId);
    if (current && presenceOf(current, now) !== 'offline') return false;
    // Prefer someone actually online; fall back to merely away over nobody.
    const replacement = room.players.find(p => presenceOf(p, now) === 'online')
        || room.players.find(p => presenceOf(p, now) === 'away');
    if (!replacement || replacement.id === room.hostId) return false;
    room.hostId = replacement.id;
    return true;
}

/**
 * Fully remove a player record and any state they contributed (votes, clues).
 * If they were the host, hand it on. Returns the removed player or null.
 */
function kickPlayer(room, playerId) {
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx === -1) return null;
    const [removed] = room.players.splice(idx, 1);
    if (room.socketByPlayer) delete room.socketByPlayer[playerId];
    if (room.votes) {
        room.votes = room.votes.filter(v => v.voterId !== playerId && v.targetId !== playerId);
    }
    if (room.descriptions) {
        room.descriptions = room.descriptions.filter(d => d.playerId !== playerId);
    }
    if (playerId === room.hostId) {
        const replacement = room.players.find(p => presenceOf(p) !== 'offline') || room.players[0];
        room.hostId = replacement ? replacement.id : null;
    }
    return removed;
}

function startGame(room) {
    const present = presentPlayers(room);
    if (present.length < 2) return { error: 'Need at least 2 players present to start.' };

    room.descriptions = [];
    room.votes = [];
    room.players.forEach(p => {
        p.isImpostor = false;
        p.hasSubmitted = false;
        p.hasContinued = false;
    });

    // Assign impostor at random among present players (cryptographically secure)
    const impostorIndex = crypto.randomInt(0, present.length);
    present[impostorIndex].isImpostor = true;

    room.targetWord = getRandomWord();
    room.impostorDecoyWord = getRandomWordExcluding(room.targetWord);
    room.gameState = 'assignment';
    room.round = 1;

    return { success: true };
}

// Start a new round within the same game (same word, same impostor; players add more clues).
function startNextRound(room) {
    const present = presentPlayers(room);
    if (present.length < 2) return { error: 'Need at least 2 players present to continue.' };
    if ((room.round || 0) >= MAX_ROUNDS) return { error: 'Round limit reached.', limit: true };

    room.players.forEach(p => {
        p.hasSubmitted = false;
        p.hasContinued = false;
    });

    room.votes = [];
    // Keep the same word; a new word only comes from starting a new game.
    room.gameState = 'assignment';
    room.round = (room.round || 0) + 1;

    return { success: true };
}

/**
 * Per-player acknowledgement of the role card.
 *
 * The room advances to `description` as soon as the FIRST player continues (so
 * nobody waits on a straggler), but each player keeps their own flag so they
 * are not yanked off their word before they've read it.
 */
function continuePlayer(room, playerId) {
    const player = room.players.find(p => p.id === playerId);
    if (!player) return false;
    if (room.gameState !== 'assignment' && room.gameState !== 'description') return false;
    if (player.hasContinued) return false;
    player.hasContinued = true;
    if (room.gameState === 'assignment') room.gameState = 'description';
    return true;
}

// Register or update a vote.
function castVote(room, voterId, targetId) {
    const voter = room.players.find(p => p.id === voterId);
    const target = room.players.find(p => p.id === targetId);
    if (!voter || !target) return false;

    if (!room.votes) room.votes = [];
    const existing = room.votes.find(v => v.voterId === voterId);
    if (existing) {
        existing.targetId = targetId;
    } else {
        room.votes.push({ voterId, targetId });
    }
    return true;
}

/** Have all present players voted? */
function votingComplete(room, now = Date.now()) {
    const present = presentPlayers(room, now);
    if (present.length === 0) return false;
    const voterIds = new Set((room.votes || []).map(v => v.voterId));
    return present.every(p => voterIds.has(p.id));
}

function clearVotes(room) {
    room.votes = [];
}

function submitDescription(room, playerId, type, data) {
    const player = room.players.find(p => p.id === playerId);
    if (!player || player.hasSubmitted) return false;
    // Backstop on total stored clues, independent of the round cap.
    if (room.descriptions.length >= MAX_PLAYERS_PER_ROOM * MAX_ROUNDS) return false;

    player.hasSubmitted = true;
    // Submitting implies they've seen their word.
    player.hasContinued = true;
    room.descriptions.push({ playerId, playerName: player.name, type, data });

    return true;
}

/** Have all present players submitted a clue? */
function allSubmitted(room, now = Date.now()) {
    const present = presentPlayers(room, now);
    if (present.length === 0) return false;
    return present.every(p => p.hasSubmitted);
}

function resetGame(room) {
    room.descriptions = [];
    room.votes = [];
    room.players.forEach(p => {
        p.isImpostor = false;
        p.hasSubmitted = false;
        p.hasContinued = false;
        // Deliberately NOT resetting connected/lastSeen: presence is a fact
        // about the device, not part of game state, and faking it here would
        // put absent players back into every threshold.
    });
    room.targetWord = null;
    room.impostorDecoyWord = null;
    room.gameState = 'lobby';
    room.round = 0;
}

/**
 * Decide the vote. Crew win on a strict majority of present players naming the
 * impostor; otherwise another round runs on the same word.
 */
function tallyVotes(room, now = Date.now()) {
    const impostor = room.players.find(p => p.isImpostor) || null;
    const present = presentPlayers(room, now);
    const threshold = Math.floor(present.length / 2); // strictly more than half
    // Prototype-safe: keys are client-supplied playerIds.
    const tally = Object.create(null);
    (room.votes || []).forEach((v) => {
        tally[v.targetId] = (tally[v.targetId] || 0) + 1;
    });
    const impostorVotes = (impostor && tally[impostor.id]) || 0;
    return { impostor, tally, threshold, crewWon: !!impostor && impostorVotes > threshold };
}

/** Group clues into one row per player, in first-submission order. */
function groupClues(descriptions) {
    const order = [];
    const byPlayer = new Map();
    (descriptions || []).forEach((d) => {
        if (!byPlayer.has(d.playerId)) {
            byPlayer.set(d.playerId, { playerId: d.playerId, playerName: d.playerName, items: [] });
            order.push(d.playerId);
        }
        byPlayer.get(d.playerId).items.push(String(d.data));
    });
    return order.map(id => byPlayer.get(id));
}

/**
 * The single thing sent to clients: a complete, self-contained view of the room
 * from one player's perspective. Everything the UI needs to draw itself is in
 * here, so the client never has to remember what happened before.
 *
 * Secrets are scoped: a player's role and word appear only in their own `you`
 * block, and only while the phase makes it theirs to know.
 */
function buildSnapshot(room, playerId, now = Date.now()) {
    const you = room.players.find(p => p.id === playerId) || null;
    const present = presentPlayers(room, now);
    const voterIds = new Set((room.votes || []).map(v => v.voterId));
    const phase = room.gameState;
    const showClues = phase === 'discussion' || phase === 'vote' || phase === 'reveal';
    const showRole = phase === 'assignment' || phase === 'description';
    const impostor = room.players.find(p => p.isImpostor) || null;

    return {
        protocol: PROTOCOL,
        v: room.v || 0,
        code: room.code,
        phase,
        round: room.round || 0,
        you: you ? {
            id: you.id,
            name: you.name,
            isHost: room.hostId === you.id,
            hasSubmitted: !!you.hasSubmitted,
            hasContinued: !!you.hasContinued,
            votedFor: ((room.votes || []).find(v => v.voterId === you.id) || {}).targetId || null,
            isImpostor: showRole ? !!you.isImpostor : null,
            word: showRole ? (you.isImpostor ? room.impostorDecoyWord : room.targetWord) : null,
        } : null,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            presence: presenceOf(p, now),
            hasSubmitted: !!p.hasSubmitted,
            hasVoted: voterIds.has(p.id),
            isHost: room.hostId === p.id,
        })),
        counts: {
            present: present.length,
            submitted: present.filter(p => p.hasSubmitted).length,
            voted: present.filter(p => voterIds.has(p.id)).length,
        },
        clues: showClues ? groupClues(room.descriptions) : null,
        reveal: (phase === 'reveal' && impostor) ? {
            word: room.targetWord,
            impostorId: impostor.id,
            impostorName: impostor.name,
        } : null,
    };
}

module.exports = {
    PROTOCOL,
    AWAY_GRACE_MS,
    MAX_PLAYERS_PER_ROOM,
    MAX_ROUNDS,
    hashToken,
    issueToken,
    presenceOf,
    presentPlayers,
    createRoom,
    addPlayer,
    findPlayerByRejoinToken,
    authenticate,
    markOnline,
    markOffline,
    ensureHost,
    kickPlayer,
    startGame,
    startNextRound,
    continuePlayer,
    submitDescription,
    allSubmitted,
    resetGame,
    tallyVotes,
    groupClues,
    buildSnapshot,
    castVote,
    votingComplete,
    clearVotes,
};
