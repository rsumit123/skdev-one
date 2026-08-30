const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
(async()=>{
  const b=await chromium.launch({headless:true});
  let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};
  // 1. spinner appears during connect (real backend)
  const c1=await b.newContext({viewport:{width:390,height:844}});
  const p1=await c1.newPage();
  await p1.addInitScript(()=>{try{localStorage.setItem('breach.pubapi','http://127.0.0.1:8050');}catch(e){}});
  await p1.goto('http://127.0.0.1:8055/clash.html',{waitUntil:'load'});
  await p1.click('#clCreate');
  const spun=await p1.waitForFunction(()=>document.getElementById('clCreate').classList.contains('busy'),{timeout:3000}).then(()=>true).catch(()=>false);
  ok(spun,'Create Room shows a spinner while connecting');
  await p1.waitForFunction(()=>!document.getElementById('clRoom').hidden,{timeout:20000});
  ok(true,'room created, lobby shown');
  ok(await p1.evaluate(()=>!document.getElementById('clCreate').classList.contains('busy')),'spinner clears after success');

  // 2. unreachable backend -> friendly retryable error, button usable again
  const c2=await b.newContext({viewport:{width:390,height:844}});
  const p2=await c2.newPage();
  await p2.addInitScript(()=>{try{localStorage.setItem('breach.pubapi','http://127.0.0.1:9999');}catch(e){}}); // dead port
  await p2.goto('http://127.0.0.1:8055/clash.html',{waitUntil:'load'});
  await p2.click('#clCreate');
  await p2.waitForFunction(()=>{const m=document.getElementById('clMsg').textContent;
    return m&&/try again|reach/i.test(m);},{timeout:45000});
  const msg=await p2.evaluate(()=>document.getElementById('clMsg').textContent);
  ok(/try again/i.test(msg),'dead server -> retryable message: "'+msg+'"');
  ok(await p2.evaluate(()=>!document.getElementById('clCreate').classList.contains('busy')),'button re-enabled so you can retry');
  console.log(`lobby UX: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail?1:0);
})();
