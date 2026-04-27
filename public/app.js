/* ═══════════════════════════════════════════
   IMPOSTOR GAME — Client Application
   ═══════════════════════════════════════════ */

// ═══════════════════════════════════════════
//  PERSISTENT SESSION (localStorage)
// ═══════════════════════════════════════════
// Three-layer persistence so a refresh, tab restore, or cold load can put
// the player back into their game without having to re-type code/name:
//   1. A stable `playerId` that lives forever in localStorage and rides the
//      Socket.IO handshake `auth.playerId`. The server uses it as the
//      primary identity, so reconnects no longer need to remap socket ids.
//   2. Per-code rejoin tokens (long-lived; useful even after Leave Game).
//   3. A single "active session" pointer describing the room the player is
//      currently in. Combined with the ?join=CODE URL deep link, this lets
//      the page reload itself straight back into the active game.

const PLAYER_ID_KEY = 'imposter_player_id_v1';
const REJOIN_STORAGE_PREFIX = 'imposter_rejoin_';
const ACTIVE_SESSION_KEY = 'imposter_active_session_v1';

function safeLocalGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}
function safeLocalSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode / quota */ }
}
function safeLocalRemove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
}

function generateUuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
    }
    // Fallback for older browsers; not RFC4122 but unique enough as an
    // opaque identifier on the wire.
    return `pid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getOrCreatePlayerId() {
    const existing = safeLocalGet(PLAYER_ID_KEY);
    if (existing && typeof existing === 'string' && /^[A-Za-z0-9_\-]{1,128}$/.test(existing)) {
        return existing;
    }
    const fresh = generateUuid();
    safeLocalSet(PLAYER_ID_KEY, fresh);
    return fresh;
}

const myPlayerId = getOrCreatePlayerId();

// Configure Socket.IO to be more resilient on mobile networks. We allow both
// WebSocket and HTTP long-polling — some carrier proxies, captive portals and
// corporate networks block or downgrade WS, and falling back to polling lets
// the handshake still succeed (the client will silently upgrade to WS when
// possible). The stable playerId is sent in handshake auth on every (re)
// connect so the server can identify us without relying on socket.id.
const socket = io({
    auth: { playerId: myPlayerId },
    transports: ['websocket', 'polling'],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    timeout: 20000,
});

// ─── State ───
let myId = myPlayerId; // alias: the stable identity the server sees us as
let myName = '';
let myRejoinToken = null; // Cryptographic token; preferred over playerId match

function storedRejoinTokenForCode(code) {
    if (!code) return null;
    return safeLocalGet(REJOIN_STORAGE_PREFIX + code);
}

function persistRejoinToken(code, token) {
    if (!code || !token) return;
    safeLocalSet(REJOIN_STORAGE_PREFIX + code, token);
}

function readActiveSession() {
    const raw = safeLocalGet(ACTIVE_SESSION_KEY);
    if (!raw) return null;
    try {
        const obj = JSON.parse(raw);
        if (obj && typeof obj === 'object' && obj.code && obj.name) return obj;
    } catch { /* fall through */ }
    return null;
}

function writeActiveSession({ code, name, rejoinToken }) {
    if (!code || !name) return;
    const payload = { code, name };
    if (rejoinToken) payload.rejoinToken = rejoinToken;
    safeLocalSet(ACTIVE_SESSION_KEY, JSON.stringify(payload));
}

function clearActiveSession() {
    safeLocalRemove(ACTIVE_SESSION_KEY);
}

// ═══════════════════════════════════════════
//  URL DEEP LINK ( ?join=CODE )
// ═══════════════════════════════════════════
// Mirrors the reference implementation: while a player is in a room, the
// game code lives in the URL so any reload, deep-link share, or browser
// "restore tab" lands the player straight back into that room.

function readJoinCodeFromUrl() {
    try {
        const c = new URLSearchParams(location.search).get('join');
        if (!c) return null;
        return String(c).trim().replace(/\D/g, '').slice(0, 6) || null;
    } catch {
        return null;
    }
}

function setUrlJoinCode(code) {
    try {
        const url = new URL(location.href);
        if (code) url.searchParams.set('join', code);
        else url.searchParams.delete('join');
        history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
    } catch { /* ignore */ }
}

let roomData = null;
let isHost = false;
let myRole = null; // { isImpostor, word }
let hasVotedThisRound = false;
let selectedVoteTargetId = null;
/** Descriptions from the current round — used to show clues next to each name when voting. */
let lastEvidenceDescriptions = [];

// ─── DOM Refs ───
const screens = document.querySelectorAll('.screen');

// Login
const inputName = document.getElementById('input-name');
const inputCode = document.getElementById('input-code');
const btnCreate = document.getElementById('btn-create');
const btnJoin = document.getElementById('btn-join');
const loginError = document.getElementById('login-error');

// Lobby
const lobbyCode = document.getElementById('lobby-code');
const lobbyPlayers = document.getElementById('lobby-players');
const hostControls = document.getElementById('host-controls');
const btnStart = document.getElementById('btn-start');
const btnLeave = document.getElementById('btn-leave');

// Assignment
const assignContent = document.getElementById('assign-content');
const btnContinue = document.getElementById('btn-continue');

// Description
const inputDescription = document.getElementById('input-description');
const btnSubmitText = document.getElementById('btn-submit-text');
const submitStatus = document.getElementById('submit-status');
const describeHostActions = document.getElementById('describe-host-actions');
const btnForceAdvance = document.getElementById('btn-force-advance');

// Evidence
const evidenceWaiting = document.getElementById('evidence-waiting');
const evidenceDiscussion = document.getElementById('evidence-discussion');
const evidenceCounter = document.getElementById('evidence-counter');
const evidenceList = document.getElementById('evidence-list');
const discussionStatus = document.getElementById('discussion-status');
const votePanel = document.getElementById('vote-panel');
const btnOpenVoting = document.getElementById('btn-open-voting');
const btnResolveRound = document.getElementById('btn-resolve-round');
const btnFinishGame = document.getElementById('btn-finish-game');
const voteCandidates = document.getElementById('vote-candidates');
const btnSubmitVote = document.getElementById('btn-submit-vote');
const voteStatus = document.getElementById('vote-status');

// Reveal
const revealWord = document.getElementById('reveal-word');
const revealImpostor = document.getElementById('reveal-impostor');
const revealDescriptions = document.getElementById('reveal-descriptions');
const btnPlayAgain = document.getElementById('btn-play-again');

const toastEl = document.getElementById('toast');

// ─── XSS: Escape user content before inserting into HTML ───
function escapeHtml(str) {
    if (str == null || typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ─── Avatar Palette ───
const COLORS = [
    '#a855f7', '#f97316', '#22c55e', '#3b82f6',
    '#ec4899', '#14b8a6', '#eab308', '#ef4444',
    '#6366f1', '#06b6d4', '#8b5cf6', '#f43f5e',
];

function getAvatarColor(index) {
    return COLORS[index % COLORS.length];
}

function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('visible');
    clearTimeout(toastEl._hide);
    toastEl._hide = setTimeout(() => {
        toastEl.classList.remove('visible');
    }, 3000);
}

// ═══════════════════════════════════════════
//  CONNECTION STATUS PIP
// ═══════════════════════════════════════════
// Persistent visual indicator so players always know whether the live
// connection is healthy, retrying, or fully failed. Driven by the Socket.IO
// lifecycle handlers below.
const connectionStatusEl = document.getElementById('connection-status');
function setConnectionStatus(state, label) {
    if (!connectionStatusEl) return;
    connectionStatusEl.classList.remove('connected', 'connecting', 'failed', 'disconnected');
    connectionStatusEl.classList.add(state);
    if (label) connectionStatusEl.title = label;
    const labelEl = connectionStatusEl.querySelector('.connection-label');
    if (labelEl && label) labelEl.textContent = label;
}

// ═══════════════════════════════════════════
//  SCREEN NAVIGATION
// ═══════════════════════════════════════════

function showScreen(id) {
    screens.forEach(s => s.classList.remove('active'));
    const target = document.getElementById(id);
    target.classList.add('active');
    // Re-trigger fade-in
    const card = target.querySelector('.card');
    if (card) {
        card.classList.remove('fade-in');
        void card.offsetWidth; // reflow
        card.classList.add('fade-in');
    }
}

// ═══════════════════════════════════════════
//  LOGIN SCREEN
// ═══════════════════════════════════════════

btnCreate.addEventListener('click', () => {
    const name = inputName.value.trim();
    if (!name) { showError('Please enter your name.'); return; }
    myName = name;
    socket.emit('create-room', { name });
});

btnJoin.addEventListener('click', () => {
    const name = inputName.value.trim();
    const code = inputCode.value.trim().replace(/\D/g, '');
    if (!name) { showError('Please enter your name.'); return; }
    if (!/^\d{6}$/.test(code)) { showError('Enter the 6-digit game code.'); return; }
    myName = name;
    const storedToken = storedRejoinTokenForCode(code);
    socket.emit('join-room', { code, name, rejoinToken: myRejoinToken || storedToken || undefined }, (res) => {
        if (res.error) {
            showError(res.error);
            return;
        }
        if (res.rejoinToken) {
            myRejoinToken = res.rejoinToken;
            persistRejoinToken(code, res.rejoinToken);
        }
        // Persist this session and bake the code into the URL so a refresh,
        // tab restore, or shared link puts the player straight back here.
        writeActiveSession({ code, name, rejoinToken: res.rejoinToken || myRejoinToken });
        setUrlJoinCode(code);
        if (res.rejoined) {
            loginError.textContent = '';
            showToast('Reconnecting...');
        }
    });
});

inputName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnCreate.focus();
});

inputCode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnJoin.click();
});

function showError(msg) {
    loginError.textContent = msg;
    loginError.style.animation = 'none';
    void loginError.offsetWidth;
    loginError.style.animation = 'fadeSlideUp 0.3s ease';
}

// ═══════════════════════════════════════════
//  LOBBY SCREEN
// ═══════════════════════════════════════════

btnLeave.addEventListener('click', () => {
    // Explicit "Leave" — drop the persistent session so we don't auto-rejoin
    // the same room on the next load, and clear the deep-link query string.
    clearActiveSession();
    setUrlJoinCode(null);
    location.href = location.pathname;
});

btnStart.addEventListener('click', () => {
    socket.emit('start-game');
});

function renderLobby(data) {
    lobbyCode.textContent = data.code;
    lobbyPlayers.innerHTML = '';
    isHost = data.hostId === myId;

    data.players.forEach((p, i) => {
        const li = document.createElement('li');
        li.style.animationDelay = `${i * 0.06}s`;
        const safeName = escapeHtml(p.name);
        const initial = escapeHtml((p.name || '').charAt(0).toUpperCase()) || '?';
        const isDisconnected = p.connected === false;
        if (isDisconnected) li.classList.add('player-disconnected');
        const showKick = isHost && p.id !== myId;
        const kickBtn = showKick
            ? `<button class="btn-kick" data-player-id="${escapeHtml(p.id)}" aria-label="Remove ${safeName}" title="Remove ${safeName}">✕</button>`
            : '';
        const offlineBadge = isDisconnected ? '<span class="offline-badge">offline</span>' : '';
        li.innerHTML = `
      <span class="player-avatar" style="background:${getAvatarColor(i)}">${initial}</span>
      <span class="player-name">${safeName}</span>
      ${p.id === data.hostId ? '<span class="host-badge">Host</span>' : ''}
      ${offlineBadge}
      ${kickBtn}
    `;
        lobbyPlayers.appendChild(li);
    });

    hostControls.style.display = isHost ? 'flex' : 'none';
}

// Event delegation: a single click handler on the lobby list dispatches kicks
// regardless of how many times we re-render the player rows.
if (lobbyPlayers) {
    lobbyPlayers.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-kick');
        if (!btn) return;
        const targetId = btn.dataset.playerId;
        if (!targetId || !isHost) return;
        const target = (roomData && roomData.players || []).find(p => p.id === targetId);
        const targetName = target ? target.name : 'this player';
        if (!confirm(`Remove ${targetName} from the room? They'll be returned to the login screen.`)) return;
        socket.emit('kick-player', { playerId: targetId });
    });
}

// ═══════════════════════════════════════════
//  ASSIGNMENT SCREEN
// ═══════════════════════════════════════════

function showAssignment(role) {
    myRole = role;
    const isExtraRound = (role.round || 1) > 1;
    // Same copy and styling for everyone so the imposter cannot tell from the UI.
    assignContent.innerHTML = `
      <p class="role-label">${isExtraRound ? 'Same word — add another clue!' : 'The secret word is'}</p>
      <div class="word-display civilian">${escapeHtml(role.word || '')}</div>
      <p class="hint">${isExtraRound ? 'Give one more descriptive clue.' : 'Describe it without being too obvious!'}</p>
    `;

    btnContinue.disabled = true;
    showScreen('screen-assignment');

    // 3-second reading delay
    setTimeout(() => { btnContinue.disabled = false; }, 3000);
}

btnContinue.addEventListener('click', () => {
    socket.emit('continue-to-describe');
    showScreen('screen-describe');
    submitStatus.textContent = '';
});

// ═══════════════════════════════════════════
//  DESCRIPTION SCREEN
// ═══════════════════════════════════════════

// ─── Text Submit ───
btnSubmitText.addEventListener('click', () => {
    const desc = inputDescription.value.trim();
    if (!desc) return;
    socket.emit('submit-description', { type: 'text', data: desc });
    btnSubmitText.disabled = true;
    btnSubmitText.textContent = 'Submitted ✓';
    inputDescription.disabled = true;
});

// ─── Host: Force-start discussion ───
// Lets the host unstick a round when one or more players are disconnected
// or unable to submit, instead of forcing a full game restart.
if (btnForceAdvance) {
    btnForceAdvance.addEventListener('click', () => {
        if (!isHost) return;
        const submitted = (roomData && roomData.submittedCount) || 0;
        const total = (roomData && roomData.totalCount) || 0;
        const remaining = Math.max(0, total - submitted);
        const msg = remaining > 0
            ? `Force start discussion now? ${remaining} player(s) haven't submitted — they'll be skipped.`
            : 'Force start discussion now?';
        if (!confirm(msg)) return;
        socket.emit('force-advance-to-discussion');
    });
}

function updateDescribeHostControls() {
    if (!describeHostActions || !btnForceAdvance) return;
    const inDescribe = roomData && roomData.gameState === 'description';
    if (!isHost || !inDescribe) {
        describeHostActions.style.display = 'none';
        return;
    }
    describeHostActions.style.display = 'flex';
    const submitted = roomData.submittedCount || 0;
    const total = roomData.totalCount || 0;
    btnForceAdvance.textContent = `Force Start Discussion (${submitted} / ${total} submitted)`;
}

// ═══════════════════════════════════════════
//  EVIDENCE BOARD
// ═══════════════════════════════════════════

function showEvidenceWaiting(data) {
    showScreen('screen-evidence');
    evidenceWaiting.style.display = 'flex';
    evidenceDiscussion.style.display = 'none';
    updateCounter(data);
}

function updateCounter(data) {
    evidenceCounter.textContent = `${data.submittedCount} / ${data.totalCount}`;
}

// Render the evidence/voting screen. The same screen serves both the
// "discussion" phase (clues only, no voting) and the "vote" phase (voting
// panel visible). The host advances between them with the explicit Open
// Voting / Resolve Round / Force Reveal controls below.
function showEvidenceDiscussion(descriptions, options) {
    evidenceWaiting.style.display = 'none';
    evidenceDiscussion.style.display = 'flex';
    showScreen('screen-evidence');

    lastEvidenceDescriptions = descriptions || [];
    renderEvidenceList(lastEvidenceDescriptions);

    const opts = options || {};
    if (opts.hasVoted != null) hasVotedThisRound = !!opts.hasVoted;

    updateEvidenceControls();
}

function groupDescriptionsByPlayer(descriptions) {
    const byPlayer = new Map();
    (descriptions || []).forEach((d) => {
        const key = d.playerId;
        if (!byPlayer.has(key)) {
            byPlayer.set(key, { name: d.playerName, items: [] });
        }
        byPlayer.get(key).items.push({ type: d.type, data: d.data });
    });
    return byPlayer;
}

function renderEvidenceList(descriptions) {
    const byPlayer = groupDescriptionsByPlayer(descriptions);

    evidenceList.innerHTML = '';
    let rowIndex = 0;
    byPlayer.forEach(({ name, items }) => {
        const parts = items.map((item) => escapeHtml(String(item.data)));
        const li = document.createElement('li');
        li.style.animationDelay = `${rowIndex * 0.08}s`;
        li.innerHTML = `<span class="ev-content"><strong>${escapeHtml(name)}</strong> — ${parts.join(', ')}</span>`;
        evidenceList.appendChild(li);
        rowIndex++;
    });
}

function populateVoteCandidates(descriptions) {
    if (!voteCandidates || !roomData || !roomData.players) return;

    const byPlayer = groupDescriptionsByPlayer(descriptions);
    voteCandidates.innerHTML = '';

    roomData.players.forEach((p, i) => {
        const entry = byPlayer.get(p.id);
        const cluesHtml = entry && entry.items.length
            ? entry.items.map((item) => escapeHtml(String(item.data))).join(', ')
            : '<span class="vote-candidate-empty">No clues yet</span>';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vote-candidate';
        btn.dataset.playerId = p.id;
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', 'false');
        btn.style.animationDelay = `${i * 0.05}s`;
        btn.innerHTML = `
      <span class="vote-candidate-main">
        <span class="vote-candidate-name">${escapeHtml(p.name)}</span>
        <span class="vote-candidate-clues">${cluesHtml}</span>
      </span>
    `;
        btn.addEventListener('click', () => selectVoteCandidate(p.id));
        voteCandidates.appendChild(btn);
    });

    syncVoteSelectionUI();
}

function selectVoteCandidate(playerId) {
    if (!roomData || roomData.gameState !== 'vote') return;
    selectedVoteTargetId = playerId;
    syncVoteSelectionUI();
}

function syncVoteSelectionUI() {
    if (!voteCandidates) return;
    voteCandidates.querySelectorAll('.vote-candidate').forEach((el) => {
        const id = el.dataset.playerId;
        const on = id === selectedVoteTargetId;
        el.classList.toggle('selected', on);
        el.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    if (btnSubmitVote) {
        btnSubmitVote.disabled = !selectedVoteTargetId;
    }
}

// Sync the evidence screen's vote panel + host controls to the current room
// state. Called on entry and on every room-update while the screen is open.
function updateEvidenceControls() {
    if (!roomData) return;
    const state = roomData.gameState;
    const isVote = state === 'vote';
    const isDiscussion = state === 'discussion';

    if (votePanel) votePanel.style.display = isVote ? 'flex' : 'none';
    // During voting, the selectable cards include names + clues — hide the
    // duplicate read-only list above to avoid repeating the same text twice.
    if (evidenceList) evidenceList.style.display = isVote ? 'none' : '';

    if (discussionStatus) {
        if (isDiscussion) {
            discussionStatus.textContent = isHost
                ? 'Discuss the clues with your group. Tap Open Voting when ready.'
                : 'Discuss the clues with your group. The host will open voting when ready.';
            discussionStatus.style.display = '';
        } else if (isVote) {
            const voted = roomData.votedCount || 0;
            const total = roomData.totalCount || 0;
            discussionStatus.textContent = `Voting — ${voted} / ${total} voted`;
            discussionStatus.style.display = '';
        } else {
            discussionStatus.style.display = 'none';
        }
    }

    if (isVote) {
        populateVoteCandidates(lastEvidenceDescriptions);
        voteStatus.textContent = hasVotedThisRound
            ? 'Vote submitted. You can change your pick until the round resolves.'
            : '';
    }

    if (btnOpenVoting) btnOpenVoting.style.display = (isHost && isDiscussion) ? 'inline-flex' : 'none';
    if (btnResolveRound) {
        btnResolveRound.style.display = (isHost && isVote) ? 'inline-flex' : 'none';
        if (isHost && isVote) {
            const voted = roomData.votedCount || 0;
            const total = roomData.totalCount || 0;
            btnResolveRound.textContent = `Resolve Round (${voted} / ${total} voted)`;
        }
    }
    if (btnFinishGame) btnFinishGame.style.display = (isHost && (isDiscussion || isVote)) ? 'inline-flex' : 'none';
}

if (btnOpenVoting) {
    btnOpenVoting.addEventListener('click', () => {
        if (!isHost) return;
        socket.emit('open-voting');
    });
}

if (btnResolveRound) {
    btnResolveRound.addEventListener('click', () => {
        if (!isHost) return;
        const voted = (roomData && roomData.votedCount) || 0;
        const total = (roomData && roomData.totalCount) || 0;
        const remaining = Math.max(0, total - voted);
        const msg = remaining > 0
            ? `Resolve voting now? ${remaining} player(s) haven't voted — their votes will be skipped.`
            : 'Resolve voting now?';
        if (!confirm(msg)) return;
        socket.emit('resolve-round');
    });
}

btnFinishGame.addEventListener('click', () => {
    if (!isHost) return;
    if (!confirm('Reveal the impostor now? This skips voting and ends the game.')) return;
    socket.emit('finish-game');
});

btnSubmitVote.addEventListener('click', () => {
    if (!selectedVoteTargetId) return;
    if (!roomData || roomData.gameState !== 'vote') return;
    socket.emit('cast-vote', { targetId: selectedVoteTargetId });
    hasVotedThisRound = true;
    voteStatus.textContent = 'Vote submitted. You can change your pick until the round resolves.';
});

// ═══════════════════════════════════════════
//  REVEAL SCREEN
// ═══════════════════════════════════════════

function showReveal(data) {
    showScreen('screen-reveal');

    revealWord.textContent = data.word || '';
    revealImpostor.textContent = data.impostor?.name || '';

    // Group descriptions by player (one line per player, impostor row highlighted)
    const byPlayerReveal = new Map();
    data.descriptions.forEach((d) => {
        const key = d.playerId;
        if (!byPlayerReveal.has(key)) {
            byPlayerReveal.set(key, { name: d.playerName, items: [] });
        }
        byPlayerReveal.get(key).items.push({ type: d.type, data: d.data });
    });

    revealDescriptions.innerHTML = '';
    let revIndex = 0;
    byPlayerReveal.forEach(({ name, items }, playerId) => {
        const parts = items.map((item) => escapeHtml(String(item.data)));
        const li = document.createElement('li');
        li.style.animationDelay = `${revIndex * 0.08}s`;
        if (playerId === data.impostor.id) {
            li.classList.add('impostor-highlight');
        }
        li.innerHTML = `<span class="ev-content"><strong>${escapeHtml(name)}</strong> — ${parts.join(', ')}</span>`;
        revealDescriptions.appendChild(li);
        revIndex++;
    });

    btnPlayAgain.style.display = isHost ? 'inline-flex' : 'none';
}

btnPlayAgain.addEventListener('click', () => {
    socket.emit('play-again');
});

// ═══════════════════════════════════════════
//  SOCKET EVENT HANDLERS
// ═══════════════════════════════════════════

// On the very first connect after a cold load (refresh, tab restore, shared
// link), use the URL ?join=CODE deep link plus any persisted localStorage
// session to walk straight back into the active room. Subsequent reconnects
// are handled by the dedicated 'reconnect' handler below.
let initialAutoRejoinAttempted = false;
function attemptInitialAutoRejoin() {
    const urlCode = readJoinCodeFromUrl();
    if (!urlCode) return; // No deep link → stay on the login screen.

    const session = readActiveSession();
    if (!session || session.code !== urlCode || !session.name) {
        // Deep link without a matching local session: prefill the code so the
        // user only has to type their name. Do NOT auto-rejoin under another
        // identity — that would let strangers reuse the link by guessing.
        if (inputCode) inputCode.value = urlCode;
        return;
    }

    myName = session.name;
    if (session.rejoinToken) myRejoinToken = session.rejoinToken;

    socket.emit('join-room', {
        code: urlCode,
        name: session.name,
        rejoinToken: session.rejoinToken || undefined,
    }, (res) => {
        if (!res || res.error) {
            // Stale session (server restarted, room expired, etc.) — wipe it,
            // strip the URL, and fall back to the login screen quietly.
            clearActiveSession();
            setUrlJoinCode(null);
            if (inputCode) inputCode.value = urlCode;
            if (res && res.error) showError(res.error);
            return;
        }
        if (res.rejoinToken) {
            myRejoinToken = res.rejoinToken;
            persistRejoinToken(urlCode, res.rejoinToken);
            writeActiveSession({ code: urlCode, name: session.name, rejoinToken: res.rejoinToken });
        }
        showToast('Welcome back!');
    });
}

socket.on('connect', () => {
    setConnectionStatus('connected', 'Connected');
    if (!initialAutoRejoinAttempted) {
        initialAutoRejoinAttempted = true;
        attemptInitialAutoRejoin();
    }
});

// Connection lifecycle handlers to make temporary network drops feel smoother,
// especially on mobile devices where the OS may briefly suspend networking.
socket.on('connect_error', () => {
    setConnectionStatus('connecting', 'Connection problem — retrying...');
    showToast('Connection problem — trying to reconnect...');
});

socket.on('reconnect_attempt', () => {
    setConnectionStatus('connecting', 'Reconnecting to game...');
    showToast('Reconnecting to game...');
});

socket.on('reconnect', () => {
    setConnectionStatus('connected', 'Reconnected');
    showToast('Reconnected — restoring your game...');

    // If we already know the room and player name, attempt to rejoin
    // automatically so the server can send us the appropriate rejoin state.
    if (roomData && roomData.code && myName) {
        const storedToken = storedRejoinTokenForCode(roomData.code);
        socket.emit('join-room', { code: roomData.code, name: myName, rejoinToken: myRejoinToken || storedToken || undefined }, () => {
            // The server will either emit a fresh room-update or a rejoin-state
            // event which our existing handlers already understand.
        });
    }
});

socket.on('reconnect_failed', () => {
    setConnectionStatus('failed', 'Unable to reconnect — refresh to retry.');
    showError('Unable to reconnect. Please refresh or rejoin.');
});

socket.on('kicked', () => {
    // The host removed us from the room. Wipe any persisted session so we
    // don't auto-rejoin the room we were just removed from, and bounce back
    // to the login screen with a clear message.
    clearActiveSession();
    setUrlJoinCode(null);
    if (roomData && roomData.code) {
        safeLocalRemove(REJOIN_STORAGE_PREFIX + roomData.code);
    }
    myRejoinToken = null;
    roomData = null;
    isHost = false;
    showScreen('screen-login');
    showError('You were removed from the room by the host.');
});

function applyRejoinState(data) {
    const gs = data.gameState;
    if (gs === 'lobby') {
        showScreen('screen-lobby');
        return;
    }
    if (gs === 'assignment' && data.role) {
        showAssignment(data.role);
        return;
    }
    if (gs === 'description' && data.role) {
        myRole = data.role;
        showScreen('screen-describe');
        submitStatus.textContent = roomData ? `${roomData.submittedCount} / ${roomData.totalCount} Submitted` : '';
        if (data.hasSubmitted) {
            btnSubmitText.disabled = true;
            btnSubmitText.textContent = 'Submitted ✓';
            inputDescription.disabled = true;
        } else {
            btnSubmitText.disabled = false;
            btnSubmitText.textContent = 'Submit';
            inputDescription.disabled = false;
            inputDescription.value = '';
        }
        return;
    }
    if (gs === 'discussion' || gs === 'vote') {
        showEvidenceDiscussion(data.descriptions || [], { hasVoted: data.hasVoted });
        return;
    }
    if (gs === 'reveal' && data.reveal) {
        showReveal(data.reveal);
    }
}

socket.on('rejoin-state', (data) => {
    applyRejoinState(data);
    showToast('Reconnected — you can continue.');
});

socket.on('room-created', ({ code, rejoinToken }) => {
    myRejoinToken = rejoinToken || null;
    if (rejoinToken) persistRejoinToken(code, rejoinToken);
    // Persist this session and add ?join=CODE to the URL so a refresh while
    // hosting takes the host straight back into the room.
    writeActiveSession({ code, name: myName, rejoinToken: rejoinToken || null });
    setUrlJoinCode(code);
    showScreen('screen-lobby');
});

socket.on('room-update', (data) => {
    roomData = data;
    isHost = data.hostId === myId;

    // Keep the URL / persisted session in sync with the room we're actually
    // in. This covers the case where the player joined indirectly (rejoin,
    // auto-rejoin) and we never hit the join button explicitly.
    if (data && data.code) {
        setUrlJoinCode(data.code);
        if (myName) {
            writeActiveSession({ code: data.code, name: myName, rejoinToken: myRejoinToken });
        }
    }

    if (data.gameState === 'lobby') {
        renderLobby(data);
        // Ensure we're on lobby screen when in lobby state (for join and play-again)
        const currentScreen = document.querySelector('.screen.active');
        if (currentScreen && currentScreen.id === 'screen-login') {
            showScreen('screen-lobby');
        }
    }

    // Update submission counter during description phase
    if (data.gameState === 'description') {
        submitStatus.textContent = `${data.submittedCount} / ${data.totalCount} Submitted`;
    }

    // Refresh host-only override controls (force-advance button text, etc.)
    updateDescribeHostControls();

    // Refresh evidence/voting controls if we're already on that screen so
    // hosts immediately see the right action button after a state transition.
    if (data.gameState === 'discussion' || data.gameState === 'vote') {
        const currentScreen = document.querySelector('.screen.active');
        if (currentScreen && currentScreen.id === 'screen-evidence') {
            updateEvidenceControls();
        }
    }
});

socket.on('game-started', (role) => {
    // Reset description UI for a fresh round
    btnSubmitText.disabled = false;
    btnSubmitText.textContent = 'Submit';
    inputDescription.disabled = false;
    inputDescription.value = '';
    submitStatus.textContent = '';
    hasVotedThisRound = false;
    selectedVoteTargetId = null;

    showAssignment(role);
});

socket.on('all-submitted', ({ descriptions }) => {
    hasVotedThisRound = false;
    selectedVoteTargetId = null;
    showEvidenceDiscussion(descriptions);
});

socket.on('voting-opened', () => {
    // Voting was just opened by the host. Clear any per-player vote UI state
    // so players can submit a fresh vote for this round.
    hasVotedThisRound = false;
    selectedVoteTargetId = null;
    if (voteStatus) voteStatus.textContent = '';
    updateEvidenceControls();
});

socket.on('reveal', (data) => {
    showReveal(data);
});

socket.on('back-to-lobby', () => {
    // Reset local state (keep myRejoinToken for rejoin)
    myRole = null;
    hasVotedThisRound = false;
    selectedVoteTargetId = null;

    // Reset UI elements
    btnSubmitText.disabled = false;
    btnSubmitText.textContent = 'Submit';
    inputDescription.disabled = false;
    inputDescription.value = '';

    showScreen('screen-lobby');
});

socket.on('error-msg', (msg) => {
    showError(msg);
});

socket.on('disconnect', (reason) => {
    // For temporary network drops, keep the user on their current screen and
    // let the automatic reconnection logic above handle recovery.
    if (reason !== 'io client disconnect') {
        setConnectionStatus('connecting', 'Disconnected — reconnecting...');
        showToast('Disconnected — attempting to reconnect...');
    } else {
        setConnectionStatus('disconnected', 'Disconnected');
    }
});

// ═══════════════════════════════════════════
//  AGGRESSIVE WAKE / NETWORK RECOVERY
// ═══════════════════════════════════════════
// Mobile devices often suspend networking when the screen is locked or the
// tab is backgrounded. Once Socket.IO's pingTimeout (60s by default on the
// server) is exceeded, the socket is killed and we then have to wait for the
// next reconnection backoff tick before trying again. These listeners nudge
// Socket.IO to reconnect immediately the instant the device wakes up or the
// network comes back, so the user doesn't see a long "reconnecting..." gap.

function nudgeReconnect() {
    if (!socket.connected) {
        try { socket.connect(); } catch { /* socket.io handles bad calls */ }
    }
}

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) nudgeReconnect();
});

window.addEventListener('online', () => {
    showToast('Network back online — reconnecting...');
    nudgeReconnect();
});

window.addEventListener('focus', nudgeReconnect);

// On iOS/Android the back-forward cache can restore the page from memory; the
// `pageshow` event fires with `persisted=true` in that case and we need to
// re-establish the socket because the underlying TCP/WS connection is gone.
window.addEventListener('pageshow', (e) => {
    if (e.persisted) nudgeReconnect();
});
