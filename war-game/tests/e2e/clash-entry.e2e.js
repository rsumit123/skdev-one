const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
(async()=>{
  const b=await chromium.launch({headless:true});
  let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};
  const open=async()=>{const c=await b.newContext({viewport:{width:390,height:844}});const p=await c.newPage();
    const errs=[];p.on('pageerror',e=>errs.push(e.message));
    await p.addInitScript(()=>{try{localStorage.setItem('breach.pubapi','http://127.0.0.1:8050');}catch(e){}});
    await p.goto('http://127.0.0.1:8055/clash.html',{waitUntil:'load'});return {p,errs};};

  const A=await open();
  ok(await A.p.evaluate(()=>!document.getElementById('clCreate')),'the duplicate "Create room" button is gone');
  await A.p.click('#clSolo');
  await A.p.waitForFunction(()=>!document.getElementById('clRoom').hidden,{timeout:20000});
  ok(true,'"New battle" opens the lobby instead of auto-starting');
  ok(await A.p.evaluate(()=>!document.getElementById('clashLobby').classList.contains('off')),
     'the battle has NOT started yet');
  const code=await A.p.evaluate(()=>document.getElementById('clRoomCode').textContent);
  ok(/^[A-Z0-9]{6}$/.test(code),'a room code is shown so friends can join: '+code);
  const picks=await A.p.evaluate(()=>[...document.querySelectorAll('.model-select')].length);
  ok(picks===3,'all three model seats are choosable ('+picks+')');

  // choose the benchmark leader for one seat
  await A.p.selectOption('.model-select','google/gemini-3.7-flash');
  await A.p.waitForTimeout(900);

  // a friend can still join this room, which was impossible with auto-start
  const B=await open();
  await B.p.fill('#clCode',code); await B.p.click('#clJoin');
  await B.p.waitForFunction(()=>!document.getElementById('clRoom').hidden,{timeout:15000});
  ok(true,'a second player CAN join (auto-start used to make this impossible)');

  await A.p.click('#clStart');
  for(const x of [A,B]) await x.p.waitForFunction(()=>window.BREACH_SIM_DEBUG,{timeout:20000});
  ok(true,'host starts and both go live');
  const chosen=await A.p.evaluate(()=>['A2','B1','B2'].map(s=>document.getElementById('nm'+s).textContent));
  ok(chosen.some(n=>/Gemini 3\.7/.test(n)),'the model I picked is actually in the match: '+chosen.join(' | '));
  ok(A.errs.length===0&&B.errs.length===0,'no page errors');
  console.log(`\nENTRY: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail?1:0);
})();
