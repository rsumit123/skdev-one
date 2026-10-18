# Agent Reddit v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. TDD for every task. Spec: `docs/superpowers/specs/2026-10-18-agent-reddit-v2-design.md` (the API contract there is binding for both sides).

**Goal:** front page of real threads, Reddit composer with post types (news, ask, opinion, poll, ama) written by the human or a bot OP, human comments/votes, AutoMod, edits/deletions/awards, bursty arrivals.

**Repos and rules:** backend `~/work/agora/backend` (`app/reddit/`, `pytest -q`, 371 tests at start), frontend `~/work/skdev-one/agent-reddit/` (`node --test agent-reddit/tree.test.mjs`, `PW_DIR=/tmp/ar-pw node agent-reddit/smoke.mjs`; reinstall Playwright in /tmp/ar-pw if missing). Commit straight to main as rsumit123@gmail.com, no Claude/co-author/session lines, no push. No network in tests; never print the OpenRouter key.

Backend tasks run in order (they share models/engine); frontend tasks run in parallel with them against the contract.

## Backend

**B1 Data model, create API, bot OP writer, front page, surprise.**
Files: `app/reddit/models.py`, `store.py` (additive columns + ALTER TABLE migrations; new tables `reddit_votes(thread_id, target, voter_hash, dir, PRIMARY KEY(thread_id,target,voter_hash))` and poll storage in thread JSON), new `app/reddit/posts.py` (validation per type/author, bot OP writer prompt + JSON parse + deterministic fallback, AutoMod sticky text per type), `api.py` (extended POST /reddit/threads incl. legacy body, POST /reddit/surprise, GET /reddit/threads with sort/paging/ThreadCard, Thread JSON fields), `engine.py` only as needed to run casting with OP/host flags and to call the OP writer before the first comment. Tests for every contract field, legacy payload, validation errors, hot ranking math, paging, surprise fallback, migration of an old db file.

**B2 Engine per-type behaviour.**
Per-type kind modulation; poll first-comment votes recorded and `post` events; AMA host priority and question top-levels; OP defence priority and OP badge; staggered arrival; bursty pace function (injectable); bots vote on the post when joining. Tests with MockLLMClient and pace 0.

**B3 Humans, AutoMod, texture.**
POST comments (limits, locked/removed 423, revive bounded), POST vote (ledger, replace/remove, per hashed IP, post and comment), human comments as priority targets and prompt-safe quoting, AutoMod remove/lock heuristics (word list in its own module), edits/deletions/awards with bounds, SSE events edit/delete/remove/award/lock/post. Tests for each.

**B4 Live verification and deploy.** One live thread per post type (small: 4 bots, 12 comments) plus one human comment + vote via curl, judge quality, tune prompts, then push and deploy (rsync + docker compose up -d --build --force-recreate), verify on production.

## Frontend

**F1 Front page + composer.** Router (`?t=` thread, `?new=1[&type=]` composer, else front page). Front page per spec (Create-post bar, Surprise me, Hot/New/Top, infinite-scroll ThreadCards with clickable votes, LIVE badges, poll mini-bars). Composer per spec (type tabs, who-writes toggle, per-type forms, paper/live/paste source for news reusing the existing paged feed code, crowd/length chips, Advanced, handle). Mock API in smoke tests. Keep the existing thread view working.

**F2 Thread interactions.** Comment box + inline replies (handle, optimistic insert reconciled with the SSE `comment`), votes on post and comments (localStorage state, server score), HUMAN flair, OP/HOST badges, AutoMod sticky styling, edited/deleted/removed/awards/lock rendering and SSE handlers, poll results bar, article block. Smoke checks per behaviour, mobile + desktop, light + dark, no horizontal scroll.

**F3 Production check.** After B4 deploy: push frontend, Playwright run against production creating one post of each type (small crowds), posting a human comment and a vote, screenshots reviewed.
