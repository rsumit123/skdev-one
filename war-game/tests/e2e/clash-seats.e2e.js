const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
(async()=>{
  const b=await chromium.launch({headless:true});
  let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};
  const mk=async()=>{const c=await b.newContext({viewport:{width:390,height:844}});const p=await c.newPage();
    const errs=[];p.on('pageerror',e=>errs.push(e.message));
    await p.addInitScript(()=>{try{localStorage.setItem('breach.pubapi','http://127.0.0.1:8050');}catch(e){}});
    await p.goto('http://127.0.0.1:8055/clash.html',{waitUntil:'load'});return {p,errs};};
  const A=await mk(), B=await mk();
  await A.p.click('#clCreate');
  await A.p.waitForFunction(()=>{const c=document.getElementById('clRoomCode').textContent;return c&&c.length===6&&c!=='------';},{timeout:20000});
  const code=await A.p.evaluate(()=>document.getElementById('clRoomCode').textContent);
  // team grouping present?
  const grouped=await A.p.evaluate(()=>({
    hasA:!!document.getElementById('clTeamA'), hasB:!!document.getElementById('clTeamB'),
    aRows:document.getElementById('clTeamA').children.length,
    bRows:document.getElementById('clTeamB').children.length,
    labels:[...document.querySelectorAll('.cl-team .tname')].map(e=>e.textContent)}));
  ok(grouped.hasA&&grouped.hasB,'lobby is grouped into Team A / Team B: '+grouped.labels.join(' | '));
  ok(grouped.aRows===2&&grouped.bRows===2,'each team shows exactly 2 seats ('+grouped.aRows+'/'+grouped.bRows+')');
  await B.p.fill('#clCode',code); await B.p.click('#clJoin');
  await B.p.waitForFunction(()=>!document.getElementById('clRoom').hidden,{timeout:15000});
  const before=await B.p.evaluate(()=>document.querySelector('#clRoom .you')?.closest('.row')?.querySelector('.sl')?.textContent);
  ok(before==='B1','B auto-seated on the opposing team ('+before+')');
  // B wants to play WITH A on team A -> claim A2
  const btn=await B.p.$('#clTeamA .seat-take');
  ok(!!btn,'free seats offer a "Take seat" control');
  await btn.click();
  await B.p.waitForFunction(()=>{const y=document.querySelector('#clRoom .you');
    return y&&y.closest('.row').querySelector('.sl').textContent==='A2';},{timeout:10000});
  ok(true,'B moved to A2 — friends can now pick the same team');
  // the host sees it, and B1 fell back to a model
  await A.p.waitForFunction(()=>{const rows=[...document.querySelectorAll('#clTeamA .row')];
    return rows.some(r=>r.querySelector('.sl').textContent==='A2'&&r.querySelector('.nm'));},{timeout:10000});
  ok(true,'host lobby updated live');
  const b1IsModel=await A.p.evaluate(()=>{const r=[...document.querySelectorAll('#clTeamB .row')]
    .find(x=>x.querySelector('.sl').textContent==='B1'); return !!r&&!!r.querySelector('.model-select');});
  ok(b1IsModel,'vacated seat B1 fell back to a model commander');
  ok(A.errs.length===0&&B.errs.length===0,'no page errors');
  console.log(`\nSEATS: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail?1:0);
})();
