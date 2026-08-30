const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../clash.html'), 'utf8');
let pass = 0, fail = 0;
const ok = (condition, message) => condition
  ? (pass++, console.log('  PASS', message))
  : (fail++, console.log('  FAIL', message));

// These assertions protect the player-visible contract: an open seat must show
// the configured real model, the host can change it, and a model failure gives
// players an explicit recovery path rather than silently running scripted AI.
ok(html.includes('model-select'), 'empty model seats have a dedicated selector control');
ok(html.includes("emitAck('clash:model'"), 'host selection emits clash:model');
ok(html.includes("sk.on('clash:model_error'"), 'client listens for model failures');
ok(html.includes("emitAck('clash:model_retry'"), 'failure UI can request a model retry');
ok(html.includes('Nova Lite'), 'Nova Lite is presented as the default model');

const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
for (const [i, match] of scripts.entries()) {
  try { new vm.Script(match[1], { filename: `clash-inline-${i + 1}.js` }); ok(true, `inline script ${i + 1} parses`); }
  catch (error) { ok(false, `inline script ${i + 1} parses: ${error.message}`); }
}

console.log(`Clash model lobby: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
