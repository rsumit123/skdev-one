const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(require('path').join(__dirname, '../../clash.html'), 'utf8');
const start = html.indexOf('<script id="breach-sim">') + '<script id="breach-sim">'.length;
const end = html.indexOf('</script>', start);
const ctx = { window: {}, Math };
vm.runInNewContext(html.slice(start, end), ctx);
const sim = ctx.window.BreachSim(1234, ['A1', 'B1']);

// the original prices, restored: at anything cheaper the upgrade costs a small
// fraction of the 50-coin opening bank and stops being a decision at all
assert.deepStrictEqual(Array.from(sim.state().ecoCosts), [3600, 6300, 9000]);
assert.deepStrictEqual(JSON.parse(JSON.stringify(sim.state().slotEco)), { A1: 0, A2: 0, B1: 0, B2: 0 });
// forts now open EMPTY and earn 1.0/s, so an upgrade has to be saved for
assert.strictEqual(sim.state().slotCoins.A1, 0, 'a fort starts with nothing');
sim.tick([{ op: 'eco', slot: 'A1' }]);
assert.strictEqual(sim.state().slotEco.A1, 0, 'cannot buy an upgrade you have not saved for');
sim.bases.find(b => b.id === 'A1').bc = 3600;      // hand it exactly one upgrade
const before = sim.state().slotCoins.A1;
const hash0 = sim.hash();
sim.tick([{ op: 'eco', slot: 'A1' }]);
assert.strictEqual(sim.state().slotEco.A1, 1);
// the tick also pays that fort its (now ramped) income
assert.strictEqual(sim.state().slotCoins.A1, before - 3600 + sim.state().slotInc.A1);
assert.strictEqual(sim.state().slotEco.B1, 0, 'eco upgrade must not affect teammate');
assert.notStrictEqual(sim.hash(), hash0, 'eco state is included in lockstep hash');
// Max level is deterministic and cannot spend beyond the third upgrade. Fund it
// directly: at 1.0/s a fort cannot earn all three upgrades in a few seconds any
// more, which is the whole point of the ramped economy.
sim.bases.find(b => b.id === 'A1').bc = 999999;
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
