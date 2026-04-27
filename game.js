const crypto = require('crypto');
const { getRandomWord, getRandomWordExcluding } = require('./words');

// Room structure:
// { code, hostId, players, targetWord, impostorDecoyWord, gameState,
//   descriptions, round, votes, socketByPlayer (runtime), updatedAt }
//
// Identity model: every player record uses a STABLE client-generated UUID
// (`playerId`) as `player.id`. Vote and description records reference the
// same playerId, so socket churn during reconnects no longer corrupts state.
// Per-player direct messaging on the server uses room.socketByPlayer to look
// up the current socket for a given playerId.

/** Six-digit string 000000–999999 (leading zeros preserved). */
function generateRoomCode() {
    const n = crypto.randomInt(0, 1_000_000);
    return String(n).padStart(6, '0');
}

function generateRejoinToken() {
    return crypto.randomUUID();
}

/** Optional isCodeTaken(code) retries until a free 6-digit code (create flow only). */
function createRoom(hostPlayerId, hostName, isCodeTaken) {
    const rejoinToken = generateRejoinToken();
    let code = generateRoomCode();
    if (typeof isCodeTaken === 'function') {
        for (let attempt = 0; attempt < 100 && isCodeTaken(code); attempt++) {
            code = generateRoomCode();
        }
        if (isCodeTaken(code)) return null;
    }
    return {
        code,
        hostId: hostPlayerId,
        players: [{
            id: hostPlayerId,
            name: hostName,
            isImpostor: false,
            hasSubmitted: false,
            connected: true,
            rejoinToken,
        }],
        targetWord: null,
        impostorDecoyWord: null,
        gameState: 'lobby',
        descriptions: [],
        round: 0,
        votes: [],
        socketByPlayer: {},
        updatedAt: Date.now(),
    };
}

function addPlayer(room, playerId, name) {
    if (room.players.find(p => p.id === playerId)) return false;
    if (room.gameState !== 'lobby') return false;
    const rejoinToken = generateRejoinToken();
    room.players.push({
        id: playerId,
        name,
        isImpostor: false,
        hasSubmitted: false,
        connected: true,
        rejoinToken,
    });
    return { rejoinToken };
}

function findPlayerByRejoinToken(room, rejoinToken) {
    if (!rejoinToken || typeof rejoinToken !== 'string') return null;
    return room.players.find(p => p.rejoinToken === rejoinToken) || null;
}

/** Used when rejoining without a token (e.g. wiped storage) — merge into the disconnected slot instead of adding a duplicate. */
function findDisconnectedPlayerByName(room, name) {
    const trimmed = String(name).trim();
    return room.players.find(p => p.name === trimmed && p.connected === false) || null;
}

/**
 * Mark a player as disconnected. Their record (votes, descriptions, host
 * status) is preserved so they can resume on reconnect. Use kickPlayer() to
 * fully remove a player.
 */
function removePlayer(room, playerId) {
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    player.connected = false;
    if (room.socketByPlayer) delete room.socketByPlayer[playerId];
    if (playerId === room.hostId) {
        const replacement = room.players.find(p => p.connected && p.id !== playerId);
        if (replacement) {
            room.hostId = replacement.id;
        }
    }
}

/**
 * Fully remove a player record and any state they contributed (votes,
 * descriptions). If the kicked player was the host, transfer host to the
 * next still-connected player. Returns the removed player or null.
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
        const replacement = room.players.find(p => p.connected) || room.players[0];
        if (replacement) {
            room.hostId = replacement.id;
        }
    }
    return removed;
}

function startGame(room) {
    if (room.players.length < 2) return { error: 'Need at least 2 players to start.' };

    // Reset all previous state
    room.descriptions = [];
    room.votes = [];
    room.players.forEach(p => {
        p.isImpostor = false;
        p.hasSubmitted = false;
    });

    // Assign impostor at random among connected players (cryptographically secure)
    const eligible = room.players.filter(p => p.connected !== false);
    const pool = eligible.length ? eligible : room.players;
    const impostorIndex = crypto.randomInt(0, pool.length);
    pool[impostorIndex].isImpostor = true;

    room.targetWord = getRandomWord();
    room.impostorDecoyWord = getRandomWordExcluding(room.targetWord);
    room.gameState = 'assignment';
    room.round = 1;

    return { success: true };
}

// Start a new round within the same game (same word, same impostor; players add more descriptions).
function startNextRound(room) {
    if (room.players.length < 2) return { error: 'Need at least 2 players to continue.' };

    // Reset per-round submission flags so everyone can submit again (additional clues for same word)
    room.players.forEach(p => {
        p.hasSubmitted = false;
    });

    room.votes = [];
    // Keep same word; do not pick a new one (new game = new word, only from lobby start)
    room.gameState = 'assignment';
    room.round = (room.round || 0) + 1;

    return { success: true };
}

// Register or update a vote for a given player.
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

// Have all connected players cast a vote?
function votingComplete(room) {
    const connectedPlayers = room.players.filter(p => p.connected !== false);
    if (connectedPlayers.length === 0) return false;
    const voterIds = new Set((room.votes || []).map(v => v.voterId));
    return connectedPlayers.every(p => voterIds.has(p.id));
}

function clearVotes(room) {
    room.votes = [];
}

function submitDescription(room, playerId, type, data) {
    const player = room.players.find(p => p.id === playerId);
    if (!player || player.hasSubmitted) return false;

    player.hasSubmitted = true;
    room.descriptions.push({ playerId, playerName: player.name, type, data });

    return true;
}

function allSubmitted(room) {
    const connected = room.players.filter(p => p.connected !== false);
    if (connected.length === 0) return false;
    return connected.every(p => p.hasSubmitted);
}

function resetGame(room) {
    room.descriptions = [];
    room.votes = [];
    room.players.forEach(p => {
        p.isImpostor = false;
        p.hasSubmitted = false;
        p.connected = true;
    });
    room.targetWord = null;
    room.impostorDecoyWord = null;
    room.gameState = 'lobby';
    room.round = 0;
}

function safeRoom(room) {
    // Return room data safe to broadcast (no sensitive impostor info publicly exposed)
    const connectedPlayers = room.players.filter(p => p.connected !== false);
    const voterIds = new Set((room.votes || []).map(v => v.voterId));
    const votedCount = connectedPlayers.filter(p => voterIds.has(p.id)).length;
    return {
        code: room.code,
        hostId: room.hostId,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            hasSubmitted: p.hasSubmitted,
            connected: p.connected,
        })),
        gameState: room.gameState,
        submittedCount: connectedPlayers.filter(p => p.hasSubmitted).length,
        totalCount: connectedPlayers.length,
        votedCount,
        round: room.round,
    };
}

module.exports = {
    createRoom,
    addPlayer,
    findPlayerByRejoinToken,
    findDisconnectedPlayerByName,
    removePlayer,
    kickPlayer,
    startGame,
    startNextRound,
    submitDescription,
    allSubmitted,
    resetGame,
    safeRoom,
    castVote,
    votingComplete,
    clearVotes,
};
