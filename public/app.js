/* ═══════════════════════════════════════════
   IMPOSTOR GAME — Client Application
   ═══════════════════════════════════════════ */

// Configure Socket.IO to be more resilient on mobile networks by preferring
// WebSocket and using generous reconnection behavior.
const socket = io({
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    timeout: 20000,
});

// ─── State ───
let myId = null;
let myName = '';
let myRejoinToken = null; // Prevents session hijacking on reconnect
let roomData = null;
let isHost = false;
let myRole = null; // { isImpostor, word }

// Discussion timer
let discussionInterval = null;

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
const timerDuration = document.getElementById('timer-duration');
const btnStart = document.getElementById('btn-start');
const btnLeave = document.getElementById('btn-leave');

// Assignment
const assignContent = document.getElementById('assign-content');
const btnContinue = document.getElementById('btn-continue');

// Description
const inputDescription = document.getElementById('input-description');
const btnSubmitText = document.getElementById('btn-submit-text');
const submitStatus = document.getElementById('submit-status');

// Evidence
const evidenceWaiting = document.getElementById('evidence-waiting');
const evidenceDiscussion = document.getElementById('evidence-discussion');
const evidenceCounter = document.getElementById('evidence-counter');
const timerRingFg = document.getElementById('timer-ring-fg');
const timerText = document.getElementById('timer-text');
const evidenceList = document.getElementById('evidence-list');
const btnSkipTimer = document.getElementById('btn-skip-timer');
const btnNextRound = document.getElementById('btn-next-round');
const btnFinishGame = document.getElementById('btn-finish-game');
const voteSelect = document.getElementById('vote-select');
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
    const code = inputCode.value.trim().toUpperCase();
    if (!name) { showError('Please enter your name.'); return; }
    if (code.length !== 6) { showError('Enter a 6-character game code.'); return; }
    myName = name;
    socket.emit('join-room', { code, name, rejoinToken: myRejoinToken || undefined }, (res) => {
        if (res.error) {
            showError(res.error);
            return;
        }
        if (res.rejoinToken) myRejoinToken = res.rejoinToken;
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
    location.reload();
});

btnStart.addEventListener('click', () => {
    socket.emit('start-game', { timerDuration: timerDuration.value });
});

function renderLobby(data) {
    lobbyCode.textContent = data.code;
    lobbyPlayers.innerHTML = '';
    data.players.forEach((p, i) => {
        const li = document.createElement('li');
        li.style.animationDelay = `${i * 0.06}s`;
        const safeName = escapeHtml(p.name);
        const initial = escapeHtml((p.name || '').charAt(0).toUpperCase()) || '?';
        li.innerHTML = `
      <span class="player-avatar" style="background:${getAvatarColor(i)}">${initial}</span>
      <span>${safeName}</span>
      ${p.id === data.hostId ? '<span class="host-badge">Host</span>' : ''}
    `;
        lobbyPlayers.appendChild(li);
    });

    isHost = data.hostId === myId;
    hostControls.style.display = isHost ? 'flex' : 'none';
}

// ═══════════════════════════════════════════
//  ASSIGNMENT SCREEN
// ═══════════════════════════════════════════

function showAssignment(role) {
    myRole = role;
    const isExtraRound = (role.round || 1) > 1;
    if (role.isImpostor) {
        assignContent.innerHTML = `
      <p class="role-label">Your Role</p>
      <div class="word-display impostor">🕵️ IMPOSTOR</div>
      <p class="hint">Try to blend in! You don't know the word.</p>
    `;
    } else {
        assignContent.innerHTML = `
      <p class="role-label">${isExtraRound ? 'Same word — add another clue!' : 'The secret word is'}</p>
      <div class="word-display civilian">${escapeHtml(role.word || '')}</div>
      <p class="hint">${isExtraRound ? 'Give one more descriptive clue.' : 'Describe it without being too obvious!'}</p>
    `;
    }

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

function showEvidenceDiscussion(descriptions, duration, rejoinOptions) {
    evidenceWaiting.style.display = 'none';
    evidenceDiscussion.style.display = 'flex';
    showScreen('screen-evidence');

    // Group descriptions by player (one line per player, all rounds combined)
    const byPlayer = new Map();
    (descriptions || []).forEach((d) => {
        const key = d.playerId;
        if (!byPlayer.has(key)) {
            byPlayer.set(key, { name: d.playerName, items: [] });
        }
        byPlayer.get(key).items.push({ type: d.type, data: d.data });
    });

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

    // Populate voting options
    if (roomData && roomData.players) {
        voteSelect.innerHTML = '';
        roomData.players.forEach(p => {
            const option = document.createElement('option');
            option.value = p.id;
            option.textContent = p.name;
            voteSelect.appendChild(option);
        });
        const alreadyVoted = rejoinOptions && rejoinOptions.hasVoted;
        voteSelect.disabled = alreadyVoted;
        btnSubmitVote.disabled = alreadyVoted;
        voteStatus.textContent = alreadyVoted ? 'Vote submitted. Waiting for others...' : '';
    }

    // Host controls during discussion
    btnSkipTimer.style.display = isHost ? 'inline-flex' : 'none';
    btnNextRound.style.display = isHost ? 'inline-flex' : 'none';
    btnFinishGame.style.display = isHost ? 'inline-flex' : 'none';

    // Start countdown (rejoin: use remaining seconds)
    const remaining = rejoinOptions && rejoinOptions.remainingSeconds != null ? rejoinOptions.remainingSeconds : duration;
    const total = rejoinOptions && rejoinOptions.totalSeconds != null ? rejoinOptions.totalSeconds : duration;
    if (remaining > 0) {
        startDiscussionTimer(remaining, total);
    } else {
        timerText.textContent = '0';
        timerRingFg.style.strokeDashoffset = 339.292;
    }
}

function startDiscussionTimer(remainingSeconds, totalSeconds) {
    let remaining = remainingSeconds;
    const total = totalSeconds != null ? totalSeconds : remainingSeconds;
    const circumference = 339.292; // 2 * PI * 54

    timerText.textContent = remaining;
    timerRingFg.style.strokeDashoffset = 0;
    timerRingFg.classList.remove('warning', 'danger');

    clearInterval(discussionInterval);
    discussionInterval = setInterval(() => {
        remaining--;
        timerText.textContent = remaining;

        const progress = 1 - remaining / total;
        timerRingFg.style.strokeDashoffset = circumference * progress;

        if (remaining <= 10) timerRingFg.classList.add('danger');
        else if (remaining <= total * 0.3) timerRingFg.classList.add('warning');

        if (remaining <= 0) {
            clearInterval(discussionInterval);
            socket.emit('timer-expired');
        }
    }, 1000);
}

btnSkipTimer.addEventListener('click', () => {
    clearInterval(discussionInterval);
    socket.emit('skip-timer');
});

btnNextRound.addEventListener('click', () => {
    clearInterval(discussionInterval);
    socket.emit('next-round');
});

btnFinishGame.addEventListener('click', () => {
    clearInterval(discussionInterval);
    socket.emit('finish-game');
});

btnSubmitVote.addEventListener('click', () => {
    const targetId = voteSelect.value;
    if (!targetId) return;
    socket.emit('cast-vote', { targetId });
    voteSelect.disabled = true;
    btnSubmitVote.disabled = true;
    voteStatus.textContent = 'Vote submitted. Waiting for others...';
});

// ═══════════════════════════════════════════
//  REVEAL SCREEN
// ═══════════════════════════════════════════

function showReveal(data) {
    clearInterval(discussionInterval);
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

socket.on('connect', () => {
    myId = socket.id;
});

// Connection lifecycle handlers to make temporary network drops feel smoother,
// especially on mobile devices where the OS may briefly suspend networking.
socket.on('connect_error', () => {
    showToast('Connection problem — trying to reconnect...');
});

socket.on('reconnect_attempt', () => {
    showToast('Reconnecting to game...');
});

socket.on('reconnect', () => {
    myId = socket.id;
    showToast('Reconnected — restoring your game...');

    // If we already know the room and player name, attempt to rejoin
    // automatically so the server can send us the appropriate rejoin state.
    if (roomData && roomData.code && myName) {
        socket.emit('join-room', { code: roomData.code, name: myName, rejoinToken: myRejoinToken || undefined }, () => {
            // The server will either emit a fresh room-update or a rejoin-state
            // event which our existing handlers already understand.
        });
    }
});

socket.on('reconnect_failed', () => {
    showError('Unable to reconnect. Please refresh or rejoin.');
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
    if (gs === 'discussion') {
        const timerDuration = data.timerDuration || 60;
        let remaining = timerDuration;
        if (data.discussionStartedAt != null) {
            remaining = Math.max(0, Math.ceil((data.discussionStartedAt + timerDuration * 1000 - Date.now()) / 1000));
        }
        showEvidenceDiscussion(data.descriptions || [], timerDuration, {
            remainingSeconds: remaining,
            totalSeconds: timerDuration,
            hasVoted: data.hasVoted,
        });
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
    showScreen('screen-lobby');
});

socket.on('room-update', (data) => {
    roomData = data;
    isHost = data.hostId === myId;

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
});

socket.on('game-started', (role) => {
    // Reset description UI for a fresh round
    btnSubmitText.disabled = false;
    btnSubmitText.textContent = 'Submit';
    inputDescription.disabled = false;
    inputDescription.value = '';
    submitStatus.textContent = '';

    showAssignment(role);
});

socket.on('all-submitted', ({ descriptions, timerDuration }) => {
    showEvidenceDiscussion(descriptions, timerDuration);
});

socket.on('reveal', (data) => {
    showReveal(data);
});

socket.on('back-to-lobby', () => {
    // Reset local state (keep myRejoinToken for rejoin)
    myRole = null;
    clearInterval(discussionInterval);

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
        showToast('Disconnected — attempting to reconnect...');
    }
});
