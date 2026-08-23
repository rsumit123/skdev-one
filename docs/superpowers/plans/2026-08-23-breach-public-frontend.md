# Breach Public Accounts and Game UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Breach's public model/API console with a mobile-first guest/account game flow, difficulty-based matchmaking, server-backed AI play, clean histories and leaderboards, onboarding, quotas, and an owner-only Benchmark Lab.

**Architecture:** Keep the self-contained `war-game/index.html` and unchanged v8 simulator. Add a small inline public-app state/API layer around the existing game, move all model decisions through authenticated backend game sessions, and reshape the current title/setup/leaderboard surfaces into identity, home, onboarding, history, and public ranking views. Preserve detailed benchmark controls only when `/v1/me` confirms an administrator.

**Tech Stack:** Vanilla HTML/CSS/JavaScript in one file, Canvas 2D, browser Fetch API, Node.js stdlib tests, existing `bench.js`, Vercel static deployment

**Spec:** `/Users/rsumit123/work/skdev-one/docs/superpowers/specs/2026-08-23-breach-accounts-quotas-design.md`

**Backend prerequisite:** `/Users/rsumit123/work/skdev-one/docs/superpowers/plans/2026-08-23-breach-backend-accounts-quotas.md`

## Global Constraints

- Do not introduce React, Firebase, a package manager, a frontend build step, or a second runtime JavaScript file.
- Preserve the v8 simulation slice, unit stats, economy, tower/stance behavior, prompt version, lockstep cadence, timeout/fallback behavior, and model-vs-model benchmark semantics.
- Guests display as server-issued `Guest123:Name`, receive 3 games per IST day, and can play only Easy/Medium.
- Registered users expose only their public display name, receive 10 games per IST day, and can play Easy/Medium/Hard.
- Guest and registered quota, history, and local dossier namespaces never merge.
- Users select difficulty only; the backend selects and reveals the actual opponent before gameplay.
- The browser never receives or stores the OpenRouter API key.
- The public UI never mentions OpenRouter, tokens, prompts, seeds, API URLs, `localStorage`, `results.json`, provider errors, seat splits, latency, or benchmark diagnostics.
- Public leaderboard views are Top Players, AI Commanders, and Recent Battles with only the fields approved in the spec.
- Registered quota exhaustion shows the IST countdown and **Breach Pro — coming soon**, with no checkout.
- Account/navigation screens work in portrait and landscape; gameplay remains mobile-landscape primary with a working play-anyway portrait path.
- Every `index.html` change runs the mandatory syntax, duplicate-function-name, and secret scan from `DEVELOPMENT.md`; any sim-slice change additionally runs `node war-game/bench.js gate`.
- Public UI changes require visual browser verification at 844×390, 740×360, 932×430, and representative portrait sizes.

## File structure

The product remains one deployable file:

- `war-game/index.html` — existing sim/render plus new public app shell, auth, API client, quota,
  onboarding, public match lifecycle, history, leaderboards, and admin lab visibility
- `war-game/public-app.test.js` — Node stdlib tests that extract the delimited pure public-state/API
  slice from `index.html`, stub fetch/storage/time, and verify contracts without a browser dependency
- `war-game/DEVELOPMENT.md` — update architecture map, public/backend workflow, and verification notes
- `war-game/HANDOFF_PROMPT.md` — update onboarding instructions after the new flow is live

Within `index.html`, add byte-stable comments `PUBLIC APP TEST SLICE START` and
`PUBLIC APP TEST SLICE END` around functions that do not touch the DOM. The test file extracts
only that slice, mirroring the existing `bench.js` pattern without touching its sim boundaries.

---

### Task 1: Public app state and credentialed API client

**Files:**
- Create: `/Users/rsumit123/work/skdev-one/war-game/public-app.test.js`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:760-839`

**Interfaces:**
- Consumes: backend `/v1/me`, guest token header contract, Fetch API
- Produces: `PUB`, `apiRequest`, `setIdentity`, `difficultyAccess`, `quotaView`, `dossierKey`, and stable public error codes

- [ ] **Step 1: Write failing extraction and API-client tests**

```javascript
test('apiRequest includes cookies and the current guest token', async () => {
  const calls=[];
  const ctx=loadSlice({
    fetch:async (...args)=>{calls.push(args);return jsonResponse(200,{ok:true});},
    localStorage:storage({'breach.guestToken':'guest-secret'})
  });
  await ctx.apiRequest('/v1/me');
  assert.equal(calls[0][1].credentials,'include');
  assert.equal(calls[0][1].headers['X-Breach-Guest'],'guest-secret');
});

test('dossier keys keep guest and user memories separate', () => {
  const ctx=loadSlice();
  assert.notEqual(
    ctx.dossierKey({kind:'guest',id:'g1'},'google/gemini-3.7-flash'),
    ctx.dossierKey({kind:'user',id:'u1'},'google/gemini-3.7-flash')
  );
});
```

- [ ] **Step 2: Run the test and verify the slice is absent**

Run: `node --test war-game/public-app.test.js`

Expected: FAIL because the marker and `apiRequest` do not exist.

- [ ] **Step 3: Add the pure public state/API slice**

```javascript
/* PUBLIC APP TEST SLICE START */
const PUBLIC_API='https://breach-api.skdev.one';
const PUB={identity:null,allowance:null,game:null,difficulty:null,view:'boot',busy:false};

function guestToken(){try{return localStorage.getItem('breach.guestToken')||'';}catch(e){return '';}}
function dossierKey(identity,model){return `breach.dossier.${identity.kind}.${identity.id}.${model}`;}
function setIdentity(identity){PUB.identity=identity?{...identity}:null;return PUB.identity;}
function setAllowance(allowance){PUB.allowance=allowance?{...allowance}:null;return PUB.allowance;}
function quotaView(allowance,nowMs){
  return {remaining:allowance.remaining,seconds:Math.max(0,Math.ceil((Date.parse(allowance.resetsAt)-nowMs)/1000))};
}
function difficultyAccess(identity,difficulty){
  return difficulty!=='hard'||(identity&&identity.kind==='user');
}
function publicMessage(code){return ({
  quota_exhausted:'You have used today\'s free games.',
  tier_unavailable:'That AI commander is temporarily unavailable. Your game was refunded.',
  invalid_credentials:'That email or password did not match.',
  session_expired:'Your battle session expired. Choose a difficulty to start again.'
})[code]||'Something interrupted the connection. Please try again.';}
async function apiRequest(path,{method='GET',body,headers={}}={}){
  const token=guestToken();
  const response=await fetch(PUBLIC_API+path,{method,credentials:'include',headers:{
    ...(body?{'Content-Type':'application/json'}:{}),...(token?{'X-Breach-Guest':token}:{}),...headers
  },body:body?JSON.stringify(body):undefined});
  const data=await response.json().catch(()=>({code:'connection_error'}));
  if(!response.ok)throw Object.assign(new Error(publicMessage(data.code)),{code:data.code,status:response.status,data});
  return data;
}
/* PUBLIC APP TEST SLICE END */
```

Keep registered auth only in the cookie. Store the guest token only after `POST /v1/guests`; never
copy registered session data into local storage.

- [ ] **Step 4: Run public-app and existing syntax checks**

Run: `node --test war-game/public-app.test.js`

Expected: PASS for credential inclusion, guest header, public error mapping, difficulty access,
quota formatting, countdown math, and dossier namespace isolation.

Run the syntax/duplicate/secret command from `DEVELOPMENT.md`.

Expected: `SYNTAX OK | dup fns: none | secret: clean`.

- [ ] **Step 5: Commit the public app foundation**

```bash
git add war-game/index.html war-game/public-app.test.js
git commit -m "feat: add public session API foundation"
```

### Task 2: Identity gate, signup, login, and logout

**Files:**
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:1-465`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:530-578`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:760-839`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/public-app.test.js`

**Interfaces:**
- Consumes: `apiRequest`, `PUB`, `POST /v1/guests`, `/v1/auth/*`, `GET /v1/me`
- Produces: `bootPublicApp`, `submitGuest`, `submitSignup`, `submitLogin`, `logout`, and identity-gate DOM

- [ ] **Step 1: Add failing identity behavior tests**

```javascript
test('signed-in identity wins over a stored guest token without deleting it', async () => {
  const ctx=loadSlice({localStorage:storage({'breach.guestToken':'g-token'})});
  ctx.setIdentity({kind:'user',id:'u1',displayName:'Rahul',isAdmin:false});
  assert.equal(ctx.PUB.identity.kind,'user');
  assert.equal(ctx.localStorage.getItem('breach.guestToken'),'g-token');
});

test('logout restores the separate guest continuation path', () => {
  const ctx=loadSlice({localStorage:storage({'breach.guestToken':'g-token'})});
  ctx.setIdentity(null);
  assert.equal(ctx.guestToken(),'g-token');
});
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `node --test war-game/public-app.test.js --test-name-pattern='identity|logout'`

Expected: FAIL because `setIdentity` is absent.

- [ ] **Step 3: Replace the current title card with a public identity gate and home container**

Create semantic forms with these exact visible actions:

```html
<button type="button" data-auth-view="guest">Play as guest</button>
<button type="button" data-auth-view="signup">Create account</button>
<button type="button" data-auth-view="login">Sign in</button>
<button type="button" id="btnPublicRanks">View leaderboard</button>
```

Guest form has one `displayName` input. Signup has public display name, email, and password with
`autocomplete="new-password"`; login uses `autocomplete="email"` and `current-password`.
Each form has one adjacent `role="alert"` region. Add **Password reset coming soon** as subdued
text, not an active link.

- [ ] **Step 4: Implement boot and form controllers**

```javascript
async function bootPublicApp(){
  try{
    const data=await apiRequest('/v1/me');
    setIdentity(data.identity); setAllowance(data.allowance); showPublicView('home');
  }catch(e){
    if(e.status===401)showPublicView('identity'); else showBootRetry(e.message);
  }
}
async function submitGuest(displayName){
  const data=await apiRequest('/v1/guests',{method:'POST',body:{displayName}});
  localStorage.setItem('breach.guestToken',data.guestToken);
  setIdentity(data.identity); setAllowance(data.allowance); showPublicView('home');
}
async function logout(){
  await apiRequest('/v1/auth/logout',{method:'POST'});
  PUB.identity=null; PUB.allowance=null; showPublicView('identity');
}
```

Signup and login pass exactly the backend schema. Disable submit controls while busy, restore
them after failure, keep entered email on credential failure, and never echo a password.

- [ ] **Step 5: Verify identity flow tests and browser behavior**

Run: `node --test war-game/public-app.test.js`

Expected: PASS.

Serve locally with `python3 -m http.server 8977` from `war-game`, stub backend responses in the
browser, and verify guest, signup, login error, returning session, logout, keyboard focus, and
virtual-keyboard layouts in portrait and landscape.

- [ ] **Step 6: Run the mandatory index verification and commit**

Run the `DEVELOPMENT.md` syntax/duplicate/secret scan.

Expected: `SYNTAX OK | dup fns: none | secret: clean`.

```bash
git add war-game/index.html war-game/public-app.test.js
git commit -m "feat: add guest and account entry flow"
```

### Task 3: Home, allowances, difficulty selection, and matchup reveal

**Files:**
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:1-465`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:530-667`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:760-839`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/public-app.test.js`

**Interfaces:**
- Consumes: identity and allowance state, `GET /v1/difficulties`, `POST /v1/games`
- Produces: `renderHome`, `startDifficulty`, `startResetCountdown`, and matchup reveal state

- [ ] **Step 1: Write failing quota and access-state tests**

```javascript
test('guest sees hard as locked and registered user sees it enabled', () => {
  assert.equal(ctx.difficultyAccess({kind:'guest'},'hard'),false);
  assert.equal(ctx.difficultyAccess({kind:'user'},'hard'),true);
});

test('quota exhaustion produces guest signup and user Pro states', () => {
  assert.equal(ctx.exhaustionAction({kind:'guest'}),'create_account');
  assert.equal(ctx.exhaustionAction({kind:'user'}),'pro_coming_soon');
});
```

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `node --test war-game/public-app.test.js --test-name-pattern='hard|quota|countdown'`

Expected: FAIL until `exhaustionAction` and countdown helpers exist.

- [ ] **Step 3: Build the mobile-first home and difficulty cards**

The header shows the exact server display name, a menu button, and:

```text
7 games left · Resets in 04:18:32
```

Cards use these labels and descriptions:

- **Easy — Learn the battlefield**; Nova Lite, Nova 2 Lite, Phi-4
- **Medium — Expect counterplay**; Gemini 3.5 Flash Lite, Qwen 3.7 Flash
- **Hard — Face the benchmark leader**; Gemini 3.7 Flash

Guest Hard remains visible with **Create an account to unlock Hard**. Each enabled CTA includes
**Uses 1 game** before confirmation. Do not show model IDs.

- [ ] **Step 4: Implement server-authoritative start and reveal**

```javascript
async function startDifficulty(difficulty){
  if(!difficultyAccess(PUB.identity,difficulty))return showSignupForHard();
  setPublicBusy(true);
  try{
    const data=await apiRequest('/v1/games',{method:'POST',body:{difficulty}});
    PUB.game=data; PUB.allowance={remaining:data.gamesRemaining,resetsAt:data.resetsAt};
    showMatchup({opponent:data.opponent,difficulty:data.difficulty});
  }catch(e){showGameStartError(e.code,e.data);}
  finally{setPublicBusy(false);}
}
```

The reveal says **Your opponent: [name]** and the difficulty, then enters the battlefield through
one obvious **Enter battle** action. Closing after session creation does not restore the game;
the **Uses 1 game** disclosure made that reservation explicit.

Initialize public sessions with a 90-minute server expiry returned as `expiresAt`; the browser
does not extend it. If the reveal is abandoned, the game stays consumed and a later return shows
the session-expired public message once the backend closes it.

- [ ] **Step 5: Implement server-reset countdown and exhaustion views**

Calculate only display duration from the server ISO timestamp. At zero, call `/v1/me` once and
refresh allowance rather than assuming a reset succeeded. Guest exhaustion says **Create an
account for 10 games a day**. Registered exhaustion says **You've used today's free games. More
games are coming with Breach Pro.** and renders no checkout control.

- [ ] **Step 6: Test, visually inspect, verify, and commit**

Run: `node --test war-game/public-app.test.js`

Expected: PASS for locks, exhausted states, countdown rollover, start payload, refund response,
and no client-selected model.

Run the mandatory index verification.

```bash
git add war-game/index.html war-game/public-app.test.js
git commit -m "feat: add quota-aware difficulty matchmaking"
```

### Task 4: First-time How to Play onboarding

**Files:**
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:1-465`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:600-760`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:2350-2440`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/public-app.test.js`

**Interfaces:**
- Consumes: current identity, existing unit art/icons and stance controls
- Produces: `openHowTo`, `advanceHowTo`, `skipHowTo`, current-identity completion key

- [ ] **Step 1: Write failing onboarding-state tests**

```javascript
test('onboarding completion is namespaced by current identity', () => {
  assert.equal(ctx.onboardingKey({kind:'guest',id:'g1'}),'breach.howto.guest.g1');
  assert.equal(ctx.onboardingKey({kind:'user',id:'u1'}),'breach.howto.user.u1');
});

test('skip and completion both prevent automatic reopening', () => {
  const s=ctx.storage();
  ctx.finishHowTo({kind:'user',id:'u1'},s);
  assert.equal(ctx.shouldShowHowTo({kind:'user',id:'u1'},s),false);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `node --test war-game/public-app.test.js --test-name-pattern='onboarding|HowTo'`

Expected: FAIL because onboarding helpers do not exist.

- [ ] **Step 3: Build four concise cards using existing visual language**

Use the approved sequence and exact core messages:

1. **Build your queue** — “Orders execute from left to right. If the first purchase is too
   expensive, everything behind it waits.”
2. **Counter the enemy** — “Tank beats Gunner · Gunner beats AT · AT beats Tank.” Add one short
   air note: “Choppers need Gunners or AT to stop them.”
3. **Control the tower** — “Push attacks the base. Hold captures the tower for income and
   airstrikes. Your stance stays active until you change it.”
4. **Time your economy** — “Economy costs tempo now and pays more later. Upgrade when your base
   can survive the delay.”

Each card has progress, Next, Skip, and a final **Choose difficulty** action. No card requires
vertical scrolling at 740×360.

- [ ] **Step 4: Implement first-run and menu reopening behavior**

Show onboarding after first successful guest/account identity resolution and before the home
difficulty cards. Store only the identity-namespaced completion flag. A permanent **How to Play**
menu item reopens it without altering completion state.

- [ ] **Step 5: Verify onboarding at phone sizes and commit**

Run: `node --test war-game/public-app.test.js`

Expected: PASS.

Visually verify all four cards at 740×360, 844×390, and a portrait viewport; test Skip, Back,
Next, final CTA, browser Back behavior, and menu reopening.

Run the mandatory index verification, then:

```bash
git add war-game/index.html war-game/public-app.test.js
git commit -m "feat: add first-battle onboarding"
```

### Task 5: Replace direct model calls with authorized game decisions

**Files:**
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:930-1095`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:1138-1385`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:2770-2870`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:2940-3108`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/public-app.test.js`

**Interfaces:**
- Consumes: `PUB.game`, `POST /v1/games/{id}/decisions`, existing `sanitize`, `decide`, sim view fields, and local identity-namespaced dossier
- Produces: `serverAgent`, `battleViewForServer`, public session lifecycle, and server-backed postgame completion

- [ ] **Step 1: Write failing request-contract tests**

```javascript
test('public decision sends game state but never a model or provider key', async () => {
  const body=ctx.battleViewForServer(fakeState(),1,4);
  assert.equal(body.turn,4);
  assert.equal(body.side,1);
  assert.equal('model' in body,false);
  assert.equal('apiKey' in body,false);
  assert.equal(JSON.stringify(body).includes('sk-or-'),false);
});

test('public commander assignment uses the server-selected opponent', () => {
  const cmd=ctx.publicCommanders({humanSide:0,opponent:{id:'google/gemini-3.7-flash',name:'Gemini 3.7 Flash'}});
  assert.deepEqual(cmd.map(x=>x.kind),['human','server']);
});
```

- [ ] **Step 2: Run focused decision tests to verify failure**

Run: `node --test war-game/public-app.test.js --test-name-pattern='decision|commander'`

Expected: FAIL because the server commander kind and view builder do not exist.

- [ ] **Step 3: Extract the existing battle-view construction without changing its values**

Move the current `llmAgent` view object into `battleViewForServer(St,s,turn)`. Preserve every
field used by v8: affordability, `purchaseBlocked`, `lastTurnAutoPlayed`, queues/built feedback,
tower capture state, persistent stance, compositions, threat, income/economy, HP, and typed units.
Do not modify sim constants or the four `bench.js` extraction boundaries.

- [ ] **Step 4: Implement the server-backed commander**

```javascript
async function serverAgent(St,s){
  if(!PUB.game)throw new Error('session_expired');
  const model=CMD[s].model;
  const dossier=dossierGet(model);
  const response=await apiRequest(`/v1/games/${encodeURIComponent(PUB.game.gameId)}/decisions`,{
    method:'POST',body:{...battleViewForServer(St,s,NEXT_TURN[s]),dossier:dossier||undefined}
  });
  NEXT_TURN[s]++;
  if(response.opponent)applyServerOpponent(response.opponent,s);
  return {queue:response.queue,stance:response.stance,why:response.why};
}
```

Teach `decide()` the internal `server` commander kind. Preserve its existing 30-second/fallback,
malformed-output, three-strike, 429, overlay, and log behavior using stable error codes returned by
the backend. The public flow never reads the old API-key field and never performs a chat completion
fetch from the browser.

Declare `NEXT_TURN=[0,0]`, reset both counters in `reset()`, and initialize each side from the
session response. `applyServerOpponent()` updates `PUB.game.opponent`, `CMD[s].model`, the HUD name,
match payload, and result copy together when the backend's first-turn health retry changes models.

- [ ] **Step 5: Namespace dossiers and route postgame reflection through completion**

Change `dosKey(model)` to call `dossierKey(PUB.identity,model)`. `dossierAll()` scans only the
current identity prefix. Remove direct provider fetches from `askDebrief()` and `updateDossier()`;
`POST /v1/games/{id}/complete` returns optional `debrief` and `dossierUpdate`, which the browser
renders and stores for the current identity/model. Benchmark mode never sends a dossier.

- [ ] **Step 6: Complete matches through the owned session**

At `endGame()`, send `matchPayload()` once to the completion route. Prevent rematch until completion
acknowledges or provides a retry action. A duplicate completion uses the returned existing match.
On session-expired completion failure, preserve the local result view but state that it could not
join online history; do not fabricate quota restoration.

- [ ] **Step 7: Run behavior, secret, sim, and browser checks**

Run: `node --test war-game/public-app.test.js`

Expected: PASS for request allow-list, turn sequence, commander assignment, identity dossier keys,
completion idempotency handling, and stable error translation.

Run the mandatory syntax/duplicate/secret scan and `node war-game/bench.js gate` because code near
the decision/sim boundary is high risk even though constants are intentionally unchanged.

Expected: syntax clean and balance gate PASS against the existing baseline.

Play one stubbed Human-vs-AI match through start, decisions, fallback, finish, completion, dossier
update, and rematch in the browser.

- [ ] **Step 8: Commit server-backed gameplay**

```bash
git add war-game/index.html war-game/public-app.test.js
git commit -m "feat: run public battles through game sessions"
```

### Task 6: Public results, My Battles, and simplified leaderboards

**Files:**
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:376-409`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:494-528`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:679-707`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:2440-2715`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:2746-2870`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/public-app.test.js`

**Interfaces:**
- Consumes: owned completion response, `/v1/history`, `/v1/leaderboards/*`, current allowance
- Produces: result summary, `renderHistory`, `renderPlayerRanks`, `renderAiRanks`, `renderRecentBattles`

- [ ] **Step 1: Write failing projection/escaping tests**

```javascript
test('recent battle copy is concise and contains no diagnostic metadata', () => {
  const text=ctx.recentBattleText({player:'Rahul',opponent:'Gemini 3.7 Flash',difficulty:'hard',result:'win'});
  assert.equal(text,'Rahul defeated Gemini 3.7 Flash · Hard');
  assert.equal(/seed|prompt|latency|token|error/i.test(text),false);
});

test('leaderboard names are written as text not HTML', () => {
  const target={textContent:''};
  ctx.writePublicName(target,'<img src=x onerror=alert(1)>');
  assert.equal(target.textContent,'<img src=x onerror=alert(1)>');
});
```

- [ ] **Step 2: Run focused public-copy tests to verify failure**

Run: `node --test war-game/public-app.test.js --test-name-pattern='recent|leaderboard|PublicName'`

Expected: FAIL until clean public projection helpers exist.

- [ ] **Step 3: Replace the end banner with a player-focused result card**

Show result, opponent, difficulty, remaining base HP, games remaining, reset countdown, and actions:
**Rematch (uses 1 game)**, **My Battles**, **Leaderboard**, and **Choose difficulty**. Remove public
Swap sides, New seed, Change models, Copy log, and raw Results/log actions. Admin mode retains those
inside the Benchmark Lab result surface.

- [ ] **Step 4: Build private My Battles**

Fetch `/v1/history?limit=50` on open. Render opponent, difficulty, Win/Loss/Draw, local date, and
remaining base HP. Empty copy is **No battles yet. Choose a difficulty to enter the breach.** Never
render a private email or raw payload.

- [ ] **Step 5: Replace the leaderboard modal with three public tabs**

- **Top Players:** Easy/Medium/Hard filter, rank, player, wins, losses, win rate
- **AI Commanders:** commander, difficulty, matches, wins, win rate
- **Recent Battles:** natural-language battle line and relative time

Delete public `lbWarn`, seat-bias caveats, prompt filter, seed/eco/unit diagnostics, copy, download,
import, clear-local, file input, `results.json` warning, API status, local leaderboard merging, and
technical error text. Use DOM `textContent` for every server-provided name.

- [ ] **Step 6: Test all empty/error/populated states and commit**

Run: `node --test war-game/public-app.test.js`

Expected: PASS for approved field allow-lists, escaping, all tabs, difficulty filters, empty copy,
relative timestamps, result allowance, and rematch disclosure.

Run mandatory index verification. Visually inspect result, history, and every leaderboard tab at
740×360, 844×390, 932×430, and portrait.

```bash
git add war-game/index.html war-game/public-app.test.js
git commit -m "feat: simplify results history and leaderboards"
```

### Task 7: Owner-only Benchmark Lab

**Files:**
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:611-678`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:708-730`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:2690-2770`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:3118-3270`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/public-app.test.js`

**Interfaces:**
- Consumes: `PUB.identity.isAdmin`, `POST /v1/admin/games`, constrained decision route
- Produces: conditional Benchmark Lab navigation and admin session configuration

- [ ] **Step 1: Write failing privilege-state tests**

```javascript
test('benchmark lab visibility depends only on server admin flag', () => {
  assert.equal(ctx.canOpenLab({kind:'user',displayName:'rsumit123@gmail.com',isAdmin:false}),false);
  assert.equal(ctx.canOpenLab({kind:'user',displayName:'Owner',isAdmin:true}),true);
});
```

- [ ] **Step 2: Run the privilege test to verify failure**

Run: `node --test war-game/public-app.test.js --test-name-pattern='benchmark lab'`

Expected: FAIL because `canOpenLab` does not exist.

- [ ] **Step 3: Rehouse existing technical controls behind admin state**

Normal navigation contains no Setup gear or model picker. When `isAdmin === true`, add
**Benchmark Lab** to the account menu. The lab retains model A/B, custom model ID, human/model
seat, side swap, seed, memory, mock commander, detailed reasoning/log, export, latency/error/usage,
prompt version, and side diagnostics. Remove the browser OpenRouter-key and results-server token/
URL fields entirely; the server provides model access and storage.

- [ ] **Step 4: Start admin sessions through server authorization**

```javascript
async function startBenchmark(config){
  if(!canOpenLab(PUB.identity))throw new Error('admin_required');
  PUB.game=await apiRequest('/v1/admin/games',{method:'POST',body:{
    modelA:config.modelA,modelB:config.modelB,humanSide:config.humanSide,
    seed:config.seed,memory:config.memory,sideSwap:config.sideSwap
  }});
  applyBenchmarkCommanders(PUB.game); reset(); goLive();
}
```

Both model seats use `serverAgent`. Benchmark sessions do not alter public quota or public Human-
vs-AI leaderboard rows.

- [ ] **Step 5: Verify absence and authorization boundaries**

Run: `node --test war-game/public-app.test.js`

Expected: PASS for forged owner-looking name/email denial, admin visibility, benchmark request
shape, and public navigation exclusion.

Inspect the app as guest, normal registered user, and admin. Confirm no hidden public control can
start an admin session when the backend returns 403.

- [ ] **Step 6: Run index and benchmark gates, then commit**

Run mandatory syntax/duplicate/secret scan and `node war-game/bench.js gate`.

Expected: clean scan and gate PASS.

```bash
git add war-game/index.html war-game/public-app.test.js
git commit -m "feat: move benchmark controls into owner lab"
```

### Task 8: Mobile polish, accessibility, and product-copy audit

**Files:**
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:1-465`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html:466-760`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/public-app.test.js`

**Interfaces:**
- Consumes: every public view from Tasks 2–7
- Produces: release-ready mobile layouts, focus behavior, safe-area handling, and public-copy deny-list test

- [ ] **Step 1: Add a failing public-copy and target-size audit**

```javascript
test('public markup omits developer-facing copy', () => {
  const html=publicMarkup(readIndex());
  for(const forbidden of ['OpenRouter key','results.json','localStorage','Vulcan/Cobalt','Copy log',
                           'cached tokens','prompt version','API URL','Clear local']) {
    assert.equal(html.includes(forbidden),false,forbidden);
  }
});
```

- [ ] **Step 2: Run the audit to verify existing failures**

Run: `node --test war-game/public-app.test.js --test-name-pattern='developer-facing|target'`

Expected: FAIL while old public markup/copy remains.

- [ ] **Step 3: Apply final responsive and safe-area rules**

Ensure auth/home/onboarding/history/rank/result controls have at least `min-height:44px`, visible
focus styles, and `padding` using `env(safe-area-inset-*)`. At heights 360–430px, prefer two-column
cards and fixed action rows over vertical overflow. Keep the battlefield's existing portrait
rotation invitation and working **Play in portrait anyway** action.

- [ ] **Step 4: Add modal focus and accessible state behavior**

On open, focus the modal heading or first invalid field; trap Tab within the top modal; Escape and
the visible close action return focus to the opener. Add labels, `aria-describedby`, `role=alert`,
`aria-current` on tabs, `aria-disabled` on locked Hard, and text equivalents for quota/countdown.
Do not rely on color alone for win/loss, lock, or validation states.

- [ ] **Step 5: Conduct the required visual matrix**

Using the browser-control skill against the local server, capture and inspect:

```text
844×390: identity, home, onboarding card 3, active human picker, result, rankings
740×360: identity keyboard closed, all difficulty cards, matchup, active game, exhausted quota
932×430: history, AI Commanders, Recent Battles, owner Benchmark Lab
390×844: identity with keyboard, home, rotate prompt, play-anyway, leaderboard
430×932: signup validation, onboarding, history, result
```

Fix clipping, browser-chrome overlap, hidden actions, sideways overflow, unreadable text, and touch
targets before proceeding.

- [ ] **Step 6: Run copy, unit, syntax, secret, and balance gates**

Run:

```bash
node --test war-game/public-app.test.js
node war-game/bench.js gate
```

Also run the exact syntax/duplicate/secret scan from `DEVELOPMENT.md`.

Expected: all tests PASS, balance gate PASS, duplicate functions none, and secret clean.

- [ ] **Step 7: Commit mobile and copy polish**

```bash
git add war-game/index.html war-game/public-app.test.js
git commit -m "fix: polish public mobile UX and copy"
```

### Task 9: Documentation, production cutover, and live verification

**Files:**
- Modify: `/Users/rsumit123/work/skdev-one/war-game/DEVELOPMENT.md`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/HANDOFF_PROMPT.md`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html`

**Interfaces:**
- Consumes: deployed compatible FastAPI backend and fully verified public frontend
- Produces: documented architecture, owner migration procedure, deployed public flow

- [ ] **Step 1: Update the current-state and handoff documentation**

Document FastAPI modules, auth cookie and guest token, exact 3/10 IST quotas, tier roster, public
game-session/decision flow, local identity-scoped dossiers, owner lab, clean leaderboards, backend
test command, database backup/migration order, and the unchanged mandatory frontend gate. Remove
statements that users provide their own key or that public writes are open.

- [ ] **Step 2: Run the complete local frontend gate from a clean checkout state**

Run:

```bash
node --test war-game/public-app.test.js
node war-game/bench.js gate
git diff --check
git status --short
```

Run the exact syntax/duplicate/secret scan from `DEVELOPMENT.md`.

Expected: tests and gate PASS; diff check has no output; status contains only the intended
documentation/final frontend edits.

- [ ] **Step 3: Run an end-to-end staging smoke against the deployed backend**

Verify in this order against a staging database and mock provider transport so quota-boundary
coverage does not spend OpenRouter credits:

```text
guest creation -> Easy start -> opponent reveal -> decision -> completion -> history
same guest -> total 3 starts -> fourth rejected -> accurate IST countdown
signup -> separate empty account history -> Medium start -> completion
registered total 10 starts -> eleventh rejected -> Pro coming-soon state
guest Hard rejected -> registered Hard accepted
tier-total first-turn failure -> game count restored once
normal user -> no Benchmark Lab; admin -> benchmark model-v-model start
Top Players / AI Commanders / Recent Battles -> no email or diagnostic field
```

- [ ] **Step 4: Register and migrate the owner account**

Register `rsumit123@gmail.com` through the public flow, then run the backend's idempotent command:

```bash
ssh ssh-social 'cd ~/breach-api && docker compose exec breach-api python scripts/assign_owner_matches.py --email rsumit123@gmail.com --db /data/breach.db'
```

Expected: script reports the resolved user ID, grants admin, assigns previously unowned historical
matches once, and a second run reports zero newly assigned.

- [ ] **Step 5: Commit and push the final frontend/documentation cutover**

Use the repository-required Co-Authored-By and Claude-Session trailers.

```bash
git add war-game/index.html war-game/public-app.test.js war-game/DEVELOPMENT.md war-game/HANDOFF_PROMPT.md
git commit -m "feat: launch account-based Breach public game"
git push origin main
```

- [ ] **Step 6: Poll the Vercel deployment for a unique public marker**

```bash
for i in 1 2 3 4; do
  curl -sL https://skdev.one/war-game | grep -q "Choose your difficulty" && { echo LIVE; break; }
  sleep 12
done
```

Expected: `LIVE`.

- [ ] **Step 7: Perform production mobile and security verification**

Repeat the 844×390 and 390×844 critical paths against production. Confirm signup cookie login,
guest continuation, one real Easy decision, one real Hard decision, completion/history, public
leaderboard copy, admin lab, IST countdown, and portrait play-anyway. Inspect served HTML and
network responses for `sk-or-v1-`, private emails, raw errors, prompts, and provider diagnostics;
all scans must be clean before reporting completion.
