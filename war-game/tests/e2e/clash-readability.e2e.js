/*
 * What the battlefield tells you at a glance.
 *
 * Three of the four forts are routinely the same model. The board used to label
 * all of them "Amazon Nova ..." - the vendor is the half that survives
 * truncation and the half that identifies nobody - and the attack buttons said
 * "B1 . NOVA LITE" against those labels, so picking a target and then finding
 * it on the map was a puzzle. Separately, the tower income banner was set once
 * at kickoff and never taken down, sitting over a fort in the brightest colour
 * on screen for the whole match.
 */
const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
const URL = 'http://127.0.0.1:8055/clash.html';

(async () => {
  const b = await chromium.launch({ headless: true });
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? (pass++, console.log('  PASS', m)) : (fail++, console.log('  FAIL', m)); };

  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.addInitScript(() => { try { localStorage.setItem('breach.pubapi', 'http://127.0.0.1:8050'); } catch (e) {} });
  await p.goto(URL, { waitUntil: 'load' });

  console.log('1. A solo room fills three seats with the same model…');
  await p.click('#clSolo');
  await p.waitForFunction(() => !document.getElementById('clRoom').hidden, { timeout: 20000 });
  await p.click('#clStart');
  await p.waitForFunction(() => window.BREACH_SIM_DEBUG, { timeout: 20000 });
  await p.waitForTimeout(2500);

  const names = await p.evaluate(() => Object.values(CLASH_HUD.short()));
  const dupes = await p.evaluate(() => {
    const raw = Object.values(CLASH_HUD.names());
    return raw.length - new Set(raw).size;   // how many collided before shortening
  });
  console.log('   seats -> ' + JSON.stringify(names) + ' (raw collisions: ' + dupes + ')');

  console.log('2. Every fort is distinguishable…');
  ok(new Set(names).size === 4, 'all four seat labels are distinct -> ' + names.join(' | '));
  ok(!names.some(n => /^(Amazon|Google|Microsoft|Qwen|OpenAI)\s/i.test(n)),
    'the vendor prefix is dropped from model names');
  ok(dupes > 0 ? names.some(n => / #\d$/.test(n)) : true,
    'seats that would collide are numbered');

  console.log('3. The attack buttons say what the map says…');
  const btns = await p.evaluate(() => [...document.querySelectorAll('#targetBtns button')].map(x => x.textContent));
  const mine = await p.evaluate(() => CLASH_HUD.slot());
  const foes = await p.evaluate(() => { const sh = CLASH_HUD.short(), me = CLASH_HUD.slot();
    return Object.keys(sh).filter(s => s[0] !== me[0]).map(s => sh[s]); });
  ok(foes.every(f => btns.includes(f)),
    'each enemy button carries that fort\'s own label -> ' + btns.join(' | '));
  ok(!btns.some(t => new RegExp('^[AB][12] ').test(t)),
    'no slot codes in the deck - the map does not use them either');
  ok(btns.some(t => /Nearest/i.test(t)), '"Nearest" is still offered');

  console.log('4. Nothing is clipped at 390px…');
  const clipped = await p.evaluate(() => [...document.querySelectorAll('#targetBtns button')]
    .filter(x => x.scrollWidth > x.clientWidth + 1).map(x => x.textContent));
  ok(clipped.length === 0, 'attack buttons fit their text -> ' + (clipped.join(' | ') || 'none clipped'));

  console.log('5. The tower banner is an announcement, not furniture…');
  const toast = await p.evaluate(() => {
    const t = document.getElementById('bonusToast');
    return { on: t.classList.contains('on'), opacity: getComputedStyle(t).opacity };
  });
  ok(toast.on === false && toast.opacity === '0',
    'it is not showing while nothing has changed hands -> opacity ' + toast.opacity);
  // force a change of hands and watch it appear, then leave
  const shown = await p.evaluate(async () => {
    CLASH_HUD.announceTower(1 - CLASH_HUD.team());
    const t = document.getElementById('bonusToast');
    const up = t.classList.contains('on') && t.textContent.length > 0;
    await new Promise(r => setTimeout(r, 3000));
    return { up, text: t.textContent, still: t.classList.contains('on') };
  });
  ok(shown.up, 'a change of hands announces itself -> "' + shown.text + '"');
  ok(shown.still === false, 'and takes itself down again within a few seconds');

  console.log('6. The permanent overlays step back once the battle is under way…');
  const settled = await p.evaluate(() => document.querySelector('.arena').classList.contains('settled'));
  ok(settled === false, 'your callsign and the exit link are at full strength at kickoff');
  await p.waitForFunction(() => document.querySelector('.arena').classList.contains('settled'), { timeout: 12000 })
    .then(() => ok(true, 'and dim a few seconds in, leaving the battlefield to the battle'))
    .catch(() => ok(false, 'they never dimmed'));
  await p.waitForTimeout(1200);   // the fade is .8s; sampling mid-transition reads ~1
  const dim = await p.evaluate(() => getComputedStyle(document.getElementById('youTag')).opacity);
  ok(parseFloat(dim) < 0.6 && parseFloat(dim) > 0.2, 'dimmed but still readable -> opacity ' + dim);

  console.log('7. The "deciding" pill is off the fighting lane…');
  const pill = await p.evaluate(() => {
    const el = document.getElementById('modelThinking');
    const a = document.querySelector('.arena').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const tower = { y: a.top + a.height / 2 };
    return { mid: r.top + r.height / 2 - a.top, arena: a.height, towerGap: Math.abs(r.top + r.height / 2 - tower.y) };
  });
  ok(pill.towerGap > 60, 'it does not land on the tower at the centre of the board -> ' +
    Math.round(pill.towerGap) + 'px clear');

  ok(errs.length === 0, 'no page errors -> ' + errs.join(' | '));
  console.log(`\nREADABILITY: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
