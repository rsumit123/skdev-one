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

// ---- stance is per fort ---------------------------------------------------
// It used to be team-wide, so a model teammate's stance command overwrote a
// human's every decision window: you tapped Hold and your units marched anyway.
{
  const c2 = { window: {}, Math };
  vm.runInNewContext(html.slice(start, end), c2);
  const sim2 = c2.window.BreachSim(9, ['A1', 'A2', 'B1', 'B2']);
  sim2.tick([{ op: 'stance', v: 1, slot: 'A1' }]);
  assert.strictEqual(sim2.state().slotStance.A1, 1, 'A1 holds');
  // the teammate model does what it does every four seconds
  sim2.tick([{ op: 'stance', v: 0, slot: 'A2' }]);
  assert.strictEqual(sim2.state().slotStance.A1, 1,
    "a teammate's stance must not overwrite yours");
  assert.strictEqual(sim2.state().slotStance.A2, 0, 'and their own fort follows them');
  // an enemy cannot touch it either
  sim2.tick([{ op: 'stance', v: 0, slot: 'B1' }]);
  assert.strictEqual(sim2.state().slotStance.A1, 1, 'nor can the enemy');
  // stance is part of the lockstep hash, per fort
  const h1 = sim2.hash();
  sim2.tick([{ op: 'stance', v: 0, slot: 'A1' }]);
  assert.notStrictEqual(sim2.hash(), h1, 'stance changes are hashed');
  console.log('clash stance: PASS');
}

// ---- hold actually holds ---------------------------------------------------
// "Hold tower" chased anything within CHASE_R (150 grid units) - most of the way
// to the enemy fort - so a holding unit wandered downfield and was
// indistinguishable from a pushing one.
{
  const where = (stance) => {
    const c3 = { window: {}, Math };
    vm.runInNewContext(html.slice(start, end), c3);
    const sim3 = c3.window.BreachSim(11, ['A1', 'A2', 'B1', 'B2']);
    const FP = sim3.FP;
    sim3.tick([{ op: 'stance', v: stance, slot: 'A1' }]);
    for (let t = 1; t < 2000; t++) {
      const ins = [];
      // only A1 buys, so nothing intercepts: this measures where units CHOOSE to go
      if (t % 100 === 0 && sim3.state().slotCoins.A1 >= 800)
        ins.push({ op: 'buy', t: 'inf', slot: 'A1' });
      sim3.tick(ins);
    }
    const mine = sim3.units.filter(u => u.owner === 'A1');
    return mine.length ? mine.reduce((s, u) => s + u.iy / FP, 0) / mine.length : -1;
  };
  const push = where(0), hold = where(1);
  // A1's fort is at y=83, the tower at y=260, the enemy forts at y=437
  assert.ok(push > 330, `push should march on the enemy fort, got y=${Math.round(push)}`);
  assert.ok(hold > 150 && hold < 300, `hold should garrison the tower, got y=${Math.round(hold)}`);
  assert.ok(push - hold > 120, `push and hold must be clearly different (${Math.round(push)} vs ${Math.round(hold)})`);
  console.log(`clash hold: PASS (push y=${Math.round(push)}, hold y=${Math.round(hold)})`);
}

// ---- clock ----------------------------------------------------------------
{
  const c4 = { window: {}, Math };
  vm.runInNewContext(html.slice(start, end), c4);
  const sim4 = c4.window.BreachSim(1, ['A1', 'A2', 'B1', 'B2']);
  assert.strictEqual(sim4.state().clockLeft, 600, 'a match is ten minutes');
  console.log('clash clock: PASS (10:00)');
}

// ---- no friendly fire -----------------------------------------------------
// Both of team A's forts pump units into the same middle and are told to hold,
// so they crowd together. With no enemy ever bought, ANY hp loss is friendly fire.
{
  const c5 = { window: {}, Math };
  vm.runInNewContext(html.slice(start, end), c5);
  const sim5 = c5.window.BreachSim(3, ['A1', 'A2', 'B1', 'B2']);
  const hp = new Map();
  let hits = 0;
  sim5.tick([{ op: 'stance', v: 1, slot: 'A1' }, { op: 'stance', v: 1, slot: 'A2' }]);
  for (let t = 1; t < 2200; t++) {
    const ins = [];
    if (t % 60 === 0) for (const sl of ['A1', 'A2'])
      if (sim5.state().slotCoins[sl] >= 800) ins.push({ op: 'buy', t: 'inf', slot: sl });
    sim5.tick(ins);
    for (const u of sim5.units) {
      if (u.team !== 0) continue;
      const prev = hp.get(u.id);
      if (prev !== undefined && u.hp < prev) hits++;
      hp.set(u.id, u.hp);
    }
  }
  assert.strictEqual(sim5.units.filter(u => u.team === 1).length, 0, 'no enemy was ever bought');
  assert.ok(sim5.units.filter(u => u.team === 0).length > 20, 'a real crowd of friendlies formed');
  assert.strictEqual(hits, 0, `allies must never damage each other (${hits} hits)`);
  console.log(`clash friendly fire: PASS (${sim5.units.filter(u => u.team === 0).length} allies packed together, 0 hits)`);
}
