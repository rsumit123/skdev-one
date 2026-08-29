const { chromium } = require('/Users/rsumit123/work/charade-chat/frontend/node_modules/@playwright/test');
const URL='http://127.0.0.1:8055/index.html?api=http://127.0.0.1:8050';
const log=(...a)=>console.log(...a);

async function boot(ctx,name){
  const page=await ctx.newPage();
  page.on('console',m=>{const t=m.text();if(/error|desync|fail/i.test(t))log(`  [${name} console] ${t}`);});
  await page.goto(URL,{waitUntil:'domcontentloaded'});
  // wait for boot to settle into either home or identity
  await page.waitForFunction(()=>{
    const h=document.getElementById('publicHome'),i=document.getElementById('publicIdentity');
    return (h&&h.classList.contains('on'))||(i&&i.classList.contains('on'));
  },{timeout:15000});
  const onIdentity=await page.evaluate(()=>document.getElementById('publicIdentity').classList.contains('on'));
  if(onIdentity){
    await page.click('[data-auth-view="guest"]').catch(()=>{});
    await page.fill('#guestName',name);
    await page.click('#guestForm button[type="submit"]');
  }
  await page.waitForFunction(()=>document.getElementById('publicHome').classList.contains('on'),{timeout:15000});
  await page.evaluate(()=>{const m=document.getElementById('mHowTo');if(m)m.classList.remove('on');});
  return page;
}

(async()=>{
  const browser=await chromium.launch({headless:true});
  const ctxA=await browser.newContext(), ctxB=await browser.newContext();
  let failed=false; const check=(c,m)=>{if(c){log('  PASS',m);}else{failed=true;log('  FAIL',m);}};
  try{
    log('1. Boot two guests…');
    const A=await boot(ctxA,'AlphaCmdr');
    const B=await boot(ctxB,'BravoCmdr');
    check(true,'both guests reached home');

    log('2. Player A creates a battle…');
    await A.click('#btnPvpOpen');
    await A.waitForFunction(()=>document.getElementById('publicPvp').classList.contains('on'),{timeout:8000});
    await A.click('#btnPvpCreate');
    await A.waitForFunction(()=>{const c=document.getElementById('pvpRoomCode').textContent;return c&&c.length===6&&c!=='------';},{timeout:15000});
    const code=await A.evaluate(()=>document.getElementById('pvpRoomCode').textContent);
    check(/^[A-Z0-9]{6}$/.test(code),'room code minted: '+code);

    log('3. Player B joins with the code…');
    await B.click('#btnPvpOpen');
    await B.waitForFunction(()=>document.getElementById('publicPvp').classList.contains('on'),{timeout:8000});
    await B.fill('#pvpJoinCode',code);
    await B.click('#btnPvpJoin');
    await B.waitForFunction(()=>!document.getElementById('pvpRoom').hidden,{timeout:15000});
    check(true,'player B entered the room');
    // host should now see 2 players + Start enabled
    await A.waitForFunction(()=>!document.getElementById('btnPvpStart').hidden,{timeout:8000});
    check(true,'host sees Start button (2 players present)');

    log('4. Host starts the battle…');
    await A.click('#btnPvpStart');
    // both should go live
    await A.waitForFunction(()=>document.body.classList.contains('live'),{timeout:15000});
    await B.waitForFunction(()=>document.body.classList.contains('live'),{timeout:15000});
    check(true,'both clients went live');
    // same seed on both (lockstep precondition)
    const seedA=await A.evaluate(()=>document.getElementById('seed').value);
    const seedB=await B.evaluate(()=>document.getElementById('seed').value);
    check(seedA===seedB && seedA, 'both clients share the same seed: '+seedA);
    // opposite sides
    const sideA=await A.evaluate(()=>PVP.mySide), sideB=await B.evaluate(()=>PVP.mySide);
    check(sideA!==sideB && (sideA===0||sideA===1), `sides assigned opposite: A=${sideA} B=${sideB}`);

    log('5. Play one lockstep turn (both submit orders)…');
    // each client's own picker opens when its side is asked; the other waits.
    // Wait for the picker on both, then submit on both. The turn releases only when both are in.
    async function submitTurn(page,label){
      await page.waitForFunction(()=>document.getElementById('picker').classList.contains('on'),{timeout:20000});
      // send with an empty queue (hold) — the "send orders" button
      await page.click('#pkGo');
      log('    '+label+' submitted orders');
    }
    // both pickers should be open simultaneously (both sides asked at turn 0)
    await Promise.all([submitTurn(A,'A'),submitTurn(B,'B')]);
    // after release, both sims advance to turn 1: PVP.turn should become 1 and picker reopen
    await A.waitForFunction(()=>PVP.turn>=1,{timeout:20000});
    await B.waitForFunction(()=>PVP.turn>=1,{timeout:20000});
    check(true,'both clients advanced past turn 0 in lockstep (PVP.turn>=1)');
    const desyncA=await A.evaluate(()=>PVP._desynced), desyncB=await B.evaluate(()=>PVP._desynced);
    check(!desyncA&&!desyncB,'no desync flagged on either client');


    log('6. End the game, check PvP result UI, and rematch…');
    // force game-over on both clients (deterministic UI test); PVP_END_GAME runs
    for(const [pg,nm] of [[A,'A'],[B,'B']]){
      await pg.evaluate(()=>{ S.over=true; S.win=0; endGame(); });
    }
    // benchmark row (Change models etc.) must be hidden; pvp row shown
    const benchHiddenA=await A.evaluate(()=>getComputedStyle(document.querySelector('.benchmark-result-actions')).display==='none');
    const pvpShownA=await A.evaluate(()=>getComputedStyle(document.querySelector('.pvp-result-actions')).display!=='none');
    const changeModelsHidden=await A.evaluate(()=>{const b=document.getElementById('btnNewModels');return !b.offsetParent;});
    check(benchHiddenA,'benchmark result row (Change models) is hidden in PvP');
    check(pvpShownA,'PvP result row is shown');
    check(changeModelsHidden,'Change models button is not visible to players');
    const hostLabel=await A.evaluate(()=>document.getElementById('btnPvpRematch').textContent);
    const joinLabel=await B.evaluate(()=>document.getElementById('btnPvpRematch').textContent);
    check(hostLabel==='Rematch','host sees an active Rematch button');
    check(/host only/.test(joinLabel),'joiner sees Rematch marked host-only');
    // host clicks Rematch -> both restart via game:start
    await A.click('#btnPvpRematch');
    await A.waitForFunction(()=>PVP.turn===0 && !S.over && document.body.classList.contains('live'),{timeout:20000});
    await B.waitForFunction(()=>PVP.turn===0 && !S.over && document.body.classList.contains('live'),{timeout:20000});
    check(true,'rematch restarted both clients at a fresh turn 0, in-game');
    const seed2A=await A.evaluate(()=>document.getElementById('seed').value);
    const seed2B=await B.evaluate(()=>document.getElementById('seed').value);
    check(seed2A===seed2B && seed2A, 'rematch gave both the same new seed: '+seed2A);
    log(failed?'\nE2E RESULT: FAILURES ABOVE':'\nE2E RESULT: ALL CHECKS PASSED');
  }catch(e){
    failed=true; log('E2E ERROR:',e.message);
  }finally{
    await browser.close();
    process.exit(failed?1:0);
  }
})();
