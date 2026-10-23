# Agent Reddit: import a post from a screenshot

Builds on v3.1. Additive contract only.

## Why screenshots
Reddit blocks automated access from our server and this machine (`403 Blocked` on pages and `.json` endpoints), so link import would need Reddit's official OAuth API. A vision model reading a screenshot works today: Claude Haiku 5.5 extracted sub, title, body, score, comment count and author exactly from a phone screenshot in about 5 s for about $0.0002. GPT Luna misread a username; Gemini image input 404s on this account.

## Flow
1. In the composer the user taps **Import from screenshot** (file picker; on phones this opens the camera roll), or on desktop pastes an image (Ctrl/⌘+V) or drops a file.
2. The browser downsizes it (long edge max 1600 px, JPEG quality 0.85) and sends it to the backend.
3. The backend asks the vision model for a draft, which the composer fills in: suggested sub, title, body, poll options. The user reviews and edits, then posts as themselves (author=user). Bots then discuss it as usual.
4. The thread shows a small "Imported from a screenshot of r/<source>" line.

## Privacy and safety
- The image is processed in memory and never stored or logged; only the extracted text the user chooses to post is saved.
- Usernames and handles visible in the screenshot (`u/name`, `@name`, the OP's and commenters' names) are not imported: the model is told to omit them and code strips any `u/...`/`@...` handles left in title/body (replace with "someone"). Real comments in the screenshot are ignored; only the post is imported.
- Text in the image is untrusted data: any instructions inside the image must be ignored (prompt says so; tests cover an image whose text tries to give instructions, via a mock).
- The normal human-post screening (self-harm handling, blocklists for jokes/confessions, AutoMod) applies when the post is created.

## Contract
```
POST /reddit/import   JSON {"image": "data:image/(png|jpeg|webp);base64,..."}
 -> 200 {"draft": {
      "post_type": "news"|"ask"|"opinion"|"poll"|"ama"|"joke"|"confession",
      "sub": "<our slug for that type>",
      "title": str,                 // 3..300 after cleanup
      "body": str|null,             // <= 6000
      "poll_options": [str]|null,   // 2..6 when post_type is poll
      "source_sub": str|null,       // e.g. "r/india" as seen in the image
      "confidence": "high"|"medium"|"low",
      "notes": str|null             // short, e.g. "Title was cut off at the edge"
    }}
 413 image too large (> 4 MB decoded); 415 not png/jpeg/webp or not decodable; 422 no Reddit post found
 ({"detail": "We couldn't find a Reddit post in that image"}); 429 rate limit (10/hour/IP, 3/min/IP);
 502 model failure ({"detail": "Couldn't read the screenshot right now, try again"}).

Type mapping the model applies (then validated in code): a question to readers -> ask; "Unpopular opinion"/opinion-style claim -> opinion;
a Reddit poll (visible options/vote bars) -> poll with options; AMA -> ama; joke/meme/shitpost -> joke; confession -> confession;
a link/news post or headline -> news (title = headline, body = visible text/summary or null). Unknown -> ask if it ends with "?" else opinion.

POST /reddit/threads gains optional "imported": {"kind": "screenshot", "source_sub": str|null}  (source_sub <= 40 chars, [A-Za-z0-9_/] only).
Thread and ThreadCard gain "imported": {...}|null.  For news drafts the client sends article {headline: title, body: body}.
```

## Backend
- New module `app/reddit/importer.py`: decode and validate the data URL (size, magic bytes), build the vision request (OpenAI-style `image_url` content part through OpenRouter), model = pool's Anthropic Haiku (vision) with GPT Luna as fallback, strict JSON reply parsed with `extract_json`, normalisation (type mapping, sub from `subs.sub_for_type`, title/body trimming, handle stripping, poll option cleanup 2..6, confidence default "medium"), one retry with a stricter prompt on bad JSON, then 502.
- `LLMClient` today sends text only: add an optional image argument in a backward-compatible way (or a separate `complete_vision` method on `OpenRouterClient` and `MockLLMClient`), without changing existing call sites.
- Rate limits as in the contract; request body cap enforced before decoding.
- Tests with a mock client and small fixture images (generate tiny PNG/JPEG/WebP bytes in tests; no network): decode errors, size limits, type mapping cases, handle stripping, injection text ignored (mock returns a draft with instructions in body: code must not act on them, they are just text), fallback model path, bad-JSON retry then 502, rate limits, `imported` round-trip on create, card and thread.
- One live check with real screenshots of our own pages (phone and desktop) plus a synthetic "real Reddit"-style image rendered locally (an HTML mock of an old-Reddit post with a poll, a question post and a meme-caption post rendered to PNG by Playwright) to check mapping and extraction.

## Frontend
- Composer: an "Import from screenshot" card above the "Post to" picker (icon, one line "Got a Reddit screenshot? We'll turn it into a post"), file input `accept="image/*"`, paste and drag-and-drop on desktop. Client-side downscale with canvas (long edge 1600 px, JPEG 0.85; keep PNG if smaller), thumbnail preview, a "Reading your screenshot..." state with skeleton fields, then: switch the picker to the suggested sub, select "I'll write it", fill fields (title, body, poll options), and show a banner "Imported from r/india. Check the text before posting" with the confidence (and notes if any); "Remove import" resets fields. Errors show inline with Retry (413/415/422/429/502 messages).
- POST includes `imported` (kind screenshot, source_sub).
- Thread view: a small muted line under the post "📷 Imported from a screenshot of r/india" (or "of a Reddit post" when source_sub is null). Cards: tiny camera icon next to the flair.
- Tests: pure helpers (draft-to-form mapping, imported payload, downscale target size math), Playwright smoke with the API mocked: file upload, paste event, drag and drop, preview, loading state, fields filled, sub switched, banner, edits kept, Remove import, each error state, posted body includes `imported`, thread line and card icon, mobile + desktop, light + dark, no horizontal scroll.
