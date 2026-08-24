# Breach — Development Handoff

> Read this first, then `HANDOFF.md` (deep balance lore & history). This doc is the
> current-state map and the workflow you must follow. Last updated: prompt **v8**
> (neutral tower + push/hold stance).

---

## 1. What Breach actually is

A browser wargame where two LLMs command opposing armies down one 80 m lane —
but it is really a **benchmark harness that looks like a game**. The point is to
measure which model reasons better about counters, tempo, economy timing, and now
map control. Every design decision serves that: does a *better reasoner reliably
win because of it?* If a mechanic doesn't discriminate models, it doesn't belong.

Play it at **https://skdev.one/war-game**.

---

## 2. Repos & files

**Frontend** — `~/work/skdev-one/war-game/` (this repo, `skdev-one`, deploys to Vercel):
- `index.html` — **the entire game**, one self-contained file (~180 KB), no build step, no deps. Inline `<script>` holds sim + render + decision engine + UI.
- `bench.js` — the **balance instrument** (Node, stdlib only). Your safety net. See §5.
- `bench.baseline.json` — recorded reference the gate diffs against.
- `HANDOFF.md` — history + the hard-won balance lessons. Dense, still valuable.
- `results.json` — a few seeded human-baseline matches (legacy).
- `manifest.webmanifest`, `icon-*.png` — PWA install assets.

**Backend** — `~/work/breach-api/` (separate git repo, Docker on an SSH VM):
- `app.py` — stdlib-only Python HTTP server + SQLite. Stores every match, serves the leaderboard. Tolerant `extract()`, idempotent fingerprint, `rate_ok()` 60/hr/IP.
- `Dockerfile`, `docker-compose.yml`, `README.md`. `.env` is gitignored.
- Live at `https://breach-api.skdev.one`. Endpoints: `/v1/health`, `/v1/matches?limit=N`, `/v1/matches/{id}` (full payload incl. decisions), `/v1/standings`. POST to `/v1/matches` to save.

**Secrets**: the OpenRouter key lives in `~/work/.api-keys` (and on the VM). **Never** hardcode it in `index.html` or commit it — the verify block greps for `sk-or-v1-*` on every change.

---

## 3. Architecture of index.html

Read it in these sections (search for the banner comments):
- **Constants & UNITS** — `UNITS`, tower/eco/base constants (§6).
- **Section 3 the sim** — `newGame()`, `step(dt)`, `agent()`/`baseAgent()`/`stanceFor()`. Pure logic, no DOM.
- **`3b. COMMANDERS` banner** — everything above it is the *sim slice* `bench.js` extracts. **The four slice boundaries below must stay byte-identical** or bench breaks loudly.
- **Decision engine** — `sanitize()`, `decide()`, `runDecisions()`, `llmAgent()`, `humanTurn()`.
- **Render** — `draw()`, `fort()`, `drawTower()`, unit painters, particles.
- **UI/state** — modals, pickers, leaderboard, dossiers, settings.

**Lockstep**: the sim freezes (`AWAIT=true`) while both models are queried in parallel, so sim-time is decoupled from wall-time and a slow model isn't penalized *in the game* (it still makes you wait — see the timeout, §7).

**Decision cadence**: `DECIDE = 4` sim-seconds. Each turn a side submits `{queue:[...], stance, why}`. The queue is spent strictly in order, only when the next item is affordable; an unaffordable item **blocks everything behind it**. Saving = repeating the same first item across turns.

---

## 4. THE DEV WORKFLOW (follow this every time — it is not optional)

The user gave standing authorization: **"proceed with the dev and auto push, don't wait for my go ahead."** So you implement, verify, commit, and deploy yourself. But every change to `index.html` runs this ritual first:

```bash
# 1. syntax + duplicate-function-name + secret scan (all in one)
node -e "
const s=require('fs').readFileSync('war-game/index.html','utf8');
new (require('vm').Script)(s.split('<script>')[1].split('</'+'script>')[0]);
const js=s.split('<script>')[1].split('</'+'script>')[0];
const n={},d=[];for(const m of js.matchAll(/^function ([A-Za-z_\$][\w\$]*)\s*\(/gm)){n[m[1]]=(n[m[1]]||0)+1;if(n[m[1]]>1)d.push(m[1]);}
console.log('SYNTAX OK | dup fns:',d.length?d.join(','):'none','| secret:',/sk-or-v1-[A-Za-z0-9]{20,}/.test(s)?'FOUND':'clean');"

# 2. balance gate (only if you touched the SIM; skip for pure UI/prompt)
node war-game/bench.js gate      # exit 0 = pass, exit 1 = drift

# 3. commit + push (Vercel auto-deploys main)
git add war-game/index.html && git commit -m "..." && git push origin main

# 4. confirm it went live (poll for a string unique to your change)
for i in 1 2 3 4; do curl -sL https://skdev.one/war-game | grep -q "YOUR_MARKER" && { echo LIVE; break; }; sleep 12; done
```

**Non-negotiables learned the hard way:**
- **Duplicate top-level `function` names silently overwrite each other** — a name collision (`renderPicker`) once made the game unplayable. The dup-name check above catches it.
- **Never claim something works without running the check.** State test output; if it fails, say so.
- **A denied/failed tool call means adapt, don't retry verbatim.**
- Commit messages end with the Co-Authored-By + Claude-Session trailer (see git log for the exact format).
- Deploy = push to `main`. There is no separate deploy step; Vercel watches `main`.
- Work behind a branch for anything experimental/unproven; only merge to `main` what you've validated. Existing experiment branches: `air-support`, `field-advantage`, `medic`, `trenches`, `tower` (merged). `main` is always the deployed truth.

**Local playtest**: `cd war-game && python3 -m http.server 8977`, open `http://localhost:8977/index.html`. For visual/UX checks, drive it with the Chrome tools; you can force sim state from the console (`newGame(seed)`, push into `S.units`, set `S.tower`, `AWAIT=true` to freeze, then screenshot).

---

## 5. bench.js — the instrument (your most important tool)

Single-game outcomes are **noise** — a model can win by luck, and (a since-fixed lesson) win rate swings wildly with *which 4-second tick a strategy first commits on*. `bench.js` exists to see past that.

```bash
node war-game/bench.js quick    # 25 seeds × 2×2 phase grid — ~10s smoke test
node war-game/bench.js full     # 60 seeds × 4×4 phase grid — ~40s, tight CIs
node war-game/bench.js gate     # diff vs bench.baseline.json; exit 1 on drift
node war-game/bench.js record   # re-record the baseline AFTER an intended balance change
```

How it works & why to trust it:
- It **slices the sim out of `index.html`** at four byte-exact boundaries (the `3b. COMMANDERS` banner, the `let S, R, LOG...` decl, the `LOG=[]; FX=[]; RUNNING=false...` reset block, and the `if(S.over) endGame();` line). If you edit near those, bench fails loudly rather than measuring the wrong thing — fix the boundary strings in `bench.js` if so.
- It **marginalises over commit phase** by running every pairing across a grid of per-side decision-clock offsets. The reported number is the mean ± 95% CI. This is the whole reason it's trustworthy; do not "simplify" it back to single-phase.
- **`control` is an archetype identical to `adaptive` and must score ~50%.** It is the harness auditing its own bookkeeping. If control drifts off 50, distrust the whole run.
- The **mirror** check runs 1000 seeds and tests side-evenness within the CI (there is a ~55% Vulcan/left-seat bias at low N — always play pairings both ways).
- The gate **diffs against a recorded baseline** rather than absolute bands (an absolute band would fail forever on the open `stall` exploit and get ignored). After any *intended* balance change: `record`, eyeball the numbers, commit the new `bench.baseline.json`.

**Mandatory after ANY balance change**: run `full`, confirm control ≈ 50, mirror even, and no archetype newly dominant (>65%). A mirror test alone **cannot** detect a dominant strategy — the archetype round-robin is what catches "one build beats everything."

Caveat baked into the tool: bench archetypes play with default (push) stance and don't use the tower's hold command, so the gate tests a partial slice of real play. The stance-aware harness lives in `scratchpad/tower.js`-style scripts (recreate as needed) — that's where push-vs-hold balance was validated.

---

## 6. Current game state (constants & mechanics, as of v8)

**Units** (`UNITS`):
| key | name | cost | hp | dps | spd | rng | class | notes |
|---|---|---|---|---|---|---|---|---|
| inf | Infantry | 8 | 70 | 8 | 7.0 | 2 | light | cheap generalist |
| gun | Gunner | 18 | 80 | 14 | 5.0 | 6 | support | 2× vs light |
| air | Chopper | 40 | 200 | 26 | 9.0 | 4 | air | inf/tank do 0 to it; AT 3× (`AIR_AT`), gun 0.6× (`AIR_GUN`); only 0.35× to bases (`AIR_BASE`) |
| tank | Tank | 45 | 400 | 16 | 3.5 | 5 | armor | splash; AT 4× |
| at | AT Team | 30 | 90 | 12 | 5.0 | 8 | support | 4× vs armor, 3× vs air; longest range |

Counter cycle: **tank > gun > at > tank**. `MULT()` encodes all multipliers.

**Economy**: `ECO_COST=36, ECO_STEP=0.5, ECO_MAX=3, ECO_ESC=0.75` → prices 36/63/90. Income is multiplied by `RAMP = 1 + t/55` (roughly doubles by 60 s). Eco was the dominant, misunderstood lever historically — the RULES prompt has a long section on it.

**Base**: `BASE_HP=600, BASE_DPS=2, BASE_RNG=7`. The base gun was deliberately weakened (6→2) — a strong base gun killed the early trickle for free and made *stalling* the best opening. `stall` (buy nothing ~30 s, then play) is a known ~55–60% exploit that is **not fully solved**; the tower helps only when the hold stance is used.

**Neutral tower (v8)**: `TOWER_X=lane centre, TOWER_R=10, TOWER_ECO=0.3 (doubles after TOWER_ESC=30s hold), BOLT_PERIOD=20, BOLT_DMG=120, CAP_TIME=5`.
- **Stance** (`push`/`hold`, persistent): push = march to the enemy base; hold = advance to the tower and stop. A whole-army posture that **persists across turns** until changed.
- **Capture-and-hold**: a challenger must out-number the enemy in the zone for ~`CAP_TIME`s while a capture bar fills; ownership is **sticky** (never reverts to neutral). Progress decays at half the build rate (no flicker).
- Holding pays escalating eco **and** fires an airstrike (`BOLT_DMG` to the enemy base every `BOLT_PERIOD`s of unbroken hold) — the airstrike is what prevents hold-forever stalemates (it must be strong enough to kill a base within `TIME_CAP=300`s or games time out).
- Sim-validated at these numbers: pusher/holder/control all ~50%, 0 timeouts, mirror even, stall dead *when hold is used*.

**Game end**: first base to 0 HP, or at `TIME_CAP=300` sim-s whoever has more base HP (draw if equal).

---

## 7. The decision/robustness layer (index.html)

- **`sanitize(raw)`** tolerates the shapes small models emit: comma/space strings, arrays of objects (`{unit|type|id}`), object maps, mixed case, prose with JSON buried in it (`extractJSON`). Returns `{queue, why, stance, bad, shape}`. `stance` is `null` when unspecified = **keep current posture** (stance persists). Genuinely unusable output is counted as malformed, not silently dropped (a past bug scored a model's JSON-format failures as deliberate holds).
- **Timeout & fallback**: each model call is bounded to **30 s covering the whole fetch *and* body stream** (the original bug raced only `fetch()`, which resolves at headers, so a model streaming for 500 s was never cut off — you must race the entire fetch+parse and AbortController the request). On timeout, the side falls back to the scripted adaptive order (not dumb infantry) and **the game continues** — only genuine errors (bad key/HTTP) count toward the 3-strike halt. 429s currently DO count toward the halt (user's choice — leave as-is).
- **Reasoning cap**: sends `reasoning:{max_tokens:400}` (NOT `effort` — GLM and others silently ignore `effort`). `max_tokens:6000` overall so a runaway reasoner can still emit JSON.
- **Feedback fields in the view** (so models play coherently): `purchaseBlocked`, `lastTurnAutoPlayed`, `yourLastQueue`, `builtSinceYourLastDecision`, plus the whole `tower` block and `yourStance`.

---

## 8. Memory & dossiers (v7)

- **Within-game conversation memory** (`MEMORY_ON`, default on, toggle in setup): each side replays its own last `MEM_TURNS=10` turns as real user/assistant messages so it keeps its chain of thought (fixes the "queues eco 13× owns 0" incoherence). Bounded window because **prompt caching does NOT fire for growing conversations via OpenRouter** on most models (verified: Gemini 3.7 caches 0%, Gemini 2.5 Lite/GPT-5 Nano cache 13–30% — it's model-specific). `cachedTokens` is logged so you can see when it fires. Cost ≈ $0.05/game.
- **Rival dossiers**: after each human-vs-model game the model writes a scouting report on the human (`{read, plan}`), stored per-model in `localStorage`, injected into its system prompt next game. Only for human-vs-model (never model-vs-model, so the benchmark is untouched). A "Rivals" screen shows what each model thinks of you. `dossierUsed:[bool,bool]` is stamped on saved matches. **Proven working**: models cite their scouting ("counter their gunner-heavy profile") and adapt across games.

---

## 9. Prompt versions (stamped on every saved match; filter the leaderboard by them)

v1–v3 economy wording; **v4** eco reprice 45→36 + base gun 6→2; **v5** Raider→Chopper (air); **v6** explicit `purchaseBlocked`; **v7** conversation memory; **v8** neutral tower + stance. Runs across versions are **not comparable** — that's why the version is stamped. `RULES` is a template literal built from the live constants, so most numbers self-update; prose sections you must edit by hand. Bump the version when you materially change what models are told.

---

## 10. Hard-won lessons (don't relearn these)

1. **Single games are noise.** Validate balance with `bench.js` (phase-averaged, both seats, control=50 sanity), never with one match or a mirror alone.
2. **A mirror test cannot detect a dominant strategy** — symmetric play hides it. Always run the archetype round-robin.
3. **Every new *unit* hits the same wall**: units can't be positioned and the game is race-to-base, so support/utility units are either useless or break something. Trenches (safer stalling), air (kills economy — it bypasses the front line and economy is an undefended state), and medic (sustain is low-value in a breakthrough game; knife-edge balance) all failed or barely shipped. **The tower succeeded because it added a decision axis (positioning) + agency (the stance command), not another counter-pair.** Prefer depth over width.
4. **"Will models actually use it?" is a real risk** for every optional mechanic (dossiers, hold stance). Weak/aggressive models ignore them; strong ones use them — which is itself a benchmark signal, but don't assume adoption.
5. **Timeouts must cover body streaming, not just headers.** (§7)
6. **Prompt caching is model-specific and doesn't help growing conversations.** (§8)
7. **Verify in the browser for anything visual** — force state from the console and screenshot. Several render bugs (chopper on the ground, base gun invisible) were only caught by looking.

---

## 11. Open questions / candidate next work

- **The `stall` exploit (~55–60%) is not fully solved.** The tower dents it only when hold is used. A structural fix would be worth finding.
- **Tower adoption**: with persistent stance now shipped, re-measure how often models hold (was 0–11% before persistence; the reset-to-push default was suppressing it). If still low, consider making fast aggression less able to win outright (tankier bases / weaker early rush) so the tower economy has time to matter.
- **Backend dossiers**: currently localStorage (per-device). Moving to the backend would let rivals remember across devices and enable analysis.
- **A learning/tournament ladder** using the dossier system (adaptation score across a rematch series).
- **Re-baseline discipline**: `bench.baseline.json` reflects push-only play; a stance-aware gate would be more representative.

---

## 12. Standing user preferences

- **Auto-push authorized** — implement, verify, commit, deploy without waiting for approval. Report what you did and the test output.
- **Be honest about verification** — never say "works" without evidence; disclose failures and unfaithful measurements immediately (there's precedent: a replay harness was wrong and all state-dependent metrics were withdrawn).
- The user plays mostly on **mobile, landscape**; keep it mobile-first.
- Keep the clean model-vs-model **benchmark** uncontaminated by play features (memory/dossiers are human-facing; the tower is stamped v8).
- When analysing games, pull them from the backend (`/v1/matches`) — no manual file sharing.

---

## 13. Public app — accounts, quotas, server-run models (launched 2026-08-24)

Breach now has TWO faces in the one `index.html`:
- **The public game** — the default face for real players. Accounts (guest or registered), a daily game allowance, difficulty tiers, and **the server runs the models** (players do NOT bring their own OpenRouter key). Public copy uses battle language, no API/provider/storage jargon.
- **The benchmark** — the owner-only Benchmark Lab (model-vs-model, mock, the tools this whole doc describes), gated behind `/v1/me` `isAdmin===true`. The v8 tower simulator is unchanged and still the core; bench gate stays +0.0pp.

**Backend** (`~/work/breach-api/`, branch `feature/breach-accounts-backend`, deployed on `ssh-social`): the legacy stdlib `app.py` was replaced by a **FastAPI** app (`app/` package) with SQLite. Key modules: `identity.py` (session cookie for registered users, `X-Breach-Guest` header for guests), `quota.py` (atomic IST-midnight daily allowance — **3/day guest, 10/day registered**), `games.py` + `routes_games.py` (server-owned game sessions and decisions), `openrouter.py` (bounded transport, one shared 30s deadline, stable failure codes, model-health three-strike), `prompt_v8.py` (server-side v8 prompt/memory/`extract_json`/`sanitize_decision`), `migrations.py` (additive schema, runs on startup), `legacy.py` (compatibility `POST /v1/matches` + old leaderboard reads), `routes_admin.py` (owner benchmark sessions).

**Tiers** (`app/config.py` `MODEL_TIERS`): easy = nova-lite-v1 / nova-2-lite-v1 / phi-4; medium = gemini-3.5-flash-lite / qwen3.7-flash; hard = gemini-3.7-flash (registered only).

**Public API** (all under `/v1`, `Origin: https://skdev.one` required for mutations): `POST /guests {displayName}`, `POST /auth/{signup,login,logout}`, `GET /me`, `GET /difficulties`, `POST /games`, `POST /games/{id}/complete`, `GET /history`, `GET /leaderboards/{players,models,recent}`. Legacy `GET /v1/{matches,standings}` + `POST /v1/matches` remain during compatibility.

**Compatibility & cutover**: the backend deployed with `BREACH_LEGACY_PUBLIC_READS=true` + `BREACH_LEGACY_WRITES=true` so the old frontend kept working during the swap. **After the new frontend is confirmed live, flip both to `false`** (edit `~/breach-api-new/.env` on the host, `docker compose up -d`) to close anonymous reads/writes. The old frontend's direct `POST /v1/matches` writes stop then — acceptable once the public app is the only client.

**Deploy notes** (host `ssh-social`, dir `~/breach-api-new`, compose project `breach-api`, same volume `breach-api_breach-data`, port 8050 loopback, nginx unchanged): `.env` holds the real `OPENROUTER_API_KEY` (never commit it) and `FORWARDED_ALLOW_IPS=172.17.0.1` (the Docker gateway). Backups live in `~/breach-backups/`. Provider gate: `docker compose run --rm breach-api python -m scripts.provider_smoke` must print `PASS`. Full predeploy ceremony (`scripts/predeploy_gate.py`, reviewed-source binding, recovery manifest) exists for a high-stakes cutover; the launch used the pragmatic path (DB backup + compatibility mode + additive migration + provider smoke) because there were no real users yet.

**Backend tests**: `cd ~/work/breach-api/.worktrees/breach-accounts-backend && python3 -m pytest -q` (380+ passing). **Frontend public tests**: `node --test war-game/public-app.test.js` (71 passing). The mandatory `index.html` gate (syntax/dup/secret + `bench.js gate`) is unchanged and still required.

**Owner migration**: register `rsumit123@gmail.com` through the public signup, then `docker compose exec breach-api python scripts/assign_owner_matches.py --email rsumit123@gmail.com --db /data/breach.db` (idempotent — grants admin, assigns historical unowned matches once).
