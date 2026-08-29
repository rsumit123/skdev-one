# Breach Tournament Mode — Implementation Plan

> **For agentic workers:** implement task-by-task; steps use `- [ ]` checkboxes. Each phase deploys + tests like the PvP phases did (backend: rsync + `docker compose up -d --build` on `ssh-social`; frontend: push to `main` → Vercel; verify with Playwright against local + live).

**Goal:** A 3–8 player single-elimination knockout of 1v1 lockstep matches, played one at a time with everyone else spectating live, wrapped in a broadcast-style UI.

**Architecture:** A `Tournament` is a superset of a PvP room — membership + a single-elim bracket + a pointer to the current match, whose live state reuses the existing lockstep turn protocol verbatim. Spectators are watch-only lockstep clients. Nothing in the deterministic sim changes.

**Tech Stack:** FastAPI + python-socketio (backend, single worker, in-process), SQLite, single-file `war-game/index.html` (frontend), Playwright (E2E).

**Spec:** `docs/superpowers/specs/2026-08-29-breach-tournament-mode-design.md`

---

## Phase 1 — Backend bracket model (`app/tournament.py`, pure)

**Files:** Create `app/tournament.py`, `tests/test_tournament.py`.

The pure, deterministic core: draw a single-elim bracket for N=3..8 (byes to the next power of two), advance a winner, resolve byes, detect the champion. No sockets, no DB.

Data shapes:
```python
@dataclass
class Slot:            # one competitor position in a pairing
    member_id: str | None = None      # None = empty (a future winner) 
    bye: bool = False
@dataclass
class Pairing:
    a: Slot; b: Slot
    winner_id: str | None = None
    seed: int | None = None
@dataclass
class Bracket:
    rounds: list[list[Pairing]]       # rounds[0] = first round, last = final
```

Functions (all pure):
- `draw(member_ids: list[str], *, shuffle=secrets-based) -> Bracket` — size to next pow2 ≥ N; seed real players into round-0 slots; leftover slots are byes; pre-resolve first-round byes (a bye pairing's non-bye competitor is the winner) and propagate into round 1; build empty later rounds.
- `advance(bracket, round_idx, pairing_idx, winner_id) -> None` — set winner, write it into the correct slot of the next round's pairing; if that pairing now has two decided competitors *and* is a bye, auto-resolve.
- `next_match(bracket) -> tuple[int,int] | None` — first pairing (round order) with both competitors known and no winner.
- `champion(bracket) -> str | None` — winner of the final, once set.
- `standings(bracket)` — helper for the UI (optional).

Tasks (TDD): tests for draw sizes 3/4/5/6/7/8 (count real players, bye placement, next-pow2), advance-propagation, bye auto-resolve, `next_match` ordering, champion detection, idempotent advance (re-advancing the same pairing is a no-op / guarded). Commit per green test group.

## Phase 2 — Backend tournament room + sockets (`app/tournament_room.py` + `events.py`)

**Files:** Create `app/tournament_room.py` (in-process registry mirroring `pvp.py`), modify `app/sockets/events.py`.

- `TournamentRoom` dataclass: code, members (identity/sid/connected), status (`lobby|drawn|active|ended`), `bracket`, `current` pointer, and an embedded **match** reusing the PvP lockstep fields (seed, sides, turns, log, pending_release, paused, grace) — factor the PvP match state into a small shared struct if clean, else duplicate the fields.
- Registry + join-by-code (reuse the 6-char code scheme + ticket auth already built).
- Socket events: `tourney:create` / `tourney:join` / `tourney:leave` / `tourney:draw` (host-only) / `tourney:start-match` (host-only) / `tourney:resume`. Broadcast `tourney:update` (bracket+status+current) after every state change.
- `tourney:start-match`: assign per-match seed, mark the two paired members players, emit `match:start {role, seed, yourSide?, players}` to each member, arm the turn timer.
- Reuse `turn:submit`/`turn:release` for the live match — accept submits only from the two players; emit releases to the whole tournament room (so spectators get them).
- On match end (both `game:result` or forfeit): record head-to-head (Phase 5), `advance()` the bracket, emit `tourney:update`; on final resolve set champion + emit `tourney:champion`.
- Host-leaves → promote next member; empty → end.
- Tests: `tests/test_tournament_room.py` with the FakeSio harness (create/join/draw/start/submit-release/advance/champion; forfeit-advances; host promotion; resume).

## Phase 3 — Frontend lobby + draw + bracket

**Files:** Modify `war-game/index.html`.

- Home entry "Tournament" beside "Play a friend".
- Screens: **Draw** (create/share code, member list, host "Decide opponents"), **Bracket** (the tree; current match LIVE, finished checked) — build the DOM from `tourney:update`.
- Socket client extension: `TOURNEY` object mirroring `PVP` (lazy socket, ticket auth, event handlers `tourney:update`/`match:start`/`tourney:champion`).
- Broadcast styling from the approved mockup (`scratchpad/tournament-concept.html`): crest, pill list, bracket cards, LIVE badge.

## Phase 4 — Frontend match + spectator (On Air)

**Files:** Modify `war-game/index.html`.

- `match:start` with `role:"player"` → short "get ready" countdown → enter the existing PvP battle (reuse `decide('pvp')`, `onPvpGameStart`-style setup).
- `role:"spectator"` → **On Air** screen: run `newGame(seed)`, apply each `turn:release` for BOTH sides (watch-only, never submit), render the battle with the broadcast scoreboard overlay (base-HP bars, clock, LIVE), spectating ribbon, mini-bracket + up-next.
- Between matches → standby (bracket view) until host starts the next.
- Reuse Phase 4 disconnect/reconnect for both roles.

## Phase 5 — Champion + cups-won

**Files:** Modify `war-game/index.html`; backend: a `cups_won` tally (new tiny table or a column keyed by identity) + increment on champion; optional endpoint / include in head-to-head.

- Champion screen: trophy lift, winner gold, cups-won + run record; back to final bracket.

## Phase 6 — E2E + polish

**Files:** Create `war-game/tests/e2e/tournament.e2e.js`.

- 3–4 browser contexts: join → draw → play match 1 while others **spectate the same battle** (assert spectator state hash matches the players') → advance → final → champion. Assert bracket + head-to-head update.
- Polish the broadcast styling to match the mockup; verify live.

---

## Self-review notes
- Spec coverage: all spec sections map to a phase (model→P1, sockets→P2, lobby/bracket→P3, match/spectator→P4, champion→P5, tests→P6, reuse of Phases 4–5 threaded through P2/P4/P5).
- Determinism risk: spectator must apply releases at the exact same sim points as players — reuse the identical `decide('pvp')` await path so the step cadence is identical; E2E asserts equal state hashes.
- Scope: large but decomposed; each phase is independently deployable/testable.
