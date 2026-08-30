const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
(async()=>{
  const b=await chromium.launch({headless:true});
  let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};
  const mk=async()=>{const c=await b.newContext({viewport:{width:390,height:844}});const p=await c.newPage();
    await p.addInitScript(()=>{try{localStorage.setItem('breach.pubapi','http://127.0.0.1:8050');}catch(e){}});
    await p.goto('http://127.0.0.1:8055/clash.html',{waitUntil:'load'});return {p,c};};
  const A=await mk(), B=await mk();
  // pre-game HUD must be neutral, not mock leftovers
  const pre=await A.p.evaluate(()=>({hp:[...document.querySelectorAll('.pct')].map(e=>e.textContent),
    clk:document.getElementById('clk').textContent, coins:document.getElementById('coins').textContent,
    inc:document.getElementById('inc').textContent, held:document.getElementById('twHeld').textContent}));
  ok(pre.hp.every(h=>h==='100%'),'pre-game base HP all 100% (was 82/61/74/69) -> '+pre.hp.join(','));
  ok(pre.clk==='4:00','pre-game clock 4:00 (was 1:52)');
  ok(pre.coins==='0'&&pre.inc==='—','pre-game coins 0, no fake eco (was 140 / +3.6/s eco 2)');
  ok(!/holds/.test(pre.held),'pre-game tower not "Team B holds" -> "'+pre.held+'"');
  // multiplayer: real names in the scoreboard
  await A.p.click('#clCreate');
  await A.p.waitForFunction(()=>{const c=document.getElementById('clRoomCode').textContent;return c&&c.length===6&&c!=='------';},{timeout:20000});
  const code=await A.p.evaluate(()=>document.getElementById('clRoomCode').textContent);
  await B.p.fill('#clCode',code); await B.p.click('#clJoin');
  await B.p.waitForFunction(()=>!document.getElementById('clRoom').hidden,{timeout:15000});
  await A.p.click('#clStart');
  await A.p.waitForFunction(()=>window.BREACH_SIM_DEBUG&&document.getElementById('clashLobby').classList.contains('off'),{timeout:15000});
  await A.p.waitForTimeout(2500);
  const names=await A.p.evaluate(()=>['A1','A2','B1','B2'].map(s=>document.getElementById('nm'+s).textContent));
  ok(names[0]==='You','my slot shows "You" -> '+names[0]);
  ok(names[1]==='AI Commander'&&names[3]==='AI Commander','empty slots show "AI Commander"');
  ok(names[2]&&names[2]!=='B1'&&names[2]!=='AI Commander','opponent shows their real name -> "'+names[2]+'"');
  const live=await A.p.evaluate(()=>({coins:+document.getElementById('coins').textContent,
    inc:document.getElementById('inc').textContent, clk:document.getElementById('clk').textContent}));
  ok(live.coins>=50&&live.coins<200,'coins start ~50 and tick up -> '+live.coins);
  ok(/^\+6\.0\/s/.test(live.inc),'income shows the real rate -> '+live.inc);
  ok(live.clk!=='4:00','clock is actually running -> '+live.clk);
  console.log(`HUD: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail?1:0);
})();
