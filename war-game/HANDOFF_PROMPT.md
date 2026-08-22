# Handoff prompt — paste this to the new LLM to start a dev session

You are taking over development of **Breach**, a browser wargame that is really a
**benchmark harness** measuring which LLM reasons better about counters, tempo,
economy, and map control. Two models command opposing armies down one 80 m lane.
It is live at https://skdev.one/war-game.

## Do this first, before any change
1. Read `war-game/DEVELOPMENT.md` end to end — it is the current-state map, the
   workflow, and the hard-won lessons. Then skim `war-game/HANDOFF.md` for the
   deeper balance history.
2. Understand the layout: the whole game is one self-contained file,
   `war-game/index.html` (inline `<script>`, no build step). The backend is a
   separate repo, `~/work/breach-api/` (SQLite + Docker, live at
   `https://breach-api.skdev.one`).

## How you must work (standing rules from the owner)
- **You are authorized to implement, verify, commit, and push to `main` without
  waiting for approval** ("proceed with the dev and auto push, don't wait for my
  go ahead"). Pushing to `main` auto-deploys via Vercel.
- **Every change to `index.html` runs the verification ritual in DEVELOPMENT.md §4**
  before commit: syntax check, duplicate-function-name check, secret scan
  (`sk-or-v1-*` must never be committed), and — if you touched the sim — the
  balance gate `node war-game/bench.js gate`. After pushing, poll
  `https://skdev.one/war-game` until your change is live.
- **Never claim something works without showing the test output.** If a test
  fails or a measurement is unfaithful, say so plainly and immediately. This
  project has a strict evidence-before-assertions culture.
- **Balance is judged by `bench.js`, never by a single game or a mirror alone**
  (single games are noise; a mirror can't detect a dominant strategy). Run
  `full`, confirm the `control` archetype scores ~50% (harness sanity), the
  mirror is even, and nothing new is dominant (>65%). Re-`record` the baseline
  only after an *intended* balance change.
- Keep experimental/unproven work on a branch; only merge validated work to `main`.
- The owner plays mostly on mobile landscape — keep it mobile-first. Keep the
  model-vs-model benchmark uncontaminated by human-facing play features.

## Prime directive
A mechanic earns its place only if a *better reasoner reliably wins because of
it*. Prefer depth (new decision axes) over width (more counter-pair units) —
three unit experiments (trenches, air, medic) taught that adding units mostly
fails. The neutral tower (v8) worked because it added positioning + a stance
command, not another unit.

Start by confirming you've read DEVELOPMENT.md and summarizing the current game
state (units, economy, tower, memory/dossiers, the open `stall` exploit) back to
the owner, then ask what to build.
