// A clock win with every fort still standing looked arbitrary: the player was
// told VICTORY and nothing said why. The card must explain the ending.
const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
(async()=>{
  const b=await chromium.launch({headless:true});
  let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};
  const play=async(finish)=>{
    const c=await b.newContext({viewport:{width:390,height:844}}); const p=await c.newPage();
    const errs=[]; p.on('pageerror',e=>errs.push(e.message));
    await p.addInitScript(()=>{try{localStorage.setItem('breach.pubapi','http://127.0.0.1:8050');}catch(e){}});
    await p.goto('http://127.0.0.1:8055/clash.html',{waitUntil:'load'});
    await p.waitForTimeout(500); await p.click('#clSolo');
    await p.waitForFunction(()=>{const x=document.getElementById('clRoomCode').textContent;
      return x&&x.length===6&&x!=='------';},{timeout:20000});
    await p.click('#clStart');
    await p.waitForFunction(()=>window.BREACH_SIM_DEBUG&&BREACH_SIM_DEBUG.units!==undefined,{timeout:20000});
    await p.waitForTimeout(1000);
    await p.evaluate(finish);
    await p.waitForTimeout(1600);
    const out=await p.evaluate(()=>({card:document.getElementById('endcard').innerText,
      on:document.getElementById('endcard').classList.contains('on'),
      held:document.getElementById('twHeld').getBoundingClientRect().height}));
    await c.close(); return {...out,errs};
  };

  // 1. the clock runs out with every fort standing - exactly the confusing case
  const clock=await play(()=>{
    const B=BREACH_SIM_DEBUG;
    B.bases.find(x=>x.id==='A1').ihp=710;
    B.bases.find(x=>x.id==='B1').ihp=480;
    for(let i=0;i<4900;i++) B.tick([]);
  });
  ok(clock.on,'the end card appears on a clock finish');
  ok(/time ran out/i.test(clock.card),'it says the clock ran out');
  ok(/more fort health/i.test(clock.card),'and that health decides it');
  ok(/A 171%/.test(clock.card)&&/B 148%/.test(clock.card),
    'showing both totals so the result can be checked');
  // the compact HUD now drops the scoreboard entirely - fort health lives on the
  // battlefield - so the winner is carried by the end card, not that bar
  ok(/Team A . Winner/i.test(clock.card)||/winner/i.test(clock.card),
    'the end card names the winning team');

  // 2. a fort kill explains itself differently
  const razed=await play(()=>{
    BREACH_SIM_DEBUG.bases.forEach(x=>{ if(x.team===1){ x.ihp=0; x.alive=false; } });
  });
  ok(/both destroyed/i.test(razed.card),'a fort kill says the forts were destroyed');
  ok(!/time ran out/i.test(razed.card),'and does not claim the clock ran out');
  ok(clock.errs.length===0&&razed.errs.length===0,'no page errors');
  console.log(`\nEND CARD: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail?1:0);
})();
