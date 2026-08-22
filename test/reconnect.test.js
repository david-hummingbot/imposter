/**
 * Reconnect / resilience regression tests.
 *
 * These cover the failure modes that made the game fall apart on phones when
 * the screen locked or the network blipped, plus the properties the snapshot /
 * acked-action refactor is supposed to guarantee.
 *
 *   A. A reconnected socket is still a live participant (it used to become a
 *      "zombie": connected, but unknown to the game — actions dropped, no
 *      broadcasts received).
 *   B. A player who is gone for good stops holding up the round.
 *   C. A player who blips does NOT get the round resolved out from under them.
 *   D. Host controls never end up pinned to a player who has gone.
 *   E. Leave Game removes the player server-side.
 *   F. A reconnected socket keeps receiving state.
 *   G. Retried actions are idempotent (no double-submitted clues).
 *   H. A snapshot is self-sufficient — a client that missed everything is right.
 *   I. Roles and words are scoped to the player they belong to.
 *
 * Boots its own server on TEST_PORT (default 3101) with compressed presence
 * timings, and cleans up after itself. Run with: npm test
 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { io } = require('socket.io-client');

const PORT = process.env.TEST_PORT || 3101;
const URL = `http://localhost:${PORT}`;

// Compress the presence window so "they've really gone" happens in under a
// second instead of 15. AWAY_MS must stay comfortably above the round-trip time
// or test C becomes flaky.
const AWAY_MS = 700;
const TICK_MS = 100;
const SETTLE = 250;                     // generous slack for a round trip
const AFTER_AWAY = AWAY_MS + TICK_MS + 400;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impostor-test-'));
const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: dataDir,
        AWAY_GRACE_MS: String(AWAY_MS),
        PRESENCE_TICK_MS: String(TICK_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

const clients = [];
function cleanup() {
    clients.forEach((c) => { try { c.close(); } catch { /* ignore */ } });
    if (!child.killed) child.kill();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function waitForServer() {
    for (let i = 0; i < 100; i++) {
        if (serverLog.includes('running on')) return;
        await sleep(50);
    }
    throw new Error('server did not start:\n' + serverLog);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
let failed = 0;
function check(name, cond, detail) {
    results.push({ name, ok: !!cond });
    if (!cond) failed++;
    console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${cond ? '' : '  <-- ' + (detail || '')}`);
}

function waitFor(pred, label, timeout = 4000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        (function poll() {
            let v = false;
            try { v = pred(); } catch { v = false; }
            if (v) return resolve(true);
            if (Date.now() - start > timeout) return reject(new Error('timeout waiting for ' + label));
            setTimeout(poll, 20);
        })();
    });
}

/** A test client. `S` is the latest snapshot, exactly like the real client. */
function mkClient(playerId) {
    const s = io(URL, {
        auth: { playerId },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
    });
    clients.push(s);
    s.S = null;
    s.snapshots = 0;
    s.kicked = false;
    s.on('state', (snap) => { s.S = snap; s.snapshots++; });
    s.on('kicked', () => { s.kicked = true; });
    return new Promise((resolve, reject) => {
        s.once('connect', () => resolve(s));
        s.once('connect_error', reject);
    });
}

function rpc(s, event, payload, timeout = 2500) {
    return new Promise((resolve) => {
        let done = false;
        s.emit(event, payload, (res) => { done = true; resolve(res); });
        setTimeout(() => { if (!done) resolve(null); }, timeout);
    });
}

let nonceSeq = 0;
function act(s, type, extra, nonce) {
    return rpc(s, 'action', Object.assign({ type, nonce: nonce || `n${++nonceSeq}` }, extra || {}));
}

/** Drive a fresh room to a given phase with n players. */
async function room(n, tag) {
    const cs = [];
    const host = await mkClient(`${tag}-p0`);
    cs.push(host);
    const created = await rpc(host, 'create-room', { name: 'P0' });
    if (!created || !created.code) throw new Error('create failed: ' + JSON.stringify(created));
    const code = created.code;
    for (let i = 1; i < n; i++) {
        const c = await mkClient(`${tag}-p${i}`);
        cs.push(c);
        const r = await rpc(c, 'join-room', { code, name: `P${i}` });
        if (!r || !r.success) throw new Error(`join failed P${i}: ${JSON.stringify(r)}`);
    }
    await waitFor(() => host.S && host.S.players.length === n, 'all joined');
    return { cs, host, code };
}

async function toVote(n, tag) {
    const ctx = await room(n, tag);
    const { cs, host } = ctx;
    await act(host, 'start-game');
    await waitFor(() => cs.every(c => c.S && c.S.phase === 'assignment'), 'assignment');
    for (const c of cs) await act(c, 'continue');
    await waitFor(() => host.S.phase === 'description', 'description');
    for (const c of cs) await act(c, 'submit-description', { data: `clue-${c.S.you.id.slice(-3)}` });
    await waitFor(() => host.S.phase === 'discussion', 'discussion');
    await act(host, 'open-voting');
    await waitFor(() => host.S.phase === 'vote', 'vote');
    return ctx;
}

(async () => {
await waitForServer();

console.log('\n=== A. Reconnected socket is still a live participant ===');
try {
    const { cs, code } = await toVote(3, 'A');
    const [p0, p1, p2] = cs;

    // P2's phone reconnects: brand-new socket, same stable playerId, and it
    // deliberately never re-announces itself (the old client couldn't, because
    // its reconnect handler was registered on the wrong emitter).
    p2.close();
    await sleep(120);
    const p2b = await mkClient('A-p2');
    await sleep(SETTLE);

    check('reconnected socket receives state unprompted',
        !!p2b.S && p2b.S.code === code && p2b.S.phase === 'vote',
        JSON.stringify(p2b.S && { code: p2b.S.code, phase: p2b.S.phase }));
    check('server reports it as online again',
        !!p2b.S && p2b.S.players.filter(p => p.presence === 'online').length === 3,
        JSON.stringify(p2b.S && p2b.S.players.map(p => p.presence)));

    const ack = await act(p2b, 'cast-vote', { targetId: p2b.S.players[1].id });
    check('an action from the reconnected socket is accepted', !!(ack && ack.ok), JSON.stringify(ack));
    await sleep(SETTLE);
    check('and the vote is actually recorded',
        !!p2b.S && p2b.S.you.votedFor === p0.S.players[1].id,
        `votedFor=${p2b.S && p2b.S.you.votedFor}`);
} catch (e) { check('section A ran to completion', false, 'CRASHED: ' + e.message); }

console.log('\n=== B. A player gone for good stops holding up the round ===');
try {
    const { cs } = await toVote(3, 'B');
    const [p0, p1, p2] = cs;
    await act(p0, 'cast-vote', { targetId: p0.S.players[1].id });
    await act(p1, 'cast-vote', { targetId: p1.S.players[1].id });
    await waitFor(() => p0.S.counts.voted === 2, '2 votes in');
    check('still waiting on the third player', p0.S.phase === 'vote');

    p2.close();                       // screen locks, never comes back
    await waitFor(() => p0.S.phase !== 'vote', 'auto-resolve after away window', 4000);
    check('round resolves once they age out of the away window',
        p0.S.phase !== 'vote', `phase=${p0.S.phase}`);
} catch (e) { check('section B ran to completion', false, 'CRASHED: ' + e.message); }

console.log('\n=== C. A brief blip does NOT resolve the round early ===');
try {
    const { cs } = await toVote(3, 'C');
    const [p0, p1, p2] = cs;
    await act(p0, 'cast-vote', { targetId: p0.S.players[1].id });
    await act(p1, 'cast-vote', { targetId: p1.S.players[1].id });
    await waitFor(() => p0.S.counts.voted === 2, '2 votes in');

    p2.close();                       // drops...
    await sleep(150);                 // ...well inside the away window
    check('a just-dropped player is still counted (away, not offline)',
        p0.S.phase === 'vote' && p0.S.counts.present === 3,
        `phase=${p0.S.phase} present=${p0.S.counts.present}`);
    check('and is shown as away rather than offline',
        p0.S.players.some(p => p.presence === 'away'),
        JSON.stringify(p0.S.players.map(p => p.presence)));

    const p2b = await mkClient('C-p2');   // comes straight back
    await sleep(SETTLE);
    check('they get their vote back after reconnecting inside the window',
        p2b.S && p2b.S.phase === 'vote',
        `phase=${p2b.S && p2b.S.phase}`);
} catch (e) { check('section C ran to completion', false, 'CRASHED: ' + e.message); }

console.log('\n=== D. Host is never pinned to a player who has gone ===');
try {
    const c0 = await mkClient('D-p0');
    const created = await rpc(c0, 'create-room', { name: 'P0' });
    const code = created.code;
    const c1 = await mkClient('D-p1');
    await rpc(c1, 'join-room', { code, name: 'P1' });
    await waitFor(() => c1.S && c1.S.players.length === 2, 'both joined');
    check('creator starts as host', c1.S.players.find(p => p.isHost).id === 'D-p0');

    c1.close();
    await sleep(80);
    c0.close();                       // everybody gone
    await sleep(AFTER_AWAY);

    const c1b = await mkClient('D-p1');   // one returns
    await sleep(SETTLE);
    check('the returning player becomes host', !!c1b.S && c1b.S.you.isHost,
        `isHost=${c1b.S && c1b.S.you.isHost}`);

    const refused = await act(c1b, 'start-game');
    check('start is refused with only 1 player present',
        !!(refused && !refused.ok), JSON.stringify(refused));

    const c0b = await mkClient('D-p0');
    await sleep(SETTLE);
    const started = await act(c1b, 'start-game');
    check('the new host can actually drive the game', !!(started && started.ok), JSON.stringify(started));
    await sleep(SETTLE);
    check('and everyone lands in assignment',
        c0b.S.phase === 'assignment' && c1b.S.phase === 'assignment',
        `${c0b.S.phase}/${c1b.S.phase}`);
} catch (e) { check('section D ran to completion', false, 'CRASHED: ' + e.message); }

console.log('\n=== E. Leave Game removes the player server-side ===');
try {
    const { cs } = await toVote(3, 'E');
    const [p0, p1, p2] = cs;
    await act(p0, 'cast-vote', { targetId: p0.S.players[1].id });
    await waitFor(() => p0.S.counts.voted === 1, '1 vote in');

    const ack = await act(p2, 'leave');
    check('leave is acknowledged', !!(ack && ack.ok), JSON.stringify(ack));
    await sleep(SETTLE);
    check('the leaver is removed, not merely marked offline',
        p0.S.players.length === 2, `players=${p0.S.players.length}`);

    const p2b = await mkClient('E-p2');
    await sleep(SETTLE);
    check('and is not auto-resumed back in on their next load',
        p2b.S === null, JSON.stringify(p2b.S && p2b.S.code));
} catch (e) { check('section E ran to completion', false, 'CRASHED: ' + e.message); }

console.log('\n=== F. Reconnected socket keeps receiving state ===');
try {
    const { cs, host } = await toVote(2, 'F');
    const [p0, p1] = cs;
    p1.close();
    await sleep(120);
    const p1b = await mkClient('F-p1');
    await sleep(SETTLE);
    const before = p1b.snapshots;
    await act(host, 'finish-game');
    await waitFor(() => p1b.S && p1b.S.phase === 'reveal', 'reveal reaches it', 3000);
    check('a later phase change still reaches the reconnected socket',
        p1b.S.phase === 'reveal' && p1b.snapshots > before,
        `phase=${p1b.S.phase} snapshots ${before}->${p1b.snapshots}`);
    check('and the reveal names the impostor',
        !!(p1b.S.reveal && p1b.S.reveal.impostorName && p1b.S.reveal.word),
        JSON.stringify(p1b.S.reveal));
} catch (e) { check('section F ran to completion', false, 'CRASHED: ' + e.message); }

console.log('\n=== G. Retried actions are idempotent ===');
try {
    const { cs, host } = await room(3, 'G');
    await act(host, 'start-game');
    await waitFor(() => cs.every(c => c.S && c.S.phase === 'assignment'), 'assignment');
    for (const c of cs) await act(c, 'continue');
    await waitFor(() => host.S.phase === 'description', 'description');

    // Same nonce twice — the retry a client makes when it never saw the ack.
    const n = 'fixed-nonce-g';
    const first = await act(cs[0], 'submit-description', { data: 'only-once' }, n);
    const retry = await act(cs[0], 'submit-description', { data: 'only-once' }, n);
    check('retry with the same nonce returns the original result',
        !!(first && first.ok) && !!(retry && retry.ok), `${JSON.stringify(first)} / ${JSON.stringify(retry)}`);
    await sleep(SETTLE);
    check('the clue was stored exactly once',
        host.S.counts.submitted === 1, `submitted=${host.S.counts.submitted}`);

    // A genuinely NEW attempt must be rejected, not silently appended.
    const second = await act(cs[0], 'submit-description', { data: 'sneaky-second' });
    check('a second distinct submission is refused',
        !!(second && !second.ok && second.code === 'ALREADY_SUBMITTED'), JSON.stringify(second));
    await sleep(SETTLE);
    check('and the clue count is unchanged',
        host.S.counts.submitted === 1, `submitted=${host.S.counts.submitted}`);
} catch (e) { check('section G ran to completion', false, 'CRASHED: ' + e.message); }

console.log('\n=== H. A snapshot is self-sufficient ===');
try {
    const { cs, host } = await toVote(3, 'H');
    // A client that has seen NOTHING joins mid-vote and must be able to draw
    // the whole screen from its first snapshot alone.
    cs[2].close();
    await sleep(120);
    const fresh = await mkClient('H-p2');
    await waitFor(() => fresh.S, 'first snapshot');
    const s = fresh.S;
    const complete = s.phase === 'vote'
        && typeof s.v === 'number'
        && typeof s.protocol === 'number'
        && !!s.code
        && Array.isArray(s.players) && s.players.length === 3
        && !!s.you && typeof s.you.isHost === 'boolean'
        && Array.isArray(s.clues) && s.clues.length === 3
        && s.counts && typeof s.counts.present === 'number';
    check('one snapshot carries phase, players, clues, counts and identity',
        complete, JSON.stringify(Object.keys(s)) + ' clues=' + (s.clues && s.clues.length));
    check('every clue row is attributed to a named player',
        (s.clues || []).every(c => c.playerId && c.playerName && Array.isArray(c.items) && c.items.length),
        JSON.stringify(s.clues));
} catch (e) { check('section H ran to completion', false, 'CRASHED: ' + e.message); }

console.log('\n=== I. Roles and words stay scoped to their owner ===');
try {
    const { cs, host } = await room(3, 'I');
    await act(host, 'start-game');
    await waitFor(() => cs.every(c => c.S && c.S.phase === 'assignment'), 'assignment');

    const impostors = cs.filter(c => c.S.you.isImpostor);
    check('exactly one player is told they are the impostor',
        impostors.length === 1, `count=${impostors.length}`);

    const crewWords = new Set(cs.filter(c => !c.S.you.isImpostor).map(c => c.S.you.word));
    check('all crew share one word', crewWords.size === 1, JSON.stringify([...crewWords]));
    check('the impostor gets a different word',
        impostors.length === 1 && !crewWords.has(impostors[0].S.you.word),
        `impostor=${impostors[0] && impostors[0].S.you.word} crew=${[...crewWords]}`);

    check("no snapshot exposes another player's role",
        cs.every(c => c.S.players.every(p => !('isImpostor' in p) && !('word' in p))),
        JSON.stringify(cs[0].S.players[0]));

    // Once the word is no longer theirs to know, it stops being sent.
    for (const c of cs) await act(c, 'continue');
    await waitFor(() => host.S.phase === 'description', 'description');
    for (const c of cs) await act(c, 'submit-description', { data: 'x' });
    await waitFor(() => host.S.phase === 'discussion', 'discussion');
    check('the word is withheld once the clue phase is over',
        cs.every(c => c.S.you.word === null && c.S.you.isImpostor === null),
        JSON.stringify(cs.map(c => c.S.you.word)));
    check('and the reveal block is absent before the reveal',
        cs.every(c => c.S.reveal === null), JSON.stringify(cs[0].S.reveal));
} catch (e) { check('section I ran to completion', false, 'CRASHED: ' + e.message); }

console.log(`\n${failed === 0 ? '✓ ALL PASS' : '✗ ' + failed + ' FAILURE(S)'} — ${results.length} checks\n`);
process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('\nHARNESS ERROR:', e.message, '\n', e.stack); process.exit(2); });
