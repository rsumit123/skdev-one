const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
const URL='http://127.0.0.1:8055/index.html?api=http://127.0.0.1:8050';
const log=(...a)=>console.log(...a);
async function boot(ctx,name){
  const page=await ctx.newPage();
  await page.goto(URL,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>{const h=document.getElementById('publicHome'),i=document.getElementById('publicIdentity');
    return (h&&h.classList.contains('on'))||(i&&i.classList.contains('on'));},{timeout:15000});
  if(await page.evaluate(()=>document.getElementById('publicIdentity').classList.contains('on'))){
    await page.click('[data-auth-view="guest"]').catch(()=>{});
    await page.fill('#guestName',name); await page.click('#guestForm button[type="submit"]');
  }
  await page.waitForFunction(()=>document.getElementById('publicHome').classList.contains('on'),{timeout:15000});
  await page.evaluate(()=>{const m=document.getElementById('mHowTo');if(m)m.classList.remove('on');});
  return page;
}
async function playToLive(A,B){
  await A.click('#btnPvpOpen'); await A.waitForFunction(()=>document.getElementById('publicPvp').classList.contains('on'),{timeout:8000});
  await A.click('#btnPvpCreate');
  await A.waitForFunction(()=>{const c=document.getElementById('pvpRoomCode').textContent;return c&&c.length===6&&c!=='------';},{timeout:15000});
  const code=await A.evaluate(()=>document.getElementById('pvpRoomCode').textContent);
  await B.click('#btnPvpOpen'); await B.waitForFunction(()=>document.getElementById('publicPvp').classList.contains('on'),{timeout:8000});
  await B.fill('#pvpJoinCode',code); await B.click('#btnPvpJoin');
  await A.waitForFunction(()=>!document.getElementById('btnPvpStart').hidden,{timeout:8000});
  await A.click('#btnPvpStart');
  await A.waitForFunction(()=>document.body.classList.contains('live'),{timeout:15000});
  await B.waitForFunction(()=>document.body.classList.contains('live'),{timeout:15000});
}
const bannerText=p=>p.evaluate(()=>{const b=document.getElementById('reconnectBanner');return b&&b.classList.contains('on')?b.textContent:'';});

(async()=>{
  const browser=await chromium.launch({headless:true});
  let failed=false; const check=(c,m)=>{if(c){log('  PASS',m);}else{failed=true;log('  FAIL',m);}};
  try{
    // ---- Scenario 1: disconnect -> pause -> reconnect ----
    log('Scenario 1: opponent drops then reconnects within grace');
    let ctxA=await browser.newContext(), ctxB=await browser.newContext();
    let A=await boot(ctxA,'Alpha'), B=await boot(ctxB,'Bravo');
    await playToLive(A,B);
    check(true,'match live');
    // B drops its socket
    await B.evaluate(()=>PVP.socket.disconnect());
    await A.waitForFunction(()=>{const b=document.getElementById('reconnectBanner');return b&&b.classList.contains('on')&&/disconnected/i.test(b.textContent);},{timeout:8000});
    check(true,'A sees "opponent disconnected" banner: '+JSON.stringify(await bannerText(A)));
    check(await A.evaluate(()=>!S.over),'game not ended during grace');
    // B reconnects (well within 3s? no — need to reconnect fast). Reconnect immediately.
    await B.evaluate(()=>PVP.socket.connect());
    await A.waitForFunction(()=>{const b=document.getElementById('reconnectBanner');return !(b&&b.classList.contains('on'));},{timeout:8000});
    check(true,'A banner cleared after B reconnected');
    check(await A.evaluate(()=>!S.over)&&await B.evaluate(()=>!S.over),'both still in-game after reconnect');
    await ctxA.close(); await ctxB.close();

    // ---- Scenario 2: disconnect -> grace expires -> forfeit ----
    log('Scenario 2: opponent leaves, grace (3s) expires -> forfeit');
    ctxA=await browser.newContext(); ctxB=await browser.newContext();
    A=await boot(ctxA,'Alpha2'); B=await boot(ctxB,'Bravo2');
    await playToLive(A,B);
    const aSide=await A.evaluate(()=>PVP.mySide);
    // B leaves for good
    await B.evaluate(()=>PVP.socket.disconnect());
    await A.waitForFunction(()=>{const b=document.getElementById('reconnectBanner');return b&&b.classList.contains('on');},{timeout:8000});
    // wait out the grace -> A should win by forfeit
    await A.waitForFunction(()=>S.over===true,{timeout:12000});
    const win=await A.evaluate(()=>S.win);
    const txt=await A.evaluate(()=>document.getElementById('bannerTxt').textContent);
    check(win===aSide,`A won by forfeit (win=${win}, aSide=${aSide})`);
    check(/you win/i.test(txt),'A sees "Opponent left — you win": '+JSON.stringify(txt));
    const pvpRowShown=await A.evaluate(()=>getComputedStyle(document.querySelector('.pvp-result-actions')).display!=='none');
    check(pvpRowShown,'PvP result row shown after forfeit');
    await ctxA.close(); await ctxB.close();

    log(failed?'\nPHASE 4 E2E: FAILURES ABOVE':'\nPHASE 4 E2E: ALL CHECKS PASSED');
  }catch(e){failed=true; log('E2E ERROR:',e.message);}
  finally{ await browser.close(); process.exit(failed?1:0); }
})();
