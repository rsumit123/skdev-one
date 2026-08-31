const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
(async()=>{
  const b=await chromium.launch({headless:true});
  let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};
  const c=await b.newContext({viewport:{width:390,height:844}});
  const p=await c.newPage();
  await p.addInitScript(()=>{try{localStorage.setItem('breach.pubapi','http://127.0.0.1:8050');}catch(e){}});
  await p.goto('http://127.0.0.1:8055/clash.html',{waitUntil:'load'});
  await p.click('#clSolo');                       // opens the lobby
  await p.waitForFunction(()=>!document.getElementById('clRoom').hidden,{timeout:20000});
  await p.click('#clStart');
  await p.waitForFunction(()=>window.BREACH_SIM_DEBUG,{timeout:20000});
  ok(true,'match started vs model seats');
  // fast-forward the deterministic sim to a finish, then let the client report
  // force a DECIDED outcome: raze team B's forts, then let the sim conclude
  await p.evaluate(()=>{ for(const b of BREACH_SIM_DEBUG.bases) if(b.team===1){b.ihp=0;b.alive=false;}
    for(let i=0;i<50&&!BREACH_SIM_DEBUG.state().over;i++) BREACH_SIM_DEBUG.tick([]); });
  await p.waitForTimeout(2500);
  const st=await p.evaluate(()=>BREACH_SIM_DEBUG.state());
  ok(st.over,'game reached a decided end (winner team '+st.winner+')');
  // leaderboard
  const lb=await p.evaluate(async()=>{const r=await fetch('http://127.0.0.1:8050/v1/clash/leaderboard');return r.json();});
  console.log('   leaderboard:',JSON.stringify(lb).slice(0,260));
  ok((lb.players||[]).length>0,'human commander appears on the Clash board');
  ok((lb.models||[]).length>0,'MODEL commanders appear (the benchmark view)');
  const decided=(lb.players||[]).some(x=>x.wins+x.losses>0)||(lb.models||[]).some(x=>x.wins+x.losses>0);
  ok(decided,'wins/losses actually recorded (winner reaches the DB)');
  // personal history
  const h=await p.evaluate(async()=>{let t='';try{t=localStorage.getItem('breach.guestToken')||''}catch(e){}
    const r=await fetch('http://127.0.0.1:8050/v1/clash/history',{headers:t?{'X-Breach-Guest':t}:{},credentials:'include'});return r.json();});
  ok((h.battles||[]).length>0,'battle appears in My Clash history');
  const bt=(h.battles||[])[0];
  if(bt){ ok(bt.seats.length===4,'history row carries all 4 seats');
          ok(bt.seats.some(s=>s.you),'my seat is marked');
          ok(bt.seats.some(s=>s.isModel),'model seats identified by name'); }
  console.log(`\nCLASH BOARDS: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail?1:0);
})();
