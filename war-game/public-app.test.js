const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const vm=require('node:vm');

const INDEX=path.join(__dirname,'index.html');
const START='/* PUBLIC APP TEST SLICE START */';
const END='/* PUBLIC APP TEST SLICE END */';

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
    document:overrides.document,
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
    'loadDifficulties','startDifficulty','setPublicBusy','difficultyButtonDisabled',
    'refreshPublicSession'];
  const expose=exports.map(name=>`${JSON.stringify(name)}:typeof ${name}==='undefined'?undefined:${name}`).join(',');
  vm.runInContext(`${source.slice(start,end+END.length)}\nglobalThis.__slice={${expose}};`,context);
  return {...context.__slice,localStorage};
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
  const ctx=loadSlice({document:publicActionDocument(buttons)});
  ctx.setPublicBusy(true);
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

module.exports={jsonResponse,loadSlice,storage};
