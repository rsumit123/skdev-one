const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const html = fs.readFileSync(require('path').join(__dirname, '../../clash.html'), 'utf8');
const start = html.indexOf('<script id="breach-sim">') + '<script id="breach-sim">'.length;
const end = html.indexOf('</script>', start);
const ctx = { window: {}, Math };
vm.runInNewContext(html.slice(start, end), ctx);
const sim = ctx.window.BreachSim(1234, ['A1', 'B1']);

assert.deepStrictEqual(Array.from(sim.state().ecoCosts), [3600, 6300, 9000]);
assert.deepStrictEqual(JSON.parse(JSON.stringify(sim.state().slotEco)), { A1: 0, A2: 0, B1: 0, B2: 0 });
const before = sim.state().slotCoins.A1;
const hash0 = sim.hash();
sim.tick([{ op: 'eco', slot: 'A1' }]);
assert.strictEqual(sim.state().slotEco.A1, 1);
assert.strictEqual(sim.state().slotCoins.A1, before - 3600 + 36);
assert.strictEqual(sim.state().slotEco.B1, 0, 'eco upgrade must not affect teammate');
assert.notStrictEqual(sim.hash(), hash0, 'eco state is included in lockstep hash');
// Max level is deterministic and cannot spend beyond the third upgrade.
for (let i = 0; i < 400; i++) sim.tick([{ op: 'eco', slot: 'A1' }]);
assert.strictEqual(sim.state().slotEco.A1, 3);
assert.strictEqual(sim.state().slotCoins.A1 >= 0, true);
console.log('clash eco sim: PASS');
