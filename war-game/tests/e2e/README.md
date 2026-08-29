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
BREACH_DB=/tmp/breach-e2e.db \
BREACH_ORIGINS=http://localhost:8055,http://127.0.0.1:8055 \
OPENROUTER_API_KEY= \
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8050

# 2. serve this frontend
cd war-game && python3 -m http.server 8055 --bind 127.0.0.1

# 3. run the test (uses @playwright/test from any local install; browsers cached)
node tests/e2e/pvp.e2e.js
```

The frontend points at the local backend via the `?api=http://127.0.0.1:8050`
query override (see `PUBLIC_API` in `index.html`).
