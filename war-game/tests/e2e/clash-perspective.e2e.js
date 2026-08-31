// Every player looks at their own forts from the bottom of the screen. The flip
// is a camera transform: both clients must still simulate an identical battle.
const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
(async()=>{
  const b=await chromium.launch({headless:true});
  let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};
  const mk=async()=>{const c=await b.newContext({viewport:{width:390,height:844}});const p=await c.newPage();
    const errs=[]; p.on('pageerror',e=>errs.push(e.message));
    await p.addInitScript(()=>{try{localStorage.setItem('breach.pubapi','http://127.0.0.1:8050');}catch(e){}});
    await p.goto('http://127.0.0.1:8055/clash.html',{waitUntil:'load'});return {p,errs};};
  const A=await mk(), B=await mk();
  await A.p.waitForTimeout(600); await A.p.click('#clSolo');
  await A.p.waitForFunction(()=>{const c=document.getElementById('clRoomCode').textContent;return c&&c.length===6&&c!=='------';},{timeout:20000});
  const code=await A.p.evaluate(()=>document.getElementById('clRoomCode').textContent);
  await B.p.fill('#clCode',code); await B.p.click('#clJoin');
  await B.p.waitForFunction(()=>!document.getElementById('clRoom').hidden,{timeout:15000});
  await A.p.click('#clStart');
  for(const X of [A,B]) await X.p.waitForFunction(()=>window.BREACH_SIM_DEBUG&&BREACH_SIM_DEBUG.units!==undefined,{timeout:15000});
  await A.p.waitForTimeout(1500);

  // MYSLOT/MYTEAM are script-scoped, so read the slot off the on-screen tag
  const view=X=>X.p.evaluate(()=>{
    const tag=document.getElementById('youTag').textContent;
    const slot=(tag.match(/\b([AB][12])\b/)||[])[1];
    const team=slot&&slot[0]==='B'?1:0;
    const mine=[],foe=[];
    for(const base of BREACH_SIM_DEBUG.bases) (base.team===team?mine:foe).push({id:base.id,y:base.y});
    return {slot,team,mine,foe};});
  const a=await view(A), bb=await view(B);
  for(const [n,v] of [['A',a],['B',bb]]){
    const mid=(Math.max(...v.mine.map(x=>x.y),...v.foe.map(x=>x.y))+Math.min(...v.mine.map(x=>x.y),...v.foe.map(x=>x.y)))/2;
    ok(v.mine.every(x=>x.y>mid),n+' ('+v.slot+') sees its own forts on the near side');
    ok(v.foe.every(x=>x.y<mid),n+' ('+v.slot+') sees the enemy forts opposite');
  }
  ok(a.team!==bb.team,'the two clients really are on opposite teams');

  // the camera moved; the simulation must not have
  const sample=X=>X.p.evaluate(()=>({f:window.CLASH_NET&&CLASH_NET.frame,h:BREACH_SIM_DEBUG.hash()}));
  let matched=false;
  for(let i=0;i<40&&!matched;i++){
    const [x,y]=await Promise.all([sample(A),sample(B)]);
    if(x.f===y.f){ matched=true; ok(x.h===y.h,'sim hashes identical at frame '+x.f+' — the flip is render-only'); }
    else await A.p.waitForTimeout(60);
  }
  ok(matched,'sampled both clients at the same frame');
  ok(A.errs.length===0&&B.errs.length===0,'no page errors: '+JSON.stringify([A.errs,B.errs]));
  console.log(`\nPERSPECTIVE: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail?1:0);
})();
