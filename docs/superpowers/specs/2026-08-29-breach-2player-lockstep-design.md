# Breach — 2-Player (Human vs Human) Design

Real-time PvP: two humans command opposing armies in one Breach battle. Built on
the game's **deterministic lockstep** foundation (proven 2026-08-28: sim math is
`abs/imul/min/max/round` only → cross-engine deterministic; 30 games / 58k ticks
bit-identical between independent instances; a 1-decision divergence is caught by
a state hash). Decisions and disconnect/turn discipline are ported from the
charade-chat quickmatch path (its 2-player, server-coordinated flow), which was
hardened over many bug-fix rounds.

## Locked decisions (owner, 2026-08-29)

1. **Sync = client-side deterministic lockstep.** The server is a **decision
   relay + turn gate**, NOT a game engine. It never runs the Breach sim. Both
   browsers run the identical deterministic sim and exchange only the two tiny
   decisions per 4-second turn.
2. **Transport = Socket.IO** (`python-socketio` on breach-api, `socket.io-client`
   on the frontend), same as charade. Single uvicorn worker (breach-api already
   runs one), all room state in-process, DB-mirrored for crash recovery. Gives
   real-time disconnect detection (~20s with tuned ping) for free.
3. **Matchmaking = phased.** Phase 1: **join by 6-char code** (invite a friend,
   works with zero player base). Phase 2: **quick-match queue** (random pairing)
   once there is traffic.
4. **Turn timeout (connected-but-idle) = auto-play a default after ~30s** — a
   safe `{queue:[], stance:current}` (hold, no build) so the game never stalls on
   an AFK-but-connected player. A real disconnect is a *separate* path (pause +
   grace, below).

## Why Breach is simpler than charade here

Charade is fully **server-authoritative** (server owns all game state). Breach is
not: the sim is deterministic, so:
- The server stores only the **decision log** (a list of `{turn, side, queue,
  stance}`), never the sim state.
- **Reconnect = replay, not snapshot.** A returning client fetches the decision
  log and replays it deterministically to catch up (instant — a full game is
  milliseconds headless). Charade had to hand-build per-game state snapshots; we
  get resync for free from determinism.

## Protocol

**Room** (in-process `ROOMS: dict[code, RoomState]`, mirrored to a DB row):
- `room:create` → 6-char `A-Z0-9` code (DB-unique), creator is **host**, 2 seats.
- `room:join {code}` → second player joins. Quickmatch rooms (Phase 2) are hidden
  from code-join (charade pattern: `origin=="quickmatch" → NOT_FOUND`).
- Host assigns sides (Vulcan/Cobalt) and the server picks the `seed`.
- `game:start {seed, yourSide, opponent}` emitted to both → both call
  `newGame(seed)`; the model-decision path is replaced by the socket exchange.

**Each 4-second turn** (monotonic index `T`, the only ordinal — no global seq #s):
- Each client, on its decision tick, emits `turn:submit {T, queue, stance,
  stateHash}` (the picker's output; `stateHash` from the proven hash fn).
- Server, **under the per-room `asyncio.Lock`**, records the submission. Reject a
  second submit for the same `(T, side)` with `ALREADY_SUBMITTED`. When **both**
  sides for `T` are in, emit `turn:release {T, decisions:[d0,d1],
  hashes:[h0,h1]}` to both.
- Both clients apply BOTH decisions deterministically, step to the next tick, and
  compare their own tick hash to the peer's relayed hash. Mismatch → desync path.
- **Timeout**: if a side's submit for `T` is not received within 30s of the turn
  opening, the server auto-submits `{queue:[], stance:current}` for that side,
  records, and releases. (The client-side `AWAIT` freeze already waits, exactly
  like it waits for a slow model today.)

## Disconnect / reconnect (ported from charade quickmatch)

- Socket.IO `ping_interval=10, ping_timeout=10` → hard drop detected in ~20s.
- On `disconnect`: mark the player disconnected, **cancel the turn-timeout task**,
  broadcast `game:paused` + `game:reconnect_grace {expires_at}` (60s), schedule
  `_remove_after_grace()` (an `asyncio.sleep(60)` task, cancelled on reconnect).
- Client re-emits `room:register` on **every** `connect` (`.on`, not `.once`).
- Reconnect within grace → server re-enters the SID, sends `game:resync {seed,
  yourSide, decisionLog}` to **that socket only**; client `newGame(seed)` +
  replays the log to catch up, then `game:resumed` with a **fresh** turn timer.
- Grace expiry → forfeit-to-survivor; survivor's client finalizes the win locally
  and reports the result (below).

## Desync safety net

`turn:release` carries both sides' submitted hashes. If a client's local
tick-boundary hash ≠ the peer's relayed hash → halt with "connection desynced"
and offer resync-by-replay. Rare (determinism is proven), but the hash is proven
to catch any drift, so we fail loud instead of showing two different battles.

## Result recording

On game over, **exactly one** client reports the completion (deterministic
choice: the **host** side) via the existing completion path (a PvP variant of
`/v1/games/{id}/complete`, both commanders `kind:"human"`). Server dedupes
idempotently; the other client does not submit. **Open sub-decision for Phase 5**:
human-vs-human matches don't satisfy the current `PUBLIC_BATTLE_SQL` join (which
requires one `llm` side), so PvP results need either a separate history/leaderboard
projection or an exclusion — decide when we get there.

## Non-negotiable discipline (charade's scars)

- **Socket**: `off()` before `on()`; `on('connect')` re-register (never `.once`);
  never set your own identity from a room-wide broadcast — only from your own
  create/join/register response.
- **One `asyncio.Lock` per room** around every record-then-check block.
- **Server timestamps** (`turn_opened_ts + 30`) drive the countdown; never trust
  client clocks.
- **Pop/clear room state BEFORE emitting the terminal `game:end`** (avoids a
  reconnect finding stale state mid-emit).
- **Never cancel the turn-timer task from code running inside that same task**
  (raises `CancelledError`, aborts the DB write).
- **Single worker only.** All room/SID/grace/timer state is process-local; no
  Redis adapter. `>1` worker would split rooms — matches the current deploy.

## Resolved sub-decisions (owner, 2026-08-29)

- **Quota**: a PvP game does NOT count against the daily allowance (it spends no
  OpenRouter credits). No allowance check on the PvP path.
- **Side assignment**: RANDOM — the server coin-flips Vulcan/Cobalt at game start.
- **Error UX**: transient toast/alert system + a persistent reconnect banner,
  mirroring charade's Toast/GameAlerts UX (built fresh in vanilla JS for the
  single-file frontend).

## Build phases

1. **Backend Socket.IO scaffold** — mount `python-socketio` on breach-api,
   JWT/guest auth per event, `room:create`/`room:join` by code, in-process room
   registry + DB mirror + crash-restore. Tests.
2. **Lockstep turn protocol** — `turn:submit`/`turn:release`, per-room lock, turn
   index, 30s timeout auto-play, desync hash relay. Tests.
3. **Frontend** — socket singleton (off/on discipline, re-register on connect),
   lobby UI (create/join by code, side assignment), swap the model-decision path
   for the socket submit/release exchange in the human seat.
4. **Disconnect/reconnect** — pause + 60s grace + replay resync + forfeit. E2E.
5. **Result recording** — PvP completion + history/leaderboard handling.
6. **Quick-match queue** (Phase 2 matchmaking) — later, once there's traffic.
   Note charade hit several matchmaker races (cancel-then-join, double-tap,
   fallback); reuse its `matched=True` poison-entry invariant.
</content>
