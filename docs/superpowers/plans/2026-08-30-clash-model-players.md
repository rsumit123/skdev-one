# Clash Model Players Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Clash's scripted AI fillers with concurrently queried, validated model players while preserving deterministic lockstep simulation.

**Architecture:** The backend owns model assignments, snapshots room state at each decision window, fans out one OpenRouter request per AI seat with a shared deadline, and commits validated commands into the next lockstep frame. The frontend renders model assignments in the lobby and surfaces model failures; the simulator remains authoritative and never chooses AI actions.

**Tech Stack:** FastAPI, python-socketio, asyncio, existing OpenRouter client, SQLite migrations, vanilla HTML/JavaScript Clash client, Node test scripts.

**Spec:** `docs/superpowers/specs/2026-08-30-clash-model-players-design.md`

## Global Constraints

- Default model is Nova Lite.
- Model IDs come from an explicit server allowlist.
- AI calls for a decision window run concurrently under one shared deadline.
- Invalid, failed, or timed-out model decisions pause the room; no scripted fallback.
- Human and model commands use the existing Clash input schema and deterministic lockstep.
- CI and local tests use a fake provider; no live model calls.

---

### Task 1: Model catalogue and seat assignment

**Files:**
- Create: `app/clash_models.py`
- Modify: `app/clash.py`
- Modify: `app/sockets/events.py`
- Test: `tests/test_clash_models.py`

**Interfaces:**
- `allowed_models() -> list[dict]` returns IDs and display names.
- `validate_model_id(model_id: str) -> str` returns the normalized allowlisted ID or raises `ValueError`.
- `ClashRoom.model_assignments: dict[str, str]` stores one model per AI seat.
- `set_model(room, identity_id, slot, model_id) -> str | None` enforces host ownership and unoccupied-seat selection.
- `start_payload` and `lobby_payload` include `models`/`modelId` metadata.

- [ ] Write failing tests for default Nova Lite assignments, allowlist rejection, and host-only changes.
- [ ] Run `pytest tests/test_clash_models.py -q` and verify expected failures.
- [ ] Implement catalogue, room state, socket `clash:model`, and payload metadata.
- [ ] Run focused tests and existing Clash tests; verify all pass.
- [ ] Commit `feat: add Clash model seat assignments`.

### Task 2: Concurrent model decision service

**Files:**
- Create: `app/clash_agents.py`
- Modify: `app/openrouter.py`
- Modify: `app/sockets/events.py`
- Test: `tests/test_clash_agents.py`

**Interfaces:**
- `async decide_parallel(seats, snapshot, transport, deadline) -> dict[str, list[dict]]` uses `asyncio.gather` and one deadline.
- `sanitize_clash_decision(value, slot) -> list[dict]` accepts only `buy`, `eco`, and `stance` operations.
- `ModelDecisionError` identifies timeout, provider, and invalid-output failures.

- [ ] Write failing tests proving three requests overlap, share a deadline, and reject malformed commands.
- [ ] Run focused tests and verify they fail for missing service behavior.
- [ ] Implement bounded prompts, fake-transport injection, concurrent gather, and sanitization.
- [ ] Run focused tests and all backend tests.
- [ ] Commit `feat: add concurrent Clash model decisions`.

### Task 3: Server-authoritative Clash decision windows

**Files:**
- Modify: `app/clash.py`
- Modify: `app/sockets/events.py`
- Test: `tests/test_clash_model_flow.py`

**Interfaces:**
- Active Clash rooms expose a decision-window task that snapshots state and calls `decide_parallel` for AI seats.
- On success, model inputs join the next `flush_frame` payload with human inputs.
- On failure, room status becomes `paused_model_error` and emits `clash:model_error` with a safe code.
- `clash:model_retry` retries the current window; `clash:over` remains the explicit end path.

- [ ] Write failing tests for model commands entering a frame and failure pausing without conversion.
- [ ] Run focused tests and verify failure.
- [ ] Implement the decision-window scheduler and retry state without changing simulator math.
- [ ] Run focused and full backend tests.
- [ ] Commit `feat: run Clash model seats server-side`.

### Task 4: Lobby model selectors and failure UX

**Files:**
- Modify: `war-game/clash.html`
- Test: `war-game/tests/e2e/clash-model-lobby.unit.js`

**Interfaces:**
- Empty seats render a model selector defaulting to Nova Lite.
- Host selector changes emit `clash:model`; human seats replace the selector with the human name.
- Start/resume payloads render model display names in scoreboard and results.
- `clash:model_error` pauses controls and offers retry/end messaging.

- [ ] Write failing static tests for selectors, model event, and model-error handling.
- [ ] Run the unit script and verify expected failures.
- [ ] Implement responsive selector rows and event handlers using existing socket helpers.
- [ ] Run all Clash unit scripts and parse every inline script.
- [ ] Commit `feat: add Clash model lobby controls`.

### Task 5: Integration verification and deployment

**Files:**
- Modify: `war-game/tests/e2e/clash-model-lobby.unit.js` (only if integration assertions need tightening)
- Modify: `docs/superpowers/plans/2026-08-30-clash-model-players.md` (checklist updates)

- [ ] Run backend full suite and all provider-independent Clash tests.
- [ ] Run frontend Clash simulation/unit tests and public-app regression tests.
- [ ] Run syntax, duplicate-function, secret scans, and the required balance gate; record any pre-existing gate drift without changing the baseline for model-player work.
- [ ] Review the diff for accidental model-key exposure and deterministic fallback paths.
- [ ] Push frontend `main`; deploy backend through the documented `ssh-social` compose flow.
- [ ] Verify health, model catalogue, and a one-human/one-model smoke match before reporting completion.
