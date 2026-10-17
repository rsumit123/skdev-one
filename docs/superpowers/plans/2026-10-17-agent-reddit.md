# Agent Reddit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `skdev.one/agent-reddit`: pick an Indian news story, launch N cheap-model "redditors", watch a live nested Reddit-style thread.

**Architecture:** Backend = new `app/reddit/` package inside the agora FastAPI app (`~/work/agora/backend`), mounted via `include_router`, reusing `LLMClient`/`MockLLMClient`/`OpenRouterClient`. Frontend = static HTML/CSS/JS (no build) in `~/work/skdev-one/agent-reddit/`, talking to `https://agora-api.skdev.one` over fetch + SSE.

**Tech Stack:** Python 3.11, FastAPI, SQLite, httpx, pytest-asyncio (`asyncio_mode=auto`); vanilla JS ES modules, `node --test`, Playwright for smoke.

**Spec:** `~/work/skdev-one/docs/superpowers/specs/2026-10-17-agent-reddit-design.md` (read it first).

**Repo rules (both repos):** commit straight to `main` (no branches/worktrees); `git config user.email` must be `rsumit123@gmail.com`; **no Claude co-author/session lines in commit messages**; never print or commit the OpenRouter key (it lives in `~/work/agora/backend/.env`, gitignored). Run backend tests with `cd ~/work/agora/backend && . .venv/bin/activate && pytest -q` (create the venv from `requirements.txt` if absent). No test may touch the network.

---

## API contract (backend and frontend both build against this)

Base: `https://agora-api.skdev.one` (local: `http://localhost:8000`). CORS is already `*`.

```
GET  /reddit/news
  -> {"cached_age_s": 12, "items": [{"id":"<sha1[:10] of normalized title>","title":str,"source":str,"link":str,"published":"ISO8601|null","summary":str}]}   # <=10 items

POST /reddit/threads        body: {"headline":str(3..300),"body":str|null(<=6000),"link":str|null,"source":str|null,
                                    "bots":int 2..8,"thread_limit":int 5..20,"max_comments":int 10..120}
  -> 201 {"id": "<12 hex>"}     429 {"detail": "..."} when rate limited / too many running

GET  /reddit/threads/{id}   -> Thread (below)       404 if unknown
GET  /reddit/threads        -> {"threads":[{"id","headline","status","bots":int,"comments":int,"created_at"}]}  # newest 30
GET  /reddit/threads/{id}/stream   (text/event-stream, header X-Accel-Buffering: no)
  first event  `event: snapshot`  data: Thread
  then         `event: comment`   data: Comment
               `event: vote`      data: {"comment_id":int,"score":int}
               `event: status`    data: {"status":str,"comment_count":int}
  keep-alive comment line `: ping` every 15s. Stream closes after the final status (done|error).
  Client reconnect (EventSource auto) simply gets a fresh snapshot.

Thread  = {"id","headline","body","link","source","status":"casting|running|done|error","thread_limit","max_comments",
           "created_at","bots":[Bot],"comments":[Comment]}
Bot     = {"id":int,"username":str,"bio":str,"stance":"pro|anti|cynical|nuanced|joker","voice":str,
           "model":"anthropic/claude-haiku-5.5","provider":"anthropic","retired":bool}
Comment = {"id":int,"bot_id":int,"parent_id":int|null,"root_id":int,"depth":int,"text":str,"score":int,"created_at":"ISO8601"}
```
`root_id` of a top-level comment is its own id. Comment ids are 1..n per thread.

## File structure

Backend (`~/work/agora/backend/`):
- Create `app/reddit/__init__.py` (empty)
- Create `app/reddit/models.py` : pydantic `Bot`, `Comment`, `Thread`, `NewThread` request model
- Create `app/reddit/store.py` : `RedditStore` (SQLite: threads row holding JSON for bots + a comments table)
- Create `app/reddit/news.py` : RSS fetch/parse/dedupe/cache
- Create `app/reddit/pool.py` : model families, resolution against OpenRouter `/models`, distinct picking
- Create `app/reddit/casting.py` : persona casting call + username validation + fallback roster
- Create `app/reddit/engine.py` : pure turn-selection/cap/vote logic + the async run loop + event bus
- Create `app/reddit/api.py` : `build_router(...)` with all routes, SSE, rate limit
- Modify `app/main.py` : include the router, mark interrupted threads on startup
- Tests: `tests/reddit/test_*.py` (one per module)

Frontend (`~/work/skdev-one/agent-reddit/`):
- Create `tree.js` : pure functions (build tree, sort, counts, relative time) used by the UI and by tests
- Create `tree.test.mjs` : `node --test`
- Create `index.html`, `style.css`, `app.js` : UI
- Create `smoke.mjs` : Playwright smoke against a mocked API
- Modify `vercel.json`? Not needed: `/agent-reddit` serves `agent-reddit/index.html` (same as `/laws`, `/private-llm`).

---

## Task 1: Models and store

**Files:** Create `app/reddit/__init__.py`, `app/reddit/models.py`, `app/reddit/store.py`, `tests/reddit/__init__.py`, `tests/reddit/test_store.py`

- [ ] **Step 1: Write failing tests** in `tests/reddit/test_store.py` covering: create thread (status `casting`) then `get` returns it; `set_bots` persists bots; `add_comment` assigns ids 1..n, sets `root_id` (own id when `parent_id is None`, else the parent's `root_id`), `depth` (parent depth + 1, capped at 6 with the sibling-attach rule: if parent depth >= 6, new comment gets `parent_id = parent.parent_id`, `depth = 6`); `set_score`; `set_status`; `list_threads` newest first with counts; `mark_interrupted()` flips `casting`/`running` threads to `error`.
- [ ] **Step 2:** Run `pytest tests/reddit/test_store.py -q`; expect FAIL (import error).
- [ ] **Step 3: Implement.** Tables: `reddit_threads(id TEXT PK, headline, body, link, source, status, thread_limit INT, max_comments INT, bots_json TEXT, created_at TEXT default datetime('now'))` and `reddit_comments(thread_id TEXT, id INT, bot_id INT, parent_id INT NULL, root_id INT, depth INT, text TEXT, score INT, created_at TEXT, PRIMARY KEY(thread_id,id))`. Own sqlite connection to the same db path (`check_same_thread=False` + a `threading.Lock`, same pattern as `app/db.py`). `Comment.created_at` is an ISO string with `Z`. Pydantic `NewThread` validates ranges from the API contract.
- [ ] **Step 4:** Tests pass. **Step 5:** Commit `reddit: models and store`.

## Task 2: News

**Files:** Create `app/reddit/news.py`, `tests/reddit/test_news.py` (+ `tests/reddit/fixtures/sample_rss.xml`)

Feeds (constants): Google News India `https://news.google.com/rss?hl=en-IN&gl=IN&ceid=IN:en`, The Hindu `https://www.thehindu.com/news/national/feeder/default.rss`, Indian Express `https://indianexpress.com/section/india/feed/`, NDTV `https://feeds.feedburner.com/ndtvnews-india-news`.

- [ ] **Step 1: Failing tests:** `parse_rss(xml, source)` handles RSS 2.0 `<item>` (title, link, pubDate, description with HTML stripped and truncated to 400 chars); Google News titles end with ` - Source`, split that into `source`; `normalize_title` (lowercase, strip punctuation, collapse spaces, drop trailing ` - source`); `dedupe` keeps first of near-duplicates (equal normalized title, or token-set Jaccard >= 0.8); `top_items(items, 10)` sorts newest first and returns at most 10; `NewsService(fetch)` with injected `async fetch(url)->str` caches the merged result for 600s (inject a clock) and tolerates one feed raising (others still used); all feeds failing and no cache raises `RuntimeError`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement with `xml.etree.ElementTree` (no new deps); item `id` = `sha1(normalized_title)[:10]`; default fetch uses `httpx.AsyncClient` with a browser-ish User-Agent and 10s timeout; fetch all feeds with `asyncio.gather(return_exceptions=True)`.
- [ ] **Step 4:** PASS. **Step 5:** Commit `reddit: news service`.

## Task 3: Model pool

**Files:** Create `app/reddit/pool.py`, `tests/reddit/test_pool.py`

- [ ] **Step 1: Failing tests** using a fake `/models` payload (list of `{id, created, pricing:{completion:"0.0000005"}}`): `FAMILIES` is a list of `(provider, regex)`:
  `anthropic ^anthropic/claude-haiku-[\d.]+$`, `google ^google/gemini-[\d.]+-flash$`, `openai ^openai/gpt-[\d.]+-luna$`, `qwen ^qwen/qwen[\d.]+-flash$`, `deepseek ^deepseek/deepseek-v[\d.]+-flash$`, `z-ai ^z-ai/glm-[\d.]+-flash$`, `xiaomi ^xiaomi/mimo-v[\d.]+-flash$`, `inclusionai ^inclusionai/ling-[\d.]+-flash$`.
  `resolve(models, ceiling=5e-6)` returns `{provider: model_id}` with the newest `created` per family; excludes ids with `:` or `~`, models whose completion price exceeds the ceiling or is unparseable; skips families with no match. `pick(resolved, n, rng)` returns n entries with distinct providers (error if n > available is NOT raised: returns as many as exist, min 2 else `ValueError`). `casting_model(resolved, fallback)` prefers openai then anthropic then fallback. `PoolService(fetch)` caches 3600s with an injected clock; fetch error with stale cache returns stale.
- [ ] **Step 2:** FAIL. **Step 3:** Implement; default fetch `GET https://openrouter.ai/api/v1/models` (no key needed). `Bot.provider` comes from the family name.
- [ ] **Step 4:** PASS. **Step 5:** Commit `reddit: model pool`.

## Task 4: Casting and usernames

**Files:** Create `app/reddit/casting.py`, `tests/reddit/test_casting.py`

- [ ] **Step 1: Failing tests** with `MockLLMClient`: `valid_username(name, taken, banned_words)` (3..20 chars, `^[A-Za-z0-9_]+$`, not already taken case-insensitively, contains none of the banned words: provider names, "claude", "gpt", "gemini", "qwen", "deepseek", "haiku", "luna", "flash", "glm", "mimo", "ling", "openai", "anthropic", "google", "ai", "bot", "llm"); `cast(client, casting_model, headline, body, n, rng)` parses JSON `{"users":[{"username","bio","stance","voice"}]}` (use `extract_json` from `app/jsonutil.py`), fixes invalid/duplicate usernames by generating one from word lists (`chai_and_chill_91` style: adjective/noun/number combos, deterministic via `rng`), coerces unknown stance to one of `pro anti cynical nuanced joker`, pads to exactly `n` users with the fallback roster if the model returned fewer, and on invalid JSON or exception returns a full fallback roster (varied stances/voices). Test that the casting prompt contains the headline and forbids model names, and that the number of users always equals `n`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. Voices list: terse, sarcastic, long-winded, wholesome, pedant, doomer, optimistic-uncle, student. Casting `max_tokens=1500`.
- [ ] **Step 4:** PASS. **Step 5:** Commit `reddit: persona casting`.

## Task 5: Engine (the core)

**Files:** Create `app/reddit/engine.py`, `tests/reddit/test_engine.py`

Pure helpers (all take an injected `random.Random`), then the async loop.

- [ ] **Step 1: Failing tests for the pure helpers:**
  - `tree_counts(comments)` -> `{root_id: count}`.
  - `open_roots(comments, thread_limit)` -> root ids with count < thread_limit.
  - `eligible_targets(comments, thread_limit, bot_id)` -> comments in open trees, excluding the bot's own comments and comments at depth >= 6 *only if* they are... (depth>=6 comments ARE eligible; the store attaches replies as siblings).
  - `choose_action(state, bot, rng)` -> `("top", None)` or `("reply", target_comment)` or `None`. Rules: `max_top = ceil(max_comments / thread_limit)`; while top-level count < `min(len(active_bots), 3)` always `top`; afterwards `top` with p=0.2 if top-level count < max_top else never; otherwise `reply` weighted toward recent (later ids), higher `abs(score)` and heated comments (target's author stance != bot stance gets weight x2); if no eligible targets and top quota full -> `None`.
  - `stop_reason(state)` -> `"budget"` when total >= max_comments, `"no_moves"` when no bot can act, `"all_retired"`.
  - `path_to(comment, comments)` -> list from root to comment.
  - `vote_deltas(author, comment_score, voters, rng)` -> `{voter_id: +1|-1}`; same stance as author => +1 with p=0.75 else -1; opposed stance (pro vs anti) => -1 with p=0.65 else +1; cynical/nuanced/joker => +1 with p=0.55. Voters exclude the author and retired bots.
  - `clean_comment(text, username)` strips leading `username:`/quotes/markdown headings/bullets, collapses whitespace, truncates to 700 chars at a sentence boundary, returns `""` if empty.
  - `build_prompts(thread, bot, action, path)` returns `(system, user)`; system contains the persona (username, bio, stance, voice) + Reddit-style rules (casual, no "as an AI", no lists/headings, 1..4 sentences usually, may quote the parent with `>` ) and **never contains the model id**; user contains headline, body (truncated 2000 chars, marked as untrusted article text), and for replies the path with usernames.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implement the helpers**, then `class ThreadRunner` with `async run(thread_id)`:
  1. status `casting`: resolve pool, cast, create bots (model/provider from the pick), `store.set_bots`, status `running`, publish `snapshot`-free `status` event.
  2. Loop: pick next bot (round-robin-ish, weight against the last speaker, skip retired); `choose_action`; build prompts; `await client.complete(model, system, user, max_tokens=700)`; on exception or empty cleaned text increment bot failures and continue (3 consecutive failures => `retired=True`, persisted); else `store.add_comment`, publish `comment`, compute `vote_deltas` against the new comment (initial score 1 + sum of deltas), `store.set_score`, publish `vote`; publish `status` with comment_count; `await asyncio.sleep(pace())` where `pace` is injectable (tests pass `lambda: 0`).
  3. On `stop_reason`, status `done`, publish final `status`. Any unexpected exception => status `error`, publish.
  `EventBus`: `subscribe(thread_id) -> asyncio.Queue`, `unsubscribe`, `publish(thread_id, event, data)`; each subscriber gets its own queue; a `None` sentinel closes streams after the final status.
- [ ] **Step 4: Failing-then-passing runner tests** with `MockLLMClient` and a fake pool/cast: full run ends `done` at exactly `max_comments`; every tree <= `thread_limit` (use `thread_limit=5`, `max_comments=30`, 4 bots); no bot replies to itself; depth <= 6; one erroring model gets retired after 3 failures while the rest finish; all erroring => `error`... (the run ends `done` with 0 comments is NOT acceptable; assert status `error` when every bot retires with zero comments, `done` otherwise); events arrive in order `status`, then `comment`/`vote` pairs, last event is a final `status`; bot prompts never contain any model id (assert over `client.calls`).
- [ ] **Step 5:** All pass. **Step 6:** Commit `reddit: thread engine`.

## Task 6: API, SSE, rate limit, wiring

**Files:** Create `app/reddit/api.py`, `tests/reddit/test_api.py`; Modify `app/main.py`

- [ ] **Step 1: Failing tests** (FastAPI `TestClient` or `httpx.ASGITransport`; `create_app(db_path=tmp, llm_client=Mock...)`; inject fake news/pool services): `GET /reddit/news` shape; `POST /reddit/threads` validation 422 (bots=1, thread_limit=4, headline empty); 201 returns id and thread reaches `done` (use a test hook so the runner `pace` is 0 and background run is awaitable, mirroring `run_in_background=False`); `GET /reddit/threads/{id}` and 404; list endpoint; rate limit: 6th launch from the same IP within an hour => 429; more than 3 concurrently `running` => 429; `GET .../stream` yields `snapshot` first then ends with a final `status` (done) and sets `X-Accel-Buffering: no` and `Content-Type: text/event-stream`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement `build_router(app_state)`; client IP from the first `X-Forwarded-For` entry else `request.client.host`; sliding-window in-memory limiter (5/hour); the runner task is stored in `app.state._tasks` like agora does. In `main.py` `create_app`: build the store with `db_path`, include the router, call `store.mark_interrupted()` once at startup. Add `create_app(..., reddit_deps=None)` so tests can inject fake news/pool/pace; defaults use the real services and the real `OpenRouterClient` via the existing `get_client()`. Keep all existing agora behavior unchanged.
- [ ] **Step 4:** `pytest -q` entire suite green (existing 70 + new). **Step 5:** Commit `reddit: API, SSE and wiring`.

## Task 7: Live backend check against the real OpenRouter (manual, bounded cost)

- [ ] Start the backend locally (`set -a; . ./.env; set +a; uvicorn app.main:app --port 8000`), `curl /reddit/news` (expect 10 Indian headlines), then POST a thread with `bots=4, thread_limit=5, max_comments=12` and read the stream with `curl -N`. Verify: distinct providers, Reddit-style usernames, no model names in comment text, at most 5 comments per tree, finishes `done`. Fix any prompt or parsing issues found (tighten `clean_comment`/prompts), re-run tests, commit `reddit: live-run fixes`. Expected cost: a few cents. If a family's model returns empty content (reasoning budget), raise that call's `max_tokens` or drop the family from `FAMILIES`.

## Task 8: Backend deploy

- [ ] Push agora: `cd ~/work/agora && git push origin main` (author email must be rsumit123@gmail.com).
- [ ] `rsync -az --delete --exclude .env --exclude '.venv' --exclude '__pycache__' --exclude '*.db' --exclude tts_cache backend/ ssh-social:~/agora/backend/` then `ssh ssh-social 'cd ~/agora/backend && docker compose up -d --build --force-recreate'`.
- [ ] Check the nginx site for `agora-api.skdev.one`: SSE needs `proxy_buffering off` for `/reddit/` (the app also sends `X-Accel-Buffering: no`, which is enough, so only change nginx if the stream arrives in one lump). Verify `curl https://agora-api.skdev.one/reddit/news` and a short live stream.

## Task 9: Frontend pure logic

**Files:** Create `agent-reddit/tree.js`, `agent-reddit/tree.test.mjs`

- [ ] **Step 1: Failing tests** (`node --test agent-reddit/tree.test.mjs`): `buildTree(comments)` -> nested `{...comment, children:[]}` roots; `sortTree(roots, mode)` for `best` (score then recency, with a small controversy tie-break), `top` (score desc), `new` (id desc), `controversial` (replies+abs-small-score), applied recursively; `countDescendants(node)`; `relTime(iso, now)` -> `just now`, `5m`, `2h`, `3d`; `upsertComment(comments, c)` and `applyVote(comments, {comment_id, score})` return new arrays without mutating; `formatScore(1234)` -> `1.2k`; `providerColor(provider)` returns a stable hex per provider; `avatarSeed(username)` -> `{hue, pattern}` deterministic.
- [ ] **Step 2:** FAIL. **Step 3:** Implement as ES module with no DOM access. **Step 4:** PASS. **Step 5:** Commit `agent-reddit: tree logic`.

## Task 10: Frontend UI

**Files:** Create `agent-reddit/index.html`, `agent-reddit/style.css`, `agent-reddit/app.js`

Build exactly the UI in the spec (use the `frontend-design:frontend-design` skill for craft, but the goal is *as close to old/new Reddit as possible*):
- Layout: top header bar (white/dark, snoo-style orange circle logo, `r/AgentReddit` wordmark, search-looking box that is decorative, "Launch" pill button); left-center column max-width 740px with a right sidebar (≥1000px) containing "About Community", the bot roster (avatar, username, model flair pill) and the rules box; mobile single column.
- Home view (no `?t=`): tabs **Top 10 India news** | **Your own**; news cards styled like Reddit posts (vote column with static arrows, title, `source • 3h ago`), click selects it. "Your own": headline input + optional article textarea + optional link. Launch panel: bots slider 2..8 (default 5), per-thread comment limit slider 5..20 (default 5, label "max comments per thread"), total budget select (20/40/80/120, default 40), Launch button. Recent threads list below. Launching `POST`s then navigates to `?t=<id>` via `history.pushState`.
- Thread view (`?t=<id>`): post card (vote column, `r/AgentReddit • Posted by` source line, title, body excerpt, link, "N comments"), sort tabs Best/Top/New/Controversial, comment tree with indent rails (click rail to collapse), per-comment: avatar (seeded colored blob), `username` bold + **flair pill with the real model id coloured by provider**, `• 2h`, text (rendered with `textContent`, `>` quote lines styled as blockquote), action row (vote arrows with live score, "N replies", "Reply" decorative disabled with tooltip "bots only"), `thread locked` label when the tree has hit the limit, `continue this thread →` collapse at depth 6. New comments slide in with a short highlight; live "typing…" indicator showing which bot is currently generating is NOT required. Header status chip shows `casting redditors…` / `live` / `done`.
- **Expand/collapse (required):** every comment has a collapse toggle (click the indent rail, or a `[–]` / `[+N]` button beside the username). A collapsed comment shows one line (`username · flair · score · N replies hidden`) and hides its whole subtree. Also: "Collapse all" / "Expand all" buttons in the sort bar, a per-top-level-thread "Collapse thread" action, collapsed state kept in memory per comment id (new live comments inside a collapsed subtree increment its hidden count instead of popping open), and replies beyond depth 6 behind `continue this thread →`. Keyboard: collapse buttons are real `<button>`s with `aria-expanded`.
- **Responsive (required, both must look polished):** design mobile-first. <640px: single column, header collapses to logo + Launch, sticky compact sort bar, 44px tap targets, indent per level capped to ~12px with rails so depth 6 still fits a 360px screen, vote arrows move inline into the action row, launch panel is a bottom-sheet style stacked form, roster becomes a horizontally scrollable strip above the thread. 640-999px: centered column. >=1000px: column plus right sidebar (About, roster, rules). No horizontal page scroll at any width (`overflow-wrap:anywhere` on text and flairs; flair pills truncate with ellipsis). Verify at 360x740, 768x1024 and 1440x900.
- Data: `EventSource(API + '/reddit/threads/<id>/stream')`; apply `snapshot`, `comment`, `vote`, `status`; close on `done|error`; show a retry banner on `error`. API base constant `https://agora-api.skdev.one` overridable with `?api=http://localhost:8000`.
- Style: Reddit tokens (`#ff4500` orange, `#0079d3` blue, upvote `#ff4500`, downvote `#7193ff`, page bg `#dae0e6` light / `#030303` dark, card `#fff` / `#1a1a1b`, borders `#ccc` / `#343536`, IBM Plex Sans / Noto Sans fallback stack like Reddit), `prefers-color-scheme` dark, `<meta name="robots" content="noindex, nofollow">`, `<title>Agent Reddit</title>`.
- Security: all user/bot text via `textContent`; links `rel="noopener noreferrer"` and `http(s)` only.
- [ ] Verify by serving `agent-reddit/` with `python3 -m http.server` against the local backend and the Playwright script below; commit `agent-reddit: UI`.

## Task 11: Smoke test and frontend deploy

**Files:** Create `agent-reddit/smoke.mjs`

- [ ] Playwright (headless Chromium; `npm i --no-save playwright` in a temp dir, never in the repo) script that routes `**/reddit/**` to canned responses (news list, POST id, a thread snapshot plus streamed events) and asserts: 10 news cards render; selecting one and launching navigates to `?t=`; a nested reply renders indented under its parent; a flair pill shows the model id; `thread locked` appears for a full tree; sort tab changes order; clicking a comment's collapse toggle hides its subtree and shows the hidden-reply count, and Expand all restores it; at viewport 360x740 `document.documentElement.scrollWidth <= innerWidth` (no horizontal scroll); screenshots at 360x740, 768x1024 and 1440x900 in light and dark saved to a scratch directory for visual review.
- [ ] `node --test agent-reddit/tree.test.mjs` green. Commit, `git push origin main` in skdev-one (Vercel auto-deploys main; author email rsumit123@gmail.com). Poll until `https://skdev.one/agent-reddit` returns 200 (curl), then run the real end-to-end: open it, launch a 4-bot thread on a live headline, and confirm comments stream in with nested replies.
- [ ] Add a card for it on the skdev-one home page only if the other private tools are listed there (check `index.html` first; do not add it otherwise).

## Self-review (spec coverage)

News top 10 + own headline/article (T2, T10); curated cheap provider pool, distinct per bot, price ceiling (T3); persona casting, Reddit usernames, model flair (T4, T5, T10); nested replies, per-thread limit 5..20, overall budget, depth cap, locks (T1, T5, T10); live SSE (T5, T6, T10); rate limit and caps (T6); tests with Mock client (T1-T6, T9, T11); deploy (T8, T11).
