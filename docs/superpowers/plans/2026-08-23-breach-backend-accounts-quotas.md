# Breach Backend Accounts and Quotas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a FastAPI backend that authenticates guests and registered players, enforces IST daily games, chooses tiered opponents, proxies bounded Breach decisions, stores owned matches, and serves clean public leaderboards.

**Architecture:** Replace the single stdlib HTTP handler with focused FastAPI modules while continuing to use raw `sqlite3` and the existing database volume. Land compatibility reads first, then additive migrations, identity, atomic quota/session creation, constrained OpenRouter calls, owned completion, public aggregation, and admin-only benchmark routes. The browser remains the deterministic simulator; the backend owns identity, prompt text, bounded model conversations, provider credentials, routing, and persistence.

**Tech Stack:** Python 3.12, FastAPI, Uvicorn, SQLite (`sqlite3`), Argon2id (`argon2-cffi`), HTTPX, Pydantic, pytest, Docker Compose

**Spec:** `/Users/rsumit123/work/skdev-one/docs/superpowers/specs/2026-08-23-breach-accounts-quotas-design.md`

## Global Constraints

- Guest allowance is exactly 3 games per `Asia/Kolkata` calendar day and permits only Easy and Medium.
- Registered free allowance is exactly 10 games per `Asia/Kolkata` calendar day and permits Easy, Medium, and Hard.
- A game is consumed atomically when the model-backed session starts; abandonment remains consumed.
- A total tier failure before the first playable decision refunds exactly once; underway failures use the existing fallback and do not refund.
- The initial roster is Easy: `amazon/nova-lite-v1`, `amazon/nova-2-lite-v1`, `microsoft/phi-4`; Medium: `google/gemini-3.5-flash-lite`, `qwen/qwen3.7-flash`; Hard: `google/gemini-3.7-flash`.
- Registered passwords use Argon2id; registered sessions use opaque random Secure, HttpOnly, SameSite cookies.
- Guest and registered identity, quota, history, and dossier namespaces never merge.
- The OpenRouter key exists only in backend environment configuration and never appears in an API response.
- Preserve prompt v8, the ten-turn memory window, 30-second whole-response timeout, 400 reasoning-token cap, 6000 overall-token cap, sanitation/fallback semantics, and 429 strike behavior.
- Preserve the current public `GET /v1/health`, `GET /v1/matches`, `GET /v1/matches/{id}`, and `GET /v1/standings` contracts until the frontend migration is live.
- New public identity/game/leaderboard APIs never return private email, raw provider errors, prompt text, tokens, latency diagnostics, or administrator controls; legacy diagnostic reads remain only for the compatibility window and become admin-only at frontend cutover.
- Use raw SQLite rather than adding SQLAlchemy; the small VM and existing database volume remain operational constraints.
- Every database schema change is additive and tested against a copy of the existing `matches` schema.

## File structure

Create a focused application package in `/Users/rsumit123/work/breach-api`:

- `app/main.py` — FastAPI construction, middleware, router registration, startup migration
- `app/config.py` — immutable environment-backed settings and model roster
- `app/db.py` — SQLite connection/transaction helpers
- `app/migrations.py` — idempotent additive schema migration
- `app/schemas.py` — all request/response Pydantic models
- `app/security.py` — Argon2id, opaque tokens, cookie and CSRF/origin helpers
- `app/identity.py` — guest and registered identity repository/service
- `app/quota.py` — IST usage-date/reset calculations and atomic reservations/refunds
- `app/routing.py` — tier roster, rotation, health cooldown, selection
- `app/openrouter.py` — bounded provider transport and private usage diagnostics
- `app/prompt_v8.py` — exact server-owned v8 system/debrief/dossier prompts
- `app/games.py` — session start, turn validation, conversation memory, completion
- `app/leaderboards.py` — public/player/model/recent projections
- `app/routes_auth.py`, `app/routes_games.py`, `app/routes_public.py`, `app/routes_admin.py` — HTTP boundaries
- `app/legacy.py` — compatible match extraction and legacy read/write projections during migration
- `scripts/assign_owner_matches.py` — idempotent owner-role and historical match assignment
- `tests/` — isolated temporary-SQLite unit and API tests
- `requirements.txt`, `requirements-dev.txt` — runtime and test dependencies

`app.py` remains a short compatibility launcher importing `app.main:app` until deployment scripts and documentation have moved to Uvicorn.

---

### Task 1: FastAPI shell with legacy read compatibility

**Files:**
- Create: `/Users/rsumit123/work/breach-api/app/__init__.py`
- Create: `/Users/rsumit123/work/breach-api/app/config.py`
- Create: `/Users/rsumit123/work/breach-api/app/db.py`
- Create: `/Users/rsumit123/work/breach-api/app/legacy.py`
- Create: `/Users/rsumit123/work/breach-api/app/main.py`
- Create: `/Users/rsumit123/work/breach-api/tests/conftest.py`
- Create: `/Users/rsumit123/work/breach-api/tests/test_legacy_api.py`
- Create: `/Users/rsumit123/work/breach-api/requirements.txt`
- Create: `/Users/rsumit123/work/breach-api/requirements-dev.txt`
- Modify: `/Users/rsumit123/work/breach-api/app.py`

**Interfaces:**
- Consumes: existing `matches` table and `extract()`/`standings()` behavior from `app.py`
- Produces: `create_app(settings: Settings) -> FastAPI`, `connect(settings: Settings) -> sqlite3.Connection`, and compatible legacy routes

- [ ] **Step 1: Declare the minimal runtime and test dependencies**

```text
# requirements.txt
fastapi==0.115.2
uvicorn==0.31.1
argon2-cffi==25.1.0
httpx==0.27.2

# requirements-dev.txt
-r requirements.txt
pytest==8.3.3
pytest-asyncio==0.24.0
```

- [ ] **Step 2: Write failing compatibility tests**

```python
def test_health_reports_existing_match_count(client, seeded_match):
    response = client.get("/v1/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "matches": 1}

def test_legacy_matches_excludes_payload(client, seeded_match):
    row = client.get("/v1/matches?limit=10").json()["matches"][0]
    assert row["id"] == seeded_match
    assert "payload" not in row

def test_legacy_standings_keeps_seat_splits(client, seeded_match):
    body = client.get("/v1/standings").json()
    assert body["matches"] == 1
    assert body["standings"][0]["vulcan"] == [1, 0]
```

- [ ] **Step 3: Run tests and verify the FastAPI app does not exist yet**

Run: `python -m pytest tests/test_legacy_api.py -q`

Expected: FAIL importing `app.main.create_app`.

- [ ] **Step 4: Implement settings, SQLite connection, copied legacy projections, and app construction**

```python
@dataclass(frozen=True)
class Settings:
    db_path: str = os.getenv("BREACH_DB", "/data/breach.db")
    origins: tuple[str, ...] = tuple(
        x.strip() for x in os.getenv("BREACH_ORIGINS", "https://skdev.one").split(",") if x.strip()
    )
    openrouter_key: str = os.getenv("OPENROUTER_API_KEY", "")
    session_cookie: str = "breach_session"
    session_days: int = 30

def connect(settings: Settings) -> sqlite3.Connection:
    conn = sqlite3.connect(settings.db_path, timeout=10, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn

def create_app(settings: Settings | None = None) -> FastAPI:
    cfg = settings or Settings()
    app = FastAPI(title="Breach API", version="1")
    app.state.settings = cfg
    app.add_middleware(CORSMiddleware, allow_origins=list(cfg.origins),
                       allow_credentials=True, allow_methods=["GET", "POST"],
                       allow_headers=["Content-Type", "X-Breach-Guest", "X-CSRF-Token"])
    app.include_router(legacy_router)
    return app
```

Keep `app.py` executable with:

```python
from app.main import app

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8050)
```

- [ ] **Step 5: Run compatibility tests**

Run: `python -m pytest tests/test_legacy_api.py -q`

Expected: PASS for health, summaries, full match lookup, prompt-version filtering, and legacy standings.

- [ ] **Step 6: Commit the compatibility shell**

```bash
git add app app.py requirements.txt requirements-dev.txt tests
git commit -m "refactor: add FastAPI shell with legacy compatibility"
```

### Task 2: Additive identity, usage, game-session, and match-owner schema

**Files:**
- Create: `/Users/rsumit123/work/breach-api/app/migrations.py`
- Create: `/Users/rsumit123/work/breach-api/tests/test_migrations.py`
- Modify: `/Users/rsumit123/work/breach-api/app/main.py`
- Modify: `/Users/rsumit123/work/breach-api/app/db.py`

**Interfaces:**
- Consumes: `connect(settings)` and the exact existing `matches` schema
- Produces: `migrate(conn: sqlite3.Connection) -> None` and schema version 1

- [ ] **Step 1: Write migration tests against both an empty database and a legacy database**

```python
def test_migrate_legacy_database_preserves_match(conn_with_legacy_match):
    migrate(conn_with_legacy_match)
    row = conn_with_legacy_match.execute("SELECT id, payload, owner_type FROM matches").fetchone()
    assert row["id"] == 1
    assert json.loads(row["payload"])["seed"] == 42
    assert row["owner_type"] is None

def test_migrate_is_idempotent(conn_with_legacy_match):
    migrate(conn_with_legacy_match)
    migrate(conn_with_legacy_match)
    assert conn_with_legacy_match.execute("PRAGMA user_version").fetchone()[0] == 1
```

- [ ] **Step 2: Run migration tests to verify failure**

Run: `python -m pytest tests/test_migrations.py -q`

Expected: FAIL because `app.migrations` does not exist.

- [ ] **Step 3: Implement one transactional, idempotent migration**

Create tables with these stable columns and constraints:

```sql
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email_normalized TEXT UNIQUE,
  password_hash TEXT,
  auth_provider TEXT NOT NULL DEFAULT 'password',
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0,1)),
  disabled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS guests(
  id TEXT PRIMARY KEY,
  guest_number INTEGER NOT NULL UNIQUE,
  chosen_name TEXT NOT NULL,
  public_handle TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_usage(
  identity_type TEXT NOT NULL CHECK(identity_type IN ('guest','user')),
  identity_id TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(identity_type, identity_id, usage_date)
);
CREATE TABLE IF NOT EXISTS game_sessions(
  id TEXT PRIMARY KEY,
  identity_type TEXT NOT NULL CHECK(identity_type IN ('guest','user')),
  identity_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('public','benchmark')),
  difficulty TEXT,
  human_side INTEGER,
  model_a TEXT,
  model_b TEXT,
  state TEXT NOT NULL CHECK(state IN ('active','completed','expired','refunded')),
  usage_date TEXT,
  next_turn_a INTEGER NOT NULL DEFAULT 0,
  next_turn_b INTEGER NOT NULL DEFAULT 0,
  first_playable_at TEXT,
  refunded_at TEXT,
  refund_reason TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  match_id INTEGER REFERENCES matches(id)
);
CREATE TABLE IF NOT EXISTS model_health(
  model_id TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  unhealthy_until TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_session_id TEXT NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  side INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cached_tokens INTEGER,
  cost_usd REAL,
  private_error TEXT,
  created_at TEXT NOT NULL
);
```

Use `PRAGMA table_info(matches)` before additive `ALTER TABLE` statements for
`owner_type`, `owner_id`, `game_session_id`, and `difficulty`.

- [ ] **Step 4: Run migration and legacy suites**

Run: `python -m pytest tests/test_migrations.py tests/test_legacy_api.py -q`

Expected: PASS with the legacy row byte-for-byte payload preserved.

- [ ] **Step 5: Commit the schema migration**

```bash
git add app/migrations.py app/main.py app/db.py tests/test_migrations.py
git commit -m "feat: add account quota and game session schema"
```

### Task 3: Registered and guest authentication

**Files:**
- Create: `/Users/rsumit123/work/breach-api/app/schemas.py`
- Create: `/Users/rsumit123/work/breach-api/app/security.py`
- Create: `/Users/rsumit123/work/breach-api/app/identity.py`
- Create: `/Users/rsumit123/work/breach-api/app/routes_auth.py`
- Create: `/Users/rsumit123/work/breach-api/tests/test_auth.py`
- Modify: `/Users/rsumit123/work/breach-api/app/main.py`

**Interfaces:**
- Consumes: migrated `users`, `auth_sessions`, and `guests` tables
- Produces: `Identity(kind: Literal['guest','user'], id: str, display_name: str, is_admin: bool)`, `require_identity(request)`, and auth routes

- [ ] **Step 1: Write failing API tests for account and guest isolation**

```python
def test_signup_sets_http_only_cookie_and_hides_email(client):
    response = client.post("/v1/auth/signup", json={
        "displayName": "Rahul", "email": " RAHUL@example.com ", "password": "correct horse"
    }, headers={"Origin": "https://skdev.one"})
    assert response.status_code == 201
    assert response.json()["identity"] == {"kind": "user", "displayName": "Rahul", "isAdmin": False}
    assert "email" not in response.text.lower()
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "Secure" in response.headers["set-cookie"]

def test_guest_gets_generated_public_handle(client):
    response = client.post("/v1/guests", json={"displayName": "Rahul"})
    assert response.status_code == 201
    assert re.fullmatch(r"Guest\d+:Rahul", response.json()["identity"]["displayName"])
    assert response.json()["guestToken"]

def test_signing_in_does_not_convert_guest(client, guest_headers, registered_cookie):
    assert client.get("/v1/me", headers=guest_headers).json()["identity"]["kind"] == "guest"
    assert client.get("/v1/me", cookies=registered_cookie).json()["identity"]["kind"] == "user"

def test_login_rate_limit_is_generic(client, user):
    for _ in range(10):
        client.post("/v1/auth/login", json={"email": user.email, "password": "wrong"})
    response = client.post("/v1/auth/login", json={"email": user.email, "password": "wrong"})
    assert response.status_code == 429
    assert response.json()["code"] == "try_again_later"
```

- [ ] **Step 2: Run auth tests to verify failure**

Run: `python -m pytest tests/test_auth.py -q`

Expected: FAIL with missing routes and `require_identity`.

- [ ] **Step 3: Implement normalized identity inputs and opaque credentials**

```python
DISPLAY_RE = re.compile(r"^[\w .'-]{1,24}$", re.UNICODE)

def normalize_email(value: str) -> str:
    return value.strip().casefold()

def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()

def new_token() -> str:
    return secrets.token_urlsafe(32)

@dataclass(frozen=True)
class Identity:
    kind: Literal["guest", "user"]
    id: str
    display_name: str
    is_admin: bool = False
```

Use `argon2.PasswordHasher()` for password hashes. Resolve a user from the
`breach_session` cookie first and a guest from `X-Breach-Guest` only when no valid user session
exists. Never promote or merge one identity into the other.

Add a bounded in-memory sliding-window limiter in `security.py`: guest creation 20/hour/IP,
signup 10/hour/IP, login 20/hour/IP and 10/hour/normalized-email. All login limit failures use
`try_again_later` and do not disclose whether the email exists. Store no passwords or raw session/
guest tokens in limiter keys.

- [ ] **Step 4: Implement the auth routes and cookie lifecycle**

```text
POST /v1/guests
POST /v1/auth/signup
POST /v1/auth/login
POST /v1/auth/logout
GET  /v1/me
```

Guest creation, signup, login, and `/v1/me` return the same public shape:

```json
{"identity":{"kind":"user","id":"u_123","displayName":"Rahul","isAdmin":false},
 "allowance":{"remaining":10,"limit":10,"resetsAt":"2026-08-24T00:00:00+05:30"}}
```

Guest creation additionally returns `guestToken` exactly once. Registered responses omit email
and every credential field.

`POST /v1/auth/logout` revokes the hashed session and expires the cookie. Signup and login use a
shared generic `invalid_credentials` response for credential failures. Reject disallowed origins
before cookie-authenticated mutations. Set the login cookie with `secure=True`, `httponly=True`,
`samesite="lax"`, `path="/"`, and `max_age=30*24*60*60`; logout repeats the same path/domain
attributes while setting `max_age=0`.

- [ ] **Step 5: Run auth, migration, and legacy tests**

Run: `python -m pytest tests/test_auth.py tests/test_migrations.py tests/test_legacy_api.py -q`

Expected: PASS, including duplicate email, eight-character password minimum, expired/revoked
session, malformed display name, guest continuation, CORS credentials, and origin rejection.

- [ ] **Step 6: Commit authentication**

```bash
git add app tests/test_auth.py
git commit -m "feat: add guest and account authentication"
```

### Task 4: Atomic IST quota and public game-session start

**Files:**
- Create: `/Users/rsumit123/work/breach-api/app/quota.py`
- Create: `/Users/rsumit123/work/breach-api/app/routing.py`
- Create: `/Users/rsumit123/work/breach-api/app/games.py`
- Create: `/Users/rsumit123/work/breach-api/app/routes_games.py`
- Create: `/Users/rsumit123/work/breach-api/tests/test_quota.py`
- Create: `/Users/rsumit123/work/breach-api/tests/test_game_start.py`
- Modify: `/Users/rsumit123/work/breach-api/app/config.py`
- Modify: `/Users/rsumit123/work/breach-api/app/main.py`

**Interfaces:**
- Consumes: `Identity`, migrated usage/session tables, configured tier roster
- Produces: `allowance(identity, now) -> Allowance`, `start_public_game(conn, identity, difficulty, now) -> StartedGame`, `POST /v1/games`, and `GET /v1/difficulties`

- [ ] **Step 1: Write failing timezone and concurrency tests**

```python
def test_ist_day_changes_at_midnight_not_utc():
    before = datetime(2026, 8, 23, 18, 29, 59, tzinfo=timezone.utc)
    after = datetime(2026, 8, 23, 18, 30, 0, tzinfo=timezone.utc)
    assert usage_date(before) == date(2026, 8, 23)
    assert usage_date(after) == date(2026, 8, 24)

def test_guest_fourth_atomic_start_is_rejected(app, guest_headers):
    statuses = concurrent_posts(app, 4, "/v1/games", {"difficulty": "easy"}, guest_headers)
    assert sorted(statuses) == [201, 201, 201, 429]

def test_guest_cannot_start_hard(client, guest_headers):
    response = client.post("/v1/games", json={"difficulty": "hard"}, headers=guest_headers)
    assert response.status_code == 403
    assert response.json()["code"] == "difficulty_requires_account"

def test_game_start_limiter_rejects_after_configured_window():
    limiter = SlidingWindowLimiter(limit=2, seconds=3600)
    assert limiter.take("user:u1", now=1000) is True
    assert limiter.take("user:u1", now=1001) is True
    assert limiter.take("user:u1", now=1002) is False
```

- [ ] **Step 2: Run quota tests to verify failure**

Run: `python -m pytest tests/test_quota.py tests/test_game_start.py -q`

Expected: FAIL because quota/session services do not exist.

- [ ] **Step 3: Implement exact tier configuration and rotation cursor**

```python
MODEL_TIERS = {
    "easy": ("amazon/nova-lite-v1", "amazon/nova-2-lite-v1", "microsoft/phi-4"),
    "medium": ("google/gemini-3.5-flash-lite", "qwen/qwen3.7-flash"),
    "hard": ("google/gemini-3.7-flash",),
}
LIMITS = {"guest": 3, "user": 10}
IST = ZoneInfo("Asia/Kolkata")
```

Select from models whose `unhealthy_until` is absent or expired, rotating deterministically by
the tier's prior start count so every healthy model receives traffic.

- [ ] **Step 4: Implement an immediate SQLite transaction for reservation and session creation**

```python
def start_public_game(conn, identity: Identity, difficulty: str, now: datetime) -> StartedGame:
    conn.execute("BEGIN IMMEDIATE")
    try:
        expire_stale_session(conn, identity, now)
        assert_allowed(identity, difficulty)
        allowance = reserve_one(conn, identity, now)
        model = select_model(conn, difficulty, now)
        game = insert_public_session(conn, identity, difficulty, model, allowance.usage_date, now)
        conn.commit()
        return game
    except Exception:
        conn.rollback()
        raise
```

Return `gameId`, `difficulty`, `opponent`, `humanSide`, `gamesRemaining`, and an ISO-8601
`resetsAt` plus `expiresAt` exactly 90 minutes after creation. Reject a second active session until
the first completes or expires.
Apply a 20/hour/identity game-start limiter before opening the SQLite reservation transaction;
the stricter 3/10 daily allowance remains the accounting authority.

- [ ] **Step 5: Run exact quota/start suites**

Run: `python -m pytest tests/test_quota.py tests/test_game_start.py -q`

Expected: PASS for 3/10 limits, midnight boundary, countdown, abandonment, tier access, model
rotation, one active session, and four-way concurrent guest starts.

- [ ] **Step 6: Commit quotas and game start**

```bash
git add app tests/test_quota.py tests/test_game_start.py
git commit -m "feat: enforce IST quotas and tiered game starts"
```

### Task 5: Bounded OpenRouter transport and health accounting

**Files:**
- Create: `/Users/rsumit123/work/breach-api/app/openrouter.py`
- Create: `/Users/rsumit123/work/breach-api/tests/test_openrouter.py`
- Modify: `/Users/rsumit123/work/breach-api/app/routing.py`
- Modify: `/Users/rsumit123/work/breach-api/app/config.py`

**Interfaces:**
- Consumes: `OPENROUTER_API_KEY`, selected model ID, fixed messages
- Produces: `OpenRouterClient.complete(model_id, messages) -> ProviderReply`, `record_success`, and `record_failure`

- [ ] **Step 1: Write failing transport tests with HTTPX mock transport**

```python
@pytest.mark.asyncio
async def test_completion_sends_reasoning_and_usage_controls(fake_transport):
    reply = await client.complete("google/gemini-3.7-flash", [{"role": "user", "content": "{}"}])
    body = fake_transport.last_json
    assert body["reasoning"] == {"max_tokens": 400}
    assert body["max_tokens"] == 6000
    assert body["usage"] == {"include": True}
    assert reply.text == '{"queue":[],"stance":"hold","why":"wait"}'

@pytest.mark.asyncio
async def test_timeout_covers_stream_body(slow_body_transport):
    with pytest.raises(ProviderTimeout):
        await client.complete("microsoft/phi-4", [{"role": "user", "content": "{}"}])
```

- [ ] **Step 2: Run transport tests to verify failure**

Run: `python -m pytest tests/test_openrouter.py -q`

Expected: FAIL importing `OpenRouterClient`.

- [ ] **Step 3: Implement provider request, response parsing, and private usage result**

```python
@dataclass(frozen=True)
class ProviderReply:
    text: str
    latency_ms: int
    prompt_tokens: int
    completion_tokens: int
    cached_tokens: int
    cost_usd: float | None

class OpenRouterClient:
    async def complete(self, model_id: str, messages: list[dict[str, object]]) -> ProviderReply:
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0)) as http:
            response = await http.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}", "X-Title": "Breach"},
                json={"model": model_id, "messages": messages, "temperature": 0.7,
                      "max_tokens": 6000, "usage": {"include": True},
                      "reasoning": {"max_tokens": 400}},
            )
            response.raise_for_status()
            return parse_provider_reply(response.json(), elapsed_ms)
```

Read both `message.content` and `message.reasoning` candidates as the current browser does.
Persist errors only in `provider_events.private_error`; return stable internal exception codes.

- [ ] **Step 4: Implement model health cooldown**

After two consecutive first-turn transport/provider failures, set `unhealthy_until` to 10 minutes
after the latest failure. A successful call clears consecutive failures and cooldown. A 429 is a
provider failure and remains visible to the game strike/fallback logic.

- [ ] **Step 5: Run transport and routing tests**

Run: `python -m pytest tests/test_openrouter.py tests/test_game_start.py -q`

Expected: PASS for body timeout, provider error parsing, hidden credentials/errors, usage fields,
reasoning-field rejection retry, health cooldown, and successful health reset.

- [ ] **Step 6: Commit the provider boundary**

```bash
git add app/openrouter.py app/routing.py app/config.py tests/test_openrouter.py
git commit -m "feat: add bounded OpenRouter transport"
```

### Task 6: Server-owned v8 prompt, memory, decisions, and first-turn refund

**Files:**
- Create: `/Users/rsumit123/work/breach-api/app/prompt_v8.py`
- Create: `/Users/rsumit123/work/breach-api/tests/fixtures/prompt_v8.txt`
- Create: `/Users/rsumit123/work/breach-api/tests/test_decisions.py`
- Modify: `/Users/rsumit123/work/breach-api/app/schemas.py`
- Modify: `/Users/rsumit123/work/breach-api/app/games.py`
- Modify: `/Users/rsumit123/work/breach-api/app/routes_games.py`
- Modify: `/Users/rsumit123/work/breach-api/app/quota.py`
- Modify: `/Users/rsumit123/work/breach-api/app/migrations.py`
- Modify: `/Users/rsumit123/work/breach-api/tests/test_migrations.py`

**Interfaces:**
- Consumes: active game session, fixed `BattleView`, optional bounded local dossier, `OpenRouterClient`
- Produces: `POST /v1/games/{game_id}/decisions`, ten-turn private conversation state, sanitized `DecisionResponse`, and `refund_before_play`

- [ ] **Step 1: Freeze the current v8 prompt as a parity fixture**

Copy the fully interpolated v8 `RULES` text and debrief/dossier instructions from
`war-game/index.html` into `tests/fixtures/prompt_v8.txt`. Add a test that asserts the server
prompt contains the exact economy prices `36/63/90`, persistent stance rule, capture time 5,
tower airstrike 120, `purchaseBlocked`, and JSON response schema.

```python
def test_prompt_v8_parity_contract():
    text = build_system_prompt(dossier=None)
    assert '"queue"' in text and '"stance"' in text and '"why"' in text
    assert all(f'"{unit}"' in text for unit in ("inf", "gun", "air", "tank", "at", "eco"))
    for required in ("36/63/90", "PERSISTS", "purchaseBlocked", "120", "5 seconds"):
        assert required in text
```

- [ ] **Step 2: Write failing decision/session tests**

```python
def test_decision_requires_next_monotonic_turn(client, active_game, identity_headers):
    first = client.post(f"/v1/games/{active_game}/decisions", json=battle_view(turn=0), headers=identity_headers)
    replay = client.post(f"/v1/games/{active_game}/decisions", json=battle_view(turn=0), headers=identity_headers)
    assert first.status_code == 200
    assert replay.status_code == 409
    assert replay.json()["code"] == "turn_out_of_order"

def test_memory_keeps_only_last_ten_turn_pairs(game_service, provider):
    for turn in range(12):
        game_service.decide(game_id, identity, battle_view(turn=turn))
    assert len(provider.last_messages) == 1 + 20 + 1

def test_decision_rate_limit_bounds_session_calls():
    limiter = SlidingWindowLimiter(limit=120, seconds=600)
    assert all(limiter.take("game:g1", now=1000+i) for i in range(120))
    assert limiter.take("game:g1", now=1120) is False
```

- [ ] **Step 3: Run decision tests to verify failure**

Run: `python -m pytest tests/test_decisions.py -q`

Expected: FAIL because the decision route and server prompt do not exist.

- [ ] **Step 4: Implement fixed request and response schemas**

`BattleView` accepts only the current game-facing fields: turn, side, time, coins/income/eco,
base HP, own/enemy typed units, compositions, nearest threat, costs/affordability, queue feedback,
stance, and tower state. Reject extra fields and bodies over 128 KiB. `LocalDossier` is limited to
integer records plus `read` and `plan` strings of at most 600 characters each.

```python
class DecisionResponse(BaseModel):
    queue: list[Literal["inf", "gun", "air", "tank", "at", "eco"]]
    stance: Literal["push", "hold"] | None
    why: str = Field(max_length=600)
    autoPlayed: bool = False
    opponent: dict[str, str] | None = None
    providerCode: None = None
```

- [ ] **Step 5: Implement memory and sanitization parity**

Store conversation JSON privately on `game_sessions` with a schema migration adding
`conversation_a`, `conversation_b`, and `dossier_input`, then bump `PRAGMA user_version` to 2.
Append one user/assistant pair only after a parsed reply, slice to the last 20 messages before each
provider call, and use the tolerant current v8 parsing rules for arrays, object maps, prose-wrapped
JSON, stance persistence, invalid tokens, and empty outputs. Validate and retain the first accepted
local dossier snapshot for postgame reflection; later turns cannot replace it. Return no raw
provider text. Permit at most 120 decision requests per ten minutes for a single game session;
reject excess calls with `turn_rate_limited` before provider work.

- [ ] **Step 6: Implement first-turn model switching and total-tier refund**

For a public AI's first turn, try each healthy model in the requested tier at most once. Update
the session's selected model when switching. When none returns a playable decision, call
`refund_before_play(conn, session_id, "tier_unavailable")` in one transaction, decrement the
matching `daily_usage` row once, mark the session `refunded`, and return HTTP 503 with
`code=tier_unavailable`, refreshed games remaining, and reset time. Later failures return the
existing auto-play instruction and do not refund. When a healthy replacement wins the first-turn
retry, include its public `{id,name}` as `opponent` in `DecisionResponse` so the client updates the
matchup label and saved commander before play advances.

- [ ] **Step 7: Run decision, quota, and prompt parity suites**

Run: `python -m pytest tests/test_decisions.py tests/test_quota.py tests/test_openrouter.py -q`

Expected: PASS for monotonic turns, identity ownership, expiry, 20-message memory, prompt parity,
sanitization, local dossier bounds, model switch recording, one-time refund, and underway fallback.

- [ ] **Step 8: Commit the constrained decision engine**

```bash
git add app tests/test_decisions.py tests/fixtures/prompt_v8.txt
git commit -m "feat: proxy bounded v8 game decisions"
```

### Task 7: Owned completion, personal history, and clean public leaderboards

**Files:**
- Create: `/Users/rsumit123/work/breach-api/app/leaderboards.py`
- Create: `/Users/rsumit123/work/breach-api/tests/test_completion.py`
- Create: `/Users/rsumit123/work/breach-api/tests/test_leaderboards.py`
- Modify: `/Users/rsumit123/work/breach-api/app/games.py`
- Modify: `/Users/rsumit123/work/breach-api/app/routes_games.py`
- Modify: `/Users/rsumit123/work/breach-api/app/routes_public.py`
- Modify: `/Users/rsumit123/work/breach-api/app/legacy.py`

**Interfaces:**
- Consumes: active owned session and existing match payload shape
- Produces: `POST /v1/games/{id}/complete`, `GET /v1/history`, and public leaderboard projections

- [ ] **Step 1: Write failing ownership and privacy tests**

```python
def test_complete_links_match_to_session_identity(client, active_game, identity_headers, match_payload):
    response = client.post(f"/v1/games/{active_game}/complete", json=match_payload, headers=identity_headers)
    assert response.status_code == 201
    row = client.get("/v1/history", headers=identity_headers).json()["battles"][0]
    assert set(row) == {"id", "opponent", "difficulty", "result", "playedAt", "remainingBaseHp"}

def test_public_leaderboards_never_expose_private_or_diagnostic_fields(client, completed_match):
    text = json.dumps(client.get("/v1/leaderboards/recent").json()).lower()
    for forbidden in ("email", "seed", "prompt", "latency", "error", "token", "payload"):
        assert forbidden not in text

def test_completion_returns_local_dossier_update_without_exposing_prompt(client, active_game, identity_headers, match_payload):
    body = client.post(f"/v1/games/{active_game}/complete", json=match_payload,
                       headers=identity_headers).json()
    assert set(body["dossierUpdate"]) == {
        "model", "name", "games", "modelWins", "humanWins", "read", "plan"
    }
    assert "prompt" not in json.dumps(body).lower()
```

- [ ] **Step 2: Run completion and leaderboard tests to verify failure**

Run: `python -m pytest tests/test_completion.py tests/test_leaderboards.py -q`

Expected: FAIL with missing completion/history/leaderboard routes.

- [ ] **Step 3: Implement idempotent owned completion**

Verify session ownership, active state, `promptVersion == 8`, selected opponent model, difficulty,
human/AI commander kinds, duration `0..300`, and one completion per session. Insert using a
session-based fingerprint, stamp `owner_type`, `owner_id`, `game_session_id`, and `difficulty`,
then mark the session completed in the same transaction. A repeated completion returns the same
match with `stored=false`.

After the match transaction commits, use the session's selected model and stored dossier snapshot
to request the existing v8 debrief and dossier JSON through `OpenRouterClient`. Run the two
reflections concurrently under one 30-second response deadline. Return bounded `debrief` and
`dossierUpdate` objects to the owning client for local identity-scoped storage. Reflection failure
never rolls back the match, changes quota, or leaks a provider error; it returns the failed optional
field as `null` and records a private provider event. Benchmark sessions request debriefs but never
dossier updates.

- [ ] **Step 4: Implement narrow public projections**

```text
GET /v1/history?limit=50
GET /v1/leaderboards/players?difficulty=easy|medium|hard
GET /v1/leaderboards/models
GET /v1/leaderboards/recent?limit=30
```

Player rows are exactly `rank`, `displayName`, `wins`, `losses`, `winRate`; sort by wins descending,
then win rate descending, then display name. AI rows are exactly `name`, `difficulty`, `matches`,
`wins`, `winRate`. Recent rows are exactly `player`, `opponent`, `difficulty`, `result`, `playedAt`.
Only completed public Human-vs-AI sessions participate.

- [ ] **Step 5: Run all persistence and public-projection tests**

Run: `python -m pytest tests/test_completion.py tests/test_leaderboards.py tests/test_legacy_api.py -q`

Expected: PASS for ownership denial, completion idempotency, private guest/user histories, three
difficulty filters, sort ties, guest public handles, empty states, and forbidden-field scans.

- [ ] **Step 6: Commit completion and leaderboards**

```bash
git add app tests/test_completion.py tests/test_leaderboards.py
git commit -m "feat: store owned battles and public standings"
```

### Task 8: Admin benchmark sessions and historical owner assignment

**Files:**
- Create: `/Users/rsumit123/work/breach-api/app/routes_admin.py`
- Create: `/Users/rsumit123/work/breach-api/scripts/assign_owner_matches.py`
- Create: `/Users/rsumit123/work/breach-api/tests/test_admin.py`
- Modify: `/Users/rsumit123/work/breach-api/app/games.py`
- Modify: `/Users/rsumit123/work/breach-api/app/main.py`

**Interfaces:**
- Consumes: authenticated `Identity.is_admin`, game decision service, owner email supplied only to the migration script
- Produces: `POST /v1/admin/games`, admin diagnostics, and idempotent historical assignment

- [ ] **Step 1: Write failing authorization and migration tests**

```python
def test_owner_email_without_admin_flag_cannot_open_lab(client, owner_email_user_cookie):
    assert client.post("/v1/admin/games", json=benchmark_request(), cookies=owner_email_user_cookie).status_code == 403

def test_admin_can_start_model_vs_model_session(client, admin_cookie):
    response = client.post("/v1/admin/games", json=benchmark_request(), cookies=admin_cookie)
    assert response.status_code == 201
    assert response.json()["mode"] == "benchmark"

def test_owner_assignment_is_idempotent(legacy_db, owner_user):
    first = assign_owner(legacy_db, "rsumit123@gmail.com")
    second = assign_owner(legacy_db, "rsumit123@gmail.com")
    assert first.assigned > 0
    assert second.assigned == 0
```

- [ ] **Step 2: Run admin tests to verify failure**

Run: `python -m pytest tests/test_admin.py -q`

Expected: FAIL because the admin router and script do not exist.

- [ ] **Step 3: Implement role-checked benchmark sessions**

`POST /v1/admin/games` accepts exact fields `modelA`, `modelB`, `humanSide`, `seed`, `memory`, and
`sideSwap`; both model IDs are nonempty strings of at most 160 characters. Benchmark sessions do
not consume daily usage and can request decisions for both sides through the same constrained
decision route. Admin-only detail responses may include latency, provider usage/cost, switches,
failures, prompt version, seat, and raw match export; the public routes remain narrow.

- [ ] **Step 4: Implement the offline owner assignment command**

```bash
python scripts/assign_owner_matches.py --email rsumit123@gmail.com --db /data/breach.db
```

The script refuses to run when the user does not exist, sets `is_admin=1` by resolved user ID,
updates only matches whose `owner_id IS NULL`, prints assigned/skipped totals, and is safe to rerun.

- [ ] **Step 5: Run admin and full API suites**

Run: `python -m pytest -q`

Expected: PASS, including forged-email denial, admin session behavior, public diagnostic exclusion,
and idempotent historical assignment.

- [ ] **Step 6: Commit admin support**

```bash
git add app/routes_admin.py app/games.py app/main.py scripts tests/test_admin.py
git commit -m "feat: add owner benchmark sessions and migration"
```

### Task 9: Container, operations, and compatibility deployment

**Files:**
- Modify: `/Users/rsumit123/work/breach-api/Dockerfile`
- Modify: `/Users/rsumit123/work/breach-api/docker-compose.yml`
- Modify: `/Users/rsumit123/work/breach-api/README.md`
- Create: `/Users/rsumit123/work/breach-api/.env.example`
- Create: `/Users/rsumit123/work/breach-api/tests/test_security_contract.py`

**Interfaces:**
- Consumes: completed FastAPI app and migration
- Produces: deployable image, documented environment, compatibility-first rollout and smoke commands

- [ ] **Step 1: Write a final security contract test**

```python
def test_public_surface_contains_no_secrets_or_emails(client, completed_match):
    for path in ("/v1/health", "/v1/matches?limit=5", "/v1/leaderboards/models", "/v1/leaderboards/recent"):
        response = client.get(path)
        assert response.status_code == 200
        body = response.text.lower()
        assert "sk-or-v1-" not in body
        assert "@example.com" not in body

def test_mutation_rejects_untrusted_origin(client, user_cookie):
    response = client.post("/v1/games", json={"difficulty": "easy"}, cookies=user_cookie,
                           headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
```

- [ ] **Step 2: Run the security test to establish current failures**

Run: `python -m pytest tests/test_security_contract.py -q`

Expected: FAIL until final middleware and response projections are wired.

- [ ] **Step 3: Update the image and environment**

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY app.py .
ENV PORT=8050 BREACH_DB=/data/breach.db
EXPOSE 8050
HEALTHCHECK --interval=30s --timeout=5s --start-period=8s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8050/v1/health', timeout=4)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8050"]
```

Compose passes `OPENROUTER_API_KEY`, `BREACH_ORIGINS=https://skdev.one`, and `BREACH_DB`. Do not
retain `BREACH_TOKEN` as public write authorization after the frontend cutover; keep legacy POST
compatibility disabled by default.
Add `BREACH_LEGACY_PUBLIC_READS=true` for the backend-first compatibility deployment. After the
new frontend is live, set it to `false`: `/v1/matches/{id}` full payload and legacy diagnostic
standings then require admin auth, while `/v1/health` and narrow new leaderboards stay public.

- [ ] **Step 4: Document backup, migration, rollback, and smoke commands**

```bash
ssh ssh-social 'docker run --rm -v breach-api_breach-data:/data -v "$PWD":/backup python:3.12-slim cp /data/breach.db /backup/breach-pre-auth.db'
docker compose build
docker compose run --rm breach-api python -c 'from app.config import Settings; from app.db import connect; from app.migrations import migrate; c=connect(Settings()); migrate(c)'
docker compose up -d
curl -fsS https://breach-api.skdev.one/v1/health
curl -fsS 'https://breach-api.skdev.one/v1/matches?limit=1'
```

Document rollback as stopping the new container, restoring the named pre-auth database backup,
and rebuilding the prior Git commit; never overwrite the only database copy.

- [ ] **Step 5: Run the complete backend gate and local container smoke**

Run: `python -m pytest -q`

Expected: all tests PASS.

Run: `docker compose build && docker compose up -d && curl -fsS http://127.0.0.1:8050/v1/health`

Expected: image builds, container becomes healthy, and health returns an object with `ok=true` and
an integer `matches` count.

- [ ] **Step 6: Commit operational changes**

```bash
git add Dockerfile docker-compose.yml README.md .env.example tests/test_security_contract.py
git commit -m "ops: deploy authenticated FastAPI backend"
```

- [ ] **Step 7: Deploy compatibility backend and verify live reads**

Run the documented database backup first, then:

```bash
rsync -az --exclude '.git' --exclude '.env' ./ ssh-social:~/breach-api/
ssh ssh-social 'cd ~/breach-api && docker compose up -d --build'
curl -fsS https://breach-api.skdev.one/v1/health
curl -fsS 'https://breach-api.skdev.one/v1/standings' | python -m json.tool >/dev/null
```

Expected: live health succeeds, legacy standings remains valid JSON, and container logs contain no
database migration or missing-key exception. Do not run owner assignment until the owner has
registered through the new frontend.

After the frontend cutover is verified, set `BREACH_LEGACY_PUBLIC_READS=false`, redeploy only the
backend configuration, assert anonymous full-match/legacy-standings requests return 401, and assert
the owner session can still read them through Benchmark Lab.
