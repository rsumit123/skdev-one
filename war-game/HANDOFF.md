# Breach — handoff

A single-file browser wargame where two LLMs command opposing armies. Built as a
benchmark harness: the point is measuring which model reasons better about counters,
tempo, and economy timing, not making a fun toy (though it is one).

**Deliverable:** `breach.html` — one self-contained file, no build step, no dependencies.
Open it in a browser. All state is in memory.

There is also `deterrence.html`, an earlier and more complex 5-player territory game
(fog of war, tech trees, simultaneous orders). It works and is balance-tested, but was
set aside as too complex to follow. Breach superseded it.

---

## 1. What the game is

Two bases at opposite ends of an 80m lane, 600 HP each. Coins accrue per second.
Agents spend coins on units, which walk toward the enemy base and fight what they meet.
First base to 0 loses; at 300s the higher HP wins.

### Units

| id | name | cost | hp | dps | speed | range | class |
|----|------|------|----|-----|-------|-------|-------|
| `inf` | Infantry | 8 | 70 | 8 | 7.0 | 2 | light |
| `gun` | Gunner | 18 | 80 | 14 | 5.0 | 6 | support |
| `mob` | Raider | 20 | 120 | 10 | 11.0 | 2 | light |
| `tank` | Tank | 45 | 400 | 16 | 3.5 | 5 | armor (splash) |
| `at` | AT Team | 30 | 90 | 12 | 5.0 | 8 | support |

**Counters:** `gun` ×2 vs light, `at` ×4 vs armor, `tank` hits everything in range at once.
The cycle is **tank → gun → at → tank**. Infantry is a cheap generalist (beats AT and
Raider, loses to Gunner and Tank). Raider loses nearly every duel — its job is punishing
an empty lane at 11 m/s.

### Economy

- Income = `inc[side] * RAMP(t)` per second, where `RAMP = 1 + t/55`
- `eco` purchase: escalating price **45 / 79 / 113**, each +0.5/s to BASE income (so the
  payout is multiplied by RAMP too), max 3 times — see §4 for why it escalates
- Base defence: 6 dps at range 7, so lone raiders can't chip a base down

### Tuned constants (all in `CFG`-equivalent consts at the top of the script)

```
LANE=80  BASE_HP=600  BASE_DPS=6  BASE_RNG=7
ECO_COST=45  ECO_STEP=0.5  ECO_MAX=3  ECO_ESC=0.75   // price = 45*(1+0.75n)
DECIDE=4        // seconds of sim time between agent decisions
TIME_CAP=300
RAMP = t => 1 + t/55
tick dt = 0.05s
```

Units spawn with seeded variance: position jitter `R()*1.6`, HP `×(0.96 + 0.08*R())`.
**This matters** — see bug #4.

---

## 2. Architecture

Single `<script>` in `breach.html`, sectioned by comment banners:

1. **RULES** — `UNITS`, `MULT()`, constants, `FREE_MODELS` catalogue, `shortName()`
2. **SIM** — `newGame()`, `step(dt)`, `endGame()`. Pure; no DOM except `endGame`
3. **AGENT** — `agent(S, s)`, the scripted adaptive commander (fallback + baseline)
4. **3b. COMMANDERS** — `CMD[]`, `decide()`, `runDecisions()`, rate gate, mock agent, debrief
5. **RENDER** — canvas battlefield, HUD, feed, log
6. **CONTROLS** — tabs, buttons, save
7. **LLM SEAT** — `llmAgent()`, `RULES` prompt, `extractJSON()`, `hintFor()`, `testKey()`

### Decision flow (lockstep)

`frame()` steps the sim until `S.t >= S.next`, then calls `runDecisions()` and **pauses
the sim** while both models are queried in parallel. Sim time and wall time are fully
decoupled, so a slow model is never punished for being slow.

This was a deliberate choice over letting the sim run during calls. Running live would
benchmark latency as much as intelligence and destroy reproducibility. I also rejected
pipelining (prefetching one interval early) because it feeds the model a 4-second-stale
board, degrading the exact thing being measured.

### Prompt versions

Saved logs carry `promptVersion`. **v1 and v2 runs are not comparable.**

- **v1** — original contract. Analysis of two real v1 matches (GPT-5 Nano vs Gemini 2.5
  Lite, Granite 4.0 vs Nova Micro) found: only 6–39% of decisions cited any concrete
  quantity, 35–75% of decisions put an unaffordable item at the head of the queue, and
  models named a unit then failed to queue it 10–29% of the time. Across both matches
  **zero tanks, AT teams or raiders were ever built** — neither side exceeded 37 coins
  against a tank's 45 — so the tank → gun → at cycle was never exercised at all.
- **v2** — adds three things the v1 prompt lacked:
  1. `costs` and `affordableNow`, plus an explicit statement that an unaffordable item
     **blocks everything behind it** and that saving requires re-queueing the same item
     first across several decisions.
  2. A feedback loop — `yourLastQueue`, `builtSinceYourLastDecision`,
     `unspentFromLastQueue` — so a model can notice its tank never spawned.
  3. `counterHint` computed from the actual enemy composition rather than one static line.

- **v3** — rewrote the ECONOMY section. v1/v2 described eco as "+0.5 coins/sec", which
  understates it by 2-5x: the bonus is added to BASE income and then multiplied by `RAMP(t)`,
  so one upgrade is worth ~+1.0/sec at 60s and ~+2.3/sec at 200s, pays back in 25-45s, and
  returns several hundred coins. v2 also carried a blanket "buying economy while under
  pressure loses games", which models reading near-constant pressure appear to have taken as
  "never". Ten commander slots across five matches bought **zero** eco upgrades. v3 states the
  real value, the escalating price, and adds `ecoNextPrice` / `ecoValueNow` to the state.

The scripted `agent()` never sees the prompt, so prompt changes never move the mirror
baseline. Balance changes do — see §4.

### Fair mode — a human commander

`kind: 'human'` seats you as a commander. It reuses the lockstep path exactly: `decide(s)`
returns a promise that resolves when you press Send orders, so the sim stays frozen while you
and the model both think. Identical rules on purpose — same 4s cadence, same queue that is
replaced each decision, same unaffordable-head blocking, and the picker shows the same state
the model receives (coins, income, eco level, enemy composition by class, and the live
`counterHint`).

The point is an anchor. Every other number in the leaderboard is model-relative; a human
result makes them interpretable. Matches record `human: true` on the relevant side.

One honest asymmetry: models are capped by a 25s timeout, you are not. Since sim time is
frozen for both, neither is punished for thinking longer, but a human taking two minutes on a
decision is not doing the same task as a model taking four seconds. Read human results as a
rough anchor, not a precise rating.

### Agent contract

Each call sends fogless full state: coins, income, eco level, both base HPs, every unit
on both sides with type/HP/distance, plus `myComposition`, `enemyComposition`,
`enemyNearestToMyBaseMetres`, a `threat` flag, `secondsLeft`, and a one-line counter hint.

Response must be:
```json
{"why":"one sentence read of the battle","queue":["inf","gun","inf"]}
```
The queue is spent in order as coins allow and is replaced at the next decision.

Robustness already in place: 25s timeout via `Promise.race`, one retry, whitelist
filtering of queue items (max 6), fallback to previous queue on failure, and **halt the
match after 3 consecutive failures from one side** (a silently degraded benchmark is
worse than a stopped one).

---

## 3. Bugs already found and fixed — do not reintroduce

These were all found by testing, several from user screenshots. Each is a trap worth knowing.

1. **Unbounded economy compounding.** Original design: 6 coins = +1 production permanently,
   income scaled off production. Payback under 2 turns, infinite ROI. One side hit
   25,000,000 units by turn 40. Fixed with escalating cost and a hard cap.
   *(This was in `deterrence.html`, but the lesson generalises.)*

2. **Unit upkeep missing.** Armies accumulated forever as dead capital. Added 0.5/unit/turn
   with desertion when unaffordable. *(deterrence.html)*

3. **Stalemates.** At `RAMP = 1 + t/160` every mirror match hit the 300s cap. Base HP was
   almost irrelevant (600 → 320 moved median length 6 seconds). The **income ramp is the
   dominant lever** for game length. `t/55` gives ~183s mirrors, zero timeouts.

4. **The seed did nothing.** An RNG was created and never used, so the sim was fully
   deterministic and identical commanders produced byte-identical games — one side won
   60/60 purely from floating-point asymmetry at the lane midpoint. Adding seeded spawn
   variance fixed it: mirrors now split 40/40 over 80 seeds. **If you touch spawning,
   re-check mirror fairness.**

5. **CSS transform in keyframes clobbering SVG transforms.** A flash animation on a
   `<g transform="translate(x,y)">` teleported counters to the origin. Animate opacity
   only on positioned SVG groups.

6. **Inline `<span>` ignores width/height.** HP bars never rendered fill for several
   iterations. Needs `display:block`.

7. **Battlefield collapsing to nothing.** `flex:1; min-height:0` let the canvas shrink to
   a sliver on short viewports. Now `min-height:290px` plus a `ResizeObserver` on the
   canvas parent.

8. **Base damage never landed.** Targeting checked for an enemy unit *before* the base, and
   defenders spawn *at* the base — so an attacker standing on the enemy base always had a
   fresh spawn in front of it and did zero building damage, forever. Base is now checked
   first. Verified: 40 damage/5s both with and without a defender present.

### API integration traps

- **Sandboxed webviews** (Claude app file preview) proxy `fetch` over `postMessage`, which
  structured-clones the options object. `AbortSignal` is not cloneable and throws before
  any request. Use `Promise.race` for timeouts. Also, in-app previews usually block
  third-party calls entirely — run in a real browser.
- **`reasoning:{enabled:false}` is rejected** by some providers ("Reasoning is mandatory
  for this endpoint"). Never send it. Adaptive fallback flips `NO_REASON_PARAM` on a 400
  mentioning reasoning.
- **Reasoning models blow the token budget.** At `max_tokens:400` GPT-OSS and Laguna spent
  everything thinking and returned empty content. Now 3000. JSON extraction tries
  `message.content` then `message.reasoning`, strips fences, and falls back to the
  outermost `{...}`.
- **OpenRouter `:free` routes** are capped at 20 req/min and 50/day without credits. One
  game is ~90 calls, so free cannot finish a single match. Rate gate applies only to
  `:free` ids.
- **Model IDs go stale** (Grok 4.1 Fast was deprecated mid-project). There is a
  **"Load live models"** button that pulls `https://openrouter.ai/api/v1/models` and
  repopulates the dropdowns sorted by price. Prefer it over the curated list.

---

## 4. Headless testing harness

This is how every balance claim above was verified, and it's the fastest way to iterate.
The sim sections are DOM-free, so they can be sliced out and run in Node:

```js
const s = require('fs').readFileSync('breach.html','utf8');
const js = s.split('<script>')[1].split('</'+'script>')[0];
let core = js.split('/* ------------------------------------------------------------\n   3b. COMMANDERS')[0];
core = core
  .replace("let S, R, LOG, RUNNING=false, SPEED=1, TAB='battle', RAF=null, FX=[];", "let S,R,LOG,FX=[];")
  .replace(/  LOG=\[\]; FX=\[\]; RUNNING=false;[\s\S]*?btnPlay'\)\.textContent='Start';/, "  LOG=[];FX=[];")
  .replace("  if(S.over) endGame();", "");

require('fs').writeFileSync('core.js', core + `
function play(seed){
  newGame(seed);
  while(!S.over){
    if(S.t>=S.next){ for(let s=0;s<2;s++) S.q[s]=agent(S,s).queue||[]; S.next+=DECIDE; }
    step(.05);
  }
  return {win:S.win, t:+S.t.toFixed(0)};
}
let a=0,b=0,lens=[];
for(let s=1;s<=60;s++){ const r=play(s); lens.push(r.t); if(r.win===0)a++; else if(r.win===1)b++; }
lens.sort((x,y)=>x-y);
console.log('mirror:',a,'/',b,'| median',lens[30]+'s','| timeouts',lens.filter(l=>l>=299).length);
`);
```

**Current verified baseline (must hold after any sim change):**
- Scripted mirror, 200 seeds: **103 / 97**, median **183s**, **0 timeouts**, **1.92 eco per side**
- Eco prices escalate: **45 / 79 / 113**

### A mirror test cannot detect a dominant strategy — always run the round-robin too

This is the most important lesson in this file. The mirror baseline ran clean for months
while the game was **solved**. Symmetric play means both sides make the same mistake, so the
result always looks balanced.

A trivial heuristic — *"buy eco whenever the nearest enemy is more than 30m away, otherwise
play the adaptive control"* — beat the adaptive agent **88-98% of the time at every flat eco
price tested, from 45 all the way up to 80.** Economy was not merely strong, it was the
answer to the game. Neither the mirror check nor any LLM match surfaced it, because no model
ever bought economy at all.

**Mandatory after any balance change**, 150 seeds each way with sides swapped:

| archetype | meaning | must be |
|---|---|---|
| `ecogreedy` | eco when the lane is clear, else adaptive | 40-70% |
| `ecorush` | nothing but eco until maxed | under 20% |
| `spam` | infantry only | under 20% |
| `noeco` | adaptive with eco stripped out | under 20% |

Current values: ecogreedy 66%, ecorush 0%, spam 0%, noeco 3%.

### Why the eco price escalates

A flat price with a *ramped* payout means the first upgrade is always correct and the game
has one right move. `ECO_STEP` adds to base income, and base income is multiplied by
`RAMP(t)`, so a single upgrade is worth ~+1.0 coins/sec at 60s and ~+2.3 at 200s — it pays
back in 25-45s and returns several hundred coins over a match. Escalating the price
(`ecoPrice(n) = 45 × (1 + 0.75n)`) keeps the first upgrade strong while making the third a
real commitment. That moved the `ecogreedy` heuristic from 98% to 66%.

Dropping the flat price to 40 (briefly, before this fix) also made the crude `ecorush` viable
at 100%. The tipping point was sharp: at 45+ ecorush lost 0/300, at 42 it won 83%.

### Confirmed working: prompt v3 + escalating eco price

The first v3 match (Llama 4 Scout vs GPT-4.1 Nano, seed 42, 2026-08-17) is the first time in
seven recorded matches that **any** model bought an economy upgrade. Every v1 and v2 match
recorded `eco 0/0` on both sides.

What changed in that match:

| | Llama 4 | GPT-4.1 Nano |
|---|---|---|
| eco queued / queued FIRST | 20x / 10x | 24x / **22x** |
| longest committed run | 2 decisions | **6 decisions** |
| upgrades completed | 1 | **3 of 3** |
| peak coins | 44 | **112** |
| total economy (units + eco) | 655 | **924** |
| result | base destroyed | **600 HP, untouched** |

GPT-4.1 Nano is the same model that, under v2, showed 0% deliberate saving and lost to
GPT-5.6 Luna. Under v3 it held eco at the head of its queue for six consecutive decisions.
That is strong evidence the v1/v2 economy description — not model capability — was the
bottleneck.

The match also produced the **first full counter exchange**: Llama fielded 6 tanks, GPT-4.1
answered with 12 AT teams at 4x versus armour, and won 600-0.

Worth noting against over-trusting the reasoning metrics: Llama cited concrete quantities in
48% of its decisions versus GPT-4.1's 13%, and used more distinct queues — it *articulated*
better and lost decisively. Commitment beat commentary.

### Known: a mild side bias to Vulcan

### Confirmed working: prompt v3 + escalating eco price

The first v3 match (Llama 4 Scout vs GPT-4.1 Nano, seed 42, 2026-08-17) is the first time in
seven recorded matches that **any** model bought an economy upgrade. Every v1 and v2 match
recorded `eco 0/0` on both sides.

What changed in that match:

| | Llama 4 | GPT-4.1 Nano |
|---|---|---|
| eco queued / queued FIRST | 20x / 10x | 24x / **22x** |
| longest committed run | 2 decisions | **6 decisions** |
| upgrades completed | 1 | **3 of 3** |
| peak coins | 44 | **112** |
| total economy (units + eco) | 655 | **924** |
| result | base destroyed | **600 HP, untouched** |

GPT-4.1 Nano is the same model that, under v2, showed 0% deliberate saving and lost to
GPT-5.6 Luna. Under v3 it held eco at the head of its queue for six consecutive decisions.
That is strong evidence the v1/v2 economy description — not model capability — was the
bottleneck.

The match also produced the **first full counter exchange**: Llama fielded 6 tanks, GPT-4.1
answered with 12 AT teams at 4x versus armour, and won 600-0.

Worth noting against over-trusting the reasoning metrics: Llama cited concrete quantities in
48% of its decisions versus GPT-4.1's 13%, and used more distinct queues — it *articulated*
better and lost decisively. Commitment beat commentary.

### Known: a mild side bias to Vulcan

### Why ECO_COST dropped from 60 to 40

Across four real LLM matches and eight commander slots, **zero economy upgrades were ever
completed**. Peak coins ever banked was 44 against a cost of 60, so the upgrade was not
merely unpopular — it was unreachable. Even GPT-5.6, which demonstrably held a save across
four consecutive decisions to afford a 45-coin tank, never attempted it, and said so in its
own debrief.

A sweep of the scripted mirror over 60 seeds:

| ECO_COST | mirror | median | timeouts | eco/side | tanks | AT |
|---|---|---|---|---|---|---|
| 60 | 30/30 | 182s | 0 | 1.01 | 209 | 502 |
| 45 | 34/26 | 177s | 0 | 1.94 | 410 | 830 |
| **40** | **33/27** | **160s** | **0** | **1.93** | **312** | **661** |
| 30 | 30/30 | 129s | 0 | 2.00 | 301 | 635 |
| 25 | 30/30 | 116s | 0 | 2.00 | 159 | 437 |

Cheaper economy makes games **shorter**, not stalemated — the opposite of the failure mode in
bug #3 — and roughly doubles how often tanks and AT teams reach the field, which is what the
counter cycle needs. 40 was chosen because it sits inside the observed LLM banking range
(peaks of 40 and 44) while keeping the median above 150s. Below 35 games get short enough
that decision count drops materially.

### Confirmed working: prompt v3 + escalating eco price

The first v3 match (Llama 4 Scout vs GPT-4.1 Nano, seed 42, 2026-08-17) is the first time in
seven recorded matches that **any** model bought an economy upgrade. Every v1 and v2 match
recorded `eco 0/0` on both sides.

What changed in that match:

| | Llama 4 | GPT-4.1 Nano |
|---|---|---|
| eco queued / queued FIRST | 20x / 10x | 24x / **22x** |
| longest committed run | 2 decisions | **6 decisions** |
| upgrades completed | 1 | **3 of 3** |
| peak coins | 44 | **112** |
| total economy (units + eco) | 655 | **924** |
| result | base destroyed | **600 HP, untouched** |

GPT-4.1 Nano is the same model that, under v2, showed 0% deliberate saving and lost to
GPT-5.6 Luna. Under v3 it held eco at the head of its queue for six consecutive decisions.
That is strong evidence the v1/v2 economy description — not model capability — was the
bottleneck.

The match also produced the **first full counter exchange**: Llama fielded 6 tanks, GPT-4.1
answered with 12 AT teams at 4x versus armour, and won 600-0.

Worth noting against over-trusting the reasoning metrics: Llama cited concrete quantities in
48% of its decisions versus GPT-4.1's 13%, and used more distinct queues — it *articulated*
better and lost decisively. Commitment beat commentary.

### Known: a mild side bias to Vulcan

Measured before the escalating-price fix, 600 scripted mirror seeds split **334 / 266
(55.7% to side 0, z = 2.78)**, identically at eco 60 and 40. Under the current escalating
prices the 200-seed mirror reads 103/97, so the bias may be smaller now — but it has not been
re-measured at 600 seeds, so treat side as a confound until it is. At 60 seeds
it hides inside the noise, which is why earlier checks read 30/30. This is exactly why
**every pairing must be played on both sides** — that rule cancels it. Do not read a single
one-sided result as a model difference.
- Cost-equalised duels confirm the tank → gun → at → tank cycle holds
- Round-robin of 5 fixed archetypes: the adaptive one wins ~75%, every static build 25–50%

That last number is the whole justification for the design. Strategy has to beat
no-strategy by a clear margin or the benchmark measures nothing.

---

## 5. Current state

Working and tested: full sim, canvas battlefield, mobile-first layout, live decision feed
with reasoning and latency, per-side thinking indicators, scripted/mock/OpenRouter
commanders, lockstep async, rate limiting, post-game self-debrief from both models, rich
JSON export.

A real match ran clean: Gemini 2.5 Flash Lite vs GPT-5 Mini, 40 decisions, **0 failed,
0 malformed**, avg latency 4.0s and 4.9s.

**Cost reference** (~83k input / 7k output tokens per game):
GPT-OSS 120B ~$0.004 · GPT-5 Nano ~$0.007 · Gemini 2.5 Flash Lite ~$0.011 ·
GPT-5 Mini ~$0.035 · Gemini 3.7 Flash ~$0.045 · Grok 4.3 ~$0.12

---

## 6. Next steps, roughly in order

1. **Tournament runner.** Play every pairing on both sides (mandatory — cancels residual
   side effects), N seeds each, aggregate to Elo or win rate. Needs a headless mode that
   doesn't render, and results persisted to disk rather than a download.
2. **Event-triggered replanning.** Currently a fixed 4s cadence, ~46 calls/side/game. Only
   calling when something material changed (composition shift, base under attack, coins
   piled up) should cut calls 50–60% with little quality loss.
3. **Prompt ablations.** Does removing `counterHint` change results? Does removing
   `threat`? That measures how much the scaffolding is doing versus the model.
4. **Fog of war option.** Currently both sides see everything. Hiding enemy composition
   would test inference rather than reaction.
5. **Debrief scoring.** The self-debrief is currently just flavour. Grading whether the
   loser correctly diagnoses *why* it lost would be a genuinely interesting second metric.

## 7. Things to keep

- Never let a match continue silently when a side's calls are failing.
- Always play both sides of a pairing.
- Re-run the headless mirror check after any change to `step()`, spawning, or unit stats.
- The scripted `agent()` is the control condition — don't delete it, and be careful about
  making it smarter, since it's the baseline every model is measured against.
