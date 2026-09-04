/*
 * Battle report: the post-match "what did the models think" view.
 *
 * Playing a real 10-minute match here would make this suite unusable, and the
 * server side (participant-only access, 404 for strangers) is covered by
 * tests/test_clash_replays.py. What is only testable in a browser is the part
 * that lives in the browser: the deep link, the deterministic re-simulation of
 * a stored match, and the rendering of untrusted model text. So the replay
 * endpoint is stubbed with a hand-built match and the rendering is checked.
 */
const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
const URL = 'http://127.0.0.1:8055/clash.html';
// api() sends credentials, so a wildcard ACAO is rejected by the browser.
const CORS = { 'access-control-allow-origin': 'http://127.0.0.1:8055',
               'access-control-allow-credentials': 'true' };

// A tiny but real input log: B1 buys three gunners, A1 buys a tank. The client
// replays this through the shipped simulator, so the numbers in the report are
// produced by the same code that produced the battle.
const buy = (slot, t) => ({ op: 'buy', slot, t });
const LOG = [
  { n: 1, inputs: { A1: [buy('A1', 'tank')], B1: [buy('B1', 'gun')] } },
  { n: 2, inputs: {} },
  { n: 3, inputs: { B1: [buy('B1', 'gun'), buy('B1', 'gun')] } },
  ...Array.from({ length: 60 }, (_, i) => ({ n: 4 + i, inputs: {} })),
];
const REPLAY = {
  roomCode: 'TEST01', seed: 987654321, winnerTeam: 1, reason: 'timecap',
  endedAt: '2026-09-04T10:00:00Z',
  roster: {
    A1: { kind: 'guest', name: 'Guest12:Sumit' },
    A2: { kind: 'model', modelId: 'amazon/nova-lite-v1' },
    B1: { kind: 'model', modelId: 'google/gemini-3.5-flash-lite' },
    B2: { kind: 'model', modelId: 'openai/gpt-5-mini' },
  },
  modelLog: [
    { frame: 25, ms: 2100,
      why: { A2: 'Holding the tower is worth more than trading units right now.' },
      commands: { A2: [{ op: 'buy', t: 'at' }, { op: 'stance', v: 0 }] } },
    { frame: 75, ms: 4400,
      // model text is untrusted: this must land as literal characters, not markup
      why: { B1: 'Their <b>tank</b> push needs AT & I am saving for eco.' },
      commands: { B1: [{ op: 'eco' }] } },
  ],
  log: LOG,
};

(async () => {
  const b = await chromium.launch({ headless: true });
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? (pass++, console.log('  PASS', m)) : (fail++, console.log('  FAIL', m)); };

  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  let asked = null, method = null;
  await p.route('**/v1/clash/replay/**', route => {
    asked = route.request().url(); method = route.request().method();
    route.fulfill({ status: 200, contentType: 'application/json',
      headers: CORS, body: JSON.stringify(REPLAY) });
  });
  await p.addInitScript(() => { try { localStorage.setItem('breach.pubapi', 'http://127.0.0.1:8050'); } catch (e) {} });

  console.log('1. #report=CODE deep-links straight into the report…');
  await p.goto(URL + '#report=TEST01', { waitUntil: 'load' });
  await p.waitForFunction(() => document.getElementById('reportView').classList.contains('on'), { timeout: 10000 });
  await p.waitForFunction(() => !/Loading/.test(document.getElementById('rpBody').textContent), { timeout: 10000 });
  ok(!!asked && asked.includes('TEST01'), 'fetched the replay for the code in the hash -> ' + asked);
  // the endpoint is a GET; the page's default api() helper is POST-only and
  // would have earned a 405 against the real backend
  ok(method === 'GET', 'asked with the method the endpoint actually serves -> ' + method);

  const txt = await p.evaluate(() => document.getElementById('rpBody').textContent);

  console.log('2. The verdict reads from the stored result…');
  ok(/Defeat/.test(txt), 'an A1 player who lost to team B sees "Defeat"');
  ok(/on the clock/.test(txt), 'a timecap match says it ended on the clock');

  console.log('3. Numbers come from re-simulating the stored log…');
  ok(/1 tank/.test(txt), 'A1 is credited with the tank it bought -> ' + (txt.match(/built [^\n]*/) || [''])[0]);
  ok(/3 gun/.test(txt), 'B1 is credited with all three gunners');
  ok(/Fort health at the end/.test(txt), 'final fort health is reported');
  ok(/Tower held/.test(txt), 'tower control is reported');

  console.log('4. Turn by turn shows reasoning next to the orders…');
  ok(/Holding the tower is worth more/.test(txt), 'the first window\'s reasoning is shown');
  ok(/buy at/.test(txt) && /stance/.test(txt), 'the orders that reasoning produced are shown alongside it');
  ok(/5s/.test(txt) && /15s/.test(txt), 'windows are stamped with match time (frame/5)');
  ok(/2100ms/.test(txt), 'how long the model took is shown');

  console.log('5. Model text is untrusted…');
  const injected = await p.evaluate(() => document.querySelectorAll('#rpBody b').length);
  ok(injected === 0, 'a <b> in a model rationale renders as text, not markup');
  ok(/<b>tank<\/b>/.test(txt), 'the raw characters are still shown to the reader');

  console.log('6. Names, not slot codes…');
  ok(!/\bA2\b/.test(txt) && /nova-lite/.test(txt), 'model seats are named by model, not "A2"');
  ok(/Sumit/.test(txt) && !/Guest12:/.test(txt), 'the guest prefix is stripped from human names');

  console.log('7. A missing report explains itself…');
  await p.unroute('**/v1/clash/replay/**');
  await p.route('**/v1/clash/replay/**', route => route.fulfill({
    status: 404, contentType: 'application/json',
    headers: CORS, body: '{"error":"replay_not_found"}' }));
  // a hash-only change does not reload, so this needs a real navigation away first
  await p.goto('about:blank');
  await p.goto(URL + '#report=NOPE99', { waitUntil: 'load' });
  await p.waitForFunction(() => /predate|Could not/.test(document.getElementById('rpBody').textContent), { timeout: 10000 })
    .then(() => ok(true, '404 renders a plain explanation, not a spinner forever'))
    .catch(() => ok(false, '404 left the report stuck'));

  console.log('8. A match too big to store in full still renders…');
  // over the storage cap the server saves {truncated:true} in place of the
  // arrays; that must degrade, not throw
  await p.unroute('**/v1/clash/replay/**');
  await p.route('**/v1/clash/replay/**', route => route.fulfill({
    status: 200, contentType: 'application/json', headers: CORS,
    body: JSON.stringify({ ...REPLAY, log: { truncated: true }, modelLog: { truncated: true } }) }));
  await p.goto('about:blank');
  await p.goto(URL + '#report=TEST01', { waitUntil: 'load' });
  await p.waitForFunction(() => /No model seats|Turn by turn/.test(document.getElementById('rpBody').textContent), { timeout: 10000 })
    .then(() => ok(true, 'a truncated replay still renders the verdict and turn-by-turn section'))
    .catch(() => ok(false, 'a truncated replay broke the report'));
  ok(/Defeat/.test(await p.evaluate(() => document.getElementById('rpBody').textContent)),
    'the verdict survives a truncated log');

  console.log('9. Two seats on the same model are told apart…');
  // both B seats being the same model is the common case, and "google/
  // gemini-3.7-flash" twice tells the reader nothing about who did what
  const dupRoster = { ...REPLAY.roster,
    B1: { kind: 'model', modelId: 'google/gemini-3.7-flash' },
    B2: { kind: 'model', modelId: 'google/gemini-3.7-flash' } };
  await p.unroute('**/v1/clash/replay/**');
  await p.route('**/v1/clash/replay/**', route => route.fulfill({
    status: 200, contentType: 'application/json', headers: CORS,
    body: JSON.stringify({ ...REPLAY, roster: dupRoster }) }));
  await p.goto('about:blank');
  await p.goto(URL + '#report=TEST01', { waitUntil: 'load' });
  await p.waitForFunction(() => /Fort health/.test(document.getElementById('rpBody').textContent), { timeout: 10000 });
  const dup = await p.evaluate(() => document.getElementById('rpBody').textContent);
  ok(/gemini-3\.7-flash #1/.test(dup) && /gemini-3\.7-flash #2/.test(dup),
    'identical model seats are numbered');
  ok(!/google\//.test(dup), 'the vendor prefix is dropped - it is the same for both');
  ok(!/nova-lite-v1 #/.test(dup), 'a seat with a unique model is not numbered');

  ok(errs.length === 0, 'no page errors -> ' + errs.join(' | '));
  console.log(`\nCLASH REPORT: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
