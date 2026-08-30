# Clash Model Players Design

## Goal

Replace Clash's deterministic AI filler with real model-controlled seats while preserving the deterministic lockstep simulator as the authoritative referee.

## Lobby and identity

- Seats remain assigned in `A1, B1, A2, B2` order as humans join.
- Each unoccupied seat has a selectable model assignment, defaulting to `Nova Lite`.
- A human joining a seat replaces that model seat; the scoreboard displays the human identity.
- The host owns model-selection changes. The server validates model IDs against an allowlist and includes the selected model in start and resume payloads.

## Decision pipeline

At each Clash decision window, the server snapshots the authoritative state and launches one OpenRouter request per model seat concurrently. All requests share a deadline. Responses are parsed and sanitized into the existing Clash input schema (`buy`, `eco`, `stance`). Validated commands are committed as one lockstep frame. Human commands remain socket inputs in the same frame.

There is no deterministic-AI fallback. If a model times out, errors, or produces an invalid decision after bounded repair, the room pauses and emits a user-visible model failure; the host may retry or end the match.

## Cost and safety limits

- Default model: Nova Lite.
- Model allowlist is explicit; no arbitrary provider IDs from clients.
- Per-room concurrent request count is capped at the number of model seats (maximum four).
- One shared request deadline and bounded prompt/output sizes apply to every window.
- Existing OpenRouter health/failure handling is reused where possible.

## Testing

- Pure tests verify model-seat assignment, allowlist enforcement, parallel fan-out, shared-deadline behavior, response sanitization, and no-fallback pause behavior.
- Existing Clash lockstep, eco, reconnect, result, PvP, tournament, and public-app suites remain green.
- A provider-independent fake transport is used in tests; no live model calls are made by CI.
