const fs = require('fs');
const vm = require('vm');
const path = require('path');

const file = path.join(__dirname, '../../clash.html');
const html = fs.readFileSync(file, 'utf8');
let pass = 0, fail = 0;
const ok = (c, m) => c ? (pass++, console.log('  PASS', m)) : (fail++, console.log('  FAIL', m));

ok(html.includes("sk.on('clash:over',onNetOver)"), 'subscribes to clash:over');
ok(html.includes("sk.on('clash:result',onNetOver)"), 'subscribes to clash:result');
ok(html.includes("emitAck('clash:resume'"), 'reconnect sends clash:resume');
ok(html.includes('lastFrame:lastFrameN'), 'resume includes last applied frame');
ok(html.includes('r.frames||r.replay'), 'resume replays queued frames');
ok(html.includes('id="resultSummary"'), 'results card has a summary region');

// Every inline script should remain syntactically valid after the wiring changes.
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
for (const [i, match] of scripts.entries()) {
  try { new vm.Script(match[1], { filename: `clash-inline-${i}.js` }); ok(true, `inline script ${i + 1} parses`); }
  catch (e) { ok(false, `inline script ${i + 1} parses: ${e.message}`); }
}
console.log(`Clash reconnect/results: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
