#!/usr/bin/env node
/*
 * Replay a finished Clash match and print what actually happened.
 *
 * The simulator is deterministic, so the seed plus the server's ordered input
 * log reproduces the battle frame for frame - this is the real match, not a
 * reconstruction. Pull a row from the backend and feed it in:
 *
 *   ssh ssh-social 'cd ~/breach-api && docker compose exec -T breach-api \
 *     python -c "import sqlite3,json;c=sqlite3.connect(\"file:/data/breach.db?mode=ro\",uri=True);\
 *     c.row_factory=sqlite3.Row;r=c.execute(\"SELECT * FROM clash_replays ORDER BY id DESC LIMIT 1\").fetchone();\
 *     print(json.dumps(dict(r)))"' > match.json
 *
 *   node tools/replay.js match.json
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = process.argv[2];
if (!file) { console.error('usage: node tools/replay.js <replay.json>'); process.exit(2); }

const replay = JSON.parse(fs.readFileSync(file, 'utf8'));
const j = v => (typeof v === 'string' ? JSON.parse(v) : v);
const log = j(replay.log) || [];
const roster = j(replay.roster) || {};
const modelLog = j(replay.model_log) || [];
if (!replay.seed || !Array.isArray(log)) { console.error('replay has no seed/log'); process.exit(1); }
if (log.truncated) { console.error('note: input log was truncated when saved'); }

// load the shipped simulator
const html = fs.readFileSync(path.join(__dirname, '..', 'clash.html'), 'utf8');
const s = html.indexOf('<script id="breach-sim">') + '<script id="breach-sim">'.length;
const ctx = { window: {}, Math };
vm.runInNewContext(html.slice(s, html.indexOf('</script>', s)), ctx);

const SLOTS = ['A1', 'A2', 'B1', 'B2'];
const sim = ctx.window.BreachSim(replay.seed, SLOTS);
const who = sl => {
  const r = roster[sl] || {};
  return (r.name || r.modelId || sl).replace(/^Guest\d+:/, '');
};

console.log(`Clash replay  room ${replay.room_code}  seed ${replay.seed}`);
console.log(`  A: ${who('A1')} + ${who('A2')}`);
console.log(`  B: ${who('B1')} + ${who('B2')}`);
console.log(`  recorded winner: ${replay.winner_team === 0 ? 'TEAM A' :
  replay.winner_team === 1 ? 'TEAM B' : 'none/disputed'}  (${replay.reason})\n`);

const spend = {}, unitsBought = {};
for (const sl of SLOTS) { spend[sl] = 0; unitsBought[sl] = { inf: 0, gun: 0, at: 0, tank: 0, eco: 0 }; }
const flatten = fr => [].concat(...Object.values(fr.inputs || {}));

let tick = 0, lastReport = -1;
const row = [];
for (const frame of log) {
  const ins = flatten(frame);
  for (const i of ins) {
    if (i.op === 'buy' && unitsBought[i.slot]) { unitsBought[i.slot][i.t]++; }
    if (i.op === 'eco' && unitsBought[i.slot]) { unitsBought[i.slot].eco++; }
  }
  // the client advances exactly four sim ticks per flushed frame
  sim.tick(ins); sim.tick([]); sim.tick([]); sim.tick([]);
  tick += 4;
  const sec = Math.floor(tick / 20);
  if (sec % 15 === 0 && sec !== lastReport) {
    lastReport = sec;
    const st = sim.state();
    const live = { A1: 0, A2: 0, B1: 0, B2: 0 };
    for (const u of sim.units) if (live[u.owner] !== undefined) live[u.owner]++;
    row.push({
      sec,
      hp: sim.bases.map(b => Math.round(b.ihp / 10)),
      coins: SLOTS.map(k => Math.round(st.slotCoins[k] / 100)),
      units: SLOTS.map(k => live[k]),
      eco: SLOTS.map(k => st.slotEco[k]),
    });
  }
  if (sim.state().over) break;
}

console.log('  time |        base HP        |       coins held      |    units alive    | eco');
console.log('  -----+-----------------------+-----------------------+-------------------+-----');
for (const r of row) {
  const pad = (a, w) => a.map(v => String(v).padStart(w)).join(' ');
  console.log(`  ${String(r.sec).padStart(4)}s| ${pad(r.hp, 4)} | ${pad(r.coins, 4)} | ${pad(r.units, 3)} | ${r.eco.join('')}`);
}

const st = sim.state();
console.log(`\n  ended: ${st.over ? 'yes' : 'no (log ran out)'}  winner=${
  st.winner === 0 ? 'TEAM A' : st.winner === 1 ? 'TEAM B' : 'draw'}  at ${Math.floor(tick / 20)}s`);
if (replay.winner_team !== null && replay.winner_team !== undefined && st.over
    && st.winner !== replay.winner_team) {
  console.log('  !! replayed winner disagrees with the recorded one - desync or tampering');
}

console.log('\n  what each seat bought:');
for (const sl of SLOTS) {
  const b = unitsBought[sl];
  console.log(`    ${sl} ${who(sl).padEnd(24)} inf ${String(b.inf).padStart(3)}  gun ${String(b.gun).padStart(3)}` +
    `  at ${String(b.at).padStart(3)}  tank ${String(b.tank).padStart(3)}  eco ${b.eco}`);
}

if (modelLog.length && !modelLog.truncated) {
  const fails = modelLog.filter(w => w.error);
  const times = modelLog.filter(w => w.ms).map(w => w.ms).sort((a, b) => a - b);
  console.log(`\n  model decision windows: ${modelLog.length}` +
    (times.length ? `  median ${times[Math.floor(times.length / 2)]}ms  slowest ${times[times.length - 1]}ms` : ''));
  if (fails.length) {
    const by = {};
    for (const f of fails) by[f.error] = (by[f.error] || 0) + 1;
    console.log(`  FAILED windows: ${fails.length} -> ${JSON.stringify(by)}`);
  }
}
