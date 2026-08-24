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
    JSON
  });
  const exports=['PUB','guestToken','dossierKey','setIdentity','setAllowance','quotaView',
    'difficultyAccess','publicMessage','apiRequest','bootPublicApp','submitGuest','submitSignup',
    'submitLogin','logout','exhaustionAction','formatCountdown','countdownRefreshDue',
    'loadDifficulties','startDifficulty','difficultyButtonDisabled','refreshPublicSession'];
  const expose=exports.map(name=>`${JSON.stringify(name)}:typeof ${name}==='undefined'?undefined:${name}`).join(',');
  vm.runInContext(`${source.slice(start,end+END.length)}\nglobalThis.__slice={${expose}};`,context);
  return {...context.__slice,localStorage};
}

function loadDomSlice(PUB,document){
  const source=fs.readFileSync(INDEX,'utf8');
  const start=source.indexOf(DOM_START),end=source.indexOf(DOM_END);
  assert.notEqual(start,-1,'public DOM test slice start marker must exist');
  assert.notEqual(end,-1,'public DOM test slice end marker must exist');
  const context=vm.createContext({PUB,document});
  vm.runInContext(`${source.slice(start,end+DOM_END.length)}\nglobalThis.__dom={setPublicBusy};`,context);
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
function loadHowToSlice(seed={}){
  const html=readIndex();
  const hit=html.match(/\/\* HOW TO PLAY TEST SLICE START \*\/([\s\S]*?)\/\* HOW TO PLAY TEST SLICE END \*\//);
  assert.ok(hit,'How to Play test slice is present');
  const localStorage=storage(seed);
  return Function('localStorage',`${hit[1]};return {
    onboardingKey,finishHowTo,shouldShowHowTo,
    howToDismissOptions:typeof howToDismissOptions==='undefined'?undefined:howToDismissOptions,
    onPublicIdentityResolved:typeof onPublicIdentityResolved==='undefined'?undefined:onPublicIdentityResolved,
    mountHowToReplay:typeof mountHowToReplay==='undefined'?undefined:mountHowToReplay
  };`)(localStorage);
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
