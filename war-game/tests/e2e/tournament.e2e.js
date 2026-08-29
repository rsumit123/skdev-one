const { chromium } = require(process.env.PLAYWRIGHT_PKG || '@playwright/test');
const URL='http://127.0.0.1:8055/index.html?api=http://127.0.0.1:8050';
const log=(...a)=>console.log(...a);
async function boot(ctx,name){
  const page=await ctx.newPage();
  page.on('console',m=>{const t=m.text();if(/error|desync/i.test(t)&&!/404|401/.test(t))log(`  [${name}] ${t}`);});
  await page.goto(URL,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>{const h=document.getElementById('publicHome'),i=document.getElementById('publicIdentity');
    return (h&&h.classList.contains('on'))||(i&&i.classList.contains('on'));},{timeout:15000});
  if(await page.evaluate(()=>document.getElementById('publicIdentity').classList.contains('on'))){
    await page.click('[data-auth-view="guest"]').catch(()=>{});
    await page.fill('#guestName',name);await page.click('#guestForm button[type="submit"]');
  }
  await page.waitForFunction(()=>document.getElementById('publicHome').classList.contains('on'),{timeout:15000});
  await page.evaluate(()=>{const m=document.getElementById('mHowTo');if(m)m.classList.remove('on');});
  return page;
}
const isLive=p=>p.evaluate(()=>document.body.classList.contains('live'));
const isSpec=p=>p.evaluate(()=>document.body.classList.contains('spectating'));
const mySide=p=>p.evaluate(()=>PVP.mySide);
const onBoard=p=>p.evaluate(()=>document.getElementById('publicTourney').classList.contains('on')&&!document.getElementById('tourneyBoard').hidden);

(async()=>{
  const browser=await chromium.launch({headless:true});
  const ctxs=[],pages=[];
  let failed=false; const check=(c,m)=>{if(c){log('  PASS',m);}else{failed=true;log('  FAIL',m);}};
  try{
    log('1. Boot 4 guests, open a Cup, all join…');
    for(let i=0;i<4;i++){const c=await browser.newContext();ctxs.push(c);pages.push(await boot(c,'Cmdr'+i));}
    const [H,B,C,D]=pages;
    await H.click('#btnTourneyOpen');
    await H.waitForFunction(()=>document.getElementById('publicTourney').classList.contains('on'),{timeout:8000});
    await H.click('#btnTourneyCreate');
    await H.waitForFunction(()=>{const c=document.getElementById('tourneyCode').textContent;return c&&c.length===6&&c!=='------';},{timeout:15000});
    const code=await H.evaluate(()=>document.getElementById('tourneyCode').textContent);
    check(/^[A-Z0-9]{6}$/.test(code),'Cup code minted: '+code);
    for(const p of [B,C,D]){
      await p.click('#btnTourneyOpen');
      await p.waitForFunction(()=>document.getElementById('publicTourney').classList.contains('on'),{timeout:8000});
      await p.fill('#tourneyJoinCode',code);await p.click('#btnTourneyJoin');
    }
    await H.waitForFunction(()=>document.querySelectorAll('#tourneyMembers .tm').length===4,{timeout:10000});
    check(true,'all 4 commanders in the lobby');

    log('2. Host decides opponents (draw)…');
    await H.waitForFunction(()=>!document.getElementById('btnTourneyDraw').hidden,{timeout:8000});
    await H.click('#btnTourneyDraw');
    await H.waitForFunction(()=>!document.getElementById('tourneyBoard').hidden,{timeout:10000});
    check(await onBoard(H),'bracket board shown after draw');
    await H.waitForFunction(()=>!document.getElementById('btnTourneyStartMatch').hidden,{timeout:8000});

    // helper: play the current match — find the 2 players (mySide set) + 2 spectators
    async function playMatch(n){
      await H.click('#btnTourneyStartMatch');
      // wait until everyone has a role assigned (live for all 4)
      for(const p of pages) await p.waitForFunction(()=>document.body.classList.contains('live'),{timeout:15000});
      const sides=await Promise.all(pages.map(mySide));
      const players=pages.filter((p,i)=>sides[i]!==null);
      const specs=pages.filter((p,i)=>sides[i]===null);
      check(players.length===2 && specs.length===2, `match ${n}: 2 players + 2 spectators`);
      const specOn=await Promise.all(specs.map(isSpec));
      check(specOn.every(Boolean), `match ${n}: spectators show the On-Air view`);
      const seeds=await Promise.all(pages.map(p=>p.evaluate(()=>document.getElementById('seed').value)));
      check(new Set(seeds).size===1 && seeds[0], `match ${n}: all four share the seed ${seeds[0]}`);
      // play one lockstep turn: both players submit
      for(const p of players){
        await p.waitForFunction(()=>document.getElementById('picker').classList.contains('on'),{timeout:20000});
        await p.click('#pkGo');
      }
      // spectators advance in lockstep from the released turn
      for(const p of specs) await p.waitForFunction(()=>PVP.turn>=1,{timeout:20000});
      // the code's own desync guard compares the submitted hash to local at each
      // frozen decision point; if any spectator's sim had diverged it would have fired.
      const desynced=await Promise.all(pages.map(p=>p.evaluate(()=>PVP._desynced)));
      check(!desynced.some(Boolean), `match ${n}: no desync flagged (players + spectators in lockstep)`);
      // end the match: force game-over on the two players (side 0 wins)
      for(const p of players) await p.evaluate(()=>{S.over=true;S.win=0;endGame();});
      // everyone returns to the bracket board (server advanced)
      for(const p of pages) await p.waitForFunction(()=>{
        const co=document.getElementById('champOverlay');
        return (document.getElementById('publicTourney').classList.contains('on')&&!document.getElementById('tourneyBoard').hidden)
          || (co && !co.hidden);
      },{timeout:20000});
    }

    log('3. Play match 1 (2 play, 2 spectate live)…'); await playMatch(1);
    log('4. Play match 2…'); await playMatch(2);
    log('5. Play the final…'); await playMatch(3);

    log('6. Champion crowned…');
    for(const p of pages) await p.waitForFunction(()=>!document.getElementById('champOverlay').hidden,{timeout:15000});
    const champ=await H.evaluate(()=>document.getElementById('champName').textContent);
    check(champ && champ!=='—', 'champion overlay shows on all clients: '+champ);


    log('7. Tournament saved to history (players + champion + timestamp)…');
    await H.waitForTimeout(500);
    const hist=await H.evaluate(async()=>await apiRequest('/v1/tournaments/history'));
    check(hist && Array.isArray(hist.tournaments) && hist.tournaments.length>=1, 'a completed Cup is in history');
    const cup=hist.tournaments[0];
    check(cup.players && cup.players.length===4, 'history records all 4 players');
    check(cup.champion && cup.champion.name, 'history records the champion');
    check(!!cup.endedAt && !!cup.startedAt, 'history has start + end timestamps');
    check(cup.players.some(p=>p.you), 'the caller is marked in their own roster');
    log(failed?'\nTOURNAMENT E2E: FAILURES ABOVE':'\nTOURNAMENT E2E: ALL CHECKS PASSED');
  }catch(e){failed=true;log('E2E ERROR:',e.message);}
  finally{await browser.close();process.exit(failed?1:0);}
})();
