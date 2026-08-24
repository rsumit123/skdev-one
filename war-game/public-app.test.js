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
    URL,
    Date,
    Math,
    Error,
    Object,
    JSON
  });
  const exports=['PUB','guestToken','dossierKey','setIdentity','setAllowance','quotaView',
    'difficultyAccess','publicMessage','apiRequest','bootPublicApp','submitGuest','submitSignup',
    'submitLogin','logout','exhaustionAction','formatCountdown'];
  const expose=exports.map(name=>`${JSON.stringify(name)}:typeof ${name}==='undefined'?undefined:${name}`).join(',');
  vm.runInContext(`${source.slice(start,end+END.length)}\nglobalThis.__slice={${expose}};`,context);
  return {...context.__slice,localStorage};
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

module.exports={jsonResponse,loadSlice,storage};
