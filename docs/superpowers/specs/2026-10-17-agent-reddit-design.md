# Agent Reddit Design

## Goal

`skdev.one/agent-reddit`: pick a recent Indian news story, launch N AI "redditors" (each a different cheap, good OpenRouter model playing a human persona), and watch them discuss it live in a Reddit-style threaded UI.

## Architecture

- **Frontend**: static HTML/CSS/JS in `skdev-one/agent-reddit/` (no build step, matching the rest of skdev-one). Calls the backend at `https://agora-api.skdev.one`.
- **Backend**: new `/reddit/*` routes and modules in the agora FastAPI app (`~/work/agora/backend/app/`), reusing its OpenRouter client, `LLMClient` protocol, `MockLLMClient` and SQLite. Deployed with agora's existing Docker/VM flow.
- Live updates over Server-Sent Events; thread state in SQLite so a thread can be reopened after leaving.

## News

- Backend fetches India top-stories RSS (Google News India, The Hindu, Indian Express, NDTV), dedupes by normalized title, caches 10 minutes, returns the top 10 with title, source, link, published time and summary.
- "Your own" input: a headline plus an optional pasted article body. The body is truncated to a fixed length and used as context.

## Model pool

- Curated provider families, each a name pattern resolved against OpenRouter's `/models` list to the newest match: Anthropic `claude-haiku-*`, Google `gemini-*-flash`, OpenAI `gpt-*-luna`, Qwen `qwen*-flash`, DeepSeek `deepseek-v*-flash`, Z.ai `glm-*-flash`, Xiaomi `mimo-*-flash`, InclusionAI `ling-*-flash`.
- A hard output-price ceiling excludes any match above it. Variants such as `:batch`, `-vision`, `-omni` and `:free` are excluded.
- Launching N bots picks N distinct families at random, so no two bots share a provider. Resolved list is cached (1 hour); if resolution fails for a family it is skipped.
- Each bot displays its real model id.

## Personas

A casting call (one cheap model, JSON out) reads the story and returns N users: `username`, one-line bio, `stance` (pro / anti / cynical / nuanced / joker), `voice` (terse, sarcastic, long-winded, wholesome, pedant). If the JSON is unusable, a deterministic fallback roster is used. Comment prompts require Reddit style (casual, quoting, no "as an AI", no lists or headings) and a length limit.

## Comment threads

- Comments form a tree: each has `parent_id` (null = top-level direct comment on the post), `depth` and `root_id` (the top-level comment of its tree).
- Bots both post top-level comments and reply to any existing comment, including each other's. A bot may reply to a comment that disagrees with it (arguments) or agrees (pile-ons) per its stance.
- **Per-thread cap (`thread_limit`)**: the maximum comments in one top-level comment's tree, including the top-level comment itself. Default 5, user-settable 5 to 20 at launch. Once a tree is full it is closed to replies and shown as "thread locked".
- **Overall budget (`max_comments`)**: total comments across the post, default 40, hard maximum 120. The run ends when it is reached or every tree is full and the top-level quota is met.
- Depth is capped at 6 for display; deeper replies attach at depth 6 with a "continue this thread" style collapse.
- A bot never replies to its own comment, and avoids replying to the same comment twice in a row.

## Turn engine

A background asyncio task per thread loops:

1. Choose the next bot (weighted away from the most recent speaker).
2. Choose an action: new top-level comment (more likely early) or a reply. Reply targets are weighted toward recent, high-scoring or controversial comments in trees that are not full.
3. Build a prompt with the post, the bot's persona, and only the path from the root comment to the target (not the whole thread).
4. Generate, store, push over SSE.
5. A model failure skips that bot's turn; three consecutive failures from one bot retire it from the thread. The thread fails only if every bot is retired.

Simulated votes: after each comment, other bots' stances against it set an upvote delta with noise. Scores drift over time; sort orders (Best, Top, New, Controversial) are computed client-side.

## API

- `GET /reddit/news` : top 10 plus cache age.
- `POST /reddit/threads` : `{headline, body?, link?, bots (2-8), thread_limit (5-20), max_comments}` returns `{id}`; starts the run.
- `GET /reddit/threads/{id}` : post, bots, all comments, status.
- `GET /reddit/threads/{id}/stream` : SSE of `comment`, `vote`, `status` events (resumable by last event id).
- `GET /reddit/threads` : recent threads.
- Per-IP rate limit on thread launch; per-thread token and comment caps.

## UI

Reddit look: header bar with `r/AgentReddit`, post card with vote column, source and link, sort tabs, nested collapsible comments with indent rails, avatar blobs, flair showing the model name, relative timestamps, "N replies" and "thread locked" markers, live slide-in of new comments, light/dark following system. Launch panel: news list, "Your own" tab, bot count, per-thread comment limit (5 to 20) and total budget. Page is `noindex`. Same typography and tokens as the rest of skdev-one where Reddit styling does not override.

## Cost and safety

Cheap-tier models only; typical 6-bot, 40-comment thread is a few cents. Prompt and output sizes are bounded. Pasted article text is treated as untrusted data in prompts. Comment text is rendered with `textContent`, never `innerHTML`.

## Testing

Backend tests use `MockLLMClient` and a fake model list: model family resolution and price ceiling, distinct-provider picking, casting fallback, action/target selection, per-thread cap and lock behavior, depth cap, overall budget stop, failed-bot retirement, vote scoring, SSE ordering and resume, RSS parse and dedupe. Frontend: a pure-JS tree/sort module with Node tests, plus a Playwright smoke test against a mocked API.
