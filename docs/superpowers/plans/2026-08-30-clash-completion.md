# Clash Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Complete Clash Arena identity rendering, per-fort eco upgrades, reconnect/resume, and durable results without changing the deterministic simulator contract used by other modes.

**Architecture:** Extend the existing Clash relay and standalone client using the proven PvP `room:resume` and `game:result` patterns. Keep client simulation deterministic; the backend owns authentication, replay frames, result idempotency, and Clash-specific projections.

**Tech Stack:** Self-contained HTML/JavaScript, Python stdlib/FastAPI backend, Socket.IO, SQLite, Node stdlib tests, pytest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-30-clash-completion-design.md`

## Global Constraints

- Preserve the existing v8 simulator and all 1v1/tournament behavior.
- Eco upgrades are per fort, with the main game’s 36/63/90 progression scaled into Clash fixed-point currency.
- Slot IDs are secondary labels only; primary labels come from server identities or `AI Commander`.
- Results are Clash-specific and idempotent; no quota or benchmark contamination.
- Every `clash.html` change runs syntax/secret scans and the Clash/browser test matrix.

---

### Task 1: Clash backend identity, eco input, and room contract

**Files:**
- Modify: `/Users/rsumit123/work/breach-api/app/clash.py`
- Modify: `/Users/rsumit123/work/breach-api/app/sockets/events.py`
- Test: `/Users/rsumit123/work/breach-api/tests/test_clash.py`

**Interfaces:**
- Consumes: `Identity`, existing `ClashRoom`, `record_input`, `start_payload`.
- Produces: canonical slot metadata, `eco` input validation, replay-safe per-fort eco state contract.

- [ ] Add failing tests for canonical `{slot,name,kind}`, valid/invalid eco inputs, max-level rejection, and replay payload preservation.
- [ ] Implement `VALID_ECO`, canonical slot metadata, and sanitized input buffering with the same per-slot ownership rules as unit buys.
- [ ] Run `python3 -m pytest -q tests/test_clash.py` and the focused socket tests.
- [ ] Commit with `feat: add clash identity and eco relay contract`.

### Task 2: Clash persistence, reconnect, and results

**Files:**
- Create/modify: `/Users/rsumit123/work/breach-api/app/clash_results.py`
- Modify: `/Users/rsumit123/work/breach-api/app/sockets/events.py`
- Modify: `/Users/rsumit123/work/breach-api/app/migrations.py`
- Test: `/Users/rsumit123/work/breach-api/tests/test_clash_results.py`

**Interfaces:**
- Consumes: `ClashRoom`, `resume_payload`, identity/session helpers, existing `pvp_results` idempotency pattern.
- Produces: `clash:resume`, `clash:result`, idempotent persistence and Clash history/ranking query helpers.

- [ ] Add failing tests for reconnect rebind/replay, grace-window conversion, duplicate result reports, and all-four-seat persistence.
- [ ] Implement authenticated resume by room code/identity, replay log delivery, and explicit grace timer before AI conversion.
- [ ] Add SQLite schema/migration and result projection APIs; ensure room cleanup does not delete persisted results.
- [ ] Run Clash backend tests plus the complete pytest suite.
- [ ] Commit with `feat: persist clash results and resume rooms`.

### Task 3: Clash client identity and per-fort economy UI/sim

**Files:**
- Modify: `/Users/rsumit123/work/skdev-one/war-game/clash.html`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/tests/e2e/clash-hud.e2e.js`
- Create/modify: `/Users/rsumit123/work/skdev-one/war-game/tests/e2e/clash-eco.e2e.js`

**Interfaces:**
- Consumes: canonical start/lobby payload, `eco` relay input, deterministic Clash sim state.
- Produces: name-bound scoreboard/tower copy, eco level/cost controls, synchronized per-fort upgrades.

- [ ] Add failing browser/unit checks for no primary `A1/A2/B1/B2` names after start, dynamic tower copy, eco price progression, max-level lock, and teammate isolation.
- [ ] Add per-fort `eco`/income state to the deterministic sim, fixed-point prices 3600/6300/9000, hash/replay coverage, and a clearly labeled upgrade control.
- [ ] Bind all visible labels through one slot metadata map; retain seat IDs only as secondary accessibility/debug text.
- [ ] Run mandatory HTML syntax/duplicate/secret scan, Clash e2e at landscape and portrait sizes, and simulator integrity checks.
- [ ] Commit with `feat: add clash names and per-fort economy`.

### Task 4: Client reconnect/resume and results surfaces

**Files:**
- Modify: `/Users/rsumit123/work/skdev-one/war-game/clash.html`
- Modify: `/Users/rsumit123/work/skdev-one/war-game/index.html` (only if adding a Clash history entry point)
- Test: `/Users/rsumit123/work/skdev-one/war-game/tests/e2e/clash-reconnect.e2e.js`

**Interfaces:**
- Consumes: `clash:resume`, `clash:result`, Clash history/ranking APIs.
- Produces: reconnect banner/resync flow, deterministic replay rebuild, result submission, Clash history/ranking view.

- [ ] Add failing tests for reconnect within grace, expired grace→AI, one result despite duplicate reports, and history display.
- [ ] Implement Socket.IO reconnect callback that authenticates and resumes the prior room/seat; do not silently create a new guest during an active room.
- [ ] Submit one canonical result and render winner/loser names from server metadata; keep result failures non-destructive and retryable.
- [ ] Run all Clash e2e tests plus existing PvP/tournament suites.
- [ ] Commit with `feat: resume and record clash battles`.

### Task 5: Integration, adversarial review, and deployment

**Files:**
- Modify: `war-game/DEVELOPMENT.md`, `war-game/HANDOFF_PROMPT.md`
- Test: all existing Clash/PvP/tournament tests and backend suite.

- [ ] Cherry-pick Tasks 1–4 into isolated integration branches, resolve only the documented `serverAgent`/socket seams, and inspect the combined diff.
- [ ] Run backend full pytest, frontend syntax/secret scans, Clash 1–4-human browser matrix, reconnect/eco/results tests, PvP and tournament suites, and `node war-game/bench.js gate`.
- [ ] Run an independent review focused on identity spoofing, cross-seat eco mutation, replay determinism, reconnect races, result idempotency, and room cleanup.
- [ ] Commit documentation and integration changes, push only validated branches to `main`, then perform the host predeploy gate and live smoke checks.
