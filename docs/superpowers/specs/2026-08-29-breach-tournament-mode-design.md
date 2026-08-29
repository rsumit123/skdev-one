# Breach Tournament Mode — Design

**Status:** design approved (visual direction + core decisions), ready for implementation planning
**Date:** 2026-08-29
**Builds on:** [2-player lockstep PvP](2026-08-29-breach-2player-lockstep-design.md) — Phases 1–5 shipped (rooms, lockstep, rematch, disconnect/forfeit, head-to-head leaderboard)

## Summary

Let 3–8 friends play a **single-elimination knockout** in one sitting. Each match is an ordinary 1v1 lockstep battle (the existing engine, unchanged). Matches are played **one at a time**; everyone not in the current match **watches it live**. The wrapper around those matches is a **broadcast-style experience** — a draw ceremony, a live bracket, an on-air spectator scoreboard, and a champion celebration — so three friends feel like they're playing a Cup, not a menu.

The concept mockup (four phone screens) is the approved visual target: Draw → Bracket → On Air → Champion.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Format | Bracket of 1v1 lockstep matches (reuses the whole PvP engine) |
| Size | Flexible **3–8** players, **single elimination**, byes fill non-powers-of-two |
| Pacing | **Sequential** — one match at a time |
| Spectating | **Watch live** — non-playing members run the same deterministic sim as watch-only clients |
| Seeding | **Random** draw |
| Host control | Host creates, **"Decide opponents"** draws the bracket, host **starts each match** |
| Quota | **No** daily-game cost (same as PvP) |
| Results | Each match → **head-to-head leaderboard** (Phase 5). Champion gets a **"Cups won"** tally |
| Disconnect | Existing 60s grace → **forfeit advances the bracket** (Phase 4) |

## Architecture

A tournament is a **superset of a PvP room**: it holds membership, a bracket, and a pointer to the current match; each match *is* a lockstep match reusing the existing turn protocol. Nothing in the deterministic sim changes.

### Server model — `app/tournament.py` (new), beside `app/pvp.py`

```
Tournament:
  code            # join code (reuses the 6-char scheme)
  members         # list[Member]: identity, sid, connected
  status          # lobby | drawn | active | ended
  bracket         # list[Round]; Round = list[Pairing]
  current         # (round_index, pairing_index) of the match in progress, or None
  match           # the live lockstep state for `current` (seed, sides, turns, log,
                  #   pending_release, paused, grace) — the SAME fields as a PvP Room today
  champion        # identity id, once decided
Pairing:
  a, b            # member id or None (bye) or a "winner-of(prev)" placeholder
  winner          # member id | None
  seed            # per-match seed (assigned when the match starts)
```

**Bracket draw** (`decide opponents`): shuffle members, build a single-elim tree sized to the next power of two ≥ N; empty slots become byes that auto-advance. Pure, unit-testable.

**Roles per match:** when a match starts, the two paired members are **players**; every other connected member is a **spectator**. The server accepts `turn:submit` only from the two players; it emits `turn:release` to the whole tournament room, so spectators receive the same decisions and render the same battle.

### Socket events (extend `app/sockets/events.py`)

- `tourney:create` / `tourney:join {code}` / `tourney:leave` — lobby membership (mirrors `room:*`).
- `tourney:draw` — host-only; runs the draw, sets status `drawn`, emits `tourney:update`.
- `tourney:update` — full bracket + status + current pointer, broadcast to all members (drives the bracket UI and standby).
- `tourney:start-match` — host-only; starts `current` (or the next unfinished pairing): assigns a seed, marks the two as players, emits `match:start` to each member with `{ role: "player"|"spectator", seed, yourSide?, players:{a,b} }`, arms the turn timer.
- Reuses **`turn:submit` / `turn:release`** unchanged for the live match.
- On match end (both `game:result` reports, or a forfeit): record the head-to-head result (Phase 5), set the pairing winner, advance the bracket (propagate winner into the next round; auto-resolve byes), emit `tourney:update`. If the final resolved, set `champion`, status `ended`, emit `tourney:champion`.
- **Reconnect:** `tourney:resume {code}` re-binds a dropped member (player or spectator) and replays current match state — extends the Phase 4 `room:resume` path.

### Spectating (no new sim code)

A spectator client runs `newGame(seed)` and applies each `turn:release` for both sides via the existing `decide('pvp')` await-only path — it never submits. Because the sim is deterministic, spectators see the identical battle. Their UI is the **On Air** screen: broadcast scoreboard (both base-HP bars, match clock, LIVE badge), the battle render, a "Spectating" ribbon, and the mini-bracket + "up next".

## Frontend (`war-game/index.html`)

New public screens/components, reusing the toast/reconnect/banner UX:

1. **Tournament entry** beside "Play a friend" on home.
2. **The Draw** — lobby: create/share code, member list, host's **"Decide opponents"** button; a brief draw animation seating players into the bracket.
3. **Live Bracket** — the tournament tree; current match glows with a LIVE badge, finished matches show a check; always reachable.
4. **On Air (spectator)** — the live match with the broadcast scoreboard overlay + mini-bracket; shown to everyone who isn't in the current match.
5. **Player match** — the existing PvP battle view, entered via a short "get ready" countdown when your match starts.
6. **Champion** — trophy lift, winner in gold, cups-won tally; then back to a final bracket.

State machine on the client: `lobby → drawn (bracket) → (per match: countdown→play OR spectate) → between-matches standby (bracket) → … → champion`. Driven entirely by `tourney:update` / `match:start` / `tourney:champion`.

## Reuse of shipped work

- **Lockstep match** (Phase 3): each match verbatim.
- **Disconnect/forfeit** (Phase 4): a player dropping mid-match forfeits after 60s grace; the survivor's win advances the bracket. A spectator dropping just rejoins and resumes watching.
- **Result recording** (Phase 5): every match writes to `pvp_results` / head-to-head. A new lightweight `cups_won` tally (per identity) powers the champion stat — a small addition, not a new subsystem.

## Error handling & edge cases

- **Member leaves in lobby:** removed; draw uses whoever's present at draw time.
- **Player leaves after the draw but before their match:** forfeits that match (opponent advances) — same as an in-match forfeit.
- **Host leaves:** promote the next member to host (they inherit "start match" / draw control), or end the tournament if empty.
- **Byes:** auto-advance with no match; surfaced in the bracket as "BYE".
- **Odd sizes (3,5,6,7):** byes fill the bracket to 4/8; verified by unit tests.
- **Double-report / races:** match results are idempotent per (tournament, round, pairing); bracket advance is guarded so a late duplicate can't double-advance.

## Testing

- **Backend unit tests** (`tests/test_tournament.py`): draw sizes 3–8 (bye placement), advance-on-win, forfeit-advances, champion detection, host promotion, idempotent advance.
- **Playwright E2E** (`war-game/tests/e2e/tournament.e2e.js`): 3–4 browser contexts through a full tournament — join → draw → play match 1 while the others **spectate the same battle** → advance → final → champion. Assert spectators stay in lockstep (state hash) and the bracket/leaderboard update.

## Build phases

1. **Backend model** — `tournament.py` (draw/advance/bye/forfeit, pure) + tests.
2. **Backend sockets** — `tourney:*` events + match wiring on top of the existing lockstep handlers + resume.
3. **Frontend lobby + draw + bracket** — screens 2–3, driven by `tourney:update`.
4. **Frontend match + spectator** — player countdown/play and the On Air spectator view.
5. **Champion + cups-won** — screen 6 + the tally.
6. **E2E + polish** — the multi-context Playwright run, plus the broadcast styling from the mockup.

## Non-goals (explicitly out)

- Simultaneous multi-army free-for-all (a fundamental sim rewrite) — parked.
- Parallel matches within a round — sequential only.
- Double elimination, seeding by rating, best-of-N series — future.
- Quick-match / matchmaking queue (PvP Phase 6) — separate, parked.
