# Clash Completion Design

## Goal

Finish Clash Arena as a four-seat human/AI mode with real identities, per-fort economy upgrades, reconnect/resume, and durable results.

## Decisions

- Each seat owns its own fort economy. Eco upgrades are not shared with teammates.
- Empty and disconnected seats remain deterministic scripted AI; server-run LLM seats are out of scope for this increment.
- Slot IDs (`A1`, `B1`, etc.) remain internal/debug identifiers and may appear as secondary labels, never as the primary player name.
- Clash results use a Clash-specific history/ranking projection and do not alter 1v1 or tournament standings.

## Architecture

The existing deterministic `BreachSim(seed, humanSlots)` remains authoritative on every client. Socket.IO remains a metronome and replay log; the backend authenticates identities, reattaches reconnecting seats, persists one idempotent result per room generation, and serves Clash history/rankings. The standalone `clash.html` consumes the same identity/session conventions as PvP and uses the existing fixed-point economy semantics scaled to its integer units.

## Acceptance criteria

- Four human names, guest handles, and AI labels render consistently in lobby, scoreboard, tower messaging, and end state.
- Eco purchase is visible, affordable only for the owning fort, deterministic, replayed, hashed, and tested at all price/maximum boundaries.
- A reconnecting player resumes the original seat and state; only a grace-window expiry converts that seat to AI.
- Completion is recorded once with all four seats, winner/reason, seed, generation, and timestamps; duplicate reports are harmless.
- Existing PvP and tournament behavior remains green; Clash browser tests cover 1–4 humans, names, eco, reconnect, and results.
