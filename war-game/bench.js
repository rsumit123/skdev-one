#!/usr/bin/env node
/* ============================================================================
   Breach balance instrument.       node war-game/bench.js [quick|full|gate]

   WHY THIS EXISTS
   The old archetype round-robin was not a trustworthy test. A strategy's win
   rate depends chaotically on WHICH 4-second decision tick it first commits
   on: buying nothing for 30s beats the adaptive agent 84% of the time, and
   ecogreedy scores 15% at an 8s delay but 100% at 12s — a 85-point swing over
   400 games a cell. Any single-phase measurement is therefore reading that
   resonance, not the strategy.

   Commit phase is a nuisance parameter, so this harness marginalises over it:
   every pairing is played across a grid of per-side decision-clock offsets and
   the reported number is the mean. Crucially the offsets are applied HERE, by
   the driver that feeds queues into the sim — the game itself is untouched, so
   what we measure is the shipping game and not a modified one.

   HOW IT READS THE GAME
   index.html is a single self-contained file with no build step, so the sim is
   extracted by slicing the inline script at four exact string boundaries (the
   COMMANDERS banner, the top-level `let S, R, LOG...` declaration, the reset
   block inside newGame, and the endGame call in step). Those four strings must
   stay byte-identical or this harness fails loudly rather than silently
   measuring the wrong thing.
   ========================================================================= */
const fs=require('fs'), vm=require('vm'), path=require('path');
const HTML=path.join(__dirname,'index.html');

const CUTS={
  banner:'/* ------------------------------------------------------------\n   3b. COMMANDERS',
  decl:"let S, R, LOG, RUNNING=false, SPEED=1, TAB='battle', RAF=null, FX=[];",
  reset:/  LOG=\[\]; FX=\[\]; RUNNING=false;[\s\S]*?btnPlay'\)\.textContent='Start';/,
  end:'  if(S.over) endGame();',
};

function sim(overrides){
  const src=fs.readFileSync(HTML,'utf8');
  const m=src.split('<script>')[1];
  if(!m) throw new Error('no inline <script> found in index.html');
  const js=m.split('</'+'script>')[0];
  for(const [k,v] of Object.entries(CUTS)){
    const hit = v instanceof RegExp ? v.test(js) : js.includes(v);
    if(!hit) throw new Error(`boundary "${k}" no longer matches index.html — bench.js needs updating`);
  }
  let c=js.split(CUTS.banner)[0]
    .replace(CUTS.decl,'let S,R,LOG,FX=[];')
    .replace(CUTS.reset,'  LOG=[];FX=[];')
    .replace(CUTS.end,'');
  for(const [k,v] of Object.entries(overrides||{})){
    const re=new RegExp('(\\b'+k+'=)(-?[0-9.]+)');
    if(!re.test(c)) throw new Error('cannot override '+k);
    c=c.replace(re,'$1'+v);
  }
  return c;
}

/* Archetypes. `control` is identical to `adaptive` and must score 50% — it is
   the harness checking its own win-attribution and side-flip bookkeeping. */
const DRIVER=`
const ARCH={
  adaptive:(St,s)=>agent(St,s).queue,
  control:(St,s)=>agent(St,s).queue,
  turtle:(St,s)=> (typeof FORT_MAX!=='undefined'&&St.fort&&St.fort[s]<FORT_MAX) ? ['fort']
                : St.eco[s]<ECO_MAX ? ['eco'] : ['inf','gun'],
  ecogreedy:(St,s)=> St.eco[s]<ECO_MAX ? ['eco','inf'] : ['inf','gun','inf'],
  ecorush:(St,s)=> St.eco[s]<ECO_MAX ? ['eco'] : ['inf','gun','inf'],
  spam:()=>['inf','inf','inf'],
  noeco:(St,s)=>agent(St,s).queue.filter(x=>x!=='eco'&&x!=='fort'),
  rush:()=>['inf','inf','air'],
  airrush:()=>['air'],                                  // can air alone win?
  airspam:(St,s)=>St.units.filter(u=>u.s===s&&UNITS[u.type].cls==='air').length<3?['air']:['air','inf'],
  noAT:(St,s)=>agent(St,s).queue.filter(x=>x!=='at'),   // is air an unanswerable lock?
  noAir:(St,s)=>agent(St,s).queue.filter(x=>x!=='air'), // is air mandatory?
  stall:(St,s)=> St.t<30 ? [] : agent(St,s).queue,   // the exploit, kept as a probe
};

/* One match. Each side runs its OWN decision clock, offset by off[side]; that
   offset is the nuisance parameter we average over. off=[0,0] reproduces the
   game's real schedule exactly. */
function play(seed,fa,fb,off){
  newGame(seed);
  const next=[off[0],off[1]];
  while(!S.over){
    for(let s=0;s<2;s++) if(S.t>=next[s]){
      S.q[s]=ARCH[s===0?fa:fb](S,s)||[]; next[s]+=DECIDE;
    }
    step(.05);
  }
  return {win:S.win,t:S.t};
}

/* Phase-averaged head-to-head. Every seed is played from both seats (cancelling
   the known Vulcan side advantage) at every offset pair in the grid. */
function duel(a,b,seeds,offs){
  let w=0,n=0,to=0,len=0;
  for(let seed=1;seed<=seeds;seed++)
    for(const oa of offs) for(const ob of offs)
      for(const flip of [0,1]){
        const r = flip ? play(seed,b,a,[oa,ob]) : play(seed,a,b,[oa,ob]);
        n++; len+=r.t; if(r.t>=299) to++;
        if(r.win===(flip?1:0)) w++;
      }
  const p=w/n;
  return {pct:+(100*p).toFixed(1), n, to,
          ci:+(196*Math.sqrt(p*(1-p)/n)).toFixed(1), len:+(len/n).toFixed(0)};
}

function mirror(N){
  let a=0,b=0,l=[];
  for(let seed=1;seed<=N;seed++){
    newGame(seed);
    while(!S.over){ if(S.t>=S.next){for(let s=0;s<2;s++)S.q[s]=agent(S,s).queue||[];S.next+=DECIDE;} step(.05); }
    l.push(+S.t.toFixed(0)); if(S.win===0)a++;else if(S.win===1)b++;
  }
  l.sort((x,y)=>x-y);
  return {a,b,med:l[Math.floor(N/2)],to:l.filter(x=>x>=299).length};
}
`;

function run(overrides,expr){
  const ctx={console,OUT:null};
  vm.runInNewContext(sim(overrides)+DRIVER+'\nOUT=JSON.stringify('+expr+');',ctx);
  return JSON.parse(ctx.OUT);
}

/* ---- profiles. offs is the phase grid; DECIDE is 4s so 0..3 covers it. ---- */
const MODE=process.argv[2]||'quick';
const PROF={
  quick:{seeds:25, offs:[0,2],       label:'quick'},
  full: {seeds:60, offs:[0,1,2,3],   label:'full'},
  gate: {seeds:40, offs:[0,1,2,3],   label:'gate'},
  record:{seeds:40, offs:[0,1,2,3],   label:'record'},
}[MODE];
if(!PROF){ console.error('usage: bench.js [quick|full|gate]'); process.exit(2); }

const POOL=['control','ecogreedy','ecorush','spam','noeco','rush','stall','turtle','airrush','airspam','noAT','noAir'];
const OFFS=JSON.stringify(PROF.offs);

console.log(`Breach balance instrument — ${PROF.label}: ${PROF.seeds} seeds x `
  +`${PROF.offs.length}x${PROF.offs.length} phase grid x 2 seats\n`);

/* 1000 seeds, not 200. At 200 the 95% interval is +/-6.9pp, so an ordinary
   sample reads as a side bias -- one build showed 82/118 here and 1450/1550
   (even) at 3000 seeds. The check is now "are the sides even, within the
   interval", which is the property we actually care about, rather than an
   equality against a magic pair of numbers that goes stale on every rebalance. */
const m=run(null,`mirror(1000)`);
const mp=m.a/(m.a+m.b), mci=1.96*Math.sqrt(mp*(1-mp)/(m.a+m.b))*100;
const mirrorOK = Math.abs(mp*100-50) <= mci && m.to===0;
console.log(`mirror   ${m.a}/${m.b}  side0 ${(mp*100).toFixed(1)}% `
  +`[${(mp*100-mci).toFixed(1)}-${(mp*100+mci).toFixed(1)}]  median ${m.med}s  timeouts ${m.to}   `
  +(mirrorOK?'even':'*** SIDE BIAS ***'));

console.log('\nphase-averaged win% vs adaptive (95% CI):');
let worst=null, ctl=null;
for(const a of POOL){
  if(!run(null,`typeof FORT_MAX!=='undefined'`) && a==='turtle') continue;
  const r=run(null,`duel('${a}','adaptive',${PROF.seeds},${OFFS})`);
  const band = r.pct>65||r.pct<35;
  console.log('  '+a.padEnd(11)+String(r.pct).padStart(5)+'% ±'+String(r.ci).padStart(4)
    +'   n='+String(r.n).padStart(5)+'  avg '+String(r.len).padStart(3)+'s'
    +(a==='control' ? (Math.abs(r.pct-50)<=r.ci ? '   [control ok]' : '   *** CONTROL OFF 50% — HARNESS SUSPECT ***')
                    : (band?'   <-- OUT OF BAND':'')));
  if(a==='control') ctl=r;
  else if(!worst||r.pct>worst.pct) worst={a,...r};
}

console.log(`\nworst archetype: ${worst.a} at ${worst.pct}%`);

/* The gate answers "did this change move the game", not "is the game perfect".
   An absolute band would fail forever on the known stall exploit and so would
   be ignored within a week. Instead it diffs against a recorded baseline and
   fails on drift beyond the combined confidence intervals, plus two absolute
   rules: the control must sit on 50%, and nothing NEW may cross 65%. */
const BASE=path.join(__dirname,'bench.baseline.json');
if(MODE==='record'){
  const rec={profile:'gate',mirror:m,rows:{}};
  for(const a of POOL) rec.rows[a]=run(null,`duel('${a}','adaptive',${PROF.seeds},${OFFS})`);
  fs.writeFileSync(BASE,JSON.stringify(rec,null,2)+'\n');
  console.log('\nbaseline written to '+path.relative(process.cwd(),BASE));
}
if(MODE==='gate'){
  if(!fs.existsSync(BASE)){ console.error('\nno baseline — run: node war-game/bench.js record'); process.exit(2); }
  const base=JSON.parse(fs.readFileSync(BASE,'utf8'));
  const fails=[];
  if(!ctl || Math.abs(ctl.pct-50)>ctl.ci) fails.push('control off 50% — harness suspect');
  if(!mirrorOK) fails.push(`mirror side bias ${m.a}/${m.b}, ${m.to} timeouts`);
  console.log('\ndrift vs baseline:');
  for(const a of POOL){
    const b=base.rows[a]; if(!b) continue;
    const r=run(null,`duel('${a}','adaptive',${PROF.seeds},${OFFS})`);
    const d=r.pct-b.pct, tol=r.ci+b.ci;
    const bad=Math.abs(d)>tol;
    console.log('  '+a.padEnd(11)+String(b.pct).padStart(5)+'% -> '+String(r.pct).padStart(5)+'%   '
      +(d>=0?'+':'')+d.toFixed(1)+'pp (tol ±'+tol.toFixed(1)+')'+(bad?'   <-- DRIFT':''));
    if(bad) fails.push(`${a} moved ${d>=0?'+':''}${d.toFixed(1)}pp`);
    if(r.pct>65 && b.pct<=65) fails.push(`${a} newly dominant at ${r.pct}%`);
  }
  console.log(fails.length?'\nGATE: FAIL\n  - '+fails.join('\n  - '):'\nGATE: PASS');
  process.exit(fails.length?1:0);
}
