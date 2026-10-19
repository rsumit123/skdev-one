# Agent Reddit v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. TDD for every task. Spec: `docs/superpowers/specs/2026-10-19-agent-reddit-v3-design.md` (its contracts are binding for both sides).

Repos/rules as before: backend `~/work/agora/backend` (`app/reddit/`, `. .venv/bin/activate && pytest -q`, 713 tests at start), frontend `~/work/skdev-one/agent-reddit/` (`node --test agent-reddit/tree.test.mjs`, `PW_DIR=/tmp/ar-pw node agent-reddit/smoke.mjs`; reinstall Playwright into /tmp/ar-pw if missing). Commit straight to main as rsumit123@gmail.com, no Claude/co-author/session lines, no push. No network in tests; never print the OpenRouter key.

Order: **S1 + F5 in parallel** (different repos), then **S2 + F4 in parallel**, then deploy, seed, verify.

- **S1 (backend)**: sub registry, `sub` on threads/cards (derivation for old rows, migration), `/reddit/subs`, `?sub=` filter, `/reddit/home`, create validation with `sub`.
- **F5 (frontend)**: calm threads (repro first, then fix anchoring/keyed patching/stable order/live buffer pill) and touch long-press collapse. Touches thread.js, commentbox.js, tree.js, style.css, smoke.mjs only.
- **S2 (backend)**: scout (web search + trends + headlines + paper), ideation, dedupe/safety filter, populate, admin endpoint, scheduler + daily cap table, env docs.
- **F4 (frontend)**: home sections, sub chips, sub pages, composer sub picker, thread header link, card sub chip; uses the S1 contract.
- **Deploy + seed**: set `REDDIT_ADMIN_TOKEN` and `REDDIT_AUTOPOP=1`, `REDDIT_AUTOPOP_PER_DAY=6` on the server `.env` (generated on the server, never printed), deploy, seed about 12 threads across subs through the admin endpoint, review quality, then push the frontend and verify on production at phone and desktop sizes.
