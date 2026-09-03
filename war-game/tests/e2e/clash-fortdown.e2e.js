// A destroyed fort builds nothing - the simulator has always required the fort
// to be alive - but the deck stayed live, so a tap pulsed gold and queued a unit
// that could never arrive. A false confirmation is worse than no feedback.
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
  // let it bank enough that affordability is not what blocks the tap
  await p.waitForFunction(()=>BREACH_SIM_DEBUG.state().slotCoins.A1>=900,{timeout:40000});
  ok(!await p.evaluate(()=>document.querySelector('.screen').classList.contains('fort-down')),
    'deck is live while the fort stands');

  // destroy the player's own fort
  await p.evaluate(()=>{const m=BREACH_SIM_DEBUG.bases.find(x=>x.id==='A1'); m.ihp=0; m.alive=false;});
  await p.waitForTimeout(600);
  ok(await p.evaluate(()=>document.querySelector('.screen').classList.contains('fort-down')),
    'the deck is marked dead once the fort falls');
  ok(await p.evaluate(()=>getComputedStyle(document.querySelector('.build')).pointerEvents==='none'),
    'unit selectors stop accepting taps');
  ok(await p.evaluate(()=>getComputedStyle(document.getElementById('fortDown')).display!=='none'),
    'and it says why');

  // force the handler anyway: it must refuse, not confirm
  const before=await p.evaluate(()=>BREACH_SIM_DEBUG.units.filter(u=>u.owner==='A1').length);
  await p.evaluate(()=>document.querySelector('.build .u[data-t="inf"]').dispatchEvent(
    new MouseEvent('click',{bubbles:true})));
  await p.waitForTimeout(900);
  ok(!await p.evaluate(()=>document.querySelector('.build .u[data-t="inf"]').classList.contains('ordered')),
    'a tap on a dead fort never shows the gold confirmation');
  ok(await p.evaluate(u=>BREACH_SIM_DEBUG.units.filter(x=>x.owner==='A1').length<=u,before),
    'and no unit is produced');
  ok(errs.length===0,'no page errors: '+JSON.stringify(errs));
  console.log(`\nFORT DOWN: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail?1:0);
})();
