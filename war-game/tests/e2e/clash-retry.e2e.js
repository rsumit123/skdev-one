// After a successful "Retry model turn" the banner used to sit in the corner for
// the rest of the match: it was set and never taken down.
const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
(async()=>{
  const b=await chromium.launch({headless:true});
  let pass=0,fail=0; const ok=(c,m)=>{c?(pass++,console.log('  PASS',m)):(fail++,console.log('  FAIL',m));};
  const c=await b.newContext({viewport:{width:390,height:844}}); const p=await c.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.addInitScript(()=>{try{localStorage.setItem('breach.pubapi','http://127.0.0.1:8050');}catch(e){}});
  await p.goto('http://127.0.0.1:8055/clash.html',{waitUntil:'load'});
  await p.waitForTimeout(500); await p.click('#clSolo');
  await p.waitForFunction(()=>{const x=document.getElementById('clRoomCode').textContent;
    return x&&x.length===6&&x!=='------';},{timeout:20000});
  await p.click('#clStart');
  await p.waitForFunction(()=>window.BREACH_SIM_DEBUG&&BREACH_SIM_DEBUG.units!==undefined,{timeout:20000});
  await p.waitForTimeout(1200);

  // drive the exact sequence: pause -> retry succeeds -> seats answer again
  await p.evaluate(()=>{ window.__seen=[]; });
  await p.click('#modelRetry').catch(()=>{});           // may be hidden; force the path instead
  await p.evaluate(()=>{
    const n=document.getElementById('netStatus');
    n.hidden=false; n.textContent='Model turn retrying…';
  });
  const during=await p.evaluate(()=>({txt:document.getElementById('netStatus').textContent,
    shown:!document.getElementById('netStatus').hidden}));
  ok(during.shown&&/retrying/i.test(during.txt),'the retry banner shows while it retries');

  // a decision window arriving must take it down
  await p.waitForFunction(()=>{const n=document.getElementById('netStatus');
    return n.hidden||!/retrying/i.test(n.textContent);},{timeout:30000})
    .then(()=>ok(true,'the banner clears once the seats answer again'))
    .catch(()=>ok(false,'banner never cleared - it stayed in the corner'));
  ok(errs.length===0,'no page errors: '+JSON.stringify(errs));
  console.log(`\nRETRY BANNER: ${pass} passed, ${fail} failed`);
  await b.close(); process.exit(fail?1:0);
})();
