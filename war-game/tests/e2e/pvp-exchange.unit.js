const fs=require('fs'),vm=require('vm');
const html=fs.readFileSync('/Users/rsumit123/work/skdev-one/war-game/index.html','utf8');
// extract the PVP object literal (const PVP={ ... };) and pvpStateHash
const pvpM=html.match(/const PVP=\{[\s\S]*?\n\};/);
const hashM=html.match(/function pvpStateHash\(\)\{[\s\S]*?\n\}/);
if(!pvpM||!hashM){console.error('EXTRACT FAILED');process.exit(1);}
const sandbox={S:null,JSON,console,showToast:()=>{},stopPublicBattle:null,setReconnectBanner:()=>{}};
vm.createContext(sandbox);
vm.runInContext(pvpM[0]+'\n'+hashM[0]+'\nthis._PVP=PVP;this._hash=pvpStateHash;',sandbox);
const PVP=sandbox._PVP;
let pass=0,fail=0;
const ok=(c,m)=>{if(c){pass++;}else{fail++;console.error('FAIL:',m);}};

// --- Test 1: multi-waiter (mySide + oppSide both await same turn, one release resolves both)
(async()=>{
  PVP.reset();
  const p0=PVP.awaitRelease(0);   // e.g. oppSide branch
  const p1=PVP.awaitRelease(0);   // e.g. mySide branch, same turn
  const payload={turn:0,decisions:[{queue:['inf'],stance:'push'},{queue:[],stance:'hold'}],hashes:['h','h']};
  PVP.onRelease(payload);
  const [r0,r1]=await Promise.all([p0,p1]);
  ok(r0===payload&&r1===payload,'both waiters on same turn resolve to the release');

  // --- Test 2: release-before-await (fast opponent: release arrives before this side registers)
  PVP.reset();
  PVP.onRelease({turn:0,decisions:[{queue:[],stance:'push'},{queue:[],stance:'push'}],hashes:[null,null]});
  const late=await PVP.awaitRelease(0);
  ok(late&&late.turn===0,'awaitRelease after onRelease returns cached payload');

  // --- Test 3: independent turns don't cross-resolve
  PVP.reset();
  const t1=PVP.awaitRelease(1);
  let t1done=false; t1.then(()=>t1done=true);
  PVP.onRelease({turn:0,decisions:[{queue:[],stance:'push'},{queue:[],stance:'push'}],hashes:[null,null]});
  await new Promise(r=>setTimeout(r,5));
  ok(!t1done,'release for turn 0 does not resolve a waiter for turn 1');
  PVP.onRelease({turn:1,decisions:[{queue:[],stance:'push'},{queue:[],stance:'push'}],hashes:[null,null]});
  await t1; ok(t1done,'release for turn 1 resolves its own waiter');

  // --- Test 4: hash determinism — same state => same hash, different state => different
  const st=()=>({t:5,next:10,nid:3,coins:[20.5,19.5],inc:[1,1],eco:[1,0],hp:[100,100],
    stance:[0,1],tower:{holder:0,holdT:2},units:[{id:2,s:1,type:'gun',x:40,hp:9,fl:0},{id:1,s:0,type:'inf',x:12,hp:5,fl:0}]});
  sandbox.S=st(); const hA=sandbox._hash();
  sandbox.S=st(); const hB=sandbox._hash();   // fresh identical
  ok(hA===hB,'identical state => identical hash');
  sandbox.S=st(); sandbox.S.units[0].hp=8; const hC=sandbox._hash();
  ok(hA!==hC,'a single hp change => different hash');
  // unit order independence (sorted by id): shuffle input, same hash
  sandbox.S=st(); sandbox.S.units.reverse(); const hD=sandbox._hash();
  ok(hA===hD,'unit array order does not affect hash (sorted by id)');

  console.log(`\nPVP exchange unit test: ${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
