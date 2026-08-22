/* ═══════════════════════════════════════════
   IMPOSTOR GAME — Client Application

   Architecture note (read before editing):

   This client holds NO game state of its own. The server sends whole,
   self-contained snapshots (`state` events) stamped with a monotonic `v`, and
   everything on screen is derived from the latest one by render(). There is no
   event replay to get wrong, so a phone that slept through three phase changes
   redraws correctly from the first snapshot it receives on waking.

   The only local state is genuinely ephemeral UI: which vote candidate is
   tapped-but-not-submitted, what is typed in the clue box, whether the QR is
   enlarged. Anything the server knows about is read from `S`, never cached.

   Actions go out through an acked outbox with retry + idempotency nonces, so
   the UI never claims something landed before the server confirms it.
   ═══════════════════════════════════════════ */

// Must match game.js PROTOCOL. A mismatch means this page is a stale build.
const PROTOCOL = 3;

// ═══════════════════════════════════════════
//  PERSISTENT SESSION (localStorage)
// ═══════════════════════════════════════════
//   1. A stable `playerId` that lives forever and rides the Socket.IO
//      handshake. The server uses it as primary identity, which is what lets a
//      reconnecting socket be resumed without the client saying anything.
//   2. Per-code rejoin tokens (long-lived).
//   3. An "active session" pointer, combined with the ?join=CODE deep link, so
//      a cold load walks straight back into the game.

const PLAYER_ID_KEY = 'imposter_player_id_v1';
const REJOIN_STORAGE_PREFIX = 'imposter_rejoin_';
const ACTIVE_SESSION_KEY = 'imposter_active_session_v1';
const RELOAD_GUARD_KEY = 'imposter_protocol_reload';

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
    return `pid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getOrCreatePlayerId() {
    const existing = safeLocalGet(PLAYER_ID_KEY);
    if (existing && /^[A-Za-z0-9_\-]{1,128}$/.test(existing)) return existing;
    const fresh = generateUuid();
    safeLocalSet(PLAYER_ID_KEY, fresh);
    return fresh;
}

const myPlayerId = getOrCreatePlayerId();

function storedRejoinTokenForCode(code) {
    if (!code) return null;
    return safeLocalGet(REJOIN_STORAGE_PREFIX + code);
}

// The object handed to io() as `auth`. Socket.IO re-sends it on every
// reconnection, so mutating it in place is what lets a token obtained after
// page load reach the next handshake — and therefore be auto-resumed.
// Declared here (rather than reaching for `socket.auth` later) because the
// helpers below run before `socket` is initialised, and touching a const in its
// temporal dead zone throws even under typeof.
const handshakeAuth = {
    playerId: myPlayerId,
    rejoinToken: undefined,
};

function setCredential(token) {
    handshakeAuth.rejoinToken = token || undefined;
}

function persistRejoinToken(code, token) {
    if (!code || !token) return;
    safeLocalSet(REJOIN_STORAGE_PREFIX + code, token);
    setCredential(token);
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
//  SOCKET
// ═══════════════════════════════════════════
// Polling is kept in the transport list on purpose: some carrier proxies and
// captive portals block or downgrade WebSocket, and being able to fall back
// means the handshake still succeeds (it silently upgrades when it can).
// The handshake carries two different things. `playerId` is a public label — it
// appears in every snapshot so players can be voted for and kicked, and it
// proves nothing. `rejoinToken` is the credential: it never appears in a
// snapshot, so only we have it, and the server requires it before putting us
// back into a seat. Keeping them distinct is what stops another player reading
// our id off their own screen and reconnecting as us.
const bootSession = readActiveSession() || {};
setCredential(bootSession.rejoinToken
    || (bootSession.code ? storedRejoinTokenForCode(bootSession.code) : null));

const socket = io({
    auth: handshakeAuth,
    transports: ['websocket', 'polling'],
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    timeout: 20000,
});

// ═══════════════════════════════════════════
//  AUTHORITATIVE STATE
// ═══════════════════════════════════════════

let S = null;            // latest snapshot — the single source of truth
let lastV = -1;
let lastCode = null;
let myRejoinToken = null;
let myName = '';

// ─── Ephemeral UI state (deliberately not derived from S) ───
let voteSelection = null;      // tapped, not yet submitted
let uiPhaseKey = null;         // `${phase}:${round}` — for "just entered" detection
let continueUnlockAt = 0;      // role-card reading delay
let continueTimer = null;

// ═══════════════════════════════════════════
//  URL DEEP LINK ( ?join=CODE )
// ═══════════════════════════════════════════

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

// ─── DOM Refs ───
const screens = document.querySelectorAll('.screen');

const inputName = document.getElementById('input-name');
const inputCode = document.getElementById('input-code');
const btnCreate = document.getElementById('btn-create');
const btnJoin = document.getElementById('btn-join');
const loginError = document.getElementById('login-error');

const lobbyCode = document.getElementById('lobby-code');
const lobbyPlayers = document.getElementById('lobby-players');
const hostControls = document.getElementById('host-controls');
const btnStart = document.getElementById('btn-start');
const btnLeave = document.getElementById('btn-leave');
const lobbyQr = document.getElementById('lobby-qr');
const lobbyQrImg = document.getElementById('lobby-qr-img');

const assignContent = document.getElementById('assign-content');
const btnContinue = document.getElementById('btn-continue');

const inputDescription = document.getElementById('input-description');
const btnSubmitText = document.getElementById('btn-submit-text');
const submitStatus = document.getElementById('submit-status');
const describeHostActions = document.getElementById('describe-host-actions');
const btnForceAdvance = document.getElementById('btn-force-advance');

const evidenceWaiting = document.getElementById('evidence-waiting');
const evidenceDiscussion = document.getElementById('evidence-discussion');
const evidenceList = document.getElementById('evidence-list');
const discussionStatus = document.getElementById('discussion-status');
const votePanel = document.getElementById('vote-panel');
const btnOpenVoting = document.getElementById('btn-open-voting');
const btnResolveRound = document.getElementById('btn-resolve-round');
const btnFinishGame = document.getElementById('btn-finish-game');
const voteCandidates = document.getElementById('vote-candidates');
const btnSubmitVote = document.getElementById('btn-submit-vote');
const voteStatus = document.getElementById('vote-status');

const revealWord = document.getElementById('reveal-word');
const revealImpostor = document.getElementById('reveal-impostor');
const revealDescriptions = document.getElementById('reveal-descriptions');
const btnPlayAgain = document.getElementById('btn-play-again');

const toastEl = document.getElementById('toast');

// ─── XSS: escape user content before inserting into HTML ───
function escapeHtml(str) {
    if (str == null || typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

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
    toastEl._hide = setTimeout(() => toastEl.classList.remove('visible'), 3000);
}

function showError(msg) {
    if (!loginError) return;
    loginError.textContent = msg;
    loginError.style.animation = 'none';
    void loginError.offsetWidth;
    loginError.style.animation = 'fadeSlideUp 0.3s ease';
}

/**
 * Surface a problem wherever the player is currently looking. The login screen
 * has a dedicated error slot; everywhere else a toast is the only thing they'll
 * actually see.
 */
function reportProblem(msg) {
    if (!msg) return;
    if (!S) showError(msg);
    else showToast(msg);
}

// ─── Connection status pip ───
const connectionStatusEl = document.getElementById('connection-status');
function setConnectionStatus(state, label) {
    if (!connectionStatusEl) return;
    connectionStatusEl.classList.remove('connected', 'connecting', 'failed', 'disconnected');
    connectionStatusEl.classList.add(state);
    if (label) connectionStatusEl.title = label;
    const labelEl = connectionStatusEl.querySelector('.connection-label');
    if (labelEl && label) labelEl.textContent = label;
}

// ─── Rebuild a list only when its contents actually changed ───
// Snapshots arrive whenever anything moves (including presence ageing), and
// blowing away innerHTML every time would restart every CSS entry animation and
// drop the pressed state off whatever the player was touching.
function renderIfChanged(el, sig, build) {
    if (!el) return false;
    if (el.dataset.sig === sig) return false;
    el.dataset.sig = sig;
    el.innerHTML = '';
    build();
    return true;
}

function showScreen(id) {
    const target = document.getElementById(id);
    if (!target || target.classList.contains('active')) return;
    screens.forEach(s => s.classList.remove('active'));
    target.classList.add('active');
    const card = target.querySelector('.card');
    if (card) {
        card.classList.remove('fade-in');
        void card.offsetWidth; // reflow
        card.classList.add('fade-in');
    }
}

// ═══════════════════════════════════════════
//  OUTBOX — acked actions with retry + idempotency
// ═══════════════════════════════════════════
// Every mutating command goes through here. Each carries a nonce so a retry is
// a no-op server-side, which means we can retry freely without risking a
// double-submitted clue. Nothing is reported to the player as done until the
// server acks it — the old client optimistically printed "Vote submitted" and
// could be flatly wrong about it.

const ACTION_TIMEOUT_MS = 8000;
const OUTBOX_RETRY_MS = 2000;
const MAX_TRIES = 6;

let outbox = [];

function newNonce() {
    return generateUuid().replace(/-/g, '').slice(0, 32);
}

/** Types currently awaiting an ack — used to show "sending…" affordances. */
function pending(type) {
    return outbox.some(i => i.type === type);
}

function sendAction(type, payload) {
    outbox.push({ nonce: newNonce(), type, payload: payload || {}, tries: 0, inFlight: false });
    render();
    flushOutbox();
}

function settleAction(item, res) {
    const idx = outbox.indexOf(item);

    // No ack at all (timeout, or dropped while the socket died): keep it queued.
    if (!res) {
        item.inFlight = false;
        if (item.tries >= MAX_TRIES) {
            if (idx !== -1) outbox.splice(idx, 1);
            reportProblem('Could not reach the game. Please try that again.');
            render();
        }
        return;
    }

    // The server doesn't know us yet (fresh socket mid-rejoin). Re-announce and
    // let the retry loop have another go.
    if (res.code === 'NO_ROOM') {
        item.inFlight = false;
        resyncAfterReconnect();
        if (item.tries >= MAX_TRIES) {
            if (idx !== -1) outbox.splice(idx, 1);
            reportProblem('Lost your place in the game. Try rejoining.');
            render();
        }
        return;
    }

    if (idx !== -1) outbox.splice(idx, 1);

    // ALREADY_SUBMITTED is the idempotent outcome of a retry that actually did
    // land the first time — not something to bother the player about.
    if (!res.ok && res.code !== 'ALREADY_SUBMITTED') {
        reportProblem(res.error || 'That did not work.');
    }
    render();
}

function flushOutbox() {
    if (!socket.connected) return;
    for (const item of outbox.slice()) {
        if (item.inFlight) continue;
        item.inFlight = true;
        item.tries++;
        const payload = Object.assign({ type: item.type, nonce: item.nonce }, item.payload);
        socket.timeout(ACTION_TIMEOUT_MS).emit('action', payload, (err, res) => {
            settleAction(item, err ? null : res);
        });
    }
}

setInterval(() => { if (outbox.length) flushOutbox(); }, OUTBOX_RETRY_MS);

// ═══════════════════════════════════════════
//  RENDER
// ═══════════════════════════════════════════

function screenFor(snap) {
    switch (snap.phase) {
        case 'lobby': return 'screen-lobby';
        case 'assignment': return 'screen-assignment';
        case 'description':
            // Don't yank someone off their word before they've acknowledged it,
            // even though the room has already moved on.
            return (snap.you && snap.you.hasContinued) ? 'screen-describe' : 'screen-assignment';
        case 'discussion':
        case 'vote': return 'screen-evidence';
        case 'reveal': return 'screen-reveal';
        default: return 'screen-lobby';
    }
}

function render() {
    if (!S || !S.you) return;

    const key = `${S.phase}:${S.round}`;
    if (key !== uiPhaseKey) {
        uiPhaseKey = key;
        onEnterPhase();
    }

    showScreen(screenFor(S));

    switch (S.phase) {
        case 'lobby': renderLobby(); break;
        case 'assignment': renderAssignment(); break;
        case 'description':
            if (S.you.hasContinued) renderDescribe(); else renderAssignment();
            break;
        case 'discussion':
        case 'vote': renderEvidence(); break;
        case 'reveal': renderReveal(); break;
    }
}

/** Reset the ephemeral bits that belong to a specific phase+round. */
function onEnterPhase() {
    voteSelection = null;
    if (inputDescription) {
        inputDescription.value = '';
        inputDescription.disabled = false;
    }
    if (voteStatus) voteStatus.textContent = '';

    if (S.phase === 'assignment' || S.phase === 'description') {
        // Three-second beat so nobody can speed-tap past their own word.
        continueUnlockAt = Date.now() + 3000;
        clearTimeout(continueTimer);
        continueTimer = setTimeout(render, 3050);
    }
}

// ─── Lobby ───

function presenceBadge(p) {
    if (p.presence === 'offline') return '<span class="offline-badge">offline</span>';
    if (p.presence === 'away') return '<span class="away-badge">away</span>';
    return '';
}

function renderLobby() {
    lobbyCode.textContent = S.code;
    updateLobbyQr(S.code);

    const sig = S.players.map(p => `${p.id}:${p.name}:${p.presence}:${p.isHost}`).join('|')
        + `|host=${S.you.isHost}`;
    renderIfChanged(lobbyPlayers, sig, () => {
        S.players.forEach((p, i) => {
            const li = document.createElement('li');
            li.style.animationDelay = `${i * 0.06}s`;
            if (p.presence === 'offline') li.classList.add('player-disconnected');
            else if (p.presence === 'away') li.classList.add('player-away');
            const safeName = escapeHtml(p.name);
            const initial = escapeHtml((p.name || '').charAt(0).toUpperCase()) || '?';
            const kickBtn = (S.you.isHost && p.id !== S.you.id)
                ? `<button class="btn-kick" data-player-id="${escapeHtml(p.id)}" aria-label="Remove ${safeName}" title="Remove ${safeName}">✕</button>`
                : '';
            li.innerHTML = `
      <span class="player-avatar" style="background:${getAvatarColor(i)}">${initial}</span>
      <span class="player-name">${safeName}</span>
      ${p.isHost ? '<span class="host-badge">Host</span>' : ''}
      ${presenceBadge(p)}
      ${kickBtn}
    `;
            lobbyPlayers.appendChild(li);
        });
    });

    hostControls.style.display = S.you.isHost ? 'flex' : 'none';
    if (btnStart) {
        const starting = pending('start-game');
        btnStart.disabled = starting || S.counts.present < 2;
        btnStart.textContent = starting ? 'Starting…'
            : (S.counts.present < 2 ? 'Waiting for players…' : 'Start Game');
    }
}

// The server renders the QR from the Host header of the request, so the encoded
// join URL always matches the origin this browser is on — localhost, LAN IP or
// tunnel — without the server needing to know its own external address.
function updateLobbyQr(code) {
    if (!lobbyQr || !lobbyQrImg) return;
    if (!code) { lobbyQr.style.display = 'none'; return; }
    const src = `/qr/${encodeURIComponent(code)}`;
    if (lobbyQrImg.getAttribute('src') !== src) {
        lobbyQrImg.setAttribute('src', src);
        lobbyQrImg.classList.remove('qr-large');
    }
    lobbyQr.style.display = 'flex';
}

// ─── Assignment ───

function renderAssignment() {
    const extraRound = (S.round || 1) > 1;
    // Identical copy and styling for everyone, so the impostor can't be spotted
    // from the shape of their own UI.
    const sig = `${S.round}:${S.you.word || ''}`;
    if (assignContent.dataset.sig !== sig) {
        assignContent.dataset.sig = sig;
        assignContent.innerHTML = `
      <p class="role-label">${extraRound ? 'Same word — add another clue!' : 'The secret word is'}</p>
      <div class="word-display civilian">${escapeHtml(S.you.word || '')}</div>
      <p class="hint">${extraRound ? 'Give one more descriptive clue.' : 'Describe it without being too obvious!'}</p>
    `;
    }
    const waiting = Math.max(0, continueUnlockAt - Date.now());
    btnContinue.disabled = waiting > 0 || pending('continue');
    btnContinue.textContent = pending('continue') ? 'Continuing…' : 'Continue';
}

// ─── Describe ───

function renderDescribe() {
    const sending = pending('submit-description');
    const submitted = S.you.hasSubmitted;

    inputDescription.disabled = submitted || sending;
    btnSubmitText.disabled = submitted || sending;
    btnSubmitText.textContent = submitted ? 'Submitted ✓' : (sending ? 'Sending…' : 'Submit');

    submitStatus.textContent = `${S.counts.submitted} / ${S.counts.present} submitted`;

    if (describeHostActions && btnForceAdvance) {
        describeHostActions.style.display = S.you.isHost ? 'flex' : 'none';
        const forcing = pending('force-discussion');
        btnForceAdvance.disabled = forcing;
        btnForceAdvance.textContent = forcing
            ? 'Starting…'
            : `Force Start Discussion (${S.counts.submitted} / ${S.counts.present} submitted)`;
    }
}

// ─── Evidence board (discussion + vote) ───

function cluesSig() {
    return (S.clues || []).map(c => `${c.playerId}:${c.items.join('~')}`).join('|');
}

function renderEvidence() {
    if (evidenceWaiting) evidenceWaiting.style.display = 'none';
    if (evidenceDiscussion) evidenceDiscussion.style.display = 'flex';

    const isVote = S.phase === 'vote';

    // During voting the selectable cards already show name + clue, so the
    // read-only list above would just repeat every line.
    if (evidenceList) {
        evidenceList.style.display = isVote ? 'none' : '';
        renderIfChanged(evidenceList, cluesSig(), () => {
            (S.clues || []).forEach((c, i) => {
                const li = document.createElement('li');
                li.style.animationDelay = `${i * 0.08}s`;
                const parts = c.items.map(t => escapeHtml(String(t))).join(', ');
                li.innerHTML = `<span class="ev-content"><strong>${escapeHtml(c.playerName)}</strong> — ${parts}</span>`;
                evidenceList.appendChild(li);
            });
        });
    }

    if (discussionStatus) {
        discussionStatus.style.display = '';
        discussionStatus.textContent = isVote
            ? `Voting — ${S.counts.voted} / ${S.counts.present} voted`
            : (S.you.isHost
                ? 'Discuss the clues with your group. Tap Open Voting when ready.'
                : 'Discuss the clues with your group. The host will open voting when ready.');
    }

    if (votePanel) {
        votePanel.style.display = isVote ? 'flex' : 'none';
        votePanel.style.flexDirection = 'column';
        votePanel.style.alignItems = 'stretch';
    }
    if (isVote) renderVotePanel();

    const isDiscussion = S.phase === 'discussion';
    if (btnOpenVoting) {
        btnOpenVoting.style.display = (S.you.isHost && isDiscussion) ? 'inline-flex' : 'none';
        btnOpenVoting.disabled = pending('open-voting');
        btnOpenVoting.textContent = pending('open-voting') ? 'Opening…' : 'Open Voting';
    }
    if (btnResolveRound) {
        btnResolveRound.style.display = (S.you.isHost && isVote) ? 'inline-flex' : 'none';
        btnResolveRound.disabled = pending('resolve-round');
        btnResolveRound.textContent = pending('resolve-round')
            ? 'Resolving…'
            : `Resolve Round (${S.counts.voted} / ${S.counts.present} voted)`;
    }
    if (btnFinishGame) {
        btnFinishGame.style.display = (S.you.isHost && (isDiscussion || isVote)) ? 'inline-flex' : 'none';
        btnFinishGame.disabled = pending('finish-game');
    }
}

function renderVotePanel() {
    const candidates = S.players.filter(p => p.presence !== 'offline');
    const clueFor = new Map((S.clues || []).map(c => [c.playerId, c.items]));

    const sig = candidates.map(p => `${p.id}:${p.name}`).join('|') + '#' + cluesSig();
    renderIfChanged(voteCandidates, sig, () => {
        candidates.forEach((p, i) => {
            const items = clueFor.get(p.id);
            const answer = (items && items.length)
                ? items.map(t => escapeHtml(String(t))).join(', ')
                : '<span class="vote-candidate-muted">No clues yet</span>';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'vote-candidate';
            btn.dataset.playerId = p.id;
            btn.setAttribute('role', 'radio');
            btn.style.animationDelay = `${i * 0.05}s`;
            btn.innerHTML = `<span class="vote-candidate-text">${escapeHtml(p.name)} — ${answer}</span>`;
            voteCandidates.appendChild(btn);
        });
    });

    // The server's record of our vote wins; a local tap only overrides it until
    // that tap has been acked.
    const shown = voteSelection || S.you.votedFor;
    voteCandidates.querySelectorAll('.vote-candidate').forEach((el) => {
        const on = el.dataset.playerId === shown;
        el.classList.toggle('selected', on);
        el.setAttribute('aria-checked', on ? 'true' : 'false');
    });

    const sending = pending('cast-vote');
    const changed = shown && shown !== S.you.votedFor;
    btnSubmitVote.disabled = sending || !changed;
    btnSubmitVote.textContent = sending ? 'Sending…' : (S.you.votedFor ? 'Change Vote' : 'Submit Vote');

    // Only claim the vote is in when the SERVER says so.
    if (voteStatus) {
        voteStatus.textContent = sending
            ? 'Sending your vote…'
            : (S.you.votedFor ? 'Vote submitted. You can change it until the round resolves.' : '');
    }
}

// ─── Reveal ───

function renderReveal() {
    revealWord.textContent = (S.reveal && S.reveal.word) || '';
    revealImpostor.textContent = (S.reveal && S.reveal.impostorName) || '';

    const impostorId = S.reveal && S.reveal.impostorId;
    renderIfChanged(revealDescriptions, cluesSig() + '#' + impostorId, () => {
        (S.clues || []).forEach((c, i) => {
            const li = document.createElement('li');
            li.style.animationDelay = `${i * 0.08}s`;
            if (c.playerId === impostorId) li.classList.add('impostor-highlight');
            const parts = c.items.map(t => escapeHtml(String(t))).join(', ');
            li.innerHTML = `<span class="ev-content"><strong>${escapeHtml(c.playerName)}</strong> — ${parts}</span>`;
            revealDescriptions.appendChild(li);
        });
    });

    btnPlayAgain.style.display = S.you.isHost ? 'inline-flex' : 'none';
    btnPlayAgain.disabled = pending('play-again');
    btnPlayAgain.textContent = pending('play-again') ? 'Resetting…' : 'Play Again';
}

// ═══════════════════════════════════════════
//  USER INTENT → ACTIONS
// ═══════════════════════════════════════════

btnCreate.addEventListener('click', () => {
    const name = inputName.value.trim();
    if (!name) { showError('Please enter your name.'); return; }
    myName = name;
    btnCreate.disabled = true;
    socket.timeout(ACTION_TIMEOUT_MS).emit('create-room', { name }, (err, res) => {
        btnCreate.disabled = false;
        if (err) return showError('Could not reach the game. Please try again.');
        if (!res || res.error) return showError((res && res.error) || 'Could not create the game.');
        myRejoinToken = res.rejoinToken || null;
        persistRejoinToken(res.code, res.rejoinToken);
        writeActiveSession({ code: res.code, name, rejoinToken: res.rejoinToken });
        setUrlJoinCode(res.code);
    });
});

btnJoin.addEventListener('click', () => {
    const name = inputName.value.trim();
    const code = inputCode.value.trim().replace(/\D/g, '');
    if (!name) { showError('Please enter your name.'); return; }
    if (!/^\d{6}$/.test(code)) { showError('Enter the 6-digit game code.'); return; }
    myName = name;
    btnJoin.disabled = true;
    const token = myRejoinToken || storedRejoinTokenForCode(code) || undefined;
    socket.timeout(ACTION_TIMEOUT_MS).emit('join-room', { code, name, rejoinToken: token }, (err, res) => {
        btnJoin.disabled = false;
        if (err) return showError('Could not reach the game. Please try again.');
        if (!res || res.error) return showError((res && res.error) || 'Could not join.');
        if (res.rejoinToken) {
            myRejoinToken = res.rejoinToken;
            persistRejoinToken(code, res.rejoinToken);
        }
        writeActiveSession({ code, name, rejoinToken: res.rejoinToken || myRejoinToken });
        setUrlJoinCode(code);
        loginError.textContent = '';
    });
});

inputName.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnCreate.focus(); });
inputCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') btnJoin.click(); });

btnLeave.addEventListener('click', () => {
    clearActiveSession();
    if (S && S.code) safeLocalRemove(REJOIN_STORAGE_PREFIX + S.code);
    setUrlJoinCode(null);
    myRejoinToken = null;
    setCredential(null);

    let navigated = false;
    const go = () => {
        if (navigated) return;
        navigated = true;
        location.href = location.pathname;
    };
    // Wait for the ack so the leave lands before we tear the socket down, but
    // never hang the button on a dead connection.
    socket.timeout(2000).emit('action', { type: 'leave', nonce: newNonce() }, go);
    setTimeout(go, 2200);
});

btnStart.addEventListener('click', () => { if (S) sendAction('start-game'); });
btnContinue.addEventListener('click', () => { if (S) sendAction('continue'); });
btnPlayAgain.addEventListener('click', () => { if (S) sendAction('play-again'); });

btnSubmitText.addEventListener('click', () => {
    if (!S) return;
    const data = inputDescription.value.trim();
    if (!data) return;
    sendAction('submit-description', { data });
});

if (btnForceAdvance) {
    btnForceAdvance.addEventListener('click', () => {
        if (!S) return;
        const remaining = Math.max(0, S.counts.present - S.counts.submitted);
        const msg = remaining > 0
            ? `Force start discussion now? ${remaining} player(s) haven't submitted — they'll be skipped.`
            : 'Force start discussion now?';
        if (!confirm(msg)) return;
        sendAction('force-discussion');
    });
}

if (btnOpenVoting) btnOpenVoting.addEventListener('click', () => { if (S) sendAction('open-voting'); });

if (btnResolveRound) {
    btnResolveRound.addEventListener('click', () => {
        if (!S) return;
        const remaining = Math.max(0, S.counts.present - S.counts.voted);
        const msg = remaining > 0
            ? `Resolve voting now? ${remaining} player(s) haven't voted — their votes will be skipped.`
            : 'Resolve voting now?';
        if (!confirm(msg)) return;
        sendAction('resolve-round');
    });
}

btnFinishGame.addEventListener('click', () => {
    if (!S) return;
    if (!confirm('Reveal the impostor now? This skips voting and ends the game.')) return;
    sendAction('finish-game');
});

voteCandidates.addEventListener('click', (e) => {
    const btn = e.target.closest('.vote-candidate');
    if (!btn || !S || S.phase !== 'vote') return;
    voteSelection = btn.dataset.playerId;
    render();
});

btnSubmitVote.addEventListener('click', () => {
    const target = voteSelection || (S && S.you.votedFor);
    if (!target || !S || S.phase !== 'vote') return;
    sendAction('cast-vote', { targetId: target });
});

// Event delegation so kicks keep working across re-renders.
lobbyPlayers.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-kick');
    if (!btn || !S || !S.you.isHost) return;
    const targetId = btn.dataset.playerId;
    const target = S.players.find(p => p.id === targetId);
    if (!target) return;
    if (!confirm(`Remove ${target.name} from the room? They'll be returned to the login screen.`)) return;
    sendAction('kick', { playerId: targetId });
});

if (lobbyQrImg) {
    // A 132px code is awkward to scan off another phone; let the host tap to
    // blow it up rather than shipping a full modal.
    lobbyQrImg.addEventListener('click', () => lobbyQrImg.classList.toggle('qr-large'));
    lobbyQrImg.addEventListener('error', () => { if (lobbyQr) lobbyQr.style.display = 'none'; });
}

// ═══════════════════════════════════════════
//  SERVER EVENTS
// ═══════════════════════════════════════════

let staleClientHandled = false;
function handleStaleClient() {
    if (staleClientHandled) return;
    staleClientHandled = true;
    setConnectionStatus('failed', 'Reload required');
    showToast('The game was updated — reloading…');
    // Guard against a reload loop if the server is ever rolled BACK to an older
    // protocol than this page.
    let already = false;
    try { already = sessionStorage.getItem(RELOAD_GUARD_KEY) === '1'; } catch { /* ignore */ }
    if (already) {
        showError('This page is out of date. Please hard-refresh to continue.');
        return;
    }
    try { sessionStorage.setItem(RELOAD_GUARD_KEY, '1'); } catch { /* ignore */ }
    setTimeout(() => location.reload(), 1500);
}

socket.on('hello', (info) => {
    if (info && typeof info.protocol === 'number' && info.protocol !== PROTOCOL) {
        handleStaleClient();
    }
});

socket.on('state', (snap) => {
    if (!snap || typeof snap !== 'object' || !snap.you) return;
    if (snap.protocol !== PROTOCOL) return handleStaleClient();

    // Version guard: ignore a snapshot older than one we've already applied.
    // `v` is per-room, so it resets when we move to a different room.
    if (snap.code !== lastCode) {
        lastCode = snap.code;
        lastV = -1;
    } else if (typeof snap.v === 'number' && snap.v <= lastV) {
        return;
    }
    lastV = typeof snap.v === 'number' ? snap.v : lastV;
    S = snap;

    // Adopt identity from the server. Matters when we were auto-resumed by
    // playerId after a cold load with no stored session — otherwise myName
    // stays empty and the session pointer never gets written.
    if (S.you.name) myName = S.you.name;
    setUrlJoinCode(S.code);
    writeActiveSession({ code: S.code, name: myName, rejoinToken: myRejoinToken });

    render();
});

socket.on('kicked', () => {
    clearActiveSession();
    setUrlJoinCode(null);
    if (S && S.code) safeLocalRemove(REJOIN_STORAGE_PREFIX + S.code);
    myRejoinToken = null;
    setCredential(null);
    S = null;
    lastV = -1;
    lastCode = null;
    uiPhaseKey = null;
    outbox = [];
    showScreen('screen-login');
    showError('You were removed from the room by the host.');
});

// ─── Connection lifecycle ───

let initialAutoRejoinAttempted = false;

socket.on('connect', () => {
    setConnectionStatus('connected', 'Connected');
    if (!initialAutoRejoinAttempted) {
        initialAutoRejoinAttempted = true;
        attemptInitialAutoRejoin();
    } else {
        // Every subsequent connect is a reconnect. The server also auto-resumes
        // us by playerId, so this is belt-and-braces.
        resyncAfterReconnect();
    }
    flushOutbox();
});

socket.on('connect_error', () => {
    // No toast: reconnection is unlimited, so a flaky mobile connection would
    // fire one per attempt. The status pip already conveys this.
    setConnectionStatus('connecting', 'Connection problem — retrying...');
});

socket.on('disconnect', (reason) => {
    if (reason !== 'io client disconnect') {
        setConnectionStatus('connecting', 'Disconnected — reconnecting...');
    } else {
        setConnectionStatus('disconnected', 'Disconnected');
    }
});

// IMPORTANT: in Socket.IO v3+ these are emitted by the Manager (`socket.io`),
// NOT by the Socket. Registered on the socket they never fire at all — which is
// how a reconnected client used to become a zombie: still "connected", unknown
// to the server, every action dropped.
socket.io.on('reconnect_attempt', () => {
    setConnectionStatus('connecting', 'Reconnecting to game...');
});

socket.io.on('reconnect', () => {
    setConnectionStatus('connected', 'Reconnected');
    showToast('Reconnected — restoring your game...');
});

socket.io.on('reconnect_failed', () => {
    setConnectionStatus('failed', 'Unable to reconnect — refresh to retry.');
    reportProblem('Unable to reconnect. Please refresh or rejoin.');
});

/** Re-announce ourselves after a reconnect. Safe to call repeatedly. */
function resyncAfterReconnect() {
    const session = readActiveSession() || {};
    const code = (S && S.code) || session.code;
    const name = myName || session.name;
    if (!code || !name) return;
    const token = myRejoinToken || storedRejoinTokenForCode(code) || undefined;
    socket.emit('join-room', { code, name, rejoinToken: token }, (res) => {
        if (res && res.error) {
            console.warn('resync join-room rejected:', res.error);
            return;
        }
        if (res && res.rejoinToken) {
            myRejoinToken = res.rejoinToken;
            persistRejoinToken(code, res.rejoinToken);
        }
    });
}

/**
 * Cold load. The server already auto-resumes anyone whose playerId is still in
 * a room, so this only has to cover the deep-link cases: prefill the code for a
 * fresh player arriving via QR, and clean up a session pointing at a room that
 * no longer exists.
 */
function attemptInitialAutoRejoin() {
    const urlCode = readJoinCodeFromUrl();
    if (!urlCode) return;

    const session = readActiveSession();
    if (!session || session.code !== urlCode || !session.name) {
        // Deep link without a matching local session — the QR case. Prefill the
        // code so the player only types their name. Do NOT auto-join under
        // someone else's identity.
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
            // Stale session (server restarted, room expired) — wipe it and fall
            // back to the login screen quietly.
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

// ═══════════════════════════════════════════
//  WAKE / NETWORK RECOVERY
// ═══════════════════════════════════════════
// Phones suspend networking when the screen locks or the tab is backgrounded.
// Once the server's pingTimeout is exceeded the socket is killed, and we would
// otherwise sit through the next backoff tick before retrying. These listeners
// nudge Socket.IO to reconnect the instant the device wakes.

function nudgeReconnect() {
    if (!socket.connected) {
        try { socket.connect(); } catch { /* socket.io handles bad calls */ }
    } else {
        flushOutbox();
    }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) nudgeReconnect(); });
window.addEventListener('online', () => { showToast('Network back online — reconnecting...'); nudgeReconnect(); });
window.addEventListener('focus', nudgeReconnect);
// iOS/Android back-forward cache can restore the page from memory; the socket's
// underlying connection is gone even though the JS heap survived.
window.addEventListener('pageshow', (e) => { if (e.persisted) nudgeReconnect(); });
