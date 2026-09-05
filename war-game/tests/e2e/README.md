# Breach PvP E2E / unit tests

Verification for the 2-player (human vs human) lockstep feature.

## `pvp-exchange.unit.js` — headless, no servers
Extracts the `PVP` exchange object and `pvpStateHash()` from `index.html` and
drives them in a VM sandbox: multi-waiter release resolution, release-before-await,
per-turn isolation, and hash determinism/order-independence.

```sh
node tests/e2e/pvp-exchange.unit.js
```

## `pvp.e2e.js` — two real browsers vs a live backend
Boots two guest browser contexts and plays the full flow: create room → join by
code → host start → both go live (same seed, opposite sides) → both submit a
lockstep turn → both advance with no desync.

Prereqs (three terminals, or background the first two):

```sh
# 1. backend with sockets (breach-api, branch feature/breach-pvp)
#
# The three extra knobs are not optional if you want a clean run:
#   BREACH_GUEST_PER_HOUR - each browser context mints a guest, and the real
#                   ceiling is 20 per IP per hour held in memory. A single full
#                   suite run needs more than that, so without this every suite
#                   after the twentieth guest fails as an opaque waitForFunction
#                   timeout (the 429 is only visible in the browser console).
#                   (BREACH_RATE is the general API limiter and is NOT this one.)
#   BREACH_PVP_GRACE - pvp-phase4 waits 12s for a forfeit; the real 60s grace
#                   would time it out.
#   OPENROUTER_API_KEY - the Clash suites drive real model seats. Without a key
#                   they pause on "model provider error" and the orders deck
#                   goes pointer-events:none, so clicks silently time out.
BREACH_DB=/tmp/breach-e2e.db \
BREACH_ORIGINS=http://localhost:8055,http://127.0.0.1:8055 \
BREACH_GUEST_PER_HOUR=5000 BREACH_RATE=6000 BREACH_PVP_GRACE=3 \
OPENROUTER_API_KEY="$openrouter_api_key" \
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8050

# 2. serve this frontend
cd war-game && python3 -m http.server 8055 --bind 127.0.0.1

# 3. run the test (uses @playwright/test from any local install; browsers cached)
node tests/e2e/pvp.e2e.js
```

The frontend points at the local backend via the `?api=http://127.0.0.1:8050`
query override (see `PUBLIC_API` in `index.html`).

## `clash-friends.e2e.js` — the human-vs-human path, end to end

Two, three and four real browsers: room creation, joining by code, seat claiming,
the start, four-way lockstep, orders relaying between players, a match **played
to a real result through the deck** (no poking the simulator), and the end cards
both players actually see - mirrored verdicts, one winner, agreeing scoreboards.

It plays a full match, so it takes **4-6 minutes**. That is the point: nothing
about the result is faked. Run it before shipping anything that touches the
lobby, the lockstep relay, or the end card.

```sh
node tests/e2e/clash-friends.e2e.js
```
