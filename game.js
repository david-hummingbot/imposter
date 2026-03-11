const crypto = require('crypto');
const { getRandomWord } = require('./words');

// Room structure: { code, hostId, players, targetWord, gameState, timerDuration, descriptions, round, votes }
// gameState: 'lobby' | 'assignment' | 'description' | 'discussion' | 'reveal'

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars (0,O,1,I)

function generateRoomCode() {
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += ROOM_CODE_CHARS.charAt(crypto.randomInt(0, ROOM_CODE_CHARS.length));
    }
    return code;
}

function generateRejoinToken() {
    return crypto.randomUUID();
}

function createRoom(hostId, hostName) {
    const rejoinToken = generateRejoinToken();
    return {
        code: generateRoomCode(),
        hostId,
        players: [{ id: hostId, name: hostName, isImpostor: false, hasSubmitted: false, connected: true, rejoinToken }],
        targetWord: null,
        gameState: 'lobby',
        timerDuration: 60,
        descriptions: [],
        round: 0,
        votes: [],
    };
}

function addPlayer(room, socketId, name) {
    if (room.players.find(p => p.id === socketId)) return false;
    if (room.gameState !== 'lobby') return false;
    const rejoinToken = generateRejoinToken();
    room.players.push({ id: socketId, name, isImpostor: false, hasSubmitted: false, connected: true, rejoinToken });
    return { rejoinToken };
}

function findPlayerByRejoinToken(room, rejoinToken) {
    if (!rejoinToken || typeof rejoinToken !== 'string') return null;
    return room.players.find(p => p.rejoinToken === rejoinToken) || null;
}

function removePlayer(room, socketId) {
    const player = room.players.find(p => p.id === socketId);
    if (!player) return;
    player.connected = false;
    // If host left, assign new host among still-connected players
    if (socketId === room.hostId) {
        const replacement = room.players.find(p => p.connected && p.id !== socketId);
        if (replacement) {
            room.hostId = replacement.id;
        }
    }
}

function startGame(room, timerDuration) {
    if (room.players.length < 2) return { error: 'Need at least 2 players to start.' };

    // Reset all previous state
    room.descriptions = [];
    room.votes = [];
    room.players.forEach(p => {
        p.isImpostor = false;
        p.hasSubmitted = false;
    });

    // Assign impostor at random (cryptographically secure)
    const impostorIndex = crypto.randomInt(0, room.players.length);
    room.players[impostorIndex].isImpostor = true;

    room.targetWord = getRandomWord();
    room.timerDuration = Number(timerDuration) || 60;
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

// Compute majority outcome and whether impostor was correctly guessed.
function getVoteOutcome(room) {
    const connectedPlayers = room.players.filter(p => p.connected !== false);
    if (connectedPlayers.length === 0) return null;
    const connectedIds = new Set(connectedPlayers.map(p => p.id));
    const votes = (room.votes || []).filter(v => connectedIds.has(v.voterId));
    if (votes.length === 0) return null;

    const counts = {};
    votes.forEach(v => {
        counts[v.targetId] = (counts[v.targetId] || 0) + 1;
    });

    let topId = null;
    let topCount = 0;
    Object.entries(counts).forEach(([id, count]) => {
        if (count > topCount) {
            topId = id;
            topCount = count;
        }
    });

    const total = votes.length;
    const majority = Math.floor(total / 2) + 1;
    const hasMajority = topCount >= majority;
    const impostor = room.players.find(p => p.isImpostor);
    const guessedImpostor = hasMajority && impostor && topId === impostor.id;

    return {
        hasMajority,
        guessedImpostor,
        topId,
        topCount,
        total,
    };
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
    return room.players.every(p => p.hasSubmitted);
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
    room.gameState = 'lobby';
    room.round = 0;
}

function safeRoom(room) {
    // Return room data safe to broadcast (no sensitive impostor info publicly exposed)
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
        timerDuration: room.timerDuration,
        submittedCount: room.players.filter(p => p.hasSubmitted).length,
        totalCount: room.players.length,
        round: room.round,
    };
}

module.exports = {
    createRoom,
    addPlayer,
    findPlayerByRejoinToken,
    removePlayer,
    startGame,
    startNextRound,
    submitDescription,
    allSubmitted,
    resetGame,
    safeRoom,
    castVote,
    votingComplete,
    getVoteOutcome,
    clearVotes,
};
