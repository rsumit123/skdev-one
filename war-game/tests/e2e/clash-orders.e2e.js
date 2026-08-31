// An order the fort could not afford used to be sent and dropped in silence -
// 48% of one player's gun orders in a real recorded match. Every tap must now
// answer: confirmed, or refused with the reason.
const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
(async()=>{
  const b=await chromium.launch({headless:true});
  let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};
  const c=await b.newContext({viewport:{width:390,height:844}}); const p=await c.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.addInitScript(()=>{try{localStorage.setItem('breach.pubapi','http://127.0.0.1:8050');}catch(e){}});
  await p.goto('http://127.0.0.1:8055/clash.html',{waitUntil:'load'});
  await p.waitForTimeout(500); await p.click('#clSolo');
  await p.waitForFunction(()=>{const x=document.getElementById('clRoomCode').textContent;
    return x&&x.length===6&&x!=='------';},{timeout:20000});
  await p.click('#clStart');
  await p.waitForFunction(()=>window.BREACH_SIM_DEBUG&&BREACH_SIM_DEBUG.units!==undefined,{timeout:20000});

  // a fort opens empty, so a tank (45) is unaffordable: it must REFUSE, loudly
  await p.click('.build .u[data-t="tank"]');
  const refused=await p.evaluate(()=>({
    shook:document.querySelector('.build .u[data-t="tank"]').classList.contains('refused'),
    msg:document.getElementById('orderMsg').textContent,
    shown:document.getElementById('orderMsg').classList.contains('on')}));
  ok(refused.shook,'an unaffordable order visibly refuses');
  ok(refused.shown&&/not enough coins/i.test(refused.msg),'and says why -> "'+refused.msg+'"');
  ok(/need \d+ more/i.test(refused.msg),'including the shortfall');

  // nothing was sent to the server for it
  const unitsAfterRefusal=await p.evaluate(()=>BREACH_SIM_DEBUG.units.length);
  await p.waitForTimeout(900);
  ok(await p.evaluate(u=>BREACH_SIM_DEBUG.units.length===u,unitsAfterRefusal),
    'a refused order does not reach the simulator');

  // wait until infantry is affordable, then the tap must CONFIRM and queue
  await p.waitForFunction(()=>BREACH_SIM_DEBUG.state().slotCoins.A1>=900,{timeout:40000});
  await p.click('.build .u[data-t="inf"]');
  const accepted=await p.evaluate(()=>({
    pulsed:document.querySelector('.build .u[data-t="inf"]').classList.contains('ordered'),
    queued:document.querySelector('.build .u[data-t="inf"]').classList.contains('queued')}));
  ok(accepted.pulsed,'an accepted order confirms on the tile');
  ok(accepted.queued,'and shows it is queued until the sim executes it');
  ok(await p.waitForFunction(()=>BREACH_SIM_DEBUG.units.some(u=>u.owner==='A1'),{timeout:9000})
      .then(()=>true).catch(()=>false),'the ordered unit actually arrives');

  ok(errs.length===0,'no page errors: '+JSON.stringify(errs));
  console.log(`\nORDERS: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail?1:0);
})();
