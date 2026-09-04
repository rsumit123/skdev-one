const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
(async()=>{
  const b=await chromium.launch({headless:true});
  let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};
  const p=await (await b.newContext({viewport:{width:390,height:844}})).newPage();
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  await p.addInitScript(()=>{try{localStorage.setItem('breach.pubapi','http://127.0.0.1:8050');}catch(e){}});
  await p.goto('http://127.0.0.1:8055/clash.html',{waitUntil:'load'});
  await p.click('#clSolo');
  await p.waitForFunction(()=>!document.getElementById('clRoom').hidden,{timeout:20000});
  await p.click('#clStart');
  await p.waitForFunction(()=>window.BREACH_SIM_DEBUG,{timeout:20000});
  await p.waitForTimeout(1200);
  const btns=await p.evaluate(()=>[...document.querySelectorAll('#targetBtns button')].map(b=>b.textContent));
  ok(btns.length===3,'target picker shows both enemy forts + Nearest: '+btns.join(' | '));
  ok(!(await p.evaluate(()=>document.getElementById('targetRow').hidden)),'picker is visible in the deck');
  // choose the first enemy fort
  await p.click('#targetBtns button');
  await p.waitForTimeout(700);
  const st=await p.evaluate(()=>({t:BREACH_SIM_DEBUG.targets, on:[...document.querySelectorAll('#targetBtns button')].filter(b=>b.classList.contains('on')).map(b=>b.textContent)}));
  ok(Object.keys(st.t).length>0,'sim recorded the chosen target: '+JSON.stringify(st.t));
  ok(st.on.length===1,'the chosen fort is highlighted: '+st.on[0]);
  // back to nearest
  await p.click('#targetBtns button:last-child');
  await p.waitForTimeout(700);
  // model seats pick their own targets too, so only MY slot should clear
  const mine=await p.evaluate(()=>BREACH_SIM_DEBUG.targets[Object.keys(BREACH_SIM_DEBUG.targets).find(k=>k==='A1')]);
  ok(mine===undefined,'"Nearest" clears MY target (model seats keep theirs)');
  // Whether a live model actually issues a target inside a few seconds is the
  // model's business, not the code's - asserting on it made this suite fail on
  // model whim. The contract that a model MAY target an enemy fort is pinned
  // deterministically in tests/test_clash_agents.py; this is an observation.
  const others=await p.evaluate(()=>Object.keys(BREACH_SIM_DEBUG.targets).filter(k=>k!=='A1'));
  console.log('  NOTE model seats targeting so far: '+JSON.stringify(others));
  ok(errs.length===0,'no page errors'+(errs[0]?': '+errs[0]:''));
  console.log(`\nTARGETING: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail?1:0);
})();
