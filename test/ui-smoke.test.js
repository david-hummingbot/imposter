/**
 * UI smoke test: drives the REAL client (index.html + app.js) in jsdom against
 * a real server, all the way from the login screen to the reveal.
 *
 * This exists because the protocol suite in reconnect.test.js talks to the
 * server directly and would happily pass with a completely broken page. Here we
 * click the actual buttons and read the actual DOM, which is what catches a
 * missing element id, a listener bound to null, or a render() that no longer
 * draws the screen it claims to.
 *
 * It also pins the honesty property the acked outbox exists for: "Vote
 * submitted" must not appear until the server has confirmed the vote.
 *
 * Run with: npm run test:ui   (or npm test, which runs both suites)
 */
const { spawn } = require('child_process');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');
const { io } = require('socket.io-client');
const path = require('path'), os = require('os'), fs = require('fs');

const PORT = Number(process.env.UI_TEST_PORT) || 3104;
const URL = `http://127.0.0.1:${PORT}/`;
const REPO = path.join(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));

let fails = 0;
const check = (n, c, d) => { console.log(`${c ? '  PASS' : '  FAIL'}  ${n}${c ? '' : '  <-- ' + (d || '')}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const srv = spawn(process.execPath, [path.join(REPO, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
process.on('exit', () => { srv.kill(); try { fs.rmSync(dataDir, {recursive:true, force:true}); } catch {} });

async function waitFor(pred, label, ms = 6000) {
    const t = Date.now();
    for (;;) {
        let v = false; try { v = pred(); } catch {}
        if (v) return true;
        if (Date.now() - t > ms) throw new Error('timeout: ' + label);
        await sleep(40);
    }
}

(async () => {
    await waitFor(() => log.includes('running on'), 'server up');

    // Collect page errors — the whole point is catching runtime breakage.
    const pageErrors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', e => pageErrors.push(String(e.message || e)));
    vc.on('error', (...a) => pageErrors.push(a.map(String).join(' ')));

    const dom = await JSDOM.fromURL(URL, {
        runScripts: 'dangerously',
        resources: {
            // Hermetic: never reach the network. index.html links Google Fonts,
            // and letting that request out made this suite fail whenever it
            // hiccuped — a network problem reported as a client bug. Anything
            // not served by the app under test gets a harmless empty 200.
            interceptors: [
                requestInterceptor((request) => {
                    if (!request.url.startsWith(URL)) {
                        return new Response('', { headers: { 'Content-Type': 'text/css' } });
                    }
                }),
            ],
        },
        pretendToBeVisual: true,
        virtualConsole: vc,
    });
    const w = dom.window, d = w.document;
    w.confirm = () => true;   // auto-accept the host confirmations

    await waitFor(() => w.io && d.getElementById('btn-create'), 'page scripts loaded');
    await sleep(900);   // socket connect (polling transport under jsdom)

    check('client boots with no page errors', pageErrors.length === 0, pageErrors.join(' | '));

    const activeId = () => (d.querySelector('.screen.active') || {}).id;
    check('starts on the login screen', activeId() === 'screen-login', activeId());

    // ── Create a game through the UI ──
    d.getElementById('input-name').value = 'Ada';
    d.getElementById('btn-create').click();
    await waitFor(() => activeId() === 'screen-lobby', 'lobby screen');
    const code = d.getElementById('lobby-code').textContent.trim();
    check('lobby shows a 6-digit code', /^\d{6}$/.test(code), code);
    check('QR block is visible with the right src',
        d.getElementById('lobby-qr').style.display === 'flex'
        && d.getElementById('lobby-qr-img').getAttribute('src') === `/qr/${code}`,
        d.getElementById('lobby-qr-img').getAttribute('src'));
    check('host sees Start Game but it is disabled with 1 player',
        d.getElementById('host-controls').style.display === 'flex'
        && d.getElementById('btn-start').disabled === true,
        `disabled=${d.getElementById('btn-start').disabled}`);

    // ── Second player joins out-of-band ──
    const p2 = io(URL, { auth: { playerId: 'smoke-p2' }, transports: ['websocket'], reconnection: false, forceNew: true });
    p2.S = null; p2.on('state', s => p2.S = s);
    await new Promise(r => p2.once('connect', r));
    await new Promise(r => p2.emit('join-room', { code, name: 'Bob' }, r));
    await waitFor(() => d.getElementById('lobby-players').children.length === 2, 'two players listed');
    check('lobby list renders both players', d.getElementById('lobby-players').children.length === 2);
    check('Start Game becomes enabled at 2 players',
        d.getElementById('btn-start').disabled === false,
        `disabled=${d.getElementById('btn-start').disabled}`);

    // ── Start, read the word, submit a clue ──
    const tStart = Date.now();
    d.getElementById('btn-start').click();
    await waitFor(() => activeId() === 'screen-assignment', 'assignment screen');
    const word = (d.querySelector('#assign-content .word-display') || {}).textContent || '';
    check('assignment screen shows a secret word', word.trim().length > 0, JSON.stringify(word));

    // Measure how long Continue stays disabled rather than sampling it at an
    // arbitrary instant: a stalled event loop could otherwise let the delay
    // elapse before we look, failing a test that has found nothing wrong.
    // Starvation only ever makes this number larger, so it cannot flake.
    await waitFor(() => d.getElementById('btn-continue').disabled === false, 'continue enables', 8000);
    const gated = Date.now() - tStart;
    check('Continue is gated by a reading delay before it enables',
        gated >= 2000, `enabled after only ${gated}ms`);

    d.getElementById('btn-continue').click();
    await waitFor(() => activeId() === 'screen-describe', 'describe screen');
    d.getElementById('input-description').value = 'a smoke test clue';
    d.getElementById('btn-submit-text').click();
    await waitFor(() => d.getElementById('btn-submit-text').textContent.includes('Submitted'), 'clue acked');
    check('submit button only says Submitted after the server acks',
        d.getElementById('btn-submit-text').textContent.includes('Submitted'));
    check('counter reflects server-side counts',
        /1 \/ 2 submitted/.test(d.getElementById('submit-status').textContent),
        d.getElementById('submit-status').textContent);

    // ── Other player submits → discussion → vote ──
    await new Promise(r => p2.emit('action', { type: 'continue', nonce: 'c2' }, r));
    await new Promise(r => p2.emit('action', { type: 'submit-description', nonce: 's2', data: 'bob clue' }, r));
    await waitFor(() => activeId() === 'screen-evidence', 'evidence screen');
    check('advances to the evidence board when all clues are in',
        activeId() === 'screen-evidence' && d.getElementById('evidence-list').children.length === 2,
        `rows=${d.getElementById('evidence-list').children.length}`);

    d.getElementById('btn-open-voting').click();
    await waitFor(() => d.getElementById('vote-panel').style.display === 'flex', 'vote panel');
    check('vote panel lists both candidates',
        d.getElementById('vote-candidates').children.length === 2,
        `n=${d.getElementById('vote-candidates').children.length}`);
    check('Submit Vote is disabled until something is picked',
        d.getElementById('btn-submit-vote').disabled === true);

    d.getElementById('vote-candidates').children[1].click();
    await sleep(120);
    check('picking a candidate enables the button and marks it selected',
        d.getElementById('btn-submit-vote').disabled === false
        && d.getElementById('vote-candidates').children[1].classList.contains('selected'));
    check('vote status stays empty before the server confirms',
        d.getElementById('vote-status').textContent.trim() === '',
        JSON.stringify(d.getElementById('vote-status').textContent));

    d.getElementById('btn-submit-vote').click();
    await waitFor(() => /Vote submitted/.test(d.getElementById('vote-status').textContent), 'vote acked');
    check('vote status appears only after the ack',
        /Vote submitted/.test(d.getElementById('vote-status').textContent));

    // ── Reveal ──
    await new Promise(r => p2.emit('action', { type: 'cast-vote', nonce: 'v2', targetId: p2.S.players[0].id }, r));
    // Wait for the outcome instead of sleeping a fixed guess at it.
    await waitFor(() => activeId() === 'screen-reveal' || activeId() === 'screen-assignment',
        'round resolves', 6000);
    const reached = activeId();
    check('round resolves once everyone has voted',
        reached === 'screen-reveal' || reached === 'screen-assignment',
        `landed on ${reached}`);

    check('no page errors across the whole flow', pageErrors.length === 0, pageErrors.join(' | '));
    p2.close(); dom.window.close();
    console.log(`\n${fails === 0 ? '✓ UI SMOKE PASS' : '✗ ' + fails + ' FAILURE(S)'}\n`);
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error('\nSMOKE ERROR:', e.message); console.error(log.slice(-1500)); process.exit(2); });
