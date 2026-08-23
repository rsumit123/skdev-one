# Breach — accounts, daily games, difficulty tiers, and public UX

**Date:** 2026-08-23

**Status:** Approved design, awaiting specification review

**Repositories:** `skdev-one/war-game` frontend and `breach-api` backend

## Product goal

Turn Breach from a bring-your-own-key benchmark interface into a mobile-first public game:

- visitors can play immediately as guests;
- registered users receive a larger daily allowance;
- users choose a difficulty, not an unfamiliar model identifier;
- OpenRouter credentials and model calls remain server-side;
- public identity, match history, and global leaderboards work across devices;
- the owner retains the detailed model-vs-model benchmark controls in a private lab.

The first release does not sell subscriptions. When a registered user exhausts the free
allowance, the product shows a restrained **Breach Pro — coming soon** state.

## Product principles

1. **The public surface is a game, not an API console.** Copy talks about battles, AI
   commanders, difficulties, and games remaining. It does not expose prompts, tokens,
   OpenRouter, seeds, storage internals, or transport errors.
2. **The benchmark remains trustworthy.** The v8 rules prompt, decision cadence, lockstep
   behavior, memory window, sanitation, timeout/fallback behavior, and simulation are preserved.
   Authentication and routing wrap the benchmark; they do not alter it.
3. **Mobile landscape is the primary gameplay surface.** Account screens and navigation work
   in either orientation, while the battle keeps the existing landscape-first presentation and
   a useful portrait rotation prompt.
4. **Server authority is mandatory.** Identity, quotas, allowed tiers, chosen model, model
   requests, and match ownership are decided by the backend. Client state is only a convenience.
5. **The temporary password system must be replaceable.** The schema supports another auth
   provider later, so Google sign-in can replace email/password without redesigning game data.

## Scope

### Included in v1

- Email/password registration, sign-in, sign-out, and persistent authenticated sessions
- Named guest play with a server-issued guest identity
- Daily allowances resetting at midnight Asia/Kolkata
- Difficulty selection and server-selected opponents
- Server-paid, server-proxied OpenRouter model decisions
- Public player and AI leaderboards, recent battles, and private personal history
- First-time How to Play onboarding with permanent access from the menu
- Owner-only Benchmark Lab
- Migration of existing historical matches to the owner's account
- Clean public copy and removal of developer-facing leaderboard/setup controls

### Explicitly deferred

- Google sign-in
- Email verification, password reset, password-change UI, and account recovery
- Paid checkout, subscriptions, and billing
- Merging guest history or quota into a newly registered account
- Moving rival dossiers to server-side, cross-device storage
- A competitive rating or seasonal ranking formula
- Any game balance, unit, economy, tower, stance, prompt, or dossier-strategy change

The temporary auth UI says **Password reset coming soon** rather than implying email delivery
exists. Passwords are disposable because Google sign-in is the intended successor.

## Identity model

### Registered players

Registration asks for:

- public display name;
- private email address;
- password, minimum eight characters for the temporary flow.

Emails are normalized for uniqueness and never shown publicly. The public display name appears
on leaderboards and match history. Authorization never depends on a hard-coded email address.

Passwords are stored using Argon2id hashes. Successful login creates an opaque, random session
whose hashed token is stored by the backend and whose raw value is delivered in a Secure,
HttpOnly, SameSite cookie. Logout revokes that session. Auth endpoints are rate-limited by IP
and, where appropriate, normalized email.

The user record has an auth-provider shape rather than assuming passwords forever. This allows
the owner and other users to attach or migrate to Google identity later without changing match
ownership.

### Guests

A guest enters only a display name. The server creates:

- a private random guest token stored on that device; and
- a public handle such as `Guest123:Rahul`.

The numeric prefix is server-assigned and makes duplicate chosen names distinguishable. Guest
tokens are not accepted as registered sessions and cannot access registered history or Hard
mode.

Guest and registered identities remain deliberately separate. Registering or signing in does
not merge guest matches, usage, dossiers, or history into the account.

### Owner account

After `rsumit123@gmail.com` is registered, a one-time administrative migration resolves the
new user ID and assigns the existing historical matches to it. The account receives an explicit
backend role/flag such as `is_admin`; the UI does not grant privileges by comparing email text.

## Daily allowances

| Identity | Games per IST day | Allowed difficulties |
|---|---:|---|
| Guest | 3 | Easy, Medium |
| Registered free | 10 | Easy, Medium, Hard |

A game is consumed at the first successful creation of a model-backed game session, immediately
before the first model request. Opening setup, reading How to Play, or viewing a matchup does not
consume a game. Once the server has started the session, abandoning the page still consumes it.

The backend computes the usage date in `Asia/Kolkata`; it never trusts a browser clock or
timezone. The client receives the next reset timestamp and renders a live countdown. Quota
reservation and game-session creation occur atomically so parallel requests cannot exceed the
limit.

If every configured model in the selected tier fails before a playable first decision is
returned, the server marks the session unavailable and refunds that reservation exactly once.
Failures after play has begun use the benchmark's existing timeout/fallback behavior and do not
refund or consume another game.

Guest exhaustion offers account creation for ten daily games. Registered exhaustion shows the
next reset countdown and **Breach Pro — coming soon**, with no nonfunctional checkout button.

## Difficulty and opponent routing

The public player chooses only a difficulty. The server chooses one healthy model from that
tier, creates a bounded game session, and reveals the selected opponent before battle begins.

Initial roster:

| Difficulty | Models |
|---|---|
| Easy | Amazon Nova Lite v1, Amazon Nova 2 Lite v1, Microsoft Phi-4 |
| Medium | Gemini 3.5 Flash Lite, Qwen 3.7 Flash |
| Hard | Gemini 3.7 Flash |

Canonical OpenRouter model IDs live in backend configuration, not in public control values.
Routing rotates among healthy models in a tier rather than always selecting the first entry.
Recent failures place a model into a short health cooldown. If a first-turn request fails, the
server may select another healthy model in the same tier; it records the switch for internal
diagnostics. A fully unavailable tier returns a friendly unavailable state and refunds the game.

The public response includes only what the game needs: session identifier, difficulty,
opponent display name, games remaining, reset time, and initial game metadata. It never returns
provider credentials or arbitrary proxy controls.

## Backend architecture

`breach-api` moves from the current standard-library HTTP server to FastAPI while retaining its
SQLite database and Docker deployment. Existing public match-reading behavior remains available
through compatible routes during migration.

Suggested persistence model:

- `users`: stable user ID, display name, normalized email, password hash/auth provider, role,
  timestamps and status;
- `auth_sessions`: hashed opaque token, user ID, expiry, revocation and activity timestamps;
- `guests`: stable guest ID, public handle components, hashed device token and timestamps;
- `game_sessions`: owner type/ID, difficulty, selected model, state, usage date, expiry,
  request sequence, failure/refund metadata and linked match ID;
- `daily_usage`: identity type/ID, IST usage date, consumed count and timestamps;
- existing `matches`: additive owner, game-session and public-difficulty fields, retaining the
  full benchmark payload and idempotent fingerprint.

SQLite transactions perform quota checks, reservations, session creation, match linking, and
refunds. Schema migration is additive and preserves all existing match rows. The live database
is backed up before migration.

### API responsibilities

The backend exposes narrowly scoped endpoints for:

- guest creation/continuation;
- signup, login, logout and current identity;
- current allowance and reset time;
- available public difficulty metadata;
- game-session start;
- the next model decision for the active session;
- match completion/save;
- personal history;
- public player standings, AI standings, and recent battles;
- owner-only benchmark operations.

This is not a general LLM proxy. A decision request must reference an active, unexpired game
session; match the next monotonic turn; use the server-owned Breach prompt and bounded memory;
and conform to a fixed request/response schema. At most one active public game session is allowed
per identity. Sessions expire shortly after the maximum possible match duration plus network
grace.

The existing 30-second whole-response timeout, 400-token reasoning cap, 6000-token overall cap,
sanitizer, adaptive fallback, three-strike behavior, and 429 treatment remain benchmark rules.
The provider key comes only from backend environment configuration.

## Frontend architecture

The public redesign stays in the existing self-contained `war-game/index.html`; v1 does not
introduce React, a build pipeline, or Firebase. The current simulation and canvas renderer remain
the game core. New auth, quota, routing, onboarding, history, and leaderboard modules call the
FastAPI backend through a small explicit API layer so public UI state is not interwoven with sim
logic.

Provider calls currently made by the browser move behind that API layer. The old bring-your-own-
key controls and technical setup are removed from public navigation, while reusable benchmark
controls are retained for the owner lab. Authentication depends on the server session cookie;
the frontend never stores a registered bearer token in local storage.

## Game and dossier behavior

The public game is Human vs AI. The frontend still owns deterministic simulation and rendering,
but every AI decision comes through the authorized game session. The backend stamps the stable
user/guest owner, difficulty, selected model, prompt version, session, and diagnostic provider
events onto the saved match.

Within-game conversation memory remains bounded to the last ten turns per side exactly as in v8.
Human-vs-model rival dossiers remain in local browser storage for v1 and are namespaced by the
stable current guest or user ID plus model. Signing in never reads or imports the guest's
dossiers, and signing out never exposes the registered user's dossiers to guest play. Moving
dossiers to authenticated backend storage is a later feature. Model-vs-model benchmark sessions
do not use dossiers.

## Owner-only Benchmark Lab

The detailed setup currently exposed to every visitor moves behind admin authorization. The
owner can retain:

- model-vs-model and custom model selection;
- seat/side assignment and swaps;
- seed controls;
- benchmark memory and diagnostic controls;
- full reasoning, prompt-version, latency/error, side-split and export details;
- an optional OpenRouter field for controlled experiments if still useful.

The lab is absent from normal navigation and every privileged backend route independently checks
the server-side admin role. Hiding controls is not the security boundary.

## Public UX

### Entry and identity

The first visit opens a focused Breach identity gate with four clear actions:

- **Play as guest** — enter a name and continue immediately;
- **Create account** — display name, email and password;
- **Sign in**;
- **View leaderboard** without playing.

Returning guest and registered sessions continue directly to the home screen. Sign-out returns
to the identity gate. Technical setup fields do not appear in the public flow.

### Home and difficulty selection

The home screen leads with the public handle and allowance, for example:

> 7 games left · Resets in 04:18:32

Three large difficulty cards explain the experience in game language. Each may list the AI
commanders in its pool, but the user does not select one. Guest Hard mode is visible but locked
with a concise sign-in/create-account call to action. Choosing a tier opens a matchup reveal:

> Your opponent: Gemini 3.7 Flash
>
> Hard

Only starting the model-backed session consumes the game.

### How to Play

First-time players see a skippable four-card onboarding sequence, accessible later from the
menu:

1. **Build your queue:** purchases execute in order; an unaffordable first item blocks those
   behind it.
2. **Counter the enemy:** teach the tank/gunner/AT counter cycle and the air exception without
   dumping the entire unit table.
3. **Control the tower:** Push attacks the base; Hold captures and defends the tower for income
   and airstrikes; stance persists until changed.
4. **Time your economy:** upgrades cost tempo now but increase later income; waiting too long
   leaves the base exposed.

Copy is visual, concise, and readable on a landscape phone without scrolling walls of text.

### Results and history

The result screen shows winner, opponent, difficulty, useful battle summary, current allowance,
and actions for rematch, personal history, or global leaderboard. Rematch clearly states that it
uses another daily game before confirmation.

**My Battles** is private to the current registered or guest identity. It shows opponent,
difficulty, result, date/time, and a compact game-relevant outcome such as remaining base HP.
Raw reasoning and provider diagnostics are not public.

## Leaderboards and product copy

The global leaderboard has three simple views:

1. **Top Players:** display name, wins, losses, and win rate, filterable by Easy, Medium, and
   Hard. Within a difficulty it sorts by wins, then win rate. V1 intentionally has no opaque
   rating formula.
2. **AI Commanders:** commander name, difficulty, matches, wins against humans, and win rate.
3. **Recent Battles:** compact natural-language entries such as
   `Rahul defeated Gemini 3.7 Flash · Hard · 3m ago`.

Emails are never public. Guests display as their server-issued `Guest123:Name` handle.

Remove these from all public leaderboard and match surfaces:

- seeds, prompt versions, raw unit queues/codes and economy-price metadata;
- Vulcan/Cobalt seat splits, latency, cached tokens and provider errors;
- copy, download, import, clear-local-data and raw export controls;
- references to `localStorage`, `results.json`, API URLs, OpenRouter or deployment;
- benchmark caveats and developer warnings.

Those diagnostics remain in the Benchmark Lab. Public copy is short, concrete, and
game-focused. Approved examples include:

- **No battles yet. Choose a difficulty to enter the breach.**
- **That AI commander is temporarily unavailable. Your game was refunded.**
- **You've used today's free games. More games are coming with Breach Pro.**

Provider failures are translated into actionable game states; raw status codes and exception
text are logged internally.

## Mobile behavior and accessibility

- Account, leaderboard, onboarding, quota and result screens must fit common phone widths in
  portrait and landscape with touch targets of at least 44 CSS pixels.
- Gameplay remains landscape-primary and respects safe-area insets on notched devices.
- Portrait gameplay shows the existing rotation invitation with a working play-anyway path;
  users with orientation lock are never trapped.
- Modal sheets avoid controls beneath browser chrome, retain visible close/back actions, and do
  not require hover.
- Countdown and quota meaning are conveyed in text, not color alone.
- Focus order, labels, password autocomplete attributes, error association, and keyboard
  navigation are included in the auth screens.
- Public names and recent-battle text are escaped as text; no user-provided HTML is rendered.

## Security and abuse controls

- Argon2id password hashing and constant-behavior credential failure responses
- Secure, HttpOnly, SameSite session cookies with rotation/revocation support
- Hashed random guest tokens; no trust in a chosen display name
- CSRF protection for cookie-authenticated mutation routes through SameSite plus an explicit
  origin/CSRF-token check appropriate to deployment
- Strict CORS origin allow-list
- IP and identity rate limits on auth, session start and model-decision routes
- Server-authoritative quota, tier, model, prompt, turn ordering and session expiry
- Fixed maximum request sizes and sanitized persisted strings
- No provider key or private email in frontend bundles, public APIs, logs, or leaderboard rows
- Admin checks on every Benchmark Lab route

Operational diagnostics retain enough detail to investigate spend: selected model, provider
usage/cost where returned, switches, timeouts, fallbacks, session owner and refund reason. These
fields are private.

## Failure behavior

| Condition | Public behavior | Accounting |
|---|---|---|
| Invalid/expired login | Return to sign-in with a concise message | No game used |
| Guest token unavailable | Ask for a guest name again | Old guest remains separate |
| Daily quota exhausted | Show reset countdown and correct CTA | No extra game created |
| Some models in tier unhealthy before play | Route to another healthy model | One game total |
| Entire tier unavailable before play | Friendly unavailable message | Reserved game refunded once |
| Model timeout after play begins | Existing adaptive fallback; battle continues | No refund or extra charge |
| Page closed after session starts | Session eventually expires | Game remains consumed |
| Duplicate match completion | Return the existing match via idempotency | No duplicate row/usage |

## Verification plan

### Backend automated tests

- Signup/login/logout, password hashing, cookie attributes, revocation and duplicate email
- Guest creation, stable continuation, generated handles and isolation from registered users
- IST date boundaries, countdown timestamp, guest limit three and registered limit ten
- Concurrent start requests cannot exceed quota
- Abandonment consumes; total-tier first-turn failure refunds exactly once
- Difficulty authorization and server-selected models cannot be overridden by the client
- Model health rotation, first-turn switching, fixed prompt/schema and monotonic turn validation
- Active-session and expiry enforcement
- Match ownership, idempotency, personal-history privacy and public email exclusion
- Admin authorization, including denial when only the owner's email text is imitated
- Historical match migration is repeatable and does not duplicate or orphan matches

### Frontend and integration tests

- Guest entry, registration, login/logout and returning-session paths
- Separate guest/account quotas and histories after signing in on the same device
- Difficulty locks, matchup reveal, start accounting, exhaustion and countdown states
- How to Play first-run, skip, completion and later reopening
- Result, My Battles, Top Players, AI Commanders and Recent Battles empty/populated states
- No technical leaderboard/setup copy or privileged controls for public users
- Owner Benchmark Lab appears only after verified admin identity
- Model-provider failure messages never leak raw backend/provider details

### Mobile visual checks

Manually inspect at minimum 844×390, 740×360 and 932×430 landscape viewports plus representative
portrait sizes. Cover identity gate, auth validation, onboarding, all difficulty cards, guest
Hard lock, quota exhaustion, matchup reveal, active gameplay, result, history, each leaderboard
view, owner lab navigation, safe areas, browser chrome and virtual keyboard behavior.

### Repository gates

Every `war-game/index.html` change runs the mandatory syntax, duplicate-function and OpenRouter
secret scan from `DEVELOPMENT.md`. Because this feature is intended not to change simulation or
balance, `bench.js gate` should remain unchanged; run it if the sim slice or its extraction
boundaries are touched. Any intentional balance change would require the full balance ritual and
a separately approved design.

Backend verification includes its full automated suite, a migration test against a copy of the
current SQLite database, Docker health check, and live endpoint smoke tests after deployment.

## Rollout

1. Build and verify the FastAPI backend and additive database migration without changing the
   live frontend contract.
2. Back up the live SQLite database, deploy the compatible backend, run migrations, and confirm
   health plus existing leaderboard reads.
3. Deploy the new public frontend behind the verified auth/game-session endpoints.
4. Register the owner account, apply the ID-based admin grant, and run the idempotent historical
   match assignment.
5. Exercise guest, registered, exhausted-quota, unavailable-tier and owner-lab smoke paths on
   production mobile and desktop viewports.
6. Confirm no provider key or email is present in served frontend/static responses and that
   live public leaderboard payloads contain only approved fields.

Frontend commits follow the `skdev-one` auto-push/Vercel ritual in `DEVELOPMENT.md`. Backend
commits and deployment follow `breach-api`'s repository instructions and Docker process. A
failed verification blocks rollout; evidence from each gate is reported rather than inferred.

## Acceptance criteria

The release is complete when a new visitor can enter a name and play up to three Easy/Medium
games, a registered player can play up to ten games including Hard, both see an accurate IST
reset countdown, and no browser ever receives the OpenRouter key. Game starts are atomic and
cannot bypass quota or tier limits. Guest and registered identity remain separate. Public
leaderboards contain only the approved game-facing fields, while the owner can still access the
full benchmark workflow privately. Existing matches survive and belong to the owner account.
The unchanged v8 game remains playable and passes the applicable repository verification gates
on the mobile landscape sizes that define the product.
