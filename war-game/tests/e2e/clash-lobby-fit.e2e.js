// The lobby used to be pinned inside .arena, so on a small phone (with browser
// chrome eating height) it had ~343px to lay out a ~600px card: "Start battle"
// was clipped away entirely and no game could be started. It now covers the
// whole .screen and scrolls. Playwright scrolls before clicking, so a click test
// would NOT have caught this - assert real on-screen geometry.
const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
const SIZES=[[320,568,'tiny'],[360,600,'small phone + browser chrome'],
             [390,700,'iphone + chrome'],[412,915,'pixel 7']];
(async()=>{
  const b=await chromium.launch({headless:true});
  let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};
  for(const [w,h,name] of SIZES){
    const c=await b.newContext({viewport:{width:w,height:h}}); const p=await c.newPage();
    const errs=[]; p.on('pageerror',e=>errs.push(e.message));
    await p.addInitScript(()=>{try{localStorage.setItem('breach.pubapi','http://127.0.0.1:8050');}catch(e){}});
    await p.goto('http://127.0.0.1:8055/clash.html',{waitUntil:'load'});
    await p.waitForTimeout(400);
    await p.click('#clSolo');
    await p.waitForFunction(()=>{const x=document.getElementById('clRoomCode').textContent;
      return x&&x.length===6&&x!=='------';},{timeout:20000});
    const r=await p.evaluate(()=>{
      const btn=document.getElementById('clStart'), lob=document.getElementById('clashLobby');
      const br=btn.getBoundingClientRect(), lr=lob.getBoundingClientRect();
      return {onScreen:br.height>0&&br.top>=lr.top-1&&br.bottom<=lr.bottom+1,
        top:Math.round(br.top), bottom:Math.round(br.bottom), lobH:Math.round(lr.height),
        label:btn.textContent.trim(), hidden:btn.hidden,
        sideA:(document.getElementById('tsideA')||{}).textContent,
        eco:(document.getElementById('ecoCost')||{}).textContent};});
    ok(!r.hidden,`${name}: host sees a Start button`);
    ok(r.onScreen,`${name} (${w}x${h}): "${r.label}" fully on screen at ${r.top}..${r.bottom} of ${r.lobH}`);
    ok(errs.length===0,`${name}: no page errors`);
    if(w===320){
      ok(r.sideA==='Your side'||r.sideA==='Opponents',`side label is viewer-relative -> "${r.sideA}"`);
      ok(r.eco==='—',`pre-game eco cost is not a raw internal number -> "${r.eco}"`);
    }
    await c.close();
  }
  console.log(`\nLOBBY FIT: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail?1:0);
})();
