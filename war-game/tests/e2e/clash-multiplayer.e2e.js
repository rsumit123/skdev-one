const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
const URL='http://127.0.0.1:8055/clash.html';
(async()=>{
  const b=await chromium.launch({headless:true});
  let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};
  const mk=async()=>{ const ctx=await b.newContext({viewport:{width:390,height:844}});
    const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
    // point clash at the local backend
    await p.addInitScript(()=>{ try{localStorage.setItem('breach.pubapi','http://127.0.0.1:8050');}catch(e){} });
    await p.goto(URL,{waitUntil:'load'}); return {p,errs,ctx}; };

  console.log('1. Two players open Clash…');
  const A=await mk(), B=await mk();
  await A.p.waitForTimeout(800);
  ok(A.errs.length===0&&B.errs.length===0,'no page errors on load');

  console.log('2. A creates a room, B joins by code…');
  await A.p.click('#clSolo');
  await A.p.waitForFunction(()=>{const c=document.getElementById('clRoomCode').textContent;return c&&c.length===6&&c!=='------';},{timeout:20000});
  const code=await A.p.evaluate(()=>document.getElementById('clRoomCode').textContent);
  ok(/^[A-Z0-9]{6}$/.test(code),'room code minted: '+code);
  await B.p.fill('#clCode',code); await B.p.click('#clJoin');
  await B.p.waitForFunction(()=>!document.getElementById('clRoom').hidden,{timeout:15000});
  // rows live under the per-team boxes now; a human row carries .nm, a model
  // row carries the model picker instead.
  const slots=await A.p.evaluate(()=>({
    humans:[...document.querySelectorAll('#clTeamA .nm,#clTeamB .nm')].map(e=>e.textContent),
    models:document.querySelectorAll('#clTeamA .model-select,#clTeamB .model-select').length}));
  ok(slots.humans.length===2&&slots.models===2,
    '2 humans + 2 model slots shown -> '+slots.humans.join(',')+' + '+slots.models+' models');

  console.log('3. Host starts — both go live in lockstep…');
  await A.p.click('#clStart');
  await A.p.waitForFunction(()=>window.BREACH_SIM_DEBUG&&BREACH_SIM_DEBUG.units!==undefined,{timeout:15000});
  await B.p.waitForFunction(()=>window.BREACH_SIM_DEBUG&&BREACH_SIM_DEBUG.units!==undefined,{timeout:15000});
  const meA=await A.p.evaluate(()=>document.getElementById('youTag').textContent);
  const meB=await B.p.evaluate(()=>document.getElementById('youTag').textContent);
  ok(meA.includes('A1')&&meB.includes('B1'),'slots assigned: '+meA+' / '+meB);
  await A.p.waitForTimeout(4000);
  await A.p.waitForFunction(()=>window.CLASH_NET&&CLASH_NET.frame>=5,{timeout:15000});
  const fA=await A.p.evaluate(()=>CLASH_NET.frame);
  ok(fA>=5,'frames flowing (A at frame '+fA+')');

  console.log('4. B buys infantry — it appears on BOTH clients…');
  // forts open empty and earn ~1 coin a second, so wait until B can actually
  // afford the 8-coin infantry rather than clicking into an empty bank
  await B.p.waitForFunction(()=>BREACH_SIM_DEBUG.state().slotCoins.B1>=800,{timeout:30000});
  await B.p.click('.build .u[data-t="inf"]');
  const grew=async pg=>pg.waitForFunction(()=>BREACH_SIM_DEBUG.units.some(u=>u.owner==='B1'),{timeout:8000}).then(()=>true).catch(()=>false);
  ok(await grew(B.p),'B sees its own B1 units');
  ok(await grew(A.p),'A sees B1 units too (input relayed through lockstep)');

  console.log('5. Lockstep integrity: same frame => same hash…');
  let matched=false, tries=0, sameFrame=false;
  while(tries++<40&&!matched){
    const [ra,rb]=await Promise.all([
      A.p.evaluate(()=>({n:CLASH_NET.frame,h:BREACH_SIM_DEBUG.hash(),t:CLASH_NET.tick||0})),
      B.p.evaluate(()=>({n:CLASH_NET.frame,h:BREACH_SIM_DEBUG.hash(),t:CLASH_NET.tick||0}))]);
    if(ra.n===rb.n&&ra.t===rb.t){ sameFrame=true; matched=ra.h===rb.h; if(matched)break; }
    await A.p.waitForTimeout(37);
  }
  ok(sameFrame,'managed to sample both clients at the identical frame+tick');
  ok(matched,'sim hashes IDENTICAL at same frame — true lockstep');
  const noDesync=await A.p.evaluate(()=>document.getElementById('clMsg').textContent==='');
  ok(noDesync,'server-side hash checks: no desync flagged');

  console.log('6. B disconnects — its fort becomes AI, A plays on…');
  const fBefore=await A.p.evaluate(()=>CLASH_NET.frame);
  await B.ctx.close();
  await A.p.waitForTimeout(2500);
  const fAfter=await A.p.evaluate(()=>CLASH_NET.frame);
  ok(fAfter>fBefore,'A keeps advancing after B leaves ('+fBefore+' -> '+fAfter+')');

  console.log('7. A one-player room (three model seats) still works…');
  // "New battle" no longer auto-starts: it opens a lobby so a friend can join
  // with the code. The host presses Start when they are done waiting.
  const S=await mk(); await S.p.click('#clSolo');
  await S.p.waitForFunction(()=>{const c=document.getElementById('clRoomCode').textContent;
    return c&&c.length===6&&c!=='------';},{timeout:20000});
  ok(await S.p.evaluate(()=>!document.getElementById('clStart').hidden),
    'creating a room lands in the lobby with Start available, not mid-battle');
  await S.p.click('#clStart');
  await S.p.waitForFunction(()=>window.BREACH_SIM_DEBUG&&BREACH_SIM_DEBUG.units!==undefined,{timeout:15000});
  ok(true,'battle runs with the remaining seats on models');
  ok(S.errs.length===0&&A.errs.length===0,'no page errors anywhere');

  console.log(`\nCLASH MULTIPLAYER E2E: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail?1:0);
})();
