const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

const INDEX=path.join(__dirname,'index.html');
const START='/* PUBLIC APP TEST SLICE START */';
const END='/* PUBLIC APP TEST SLICE END */';
const DOM_START='/* PUBLIC DOM TEST SLICE START */';
const DOM_END='/* PUBLIC DOM TEST SLICE END */';

function storage(initial={}){
  const values=new Map(Object.entries(initial));
  return {
    getItem:key=>values.has(key)?values.get(key):null,
    setItem:(key,value)=>values.set(key,String(value)),
    removeItem:key=>values.delete(key)
  };
}
function jsonResponse(status,data){
  return {ok:status>=200&&status<300,status,json:async()=>data};
}

function loadSlice(overrides={}){
  const source=fs.readFileSync(INDEX,'utf8');
  const start=source.indexOf(START),end=source.indexOf(END);
  assert.notEqual(start,-1,'public app test slice start marker must exist');
  assert.notEqual(end,-1,'public app test slice end marker must exist');
  const localStorage=overrides.localStorage||storage();
  const context=vm.createContext({
    fetch:overrides.fetch||(async()=>jsonResponse(200,{})),
    localStorage,
    AbortController,
    URL,
    Date,
    Math,
    Error,
    Object,
    JSON,
    buildBattleView:overrides.buildBattleView||(()=>({}))
  });
  const exports=['PUB','guestToken','dossierKey','setIdentity','setAllowance','quotaView',
    'difficultyAccess','publicMessage','apiRequest','bootPublicApp','submitGuest','submitSignup',
    'submitLogin','logout','exhaustionAction','formatCountdown','countdownRefreshDue',
    'loadDifficulties','startDifficulty','difficultyButtonDisabled','refreshPublicSession',
    'battleViewForServer','publicCommanders','serverDecisionState','completionOutcome',
    'recentBattleText','relativeBattleTime','writePublicName','publicHistoryRow','publicPlayerRow',
    'publicAiRow','resultCardState','requestPublicDecision','completePublicGame',
    'canOpenLab','benchmarkRequest','startBenchmark','benchmarkCommanders','startMockDiagnostic',
    'benchmarkHumanSide','benchmarkActionLabel'];
  const expose=exports.map(name=>`${JSON.stringify(name)}:typeof ${name}==='undefined'?undefined:${name}`).join(',');
  vm.runInContext(`${source.slice(start,end+END.length)}\nglobalThis.__slice={${expose}};`,context);
  return {...context.__slice,localStorage};
}

function loadDomSlice(PUB,document){
  const source=fs.readFileSync(INDEX,'utf8');
  const start=source.indexOf(DOM_START),end=source.indexOf(DOM_END);
  assert.notEqual(start,-1,'public DOM test slice start marker must exist');
  assert.notEqual(end,-1,'public DOM test slice end marker must exist');
  const context=vm.createContext({PUB,document,canOpenLab:loadSlice().canOpenLab});
  vm.runInContext(`${source.slice(start,end+DOM_END.length)}\nglobalThis.__dom={setPublicBusy,setPublicHidden,syncBenchmarkLabAccess};`,context);
  return context.__dom;
}

function publicActionDocument(buttons){
  return {
    querySelectorAll(selector){
      if(selector==='.public-shell button')return buttons;
      if(selector==='.public-shell form button[type="submit"]'){
        return buttons.filter(button=>button.type==='submit');
      }
      return [];
    }
  };
}

const readIndex=()=>fs.readFileSync(INDEX,'utf8');
function loadHowToSlice(seed={},runtime={}){
  const html=readIndex();
  const hit=html.match(/\/\* HOW TO PLAY TEST SLICE START \*\/([\s\S]*?)\/\* HOW TO PLAY TEST SLICE END \*\//);
  assert.ok(hit,'How to Play test slice is present');
  const localStorage=storage(seed);
  return Function('localStorage','maybeOpenHowTo','currentHowToResolution',`${hit[1]};return {
    onboardingKey,finishHowTo,shouldShowHowTo,
    howToDismissOptions:typeof howToDismissOptions==='undefined'?undefined:howToDismissOptions,
    onPublicIdentityResolved:typeof onPublicIdentityResolved==='undefined'?undefined:onPublicIdentityResolved,
    mountHowToReplay:typeof mountHowToReplay==='undefined'?undefined:mountHowToReplay
  };`)(localStorage,runtime.maybeOpenHowTo||(()=>false),runtime.currentHowToResolution||(()=>null));
}
function loadDialogSlice(){
  const html=readIndex();
  const hit=html.match(/\/\* DIALOG FOCUS TEST SLICE START \*\/([\s\S]*?)\/\* DIALOG FOCUS TEST SLICE END \*\//);
  assert.ok(hit,'dialog focus test slice is present');
  return Function(`${hit[1]};return {trapFocusTarget,pushDialogFrame,popDialogFrame};`)();
}

function publicMarkup(html){
  const sections=[...html.matchAll(/<!-- PUBLIC MARKUP START -->([\s\S]*?)<!-- PUBLIC MARKUP END -->/g)];
  assert.ok(sections.length,'public markup boundary is present');
  return sections.map(section=>section[1]).join('\n');
}

test('onboarding completion is namespaced by current identity',()=>{
  const ctx=loadHowToSlice();
  assert.equal(ctx.onboardingKey({kind:'guest',id:'g1'}),'breach.howto.guest.g1');
  assert.equal(ctx.onboardingKey({kind:'user',id:'u1'}),'breach.howto.user.u1');
});

test('onboarding completion prevents automatic reopening for only that identity',()=>{
  const ctx=loadHowToSlice();
  const user={kind:'user',id:'u1'};
  ctx.finishHowTo(user);
  assert.equal(ctx.shouldShowHowTo(user),false);
  assert.equal(ctx.shouldShowHowTo({kind:'guest',id:'u1'}),true);
});

test('apiRequest includes cookies and the current guest token',async()=>{
  const calls=[];
  const ctx=loadSlice({
    fetch:async(...args)=>{calls.push(args);return jsonResponse(200,{ok:true});},
    localStorage:storage({'breach.guestToken':'guest-secret'})
  });
  await ctx.apiRequest('/v1/me');
  assert.equal(calls[0][0],'https://breach-api.skdev.one/v1/me');
  assert.equal(calls[0][1].credentials,'include');
  assert.equal(calls[0][1].headers['X-Breach-Guest'],'guest-secret');
});

test('apiRequest serializes only the supplied public request body',async()=>{
  const calls=[];
  const ctx=loadSlice({fetch:async(...args)=>{calls.push(args);return jsonResponse(201,{ok:true});}});
  await ctx.apiRequest('/v1/games',{method:'POST',body:{difficulty:'easy'}});
  assert.equal(calls[0][1].method,'POST');
  assert.equal(calls[0][1].headers['Content-Type'],'application/json');
  assert.equal(calls[0][1].body,'{"difficulty":"easy"}');
  assert.equal('X-Breach-Guest' in calls[0][1].headers,false);
});

test('apiRequest exposes stable public errors without raw backend detail',async()=>{
  const ctx=loadSlice({fetch:async()=>jsonResponse(503,{code:'tier_unavailable',detail:'provider exploded'})});
  await assert.rejects(
    ctx.apiRequest('/v1/games'),
    error=>error.code==='tier_unavailable'
      && error.message==='That AI commander is temporarily unavailable. Your game was refunded.'
      && !error.message.includes('provider exploded')
  );
});

test('unknown backend errors use a sanitized retry message',()=>{
  const ctx=loadSlice();
  assert.equal(ctx.publicMessage('private_stack_trace'),'Something interrupted the connection. Please try again.');
});

test('network failures are translated at the API boundary',async()=>{
  const ctx=loadSlice({fetch:async()=>{throw new TypeError('Failed to fetch internal host');}});
  await assert.rejects(
    ctx.apiRequest('/v1/me'),
    error=>error.code==='connection_error'
      && error.message==='Something interrupted the connection. Please try again.'
      && !error.message.includes('internal host')
  );
});

test('quota view uses the server reset timestamp and never goes negative',()=>{
  const ctx=loadSlice();
  assert.deepEqual(
    {...ctx.quotaView({remaining:2,resetsAt:'2026-08-24T00:00:00+05:30'},Date.parse('2026-08-23T23:59:58+05:30'))},
    {remaining:2,seconds:2}
  );
  assert.equal(ctx.quotaView({remaining:2,resetsAt:'2026-08-24T00:00:00+05:30'},Date.parse('2026-08-24T00:00:01+05:30')).seconds,0);
});

test('hard access is account-only',()=>{
  const ctx=loadSlice();
  assert.equal(ctx.difficultyAccess({kind:'guest'},'hard'),false);
  assert.equal(ctx.difficultyAccess({kind:'user'},'hard'),true);
  assert.equal(ctx.difficultyAccess({kind:'guest'},'medium'),true);
});

test('benchmark lab visibility depends only on the server admin flag',()=>{
  const ctx=loadSlice();
  assert.equal(ctx.canOpenLab(null),false);
  assert.equal(ctx.canOpenLab({kind:'guest',displayName:'Owner',isAdmin:true}),false);
  assert.equal(ctx.canOpenLab({kind:'user',displayName:'rsumit123@gmail.com',isAdmin:false}),false);
  assert.equal(ctx.canOpenLab({kind:'user',displayName:'Owner',isAdmin:true}),true);
});

test('non-admin identities cannot invoke benchmark creation',async()=>{
  let calls=0;
  const ctx=loadSlice({fetch:async()=>{calls++;return jsonResponse(201,{});}});
  ctx.setIdentity({kind:'user',id:'u1',displayName:'rsumit123@gmail.com',isAdmin:false});
  await assert.rejects(
    ctx.startBenchmark({modelA:'alpha',modelB:'beta',humanSide:null,seed:42,memory:true,sideSwap:false}),
    error=>error.code==='admin_required'
  );
  assert.equal(calls,0);
  assert.equal(ctx.PUB.game,null);
});

test('admin benchmark creation sends the exact server configuration',async()=>{
  const calls=[];
  const response={gameId:'bms_1',mode:'benchmark',modelA:'alpha',modelB:'beta',humanSide:null,
    seed:-7,memory:true,sideSwap:false,promptVersion:8,expiresAt:'2026-08-24T15:30:00Z'};
  const ctx=loadSlice({fetch:async(...args)=>{calls.push(args);return jsonResponse(201,response);}});
  ctx.setIdentity({kind:'user',id:'owner',displayName:'Owner',isAdmin:true});
  const result=await ctx.startBenchmark({modelA:'alpha',modelB:'beta',humanSide:null,seed:-7,
    memory:true,sideSwap:false,ignored:'must-not-leak'});
  assert.equal(calls[0][0],'https://breach-api.skdev.one/v1/admin/games');
  assert.deepEqual(JSON.parse(calls[0][1].body),{
    modelA:'alpha',modelB:'beta',humanSide:null,seed:-7,memory:true,sideSwap:false
  });
  assert.equal(result.gameId,'bms_1');
  assert.equal(ctx.PUB.game.gameId,'bms_1');
});

test('benchmark commander seats use server models except for the authorized human side',()=>{
  const ctx=loadSlice();
  const modelGame={modelA:'alpha',modelB:'beta',humanSide:null};
  assert.deepEqual(Array.from(ctx.benchmarkCommanders(modelGame),entry=>({...entry})),[
    {kind:'server',model:'alpha'},{kind:'server',model:'beta'}
  ]);
  assert.deepEqual(Array.from(ctx.benchmarkCommanders({...modelGame,humanSide:1}),entry=>({...entry})),[
    {kind:'server',model:'alpha'},{kind:'human',model:'beta'}
  ]);
});

test('benchmark human seat selection allows at most one human commander',()=>{
  const ctx=loadSlice();
  assert.equal(ctx.benchmarkHumanSide('server','server'),null);
  assert.equal(ctx.benchmarkHumanSide('human','server'),0);
  assert.equal(ctx.benchmarkHumanSide('server','human'),1);
  assert.throws(()=>ctx.benchmarkHumanSide('human','human'),error=>error.code==='invalid_request');
});

test('server denial cannot leave a forged benchmark session',async()=>{
  const ctx=loadSlice({fetch:async()=>jsonResponse(403,{code:'admin_required',detail:'private'})});
  ctx.setIdentity({kind:'user',id:'owner',displayName:'Owner',isAdmin:true});
  await assert.rejects(
    ctx.startBenchmark({modelA:'alpha',modelB:'beta',humanSide:null,seed:42,memory:true,sideSwap:false}),
    error=>error.code==='admin_required'&&error.message==='This command requires Benchmark Lab access.'
  );
  assert.equal(ctx.PUB.game,null);
});

test('a delayed benchmark response cannot revive admin state after logout',async()=>{
  let resolveBenchmark;
  const pendingResponse=new Promise(resolve=>{resolveBenchmark=resolve;});
  const ctx=loadSlice({fetch:async url=>url.endsWith('/v1/admin/games')?pendingResponse:
    ({ok:true,status:204,json:async()=>{throw new Error('no body');}})});
  ctx.setIdentity({kind:'user',id:'owner',displayName:'Owner',isAdmin:true});
  const pending=ctx.startBenchmark({modelA:'alpha',modelB:'beta',humanSide:null,seed:42,memory:true,sideSwap:false});
  await Promise.resolve();
  await ctx.logout();
  resolveBenchmark(jsonResponse(201,{gameId:'bms_stale',modelA:'alpha',modelB:'beta',humanSide:null,seed:42,memory:true,sideSwap:false}));
  const result=await pending;
  assert.equal(result.view,'stale');
  assert.equal(ctx.PUB.identity,null);
  assert.equal(ctx.PUB.game,null);
});

test('admin mock diagnostic is local, unrecorded, and never creates a server game',()=>{
  let calls=0;
  const ctx=loadSlice({fetch:async()=>{calls++;return jsonResponse(201,{});}});
  ctx.setIdentity({kind:'user',id:'owner',displayName:'Owner',isAdmin:true});
  const result=ctx.startMockDiagnostic({seed:19});
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{mode:'local_diagnostic',seed:19,recorded:false,
    commanders:[{kind:'mock',model:''},{kind:'mock',model:''}]});
  assert.equal(calls,0);
  assert.equal(ctx.PUB.game,null);
});

test('non-admin identities cannot invoke the local mock diagnostic',()=>{
  const ctx=loadSlice();
  ctx.setIdentity({kind:'guest',id:'g1',displayName:'Guest1:Owner',isAdmin:false});
  assert.throws(()=>ctx.startMockDiagnostic({seed:19}),error=>error.code==='admin_required');
});

test('local diagnostic start copy never implies server authorization',()=>{
  const ctx=loadSlice();
  assert.equal(ctx.benchmarkActionLabel(false),'Authorize benchmark');
  assert.equal(ctx.benchmarkActionLabel(true),'Run local diagnostic');
});

test('guest and user menus hide the lab while the admin menu reveals it',()=>{
  const buttons=new Map(['btnBenchmarkLab','btnSetupOpen','btnSetupOpen2'].map(id=>[id,{hidden:false}]));
  const document={
    querySelectorAll(){return [];},
    getElementById(id){return buttons.get(id)||null;}
  };
  const PUB={busy:false,identity:{kind:'guest',id:'g1',isAdmin:false}};
  const dom=loadDomSlice(PUB,document);
  assert.equal(dom.syncBenchmarkLabAccess(),false);
  assert.deepEqual(Array.from(buttons.values(),button=>button.hidden),[true,true,true]);
  PUB.identity={kind:'user',id:'u1',displayName:'Owner',isAdmin:true};
  assert.equal(dom.syncBenchmarkLabAccess(),true);
  assert.deepEqual(Array.from(buttons.values(),button=>button.hidden),[false,false,false]);
});

test('benchmark lab has no browser credential or results-server fields',()=>{
  const html=readIndex();
  const hit=html.match(/<div class="modal" id="mSetup">([\s\S]*?)<div class="modal" id="mPicker">/);
  assert.ok(hit,'benchmark lab modal exists');
  for(const id of ['apikey','remember','apiBase','apiTok','btnApiTest','btnApiPushAll']){
    assert.equal(new RegExp(`id=["']${id}["']`).test(hit[1]),false,id);
  }
});

test('benchmark lab owns the technical session controls removed from the public unit guide',()=>{
  const html=readIndex();
  const lab=html.match(/<div class="modal" id="mSetup">([\s\S]*?)<div class="modal" id="mPicker">/);
  const units=html.match(/<div class="modal" id="mUnits">([\s\S]*?)<script>/);
  assert.ok(lab&&units);
  for(const id of ['seed','memory','labels','lowfx','btnExport']){
    assert.match(lab[1],new RegExp(`id=["']${id}["']`),id);
    assert.equal(new RegExp(`id=["']${id}["']`).test(units[1]),false,id);
  }
  assert.match(lab[1],/Prompt v8/);
});

test('dossier keys keep guest and user memories separate',()=>{
  const ctx=loadSlice();
  assert.notEqual(
    ctx.dossierKey({kind:'guest',id:'g1'},'google/gemini-3.7-flash'),
    ctx.dossierKey({kind:'user',id:'u1'},'google/gemini-3.7-flash')
  );
});

test('signed-in identity wins over a stored guest token without deleting it',()=>{
  const ctx=loadSlice({localStorage:storage({'breach.guestToken':'g-token'})});
  ctx.setIdentity({kind:'user',id:'u1',displayName:'Rahul',isAdmin:false});
  assert.equal(ctx.PUB.identity.kind,'user');
  assert.equal(ctx.localStorage.getItem('breach.guestToken'),'g-token');
});

test('guest creation stores only the guest token and accepts server identity',async()=>{
  const calls=[];
  const ctx=loadSlice({fetch:async(url,options)=>{
    calls.push([url,options]);
    return jsonResponse(201,{
      guestToken:'issued-token',
      identity:{kind:'guest',id:'g1',displayName:'Guest1:Rahul',isAdmin:false},
      allowance:{remaining:3,limit:3,resetsAt:'2026-08-25T00:00:00+05:30'}
    });
  }});
  const result=await ctx.submitGuest('Rahul');
  assert.equal(calls[0][0],'https://breach-api.skdev.one/v1/guests');
  assert.equal(calls[0][1].body,'{"displayName":"Rahul"}');
  assert.equal(ctx.localStorage.getItem('breach.guestToken'),'issued-token');
  assert.equal(ctx.PUB.identity.displayName,'Guest1:Rahul');
  assert.equal(result.view,'home');
});

test('signup and login send exactly the backend auth schemas',async()=>{
  const calls=[];
  const ctx=loadSlice({
    localStorage:storage({'breach.guestToken':'preserved'}),
    fetch:async(url,options)=>{
      calls.push([url,options]);
      return jsonResponse(url.endsWith('/signup')?201:200,{
        identity:{kind:'user',id:'u1',displayName:'Rahul',isAdmin:false},
        allowance:{remaining:10,limit:10,resetsAt:'2026-08-25T00:00:00+05:30'}
      });
    }
  });
  await ctx.submitSignup({displayName:'Rahul',email:'rahul@example.com',password:'password1'});
  await ctx.submitLogin({email:'rahul@example.com',password:'password1'});
  assert.deepEqual(JSON.parse(calls[0][1].body),{
    displayName:'Rahul',email:'rahul@example.com',password:'password1'
  });
  assert.deepEqual(JSON.parse(calls[1][1].body),{
    email:'rahul@example.com',password:'password1'
  });
  assert.equal(ctx.localStorage.getItem('breach.guestToken'),'preserved');
});

test('boot routes an unauthorized visitor to identity without exposing server detail',async()=>{
  const ctx=loadSlice({fetch:async()=>jsonResponse(401,{code:'not_authenticated',detail:'private'})});
  const result=await ctx.bootPublicApp();
  assert.equal(result.view,'identity');
  assert.equal(ctx.PUB.identity,null);
});

test('logout clears account state and restores the separate guest continuation path',async()=>{
  const ctx=loadSlice({
    localStorage:storage({'breach.guestToken':'g-token'}),
    fetch:async()=>({ok:true,status:204,json:async()=>{throw new Error('no body');}})
  });
  ctx.setIdentity({kind:'user',id:'u1',displayName:'Rahul',isAdmin:false});
  const result=await ctx.logout();
  assert.equal(ctx.PUB.identity,null);
  assert.equal(ctx.PUB.allowance,null);
  assert.equal(ctx.guestToken(),'g-token');
  assert.equal(result.view,'identity');
});

test('guest sees hard as locked and registered user sees it enabled',()=>{
  const ctx=loadSlice();
  assert.equal(ctx.difficultyAccess({kind:'guest'},'hard'),false);
  assert.equal(ctx.difficultyAccess({kind:'user'},'hard'),true);
});

test('quota exhaustion produces guest signup and user Pro states',()=>{
  const ctx=loadSlice();
  assert.equal(ctx.exhaustionAction({kind:'guest'}),'create_account');
  assert.equal(ctx.exhaustionAction({kind:'user'}),'pro_coming_soon');
});

test('countdown formatting is stable and reset refresh is requested once per timestamp',()=>{
  const ctx=loadSlice();
  assert.equal(ctx.formatCountdown(15482),'04:18:02');
  assert.equal(ctx.formatCountdown(0),'00:00:00');
  const allowance={remaining:0,resetsAt:'2026-08-25T00:00:00+05:30'};
  const after=Date.parse('2026-08-25T00:00:01+05:30');
  assert.equal(ctx.countdownRefreshDue(allowance,after,''),true);
  assert.equal(ctx.countdownRefreshDue(allowance,after,allowance.resetsAt),false);
});

test('difficulty metadata comes from the identity-scoped endpoint',async()=>{
  const calls=[];
  const ctx=loadSlice({fetch:async(...args)=>{
    calls.push(args);
    return jsonResponse(200,{difficulties:[
      {id:'easy',name:'Easy',requiresAccount:false},
      {id:'medium',name:'Medium',requiresAccount:false},
      {id:'hard',name:'Hard',requiresAccount:true}
    ]});
  }});
  const difficulties=await ctx.loadDifficulties();
  assert.equal(calls[0][0],'https://breach-api.skdev.one/v1/difficulties');
  assert.deepEqual(Array.from(difficulties,item=>item.id),['easy','medium','hard']);
});

test('starting a difficulty sends no client-selected model and builds reveal state',async()=>{
  const calls=[];
  const ctx=loadSlice({fetch:async(...args)=>{
    calls.push(args);
    return jsonResponse(201,{
      gameId:'gms_1',difficulty:'medium',
      opponent:{id:'qwen/qwen3.7-flash',name:'Qwen 3.7 Flash'},humanSide:0,
      gamesRemaining:2,resetsAt:'2026-08-25T00:00:00+05:30',
      expiresAt:'2026-08-24T15:30:00+00:00'
    });
  }});
  ctx.setIdentity({kind:'guest',id:'g1',displayName:'Guest1:Rahul',isAdmin:false});
  const result=await ctx.startDifficulty('medium');
  assert.deepEqual(JSON.parse(calls[0][1].body),{difficulty:'medium'});
  assert.equal(calls[0][1].body.includes('model'),false);
  assert.equal(ctx.PUB.game.opponent.name,'Qwen 3.7 Flash');
  assert.equal(ctx.PUB.allowance.remaining,2);
  assert.equal(result.view,'matchup');
});

test('a fully unavailable tier restores the server-refunded allowance',async()=>{
  const ctx=loadSlice({fetch:async()=>jsonResponse(503,{
    code:'tier_unavailable',gamesRemaining:3,resetsAt:'2026-08-25T00:00:00+05:30'
  })});
  ctx.setIdentity({kind:'guest',id:'g1',displayName:'Guest1:Rahul',isAdmin:false});
  await assert.rejects(ctx.startDifficulty('easy'),error=>error.code==='tier_unavailable');
  assert.equal(ctx.PUB.allowance.remaining,3);
  assert.equal(ctx.PUB.game,null);
});

test('hard selection by a guest never creates a game',async()=>{
  let calls=0;
  const ctx=loadSlice({fetch:async()=>{calls++;return jsonResponse(201,{});}});
  ctx.setIdentity({kind:'guest',id:'g1',displayName:'Guest1:Rahul',isAdmin:false});
  const result=await ctx.startDifficulty('hard');
  assert.equal(calls,0);
  assert.deepEqual({...result},{view:'signup',code:'difficulty_requires_account'});
});

test('busy state disables every public session action, including locked and navigation controls',()=>{
  const buttons=[
    {label:'guest',type:'submit',disabled:false},
    {label:'locked hard',type:'button',disabled:false},
    {label:'sign out',type:'button',disabled:false},
    {label:'menu',type:'button',disabled:false},
    {label:'auth navigation',type:'button',disabled:false},
    {label:'medium',type:'button',disabled:false}
  ];
  const PUB={busy:false};
  const dom=loadDomSlice(PUB,publicActionDocument(buttons));
  dom.setPublicBusy(true);
  assert.equal(PUB.busy,true);
  assert.deepEqual(buttons.map(button=>button.disabled),[true,true,true,true,true,true]);
});

test('home rendering keeps locked Hard disabled while another session action is busy',()=>{
  const ctx=loadSlice();
  const guest={kind:'guest',id:'g1'};
  assert.equal(ctx.difficultyButtonDisabled(guest,{remaining:3},'hard',true),true);
  assert.equal(ctx.difficultyButtonDisabled(guest,{remaining:3},'hard',false),false);
  assert.equal(ctx.difficultyButtonDisabled(guest,{remaining:0},'medium',false),true);
});

test('public hidden state overrides flex layout when switching ranking tabs',()=>{
  const element={hidden:false,style:{display:'flex'}};
  const dom=loadDomSlice({busy:false},publicActionDocument([]));
  dom.setPublicHidden(element,true);
  assert.equal(element.hidden,true);
  assert.equal(element.style.display,'none');
  dom.setPublicHidden(element,false);
  assert.equal(element.hidden,false);
  assert.equal(element.style.display,'');
});

test('a delayed game response cannot replace a newer logout session',async()=>{
  let resolveGame;
  const gameResponse=new Promise(resolve=>{resolveGame=resolve;});
  const ctx=loadSlice({fetch:async(url)=>{
    if(url.endsWith('/v1/games'))return gameResponse;
    return {ok:true,status:204,json:async()=>{throw new Error('no body');}};
  }});
  ctx.setIdentity({kind:'user',id:'u1',displayName:'Rahul',isAdmin:false});
  ctx.setAllowance({remaining:10,resetsAt:'2026-08-25T00:00:00+05:30'});
  const pending=ctx.startDifficulty('medium');
  await Promise.resolve();
  await ctx.logout();
  resolveGame(jsonResponse(201,{
    gameId:'gms_stale',difficulty:'medium',
    opponent:{id:'qwen/qwen3.7-flash',name:'Qwen 3.7 Flash'},humanSide:0,
    gamesRemaining:9,resetsAt:'2026-08-25T00:00:00+05:30',
    expiresAt:'2026-08-24T15:30:00+00:00'
  }));
  const result=await pending;
  assert.equal(result.view,'stale');
  assert.equal(ctx.PUB.view,'identity');
  assert.equal(ctx.PUB.identity,null);
  assert.equal(ctx.PUB.game,null);
  assert.equal(ctx.PUB.allowance,null);
});

test('post-boot 401 expires the current account session but preserves its separate guest continuation',async()=>{
  const ctx=loadSlice({
    localStorage:storage({'breach.guestToken':'guest-continuation'}),
    fetch:async()=>jsonResponse(401,{code:'authentication_required',detail:'private'})
  });
  ctx.setIdentity({kind:'user',id:'u1',displayName:'Rahul',isAdmin:false});
  ctx.setAllowance({remaining:10,resetsAt:'2026-08-25T00:00:00+05:30'});
  ctx.PUB.game={gameId:'old'};
  await assert.rejects(
    ctx.startDifficulty('medium'),
    error=>error.code==='authentication_required'
      && error.message==='Your session expired. Sign in or continue as a guest.'
      && !error.message.includes('private')
  );
  assert.equal(ctx.PUB.view,'identity');
  assert.equal(ctx.PUB.identity,null);
  assert.equal(ctx.PUB.allowance,null);
  assert.equal(ctx.PUB.game,null);
  assert.equal(ctx.guestToken(),'guest-continuation');
});

test('invalid login credentials do not expire an existing guest identity',async()=>{
  const ctx=loadSlice({
    localStorage:storage({'breach.guestToken':'active-guest'}),
    fetch:async()=>jsonResponse(401,{code:'invalid_credentials'})
  });
  ctx.setIdentity({kind:'guest',id:'g1',displayName:'Guest1:Rahul',isAdmin:false});
  await assert.rejects(
    ctx.submitLogin({email:'rahul@example.com',password:'wrong-pass'}),
    error=>error.code==='invalid_credentials'
  );
  assert.equal(ctx.PUB.identity.kind,'guest');
  assert.equal(ctx.guestToken(),'active-guest');
});

test('guest token persistence failures fall back to a safe current-tab session',async()=>{
  const calls=[];
  const brokenStorage={
    getItem(){throw new Error('localStorage read denied');},
    setItem(){throw new Error('localStorage quota exceeded');},
    removeItem(){throw new Error('localStorage remove denied');}
  };
  const ctx=loadSlice({localStorage:brokenStorage,fetch:async(url,options)=>{
    calls.push([url,options]);
    if(url.endsWith('/v1/guests'))return jsonResponse(201,{
      guestToken:'memory-token',
      identity:{kind:'guest',id:'g1',displayName:'Guest1:Rahul',isAdmin:false},
      allowance:{remaining:3,limit:3,resetsAt:'2026-08-25T00:00:00+05:30'}
    });
    return jsonResponse(200,{ok:true});
  }});
  const result=await ctx.submitGuest('Rahul');
  await ctx.apiRequest('/v1/difficulties');
  assert.equal(result.view,'home');
  assert.equal(ctx.PUB.identity.displayName,'Guest1:Rahul');
  assert.equal(calls[1][1].headers['X-Breach-Guest'],'memory-token');
});

test('periodic 401 clears an in-memory guest token even when storage removal fails',async()=>{
  let expired=false;
  const brokenStorage={
    getItem(){throw new Error('read denied');},
    setItem(){throw new Error('write denied');},
    removeItem(){throw new Error('remove denied');}
  };
  const ctx=loadSlice({localStorage:brokenStorage,fetch:async url=>{
    if(url.endsWith('/v1/guests'))return jsonResponse(201,{
      guestToken:'memory-token',
      identity:{kind:'guest',id:'g1',displayName:'Guest1:Rahul',isAdmin:false},
      allowance:{remaining:3,limit:3,resetsAt:'2026-08-25T00:00:00+05:30'}
    });
    expired=true;
    return jsonResponse(401,{code:'authentication_required'});
  }});
  await ctx.submitGuest('Rahul');
  await assert.rejects(ctx.refreshPublicSession(),error=>error.code==='authentication_required');
  assert.equal(expired,true);
  assert.equal(ctx.guestToken(),'');
  assert.equal(ctx.PUB.identity,null);
  assert.equal(ctx.PUB.view,'identity');
});

test('a failed token write cannot let an older persisted token replace the new tab token',async()=>{
  const calls=[];
  const values=new Map([['breach.guestToken','old-token']]);
  const setFailStorage={
    getItem:key=>values.get(key)||null,
    setItem(){throw new Error('write unavailable');},
    removeItem:key=>values.delete(key)
  };
  const ctx=loadSlice({localStorage:setFailStorage,fetch:async(url,options)=>{
    calls.push([url,options]);
    if(url.endsWith('/v1/guests'))return jsonResponse(201,{
      guestToken:'new-token',
      identity:{kind:'guest',id:'g2',displayName:'Guest2:Rahul',isAdmin:false},
      allowance:{remaining:3,limit:3,resetsAt:'2026-08-25T00:00:00+05:30'}
    });
    return jsonResponse(200,{ok:true});
  }});
  await ctx.submitGuest('Rahul');
  await ctx.apiRequest('/v1/difficulties');
  assert.equal(values.get('breach.guestToken'),'old-token');
  assert.equal(ctx.guestToken(),'new-token');
  assert.equal(calls[1][1].headers['X-Breach-Guest'],'new-token');
});

test('a failed token removal leaves a tab tombstone that blocks persisted-token resurrection',async()=>{
  const calls=[];
  const values=new Map([['breach.guestToken','expired-token']]);
  const removeFailStorage={
    getItem:key=>values.get(key)||null,
    setItem:(key,value)=>values.set(key,String(value)),
    removeItem(){throw new Error('remove unavailable');}
  };
  let expireNext=true;
  const ctx=loadSlice({localStorage:removeFailStorage,fetch:async(url,options)=>{
    calls.push([url,options]);
    if(expireNext){expireNext=false;return jsonResponse(401,{code:'authentication_required'});}
    return jsonResponse(200,{ok:true});
  }});
  ctx.setIdentity({kind:'guest',id:'g1',displayName:'Guest1:Rahul',isAdmin:false});
  await assert.rejects(ctx.refreshPublicSession(),error=>error.code==='authentication_required');
  await ctx.apiRequest('/v1/difficulties');
  assert.equal(values.get('breach.guestToken'),'expired-token');
  assert.equal(ctx.guestToken(),'');
  assert.equal('X-Breach-Guest' in calls[1][1].headers,false);
});

test('a new guest token supersedes a removal tombstone and remains authoritative across calls',async()=>{
  const calls=[];
  const values=new Map([['breach.guestToken','expired-token']]);
  const removeFailStorage={
    getItem:key=>values.get(key)||null,
    setItem:(key,value)=>values.set(key,String(value)),
    removeItem(){throw new Error('remove unavailable');}
  };
  let phase='expire';
  const ctx=loadSlice({localStorage:removeFailStorage,fetch:async(url,options)=>{
    calls.push([url,options]);
    if(phase==='expire'){phase='create';return jsonResponse(401,{code:'authentication_required'});}
    if(url.endsWith('/v1/guests')){
      phase='use';
      return jsonResponse(201,{
        guestToken:'replacement-token',
        identity:{kind:'guest',id:'g2',displayName:'Guest2:Rahul',isAdmin:false},
        allowance:{remaining:3,limit:3,resetsAt:'2026-08-25T00:00:00+05:30'}
      });
    }
    return jsonResponse(200,{ok:true});
  }});
  ctx.setIdentity({kind:'guest',id:'g1',displayName:'Guest1:Rahul',isAdmin:false});
  await assert.rejects(ctx.refreshPublicSession());
  await ctx.submitGuest('Rahul');
  await ctx.apiRequest('/v1/difficulties');
  assert.equal(ctx.guestToken(),'replacement-token');
  assert.equal(calls[2][1].headers['X-Breach-Guest'],'replacement-token');
});

test('a guest token set after an initial read failure remains authoritative',async()=>{
  const calls=[];
  const getFailStorage={
    getItem(){throw new Error('read unavailable');},
    setItem(){},
    removeItem(){}
  };
  const ctx=loadSlice({localStorage:getFailStorage,fetch:async(url,options)=>{
    calls.push([url,options]);
    if(url.endsWith('/v1/guests'))return jsonResponse(201,{
      guestToken:'recovered-token',
      identity:{kind:'guest',id:'g3',displayName:'Guest3:Rahul',isAdmin:false},
      allowance:{remaining:3,limit:3,resetsAt:'2026-08-25T00:00:00+05:30'}
    });
    return jsonResponse(200,{ok:true});
  }});
  await ctx.submitGuest('Rahul');
  await ctx.apiRequest('/v1/difficulties');
  assert.equal(ctx.guestToken(),'recovered-token');
  assert.equal(calls[1][1].headers['X-Breach-Guest'],'recovered-token');
});

test('logout is locally final when revoke cannot connect',async()=>{
  const ctx=loadSlice({fetch:async()=>{throw new Error('internal network detail');}});
  ctx.setIdentity({kind:'user',id:'u1',displayName:'Rahul',isAdmin:false});
  ctx.setAllowance({remaining:10,resetsAt:'2026-08-25T00:00:00+05:30'});
  const result=await ctx.logout();
  assert.equal(result.view,'identity');
  assert.equal(result.notice,'You are signed out here. The connection could not confirm it.');
  assert.equal(result.notice.includes('internal'),false);
  assert.equal(ctx.PUB.identity,null);
  assert.equal(ctx.PUB.allowance,null);
});

test('logout is locally final when revoke returns a server error',async()=>{
  const ctx=loadSlice({fetch:async()=>jsonResponse(500,{code:'private_failure',detail:'stack'})});
  ctx.setIdentity({kind:'user',id:'u1',displayName:'Rahul',isAdmin:false});
  const result=await ctx.logout();
  assert.equal(result.view,'identity');
  assert.equal(result.notice,'You are signed out here. The connection could not confirm it.');
  assert.equal(ctx.PUB.identity,null);
  assert.equal(ctx.PUB.view,'identity');
});

test('successful logout needs no warning',async()=>{
  const ctx=loadSlice({fetch:async()=>({ok:true,status:204,json:async()=>{throw new Error('no body');}})});
  ctx.setIdentity({kind:'user',id:'u1',displayName:'Rahul',isAdmin:false});
  const result=await ctx.logout();
  assert.deepEqual({...result},{view:'identity',notice:''});
});

test('the pure public-app slice has no DOM dependency',()=>{
  const source=fs.readFileSync(INDEX,'utf8');
  const slice=source.slice(source.indexOf(START),source.indexOf(END));
  assert.equal(/\b(?:document|window)\b/.test(slice),false);
});

test('storage failure falls back to session memory after completion',()=>{
  const ctx=loadHowToSlice();
  const broken={getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}};
  const guest={kind:'guest',id:'g7'};
  assert.equal(ctx.shouldShowHowTo(guest,broken),true);
  assert.equal(ctx.finishHowTo(guest,broken),false);
  assert.equal(ctx.shouldShowHowTo(guest,broken),false);
});

test('automatic Close and Escape use completion semantics while replay dismissal does not',()=>{
  const ctx=loadHowToSlice();
  assert.equal(ctx.howToDismissOptions(true).complete,true);
  assert.equal(ctx.howToDismissOptions(false).complete,false);
});

test('focus trap wraps from a tabindex minus-one heading anchor',()=>{
  const ctx=loadDialogSlice();
  const heading={},close={},next={};
  assert.equal(ctx.trapFocusTarget(heading,[close,next],true),next);
  assert.equal(ctx.trapFocusTarget(heading,[close,next],false),close);
  assert.equal(ctx.trapFocusTarget(close,[close,next],true),next);
  assert.equal(ctx.trapFocusTarget(next,[close,next],false),close);
});

test('nested dialog frames preserve each opener independently',()=>{
  const ctx=loadDialogSlice();
  const stack=[],setup={},picker={},titleButton={},modelButton={};
  ctx.pushDialogFrame(stack,setup,titleButton);
  ctx.pushDialogFrame(stack,picker,modelButton);
  assert.equal(ctx.popDialogFrame(stack,picker).opener,modelButton);
  assert.equal(ctx.popDialogFrame(stack,setup).opener,titleButton);
  assert.equal(stack.length,0);
});

test('public integration exposes identity and replay hooks with foundation seams',()=>{
  const ctx=loadHowToSlice();
  assert.equal(typeof ctx.onPublicIdentityResolved,'function');
  assert.equal(ctx.onPublicIdentityResolved.length,1);
  assert.equal(typeof ctx.mountHowToReplay,'function');
  assert.equal(ctx.mountHowToReplay.length,1);
  const html=readIndex();
  assert.match(html,/breach:identity-resolved/);
  assert.match(html,/FOUNDATION CALL SITE: acceptPublicSession/);
  assert.match(html,/FOUNDATION CALL SITE: publicMenu/);
});

test('duplicate identity resolution preserves an in-progress automatic onboarding session',()=>{
  const user={kind:'user',id:'u7'};
  let session={open:false,automatic:false,identity:null};
  let step=4,activeOpener='account-menu',dialogOpener=null,openCount=0;
  const ctx=loadHowToSlice({}, {
    currentHowToResolution:()=>session,
    maybeOpenHowTo(identity){
      openCount++;step=0;dialogOpener=activeOpener;
      session={open:true,automatic:true,identity};
      return true;
    }
  });

  assert.equal(ctx.onPublicIdentityResolved(user),true);
  step=2;activeOpener='refreshed-session-button';
  assert.equal(ctx.onPublicIdentityResolved({...user}),false);
  assert.equal(step,2);
  assert.equal(dialogOpener,'account-menu');
  assert.equal(openCount,1);

  session.open=false;
  assert.equal(ctx.onPublicIdentityResolved({kind:'guest',id:'g8'}),true);
  assert.equal(openCount,2);
});

test('replay hook mounts one permanent How to Play action',()=>{
  const ctx=loadHowToSlice();
  let mounted=null;
  const logout={id:'btnPublicLogout'};
  const container={
    querySelector(selector){return selector==='[data-how-to-replay]'?mounted:selector==='#btnPublicLogout'?logout:null;},
    insertBefore(node,before){assert.equal(before,logout);mounted=node;}
  };
  const doc={createElement(){return {dataset:{},addEventListener(type,handler){this.listener=[type,handler];}};}};
  const first=ctx.mountHowToReplay(container,doc);
  const second=ctx.mountHowToReplay(container,doc);
  assert.equal(first,second);
  assert.equal(first.textContent,'How to Play');
  assert.equal(first.type,'button');
  assert.equal(first.dataset.howToReplay,'');
  assert.equal(first.listener[0],'click');
});

test('public decision sends the exact battle view with turn and side but no model or key',()=>{
  const base={time:12,myCoins:41,tower:{heldBy:'neutral'}};
  const ctx=loadSlice({buildBattleView:()=>base});
  const body=ctx.battleViewForServer({privateState:true},1,4,{games:1,modelWins:0,humanWins:1,read:'rushes',plan:'hold'});
  assert.deepEqual(JSON.parse(JSON.stringify(body)),{
    time:12,myCoins:41,tower:{heldBy:'neutral'},turn:4,side:1,
    dossier:{games:1,modelWins:0,humanWins:1,read:'rushes',plan:'hold'}
  });
  assert.equal('model' in body,false);
  assert.equal('apiKey' in body,false);
  assert.equal(JSON.stringify(body).includes('sk-or-'),false);
});

test('public commander assignment uses only the server-selected opponent and side',()=>{
  const ctx=loadSlice();
  const cmd=ctx.publicCommanders({humanSide:0,opponent:{id:'google/gemini-3.7-flash',name:'Gemini 3.7 Flash'}});
  assert.deepEqual(JSON.parse(JSON.stringify(cmd)),[
    {kind:'human',model:'human'},
    {kind:'server',model:'google/gemini-3.7-flash'}
  ]);
  const reversed=ctx.publicCommanders({humanSide:1,opponent:{id:'m1',name:'One'}});
  assert.deepEqual(Array.from(reversed,item=>item.kind),['server','human']);
});

test('server timeout auto-play resets strikes while other stable provider codes increment them',()=>{
  const ctx=loadSlice();
  const timeout=ctx.serverDecisionState({queue:[],stance:null,why:'fallback',autoPlayed:true,providerCode:'timeout'},['at'],'hold');
  assert.deepEqual(JSON.parse(JSON.stringify(timeout)),{
    queue:['at'],stance:'hold',why:'fallback',autoPlayed:true,timedOut:true,failed:true,strike:'reset',providerCode:'timeout'
  });
  for(const code of ['rate_limited','provider_unavailable','invalid_response']){
    const failed=ctx.serverDecisionState({queue:[],stance:null,why:'fallback',autoPlayed:true,providerCode:code},['inf','gun'],'push');
    assert.equal(failed.strike,'increment');
    assert.equal(failed.providerCode,code);
    assert.deepEqual(Array.from(failed.queue),['inf','gun']);
  }
});

test('normal server decision preserves server queue and never marks a fallback',()=>{
  const ctx=loadSlice();
  const result=ctx.serverDecisionState({queue:['tank'],stance:'hold',why:'counter',autoPlayed:false,providerCode:null},['inf'],'push');
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{
    queue:['tank'],stance:'hold',why:'counter',autoPlayed:false,timedOut:false,failed:false,strike:'reset',providerCode:null
  });
});

test('completion outcome accepts idempotent matches and keeps failed results local',()=>{
  const ctx=loadSlice();
  assert.deepEqual({...ctx.completionOutcome({id:91,stored:false,debrief:null,dossierUpdate:null})},{status:'saved',matchId:91});
  assert.deepEqual({...ctx.completionOutcome(null,'session_expired')},{status:'local_only',message:'Battle complete. This result could not join your online history.'});
});

test('recent battle copy is concise and contains no diagnostic metadata',()=>{
  const ctx=loadSlice();
  assert.equal(ctx.recentBattleText({player:'Rahul',opponent:'Gemini 3.7 Flash',difficulty:'hard',result:'win'}),'Rahul defeated Gemini 3.7 Flash · Hard');
  assert.equal(ctx.recentBattleText({player:'Rahul',opponent:'Gemini 3.7 Flash',difficulty:'hard',result:'loss'}),'Gemini 3.7 Flash defeated Rahul · Hard');
  assert.equal(ctx.recentBattleText({player:'Rahul',opponent:'Gemini 3.7 Flash',difficulty:'hard',result:'draw'}),'Rahul drew with Gemini 3.7 Flash · Hard');
  assert.equal(/seed|prompt|latency|token|error/i.test(ctx.recentBattleText({player:'Seed',opponent:'Prompt',difficulty:'easy',result:'win'}).replace('Seed','Player').replace('Prompt','Commander')),false);
});

test('leaderboard names are written as text instead of HTML',()=>{
  const ctx=loadSlice();
  const target={textContent:''};
  ctx.writePublicName(target,'<img src=x onerror=alert(1)>');
  assert.equal(target.textContent,'<img src=x onerror=alert(1)>');
});

test('public projections allow only approved history and leaderboard fields',()=>{
  const ctx=loadSlice();
  const privateFields={email:'private@example.com',seed:42,promptVersion:8,providerError:'secret'};
  assert.deepEqual(Object.keys(ctx.publicHistoryRow({id:1,opponent:'Nova',difficulty:'easy',result:'win',playedAt:'2026-08-24T10:00:00Z',remainingBaseHp:321,...privateFields})),
    ['id','opponent','difficulty','result','playedAt','remainingBaseHp']);
  assert.deepEqual(Object.keys(ctx.publicPlayerRow({rank:1,displayName:'Rahul',wins:4,losses:2,winRate:66.7,...privateFields})),
    ['rank','displayName','wins','losses','winRate']);
  assert.deepEqual(Object.keys(ctx.publicAiRow({name:'Nova',difficulty:'easy',matches:9,wins:3,winRate:33.3,...privateFields})),
    ['name','difficulty','matches','wins','winRate']);
});

test('relative battle time handles recent, old, and malformed timestamps',()=>{
  const ctx=loadSlice();
  const now=Date.parse('2026-08-24T12:00:00Z');
  assert.equal(ctx.relativeBattleTime('2026-08-24T11:59:30Z',now),'just now');
  assert.equal(ctx.relativeBattleTime('2026-08-24T11:57:00Z',now),'3m ago');
  assert.equal(ctx.relativeBattleTime('2026-08-24T09:00:00Z',now),'3h ago');
  assert.equal(ctx.relativeBattleTime('not-a-date',now),'');
});

test('result card state is player-relative and discloses the next game cost',()=>{
  const ctx=loadSlice();
  const state=ctx.resultCardState({humanSide:1,opponent:{name:'Gemini 3.7 Flash'},difficulty:'hard'},1,[0,275],{remaining:6,resetsAt:'2026-08-25T00:00:00+05:30'});
  assert.deepEqual(JSON.parse(JSON.stringify(state)),{
    result:'Victory',opponent:'Gemini 3.7 Flash',difficulty:'Hard',remainingBaseHp:275,
    gamesRemaining:6,resetsAt:'2026-08-25T00:00:00+05:30',rematchLabel:'Rematch (uses 1 game)'
  });
});

test('decision and completion requests stay inside the owned game session',async()=>{
  const calls=[];
  const ctx=loadSlice({fetch:async(...args)=>{calls.push(args);return jsonResponse(200,{id:9});}});
  await ctx.requestPublicDecision({gameId:'gms a/b'},{turn:2,side:1,time:8});
  await ctx.completePublicGame({gameId:'gms a/b'},{game:'breach',difficulty:'easy'});
  assert.equal(calls[0][0],'https://breach-api.skdev.one/v1/games/gms%20a%2Fb/decisions');
  assert.equal(calls[1][0],'https://breach-api.skdev.one/v1/games/gms%20a%2Fb/complete');
  assert.equal(calls[0][1].body,'{"turn":2,"side":1,"time":8}');
  assert.equal(calls[1][1].body,'{"game":"breach","difficulty":"easy"}');
});

test('public markup omits developer-facing copy',()=>{
  const html=publicMarkup(readIndex());
  assert.match(html,/id="title"/);
  for(const forbidden of ['OpenRouter key','results.json','localStorage','Vulcan/Cobalt','Copy log',
    'cached tokens','prompt version','API URL','Clear local']){
    assert.equal(html.includes(forbidden),false,forbidden);
  }
});

test('public controls declare touch targets, safe-area spacing, and visible focus',()=>{
  const html=readIndex();
  assert.match(html,/\.act\{[^}]*min-height:44px/s);
  assert.match(html,/padding:var\(--st\) var\(--sr\) var\(--sb\) var\(--sl\)/);
  assert.match(html,/button:focus-visible/);
  assert.match(html,/#bannerX,#resultsChip\{[^}]*min-width:44px;min-height:44px/s);
  assert.match(html,/body\.split \.fab\{width:44px;height:44px/s);
  assert.doesNotMatch(html,/\.fab\{width:(?:29|32|34)px;height:(?:29|32|34)px/);
});

module.exports={jsonResponse,loadSlice,storage};
