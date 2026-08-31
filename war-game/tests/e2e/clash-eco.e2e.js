const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(require('path').join(__dirname, '../../clash.html'), 'utf8');
const start = html.indexOf('<script id="breach-sim">') + '<script id="breach-sim">'.length;
const end = html.indexOf('</script>', start);
const ctx = { window: {}, Math };
vm.runInNewContext(html.slice(start, end), ctx);
const sim = ctx.window.BreachSim(1234, ['A1', 'B1']);

// repriced 2026-08-31 after the counter matrix: 36/63/90 was a trap (0/8),
// 18/32/45 an auto-buy maxed by 43s (8/8); these win 6/10 and never max out
assert.deepStrictEqual(Array.from(sim.state().ecoCosts), [2100, 3700, 5200]);
assert.deepStrictEqual(JSON.parse(JSON.stringify(sim.state().slotEco)), { A1: 0, A2: 0, B1: 0, B2: 0 });
const before = sim.state().slotCoins.A1;
const hash0 = sim.hash();
sim.tick([{ op: 'eco', slot: 'A1' }]);
assert.strictEqual(sim.state().slotEco.A1, 1);
assert.strictEqual(sim.state().slotCoins.A1, before - 2100 + 36);
assert.strictEqual(sim.state().slotEco.B1, 0, 'eco upgrade must not affect teammate');
assert.notStrictEqual(sim.hash(), hash0, 'eco state is included in lockstep hash');
// Max level is deterministic and cannot spend beyond the third upgrade.
for (let i = 0; i < 400; i++) sim.tick([{ op: 'eco', slot: 'A1' }]);
assert.strictEqual(sim.state().slotEco.A1, 3);
assert.strictEqual(sim.state().slotCoins.A1 >= 0, true);
console.log('clash eco sim: PASS');

// ---- unit counters -------------------------------------------------------
// Every unit did full damage to everything, which made the table a strict
// dominance chain: at equal coins inf beat gun beat tank beat at, 6-0 every
// pairing, and the A-Tank lost to the very thing it is named after.
const dmg = (a, b) => {
  const c = { window: {}, Math };
  vm.runInNewContext(html.slice(start, end), c);
  return c.window.BreachSim(1, ['A1']) && a; // sim builds; matrix asserted below
};
const src = html.slice(start, end);
assert.ok(/var VS=\{/.test(src), 'counter matrix exists');
const VS = JSON.parse(src.match(/var VS=(\{.*?\});/s)[1].replace(/(\w+):/g, '"$1":'));
assert.strictEqual(VS.at.tank, 300, 'the A-Tank must actually counter armour');
assert.ok(VS.inf.tank < 100, 'small arms are weak against armour');
assert.ok(VS.gun.inf > 100, 'gunners shred infantry');
assert.ok(VS.tank.gun > 100, 'armour rolls over gunners');
console.log('clash counters: PASS');
