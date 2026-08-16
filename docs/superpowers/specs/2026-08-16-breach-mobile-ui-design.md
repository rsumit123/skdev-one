# Breach — mobile-first visual overhaul, deployed at skdev.one/war-game

**Date:** 2026-08-16
**Status:** Approved, not yet implemented

## Problem

`breach.html` is a working LLM-vs-LLM lane battler and benchmark harness, but it currently
exists only as an untracked file in `~/Downloads`. Its UI is functional-but-flat: a grey
graph-paper canvas with solid-colour rectangles for units, a four-tab mobile layout, and the
model reasoning buried in a small scrolling feed.

Two goals: make it look like a real mobile game, and put it on the web at a stable URL.

## Decisions

Settled during brainstorming, in order:

1. **Public, bring-your-own-key.** No backend, no proxied key, no per-visitor cost. The page
   opens already running a Scripted vs Scripted match so a visitor with no OpenRouter key still
   sees a battle immediately.
2. **Spectacle leads.** The hook is the battle itself, not the benchmark data — but the model
   reasoning and live log must stay prominent, not buried in a tab.
3. **Side-view parallax art.** Chosen over a tactical map, neon arena, pixel art, 2.5D
   perspective, and top-down. Fits the straight-lane sim naturally, keeps both sides visually
   symmetrical (which a fair benchmark needs), and delivers the most realism per unit of effort.
4. **Landscape-primary, portrait fallback.** Landscape is the only layout that gets the full
   80m lane *and* large units.
5. **Not linked from the skdev.one root page.** Accessed by URL directly.

### Known limits, accepted

Realistic mobile-game art normally means sprite atlases. There are no image assets here and no
way to generate them in this pipeline, so the ceiling is procedural vector-shaded canvas art:
stylised but richly lit, not photoreal. True sprite-grade art would be a separate follow-up.

## Deliverable

`war-game/index.html` — one self-contained file, no build step, no dependencies, matching the
existing `laws/index.html` pattern. Vercel auto-deploys from the repo, giving
**skdev.one/war-game**. The app keeps the name **Breach**; `war-game` is only the URL.

`war-game/HANDOFF.md` moves into the repo alongside it, so the project context stops living in
a Downloads folder.

No API key is ever committed.

## Architecture

The existing single-`<script>` structure is kept: RULES, SIM, AGENT, COMMANDERS, RENDER,
CONTROLS, LLM SEAT. All changes land in RENDER, CONTROLS, and the CSS. SIM and AGENT are not
touched.

### Layout

**Landscape (primary).** Full-bleed battlefield at `100dvh` with safe-area insets on left and
right for the notch. Both HP bars overlaid top-left on the sky; clock top-right. A bottom ticker
carries each side's coins and the latest log line. Decision overlays appear in the corners and
fade after ~6s. Start / speed / reset are floating pill buttons. Setup and Units become modal
sheets rather than top-level tabs.

**Portrait (fallback).** A rotate prompt with a **"Play anyway"** button that drops into a split
layout: letterboxed battlefield on top, permanent reasoning feed below, tab bar for
Log / Setup / Units. Same renderer, shorter viewport.

Orientation is detected with `matchMedia('(orientation: portrait)')`, not a width threshold.

The portrait fallback is mandatory, not optional. `screen.orientation.lock()` is unsupported in
Safari on iOS and only works inside fullscreen on Chrome Android, so "rotate to play" is a
request that cannot be enforced. Users with rotation lock enabled would otherwise hit a dead end
where the page never works.

### Rendering

Five layers, drawn in order:

1. **Background** — rendered once to an offscreen canvas, redrawn only on resize. Sky gradient,
   sun, two blurred parallax mountain bands, treeline, ground gradient, texture streaks, dirt
   patches, grass tufts. Costs nothing per frame, which is what makes the detail affordable.
2. **Bases** — stone forts with battlements and a faction banner, accumulating cracks, smoke and
   rubble as HP drops.
3. **Units** — drawn procedurally per type, side-facing: soft ground shadow, gradient shading lit
   consistently from upper-left, HP pip above, walk bob and leg swing, recoil and muzzle flash on
   fire, death animation leaving a lingering corpse decal. Five silhouettes: rifleman, gunner
   with bipod, sprinting raider, tracked tank with turret, kneeling AT launcher.
4. **Depth** — the 5 spawn lanes the sim already uses become rows receding up the ground plane.
   Near rows draw larger and lower; draw order sorts by row so near units overlap far ones.
   Purely visual, no mechanical change.
5. **Effects** — tracers, impact sparks, dust puffs under moving units, tank exhaust smoke,
   floating damage numbers, screen shake on tank fire and base hits, vignette over everything.

### Reasoning surfaces

A pulsing "VULCAN THINKING…" indicator shows while a model is being queried — the sim is paused
there, so it is the natural beat. On response, an overlay card shows the model, its one-line read
of the battle, the units it queued, and its latency.

Everything then lands permanently in a swipe-up drawer holding the full decision history,
including failures and retries, plus the existing post-game debrief as a highlighted section.
Nothing exists only as a transient overlay — a match runs ~46 decisions per side, and reasoning
that must be caught the moment it appears would mostly be missed.

### Setup and key handling

Setup is a modal sheet: commander type and model per side, key field, test connection, load live
models, mock parameters, seed.

The OpenRouter key gains optional `localStorage` persistence behind an explicit **"remember on
this device"** checkbox, default off, with the existing warning text kept. This is a deliberate
relaxation of the current memory-only policy: typing a key on a phone every session is the
difference between usable and unusable. Default-off preserves the old behaviour for anyone who
does not opt in.

Default state on load is Scripted vs Scripted, auto-started.

## Explicitly out of scope

The simulation — `step()`, `agent()`, the lockstep decision flow, unit stats, economy — is
unchanged. This is a rendering and layout pass.

The balance baseline from `HANDOFF.md` must still hold afterwards: scripted mirror 30/30 over 60
seeds, median 182s, 0 timeouts. Since only rendering changes, it should be unaffected — but it
will be verified by running the headless harness, not assumed.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Low-end phones struggle with many units plus particles | Pool effects, cap particle count, add a quality toggle that strips FX |
| iOS landscape notch clips the battlefield | `env(safe-area-inset-left/right)`, not just bottom |
| Portrait fallback is untested surface area | Manual pass on both orientations before deploy |
| A rendering bug silently changes balance | Run the headless mirror check and compare against the baseline |

## Testing

- Headless mirror check from `HANDOFF.md` §4, compared against the 30/30 / 182s / 0-timeout baseline
- Manual: iOS Safari landscape and portrait, Chrome Android, desktop browser
- Mock LLM commander to exercise latency, dropped calls and malformed output without spending money
- Confirm no API key is present in the committed file

## Deployment

Commit and push to `origin/main` on `rsumit123/skdev-one`; Vercel auto-deploys. Push credentials
are already stored and verified — no Vercel token or CLI auth required.
