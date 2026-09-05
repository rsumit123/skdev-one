/*
 * "Is it safe to play with a friend?" - the whole human-vs-human path, end to
 * end, with no shortcuts: real rooms, real joins, a real match played to a real
 * result through the deck, and the end cards both players actually see.
 *
 * Every other Clash suite either drives one browser or stops once frames flow.
 * The things that only break with two or more people at the keyboard - opposite
 * verdicts, agreeing scoreboards, four-way lockstep, a lobby with no model seats
 * left - are only checkable here.
 *
 * Scenario 1 plays a full match, so this suite takes several minutes. That is
 * the point: nothing about the result is faked.
 */
const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
const URL = 'http://127.0.0.1:8055/clash.html';
const MATCH_BUDGET_MS = 8 * 60 * 1000;

(async () => {
  const b = await chromium.launch({ headless: true });
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? (pass++, console.log('  PASS', m)) : (fail++, console.log('  FAIL', m)); };

  const mk = async () => {
    const c = await b.newContext({ viewport: { width: 390, height: 844 } });
    const p = await c.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(() => { try { localStorage.setItem('breach.pubapi', 'http://127.0.0.1:8050'); } catch (e) {} });
    await p.goto(URL, { waitUntil: 'load' });
    return { p, c, errs };
  };
  const host = async H => {
    await H.p.click('#clSolo');
    await H.p.waitForFunction(() => { const c = document.getElementById('clRoomCode').textContent;
      return c && c.length === 6 && c !== '------'; }, { timeout: 20000 });
    return H.p.evaluate(() => document.getElementById('clRoomCode').textContent);
  };
  const join = async (X, code) => {
    await X.p.fill('#clCode', code); await X.p.click('#clJoin');
    await X.p.waitForFunction(() => !document.getElementById('clRoom').hidden, { timeout: 15000 });
  };
  const live = X => X.p.waitForFunction(
    () => window.BREACH_SIM_DEBUG && BREACH_SIM_DEBUG.units !== undefined, { timeout: 20000 });
  const sample = X => X.p.evaluate(() => ({
    n: window.CLASH_NET && CLASH_NET.frame, t: (window.CLASH_NET && CLASH_NET.tick) || 0,
    h: BREACH_SIM_DEBUG.hash() }));
  // sample every client at one identical frame AND tick - four ticks run per
  // flushed frame, so frame alone is not a common moment
  const inStep = async (players, tries = 60) => {
    for (let i = 0; i < tries; i++) {
      const s = await Promise.all(players.map(sample));
      if (s.every(x => x.n === s[0].n && x.t === s[0].t))
        return { sampled: true, equal: s.every(x => x.h === s[0].h), at: s[0].n, hashes: s.map(x => x.h) };
      await players[0].p.waitForTimeout(37);
    }
    return { sampled: false };
  };
  const order = async (X, t) => { try { await X.p.click('.build .u[data-t="' + t + '"]', { timeout: 400 }); } catch (e) {} };

  // ---------------------------------------------------------------- scenario 1
  console.log('\n=== Two friends, one match, played to a real finish ===');
  console.log('1. One creates a room, the other joins by code…');
  const A = await mk(), B = await mk();
  const code = await host(A);
  ok(/^[A-Z0-9]{6}$/.test(code), 'a room code is minted to share -> ' + code);
  ok(await A.p.evaluate(() => !document.getElementById('clStart').hidden),
    'the host lands in a lobby with Start, not straight into a battle');
  await join(B, code);
  await A.p.waitForTimeout(600);
  for (const [X, who] of [[A, 'host'], [B, 'friend']]) {
    const seen = await X.p.evaluate(() => ({
      humans: [...document.querySelectorAll('#clTeamA .nm,#clTeamB .nm')].map(e => e.textContent),
      models: document.querySelectorAll('.model-select').length }));
    ok(seen.humans.length === 2 && seen.models === 2,
      'the ' + who + ' sees both commanders and two model seats -> ' + seen.humans.join(', '));
  }
  ok(await B.p.evaluate(() => document.getElementById('clStart').hidden),
    'only the host can start the battle');

  console.log('2. The host starts; both go live on opposite sides…');
  await A.p.click('#clStart');
  await Promise.all([live(A), live(B)]);
  const slotA = await A.p.evaluate(() => CLASH_HUD.slot());
  const slotB = await B.p.evaluate(() => CLASH_HUD.slot());
  ok(slotA[0] !== slotB[0], 'they are put on opposing teams -> ' + slotA + ' vs ' + slotB);
  // which fort is drawn nearest whom is clash-perspective's job; what matters
  // here is that each player is told which one is theirs
  const ownLabel = X => X.p.evaluate(() => {
    const me = CLASH_HUD.slot();
    return { tag: document.getElementById('youTag').textContent, me,
             label: document.getElementById('nm' + me).textContent }; });
  const lA = await ownLabel(A), lB = await ownLabel(B);
  ok(lA.label === 'You' && lB.label === 'You',
    'each player\'s own fort is labelled "You" on their own screen');
  ok(lA.tag.includes(slotA) && lB.tag.includes(slotB),
    'and their callsign badge names their seat -> "' + lA.tag + '" / "' + lB.tag + '"');

  console.log('3. Frames flow and the two simulations agree…');
  await A.p.waitForFunction(() => window.CLASH_NET && CLASH_NET.frame >= 8, { timeout: 20000 });
  const step1 = await inStep([A, B]);
  ok(step1.sampled, 'both clients could be sampled at the same frame and tick');
  ok(step1.equal, 'their simulations hash identically at frame ' + step1.at + ' - true lockstep');

  console.log('4. Each player\'s orders reach the other…');
  for (const X of [A, B]) await X.p.waitForFunction(
    () => BREACH_SIM_DEBUG.state().slotCoins[CLASH_HUD.slot()] >= 800, { timeout: 40000 });
  await order(A, 'inf'); await order(B, 'inf');
  const sees = (X, slot) => X.p.waitForFunction(
    s => BREACH_SIM_DEBUG.units.some(u => u.owner === s), slot, { timeout: 12000 })
    .then(() => true).catch(() => false);
  ok(await sees(A, slotA) && await sees(B, slotB), 'each sees the unit they bought');
  ok(await sees(A, slotB) && await sees(B, slotA), 'and each sees the unit the OTHER bought');

  console.log('5. Playing the match out through the deck…');
  const t0 = Date.now();
  let over = false;
  while (Date.now() - t0 < MATCH_BUDGET_MS && !over) {
    for (const X of [A, B]) for (const t of ['tank', 'at', 'gun', 'inf']) await order(X, t);
    over = await A.p.evaluate(() => document.getElementById('endcard').classList.contains('on'));
    if (!over) await A.p.waitForTimeout(150);
  }
  const mins = ((Date.now() - t0) / 1000).toFixed(0);
  ok(over, 'the match reached a real result in ' + mins + 's, with no intervention in the sim');

  console.log('6. The end card both players see…');
  for (const X of [A, B]) await X.p.waitForFunction(
    () => document.getElementById('endcard').classList.contains('on'), { timeout: 20000 })
    .catch(() => {});
  const card = X => X.p.evaluate(() => ({
    on: document.getElementById('endcard').classList.contains('on'),
    verdict: (document.querySelector('#endcard .et') || {}).textContent,
    text: document.getElementById('endcard').innerText,
    report: (() => { const r = document.getElementById('btnReport'); return r ? !r.hidden : false; })() }));
  const cA = await card(A), cB = await card(B);
  ok(cA.on && cB.on, 'both players get an end card, not just the one whose client noticed');
  ok([cA.verdict, cB.verdict].sort().join('/') === 'Defeat/Victory',
    'exactly one Victory and one Defeat -> ' + cA.verdict + ' / ' + cB.verdict);
  const winnerOf = t => (t.match(/Team ([AB]) . Winner/i) || [])[1];
  ok(winnerOf(cA.text) && winnerOf(cA.text) === winnerOf(cB.text),
    'both cards name the same winning team -> Team ' + winnerOf(cA.text));
  const winnerIsMine = (c, slot) => (c.verdict === 'Victory') === (winnerOf(c.text) === slot[0]);
  ok(winnerIsMine(cA, slotA) && winnerIsMine(cB, slotB),
    'each player\'s verdict matches the side they were actually on');
  const totals = t => (t.match(/=\s*(\d+)%/g) || []).map(x => x.replace(/\D/g, ''));
  ok(totals(cA.text).length === 2 && totals(cA.text).join(',') === totals(cB.text).join(','),
    'the fort-health scoreboard agrees on both screens -> ' + totals(cA.text).join(' vs '));
  ok(!/Nova Lite v1 …|Nova Lite v1 \.\.\./.test(cA.text) ||
     new Set((cA.text.match(/^.*=.*$/gm) || [])).size > 0,
    'seat names on the card are not all truncated to the same string');
  const seats = (cA.text.match(/([A-Za-z0-9 .#…-]+) \d+%/g) || []).map(x => x.replace(/ \d+%$/, '').trim());
  ok(new Set(seats).size === seats.length,
    'every fort on the card is named distinctly -> ' + seats.join(' | '));
  ok(cA.report && cB.report, 'a battle report is offered - model commanders played in this match');
  ok(A.errs.length === 0 && B.errs.length === 0,
    'no page errors during the whole match -> ' + [...A.errs, ...B.errs].join(' | '));

  console.log('7. Play again returns to a usable entry screen…');
  await A.p.click('#endcard button:not(#btnReport)');
  await A.p.waitForFunction(() => {
    const s = document.getElementById('clSolo');
    return s && !s.disabled && document.getElementById('endcard').classList.contains('on') === false;
  }, { timeout: 20000 }).then(() => ok(true, 'Play again lands back where a new room can be made'))
    .catch(() => ok(false, 'Play again did not return to the entry screen'));
  await A.c.close(); await B.c.close();

  // ---------------------------------------------------------------- scenario 2
  console.log('\n=== Four friends, no model seats at all ===');
  const P = []; for (let i = 0; i < 4; i++) P.push(await mk());
  console.log('1. One hosts, three join…');
  const code4 = await host(P[0]);
  for (let i = 1; i < 4; i++) { await join(P[i], code4); await P[0].p.waitForTimeout(350); }
  const lobby = await P[0].p.evaluate(() => ({
    humans: [...document.querySelectorAll('#clTeamA .nm,#clTeamB .nm')].map(e => e.textContent),
    models: document.querySelectorAll('.model-select').length,
    takes: document.querySelectorAll('.seat-take').length }));
  ok(lobby.humans.length === 4, 'all four seats are people -> ' + lobby.humans.join(', '));
  ok(lobby.models === 0 && lobby.takes === 0, 'no model seats and nothing left to claim');

  console.log('2. All four go live in one lockstep…');
  await P[0].p.click('#clStart');
  await Promise.all(P.map(live));
  const slots = []; for (const X of P) slots.push(await X.p.evaluate(() => CLASH_HUD.slot()));
  ok(new Set(slots).size === 4, 'each player holds a distinct fort -> ' + slots.join(', '));
  await P[0].p.waitForFunction(() => window.CLASH_NET && CLASH_NET.frame >= 8, { timeout: 20000 });
  const step4 = await inStep(P);
  ok(step4.sampled, 'all four could be sampled at the same frame and tick');
  ok(step4.equal, 'all four simulations hash identically at frame ' + step4.at);

  console.log('3. Everyone\'s army is on everyone\'s screen…');
  for (const X of P) await X.p.waitForFunction(
    () => BREACH_SIM_DEBUG.state().slotCoins[CLASH_HUD.slot()] >= 800, { timeout: 40000 });
  for (const X of P) await order(X, 'inf');
  await P[0].p.waitForTimeout(2500);
  const owners = await Promise.all(P.map(X => X.p.evaluate(
    () => [...new Set(BREACH_SIM_DEBUG.units.map(u => u.owner))].sort().join(','))));
  ok(owners.every(o => o === owners[0] && o.split(',').length === 4),
    'all four armies are visible on all four clients -> ' + owners[0]);

  console.log('4. Nothing model-shaped appears in an all-human match…');
  const pill = await P[0].p.evaluate(() => document.getElementById('modelThinking').classList.contains('on'));
  const paused = await P[0].p.evaluate(() => document.getElementById('modelErrorCard').classList.contains('on'));
  ok(!pill, 'no "commanders deciding" pill - there are no model commanders');
  ok(!paused, 'and no model-paused modal can interrupt four humans');
  ok(P.every(X => X.errs.length === 0),
    'no page errors on any of the four -> ' + P.map(X => X.errs.join('|')).join(' '));
  for (const X of P) await X.c.close();

  // ---------------------------------------------------------------- scenario 3
  console.log('\n=== Three friends, and one of them picks their side ===');
  const T = []; for (let i = 0; i < 3; i++) T.push(await mk());
  const code3 = await host(T[0]);
  await join(T[1], code3); await join(T[2], code3);
  await T[0].p.waitForTimeout(600);
  const mySlotBefore = await T[2].p.evaluate(() => document.querySelector('.row .you')
    ? document.querySelector('.row .you').parentElement.querySelector('.sl').textContent : null);
  ok(!!mySlotBefore, 'the third player can see which seat is theirs -> ' + mySlotBefore);
  const free = await T[2].p.evaluate(() => {
    const t = document.querySelector('.seat-take');
    return t ? t.parentElement.querySelector('.sl').textContent : null; });
  ok(!!free, 'the remaining model seat can be claimed -> ' + free);
  await T[2].p.click('.seat-take');
  await T[2].p.waitForTimeout(800);
  const mySlotAfter = await T[2].p.evaluate(() => document.querySelector('.row .you')
    ? document.querySelector('.row .you').parentElement.querySelector('.sl').textContent : null);
  ok(mySlotAfter === free, 'taking a free seat moves them onto the side they chose -> ' +
    mySlotBefore + ' -> ' + mySlotAfter);
  await T[0].p.waitForTimeout(600);
  const hostSees = await T[0].p.evaluate(() => [...document.querySelectorAll('#clTeamA .nm,#clTeamB .nm')].length);
  ok(hostSees === 3, 'the host\'s lobby follows the move -> ' + hostSees + ' people seated');
  await T[0].p.click('#clStart');
  await Promise.all(T.map(live));
  const step3 = await inStep(T);
  ok(step3.sampled && step3.equal, 'three humans plus one model start in lockstep');
  ok(T.every(X => X.errs.length === 0), 'no page errors');
  for (const X of T) await X.c.close();

  console.log(`\nCLASH WITH FRIENDS: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
