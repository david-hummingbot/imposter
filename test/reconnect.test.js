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
const gameMod = require('../game.js');

const PORT = process.env.TEST_PORT || 3101;
const URL = `http://localhost:${PORT}`;

// Compress the presence window so "they've really gone" takes ~2s instead of
// 15. Kept well above the round-trip time on purpose: test C asserts that a
// player who dropped 150ms ago is still counted, and a tighter window would
// turn an ordinary scheduling hiccup into a failure.
const AWAY_MS = 2000;
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
        // Small enough that section K can demonstrate the limits without
        // hammering the server hundreds of times.
        MAX_JOINS_PER_IP: '100',
        MAX_CREATE_PER_IP: '15',
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

/**
 * A test client. `S` is the latest snapshot, exactly like the real client.
 * `token` is the rejoinToken presented in the handshake — the credential the
 * server requires before putting a socket back into an existing seat.
 */
function mkClient(playerId, token) {
    const s = io(URL, {
        auth: { playerId, rejoinToken: token },
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
    host.token = created.rejoinToken;
    const code = created.code;
    for (let i = 1; i < n; i++) {
        const c = await mkClient(`${tag}-p${i}`);
        cs.push(c);
        const r = await rpc(c, 'join-room', { code, name: `P${i}` });
        if (!r || !r.success) throw new Error(`join failed P${i}: ${JSON.stringify(r)}`);
        c.token = r.rejoinToken;
    }
    await waitFor(() => cs.every(c => c.S && c.S.players.length === n), 'all joined');
    return { cs, host, code };
}

/** Every client has seen this phase — not just the host. */
function allAt(cs, phase, label) {
    return waitFor(() => cs.every(c => c.S && c.S.phase === phase), label || phase);
}

async function toVote(n, tag) {
    const ctx = await room(n, tag);
    const { cs, host } = ctx;
    await act(host, 'start-game');
    await allAt(cs, 'assignment');
    for (const c of cs) await act(c, 'continue');
    await allAt(cs, 'description');
    for (const c of cs) await act(c, 'submit-description', { data: `clue-${c.S.you.id.slice(-3)}` });
    await allAt(cs, 'discussion');
    await act(host, 'open-voting');
    await allAt(cs, 'vote');
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
    const p2b = await mkClient('A-p2', p2.token);
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
    await waitFor(() => p0.S.phase !== 'vote', 'auto-resolve after away window', 8000);
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

    const p2b = await mkClient('C-p2', p2.token);   // comes straight back
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
    c0.token = created.rejoinToken;
    const c1 = await mkClient('D-p1');
    const j1 = await rpc(c1, 'join-room', { code, name: 'P1' });
    c1.token = j1.rejoinToken;
    await waitFor(() => c1.S && c1.S.players.length === 2, 'both joined');
    check('creator starts as host', c1.S.players.find(p => p.isHost).id === 'D-p0');

    c1.close();
    await sleep(80);
    c0.close();                       // everybody gone
    await sleep(AFTER_AWAY);

    const c1b = await mkClient('D-p1', c1.token);   // one returns
    await sleep(SETTLE);
    check('the returning player becomes host', !!c1b.S && c1b.S.you.isHost,
        `isHost=${c1b.S && c1b.S.you.isHost}`);

    const refused = await act(c1b, 'start-game');
    check('start is refused with only 1 player present',
        !!(refused && !refused.ok), JSON.stringify(refused));

    const c0b = await mkClient('D-p0', c0.token);
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

    const p2b = await mkClient('E-p2', p2.token);
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
    const p1b = await mkClient('F-p1', p1.token);
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
    await allAt(cs, 'assignment');
    for (const c of cs) await act(c, 'continue');
    await allAt(cs, 'description');

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
    const fresh = await mkClient('H-p2', cs[2].token);
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
    await allAt(cs, 'assignment');

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
    await allAt(cs, 'description');
    for (const c of cs) await act(c, 'submit-description', { data: 'x' });
    await allAt(cs, 'discussion');
    check('the word is withheld once the clue phase is over',
        cs.every(c => c.S.you.word === null && c.S.you.isImpostor === null),
        JSON.stringify(cs.map(c => c.S.you.word)));
    check('and the reveal block is absent before the reveal',
        cs.every(c => c.S.reveal === null), JSON.stringify(cs[0].S.reveal));
} catch (e) { check('section I ran to completion', false, 'CRASHED: ' + e.message); }

console.log('\n=== J. A public playerId is not a credential ===');
try {
    const { cs, code } = await room(3, 'J');
    const [host, bob, eve] = cs;
    await act(host, 'start-game');
    await allAt(cs, 'assignment');

    // Everything below uses ONLY what an ordinary player can read off their own
    // screen: the other players' ids. These all used to succeed.
    const publicIds = eve.S.players.map(p => p.id);
    check('player ids are visible to everyone (so they must not be credentials)',
        publicIds.includes('J-p1') && publicIds.includes('J-p0'), JSON.stringify(publicIds));

    const bobsWord = bob.S.you.word;
    const spy = await mkClient('J-p1');            // Bob's id, no token
    await sleep(SETTLE + 300);
    check('a socket presenting only a known playerId is NOT resumed into the seat',
        spy.S === null, JSON.stringify(spy.S && { code: spy.S.code, word: spy.S.you.word }));
    check("and therefore cannot see the victim's word",
        !(spy.S && spy.S.you && spy.S.you.word === bobsWord),
        `spy word=${spy.S && spy.S.you && spy.S.you.word} victim word=${bobsWord}`);

    const forged = await act(spy, 'submit-description', { data: 'forged' });
    check('an unauthenticated socket cannot act in the victim\'s name',
        !!(forged && !forged.ok && forged.code === 'NO_ROOM'), JSON.stringify(forged));

    // Host takeover: read hostId off the snapshot and try to use it.
    const hostId = eve.S.players.find(p => p.isHost).id;
    const fakeHost = await mkClient(hostId);
    await sleep(SETTLE + 300);
    const kick = await act(fakeHost, 'kick', { playerId: 'J-p2' });
    check('host powers cannot be seized by claiming the host id',
        !!(kick && !kick.ok), JSON.stringify(kick));
    await sleep(SETTLE);
    check('the victim is still in the game',
        cs[0].S.players.length === 3, `players=${cs[0].S.players.length}`);

    // Joining by name must not hand over a live seat either.
    bob.close();
    await sleep(AFTER_AWAY);
    const thief = await mkClient('J-thief');
    const byName = await rpc(thief, 'join-room', { code, name: 'P1' });
    check('a dropped seat cannot be claimed by knowing the (public) name',
        !!(byName && byName.error), JSON.stringify(byName));

    // The real owner, with the real credential, still gets back in.
    const realBob = await mkClient('J-p1', bob.token);
    await sleep(SETTLE + 300);
    check('the rightful owner still resumes with their token',
        !!(realBob.S && realBob.S.code === code && realBob.S.you.word === bobsWord),
        JSON.stringify(realBob.S && { code: realBob.S.code, word: realBob.S.you.word }));
} catch (e) { check('section J ran to completion', false, 'CRASHED: ' + e.message); }

console.log('\n=== K. A room cannot be flooded with players ===');
try {
    // Runs BEFORE the rate-limit section on purpose: that one deliberately
    // exhausts the per-address join budget, and this needs enough of it left to
    // reach the cap and be told why.
    const filler = await mkClient('K-host');
    const code = (await rpc(filler, 'create-room', { name: 'H' })).code;
    let joined = 1, refusal = null;
    for (let i = 0; i < 40; i++) {
        const s2 = await mkClient(`K-f${i}`);
        const r = await rpc(s2, 'join-room', { code, name: `f${i}` });
        s2.close();
        if (r && r.success) joined++;
        else { refusal = (r && r.error) || 'no answer'; break; }
    }
    check('a room stops accepting players at exactly its cap',
        joined === 20, `joined=${joined} (cap is 20) refusal=${JSON.stringify(refusal)}`);
    check('and the refusal says the room is full',
        /full/i.test(refusal || ''), JSON.stringify(refusal));
} catch (e) { check('section K ran to completion', false, 'CRASHED: ' + e.message); }

console.log('\n=== L. Hostile pages, reserved ids, secrets at rest, bounded games ===');
try {
    // Origin: a browser always sends it and a page cannot suppress it, so this
    // is what stops an unrelated site driving the game through a visitor.
    const foreign = io(URL, {
        auth: { playerId: 'xo' }, transports: ['websocket'],
        reconnection: false, forceNew: true,
        extraHeaders: { Origin: 'https://evil.example' },
    });
    clients.push(foreign);
    const foreignConnected = await new Promise((r) => {
        foreign.once('connect', () => r(true));
        foreign.once('connect_error', () => r(false));
        setTimeout(() => r(false), 2500);
    });
    check('a handshake from a foreign Origin is refused', !foreignConnected);

    const sameOrigin = io(URL, {
        auth: { playerId: 'so' }, transports: ['websocket'],
        reconnection: false, forceNew: true,
        extraHeaders: { Origin: URL.replace(/\/$/, '') },
    });
    clients.push(sameOrigin);
    const sameConnected = await new Promise((r) => {
        sameOrigin.once('connect', () => r(true));
        sameOrigin.once('connect_error', () => r(false));
        setTimeout(() => r(false), 2500);
    });
    check('a handshake from the same Origin still works', sameConnected);

    // "__proto__" used to be an acceptable id, and landed in plain objects
    // where writes silently vanish.
    const proto = await mkClient('__proto__');
    const pr = await rpc(proto, 'create-room', { name: 'P' });
    check('a reserved id is not accepted as a playerId',
        !!(pr && pr.success), JSON.stringify(pr));
    // It is replaced with a server-generated id rather than rejected outright,
    // so the client still works — it just cannot choose a dangerous one.
    await sleep(SETTLE);
    check('and the seat gets a safe server-assigned id',
        !!(proto.S && proto.S.you.id !== '__proto__'), `id=${proto.S && proto.S.you.id}`);

    // Snapshots must never carry the credential, in any shape.
    const { cs } = await room(2, 'M');
    const blob = JSON.stringify(cs[0].S);
    check('no snapshot contains a token or hash',
        !/rejoinToken|TokenHash|[0-9a-f]{64}/.test(blob),
        blob.slice(0, 200));

    // Games are bounded, so the clue list cannot grow for ever.
    check('there is a round cap', gameMod.MAX_ROUNDS > 0 && gameMod.MAX_ROUNDS <= 100,
        String(gameMod.MAX_ROUNDS));
    const fakeRoom = { round: gameMod.MAX_ROUNDS, players: cs.map(() => ({ connected: true, lastSeen: Date.now() })) };
    const atLimit = gameMod.startNextRound(fakeRoom);
    check('starting a round past the cap is refused as a limit, not an error',
        !!(atLimit && atLimit.limit), JSON.stringify(atLimit));
} catch (e) { check('section L ran to completion', false, 'CRASHED: ' + e.message); }

console.log('\n=== M. Limits are not bypassable by rotating a chosen id ===');
try {
    // Runs LAST on purpose: it deliberately exhausts the per-address join and
    // create budgets, so anything after it would be starved rather than tested.
    // Room-code brute force across rotated playerIds: the budget is keyed on the
    // address, which the client cannot change.
    let limited = 0, attempts = 0;
    for (let i = 0; i < 300 && limited === 0; i++) {
        const s2 = await mkClient(`bf-${i}`);
        const r = await rpc(s2, 'join-room', { code: String(200000 + i), name: 'x' });
        s2.close();
        attempts++;
        if (r && /Too many/.test(r.error || '')) limited++;
    }
    check('join attempts are rate limited despite a fresh playerId each time',
        limited > 0, `${attempts} attempts, none limited`);

    let createLimited = 0;
    for (let i = 0; i < 80 && createLimited === 0; i++) {
        const s2 = await mkClient(`cr-${i}`);
        const r = await rpc(s2, 'create-room', { name: 'x' });
        s2.close();
        if (r && r.error) createLimited++;
    }
    check('room creation is rate limited despite a fresh playerId each time',
        createLimited > 0, 'created 80 rooms unopposed');
} catch (e) { check('section M ran to completion', false, 'CRASHED: ' + e.message); }

console.log(`\n${failed === 0 ? '✓ ALL PASS' : '✗ ' + failed + ' FAILURE(S)'} — ${results.length} checks\n`);
process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('\nHARNESS ERROR:', e.message, '\n', e.stack); process.exit(2); });
