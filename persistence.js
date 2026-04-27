const fs = require('fs/promises');
const path = require('path');

// Snapshot persistence so a server restart doesn't wipe active games. We
// write a single JSON file with all rooms; runtime-only fields (socket
// mappings, transient timers) are stripped before writing and re-initialised
// on hydrate. Players resume on next reconnect via their saved rejoinToken.

const DATA_DIR = path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const TMP_FILE = ROOMS_FILE + '.tmp';
const MAX_ROOM_AGE_MS = 6 * 60 * 60 * 1000; // 6h
const PERSIST_DEBOUNCE_MS = 500;

let pendingTimer = null;
let pendingRoomsRef = null;
let writing = false;
let dirtyDuringWrite = false;

async function ensureDir() {
    try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch { /* ignore */ }
}

/**
 * Load and hydrate rooms from disk. All players are marked disconnected;
 * players resume on next reconnect. Rooms older than MAX_ROOM_AGE_MS are
 * dropped so the file doesn't accumulate dead state across long uptimes.
 */
async function loadRooms() {
    try {
        const raw = await fs.readFile(ROOMS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || !parsed.rooms || typeof parsed.rooms !== 'object') {
            return {};
        }
        const now = Date.now();
        const result = {};
        for (const [code, room] of Object.entries(parsed.rooms)) {
            if (!room || typeof room !== 'object') continue;
            const updatedAt = Number(room.updatedAt) || Number(parsed.savedAt) || 0;
            if (now - updatedAt > MAX_ROOM_AGE_MS) continue;
            // Reset runtime fields
            room.socketByPlayer = {};
            if (Array.isArray(room.players)) {
                room.players.forEach(p => { p.connected = false; });
            } else {
                room.players = [];
            }
            // Start the empty-room sweeper grace period; players have a
            // window to reconnect before the room is reclaimed.
            room.emptySince = now;
            result[code] = room;
        }
        return result;
    } catch (e) {
        if (e && e.code !== 'ENOENT') {
            console.error('persistence: failed to load rooms.json:', e.message);
        }
        return {};
    }
}

/**
 * Schedule a debounced write of the rooms map. Call after any state mutation;
 * multiple rapid calls coalesce into a single write.
 */
function schedulePersist(rooms) {
    pendingRoomsRef = rooms;
    if (writing) {
        dirtyDuringWrite = true;
        return;
    }
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
        pendingTimer = null;
        flush().catch(() => { /* logged inside */ });
    }, PERSIST_DEBOUNCE_MS);
}

async function flush() {
    if (writing) {
        dirtyDuringWrite = true;
        return;
    }
    const rooms = pendingRoomsRef;
    if (!rooms) return;
    writing = true;
    try {
        await ensureDir();
        const snapshot = {
            savedAt: Date.now(),
            rooms: {},
        };
        for (const [code, room] of Object.entries(rooms)) {
            if (!room) continue;
            const persisted = stripRuntime(room);
            persisted.updatedAt = room.updatedAt || Date.now();
            snapshot.rooms[code] = persisted;
        }
        await fs.writeFile(TMP_FILE, JSON.stringify(snapshot));
        await fs.rename(TMP_FILE, ROOMS_FILE);
    } catch (e) {
        console.error('persistence: write failed:', e.message);
    } finally {
        writing = false;
        if (dirtyDuringWrite) {
            dirtyDuringWrite = false;
            schedulePersist(pendingRoomsRef);
        }
    }
}

function stripRuntime(room) {
    // socketByPlayer is recomputed from live sockets on hydrate.
    const { socketByPlayer, ...persisted } = room;
    return persisted;
}

module.exports = {
    loadRooms,
    schedulePersist,
    flush,
};
