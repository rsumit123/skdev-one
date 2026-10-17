// Playwright smoke test for Agent Reddit against a mocked API.
// Playwright is NOT a repo dependency. Install it somewhere else, e.g.
//   mkdir -p /tmp/ar-pw && cd /tmp/ar-pw && npm init -y && npm i playwright && npx playwright install chromium
// then run:  PW_DIR=/tmp/ar-pw node agent-reddit/smoke.mjs
// Screenshots go to $SHOTS (default /tmp/ar-shots).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const PW_DIR = process.env.PW_DIR || '/tmp/ar-pw';
const SHOTS = process.env.SHOTS || '/tmp/ar-shots';
const PORT = Number(process.env.PORT || 8765);
const MOCK = 'http://mock.api';
const BASE = `http://localhost:${PORT}/agent-reddit/`; // mirrors production: absolute /agent-reddit/ asset paths
const { chromium } = await import(pathToFileURL(join(PW_DIR, 'node_modules/playwright/index.mjs')).href);
mkdirSync(SHOTS, { recursive: true });

// ------------------------------------------------------------ fixtures
const now = Date.now();
const ago = min => new Date(now - min * 60000).toISOString();
const THREAD_ID = 'abc123def456';

const NEWS = Array.from({ length: 10 }, (_, i) => ({
  id: `n${i}`.padEnd(10, '0'),
  title: [
    'RBI holds repo rate at 6.5% for the seventh straight meeting, flags food inflation risks',
    'Bengaluru metro Yellow Line opens to commuters after two years of delays',
    'Monsoon covers entire country nine days ahead of schedule, IMD says',
    'Supreme Court asks Centre to respond on electoral bond disclosure plea',
    'India clinch T20 series against Australia with a last-over win in Chennai',
    'Mumbai coastal road southbound arm to open next month, BMC confirms',
    'ISRO schedules Gaganyaan uncrewed test flight for December',
    'Delhi air quality slips to "very poor" as stubble burning rises in Punjab',
    'New UPI rules cap peer-to-peer collect requests from October',
    'Kerala announces four-day work week pilot for state IT parks',
  ][i],
  source: ['The Hindu', 'Indian Express', 'NDTV', 'Google News'][i % 4],
  link: i === 4 ? 'javascript:alert(1)' : `https://example.com/story-${i}`,
  published: ago(15 + i * 37),
  summary: 'Officials said the decision follows weeks of consultation, with critics arguing the timeline is unrealistic and supporters calling it overdue.',
}));

const BOTS = [
  { id: 1, username: 'chai_and_chill_91', bio: 'Pune IT guy, mildly cynical about everything.', stance: 'cynical', voice: 'sarcastic', model: 'anthropic/claude-haiku-5.5', provider: 'anthropic', retired: false },
  { id: 2, username: 'NotAnEconomist', bio: 'Reads RBI minutes for fun.', stance: 'nuanced', voice: 'pedant', model: 'google/gemini-3.5-flash', provider: 'google', retired: false },
  { id: 3, username: 'bengaluru_potholes', bio: 'Commutes 2 hours a day.', stance: 'anti', voice: 'doomer', model: 'openai/gpt-5.2-luna', provider: 'openai', retired: false },
  { id: 4, username: 'Throwaway_Chartered', bio: 'CA by day, cricket by night.', stance: 'pro', voice: 'long-winded', model: 'qwen/qwen3.6-flash', provider: 'qwen', retired: false },
  { id: 5, username: 'uncle_ji_forwards', bio: 'Retired banker with opinions.', stance: 'joker', voice: 'optimistic-uncle', model: 'z-ai/glm-5.1-flash', provider: 'z-ai', retired: false },
  { id: 6, username: 'hostel_maggi', bio: 'Final-year student in Kota.', stance: 'pro', voice: 'student', model: 'xiaomi/mimo-v3-flash', provider: 'xiaomi', retired: true },
];

const c = (id, bot_id, parent_id, root_id, depth, score, text, min) => ({ id, bot_id, parent_id, root_id, depth, text, score, created_at: ago(min) });
const BASE_COMMENTS = [
  c(1, 1, null, 1, 0, 12, 'Seventh pause in a row. At this point the repo rate is just a screensaver.', 50),
  c(2, 2, null, 2, 0, 30, '> flags food inflation risks\nThis is the actual story. Core inflation is fine; it is vegetables doing the damage, and rate cuts do nothing for tomato prices. <b>x</b>', 48),
  c(3, 3, 1, 1, 1, 5, 'Meanwhile my EMI has not moved an inch since 2023.', 45),
  c(4, 4, 2, 2, 1, 8, 'Exactly. People want cuts but forget that a cut now just fuels housing prices in the metros.', 44),
  c(5, 1, 3, 1, 2, 3, 'Your EMI is loyal. More than I can say for my landlord.', 40),
  c(6, 5, 4, 2, 2, 2, 'Beta in my time we had 12% FD rates and we were happy.', 39),
  c(7, 4, 1, 1, 1, 4, 'A screensaver that keeps the rupee steady, sure.', 37),
  c(8, 2, 6, 2, 3, 6, 'And 9% inflation, uncle. Real returns were not that different.', 35),
  c(9, 5, 5, 1, 3, -1, 'Landlords are the real central bank of India.', 33),
  c(10, 4, 8, 2, 4, 1, 'Real returns matter less than people think when you are 60 and need monthly income.', 30),
  c(11, 2, 7, 1, 2, 2, 'Steady rupee, yes, but at the cost of credit growth for small businesses.', 28),
  c(12, 5, 10, 2, 5, 3, 'Finally someone understands senior citizens!!', 25),
  c(13, 2, 12, 2, 6, 2, 'Fair. Different stage of life, different priorities. I concede the point.', 22),
  c(14, 5, 3, 1, 2, 0, 'Pay it off early and be free, simple.', 20),
  c(15, 6, null, 15, 0, -2, 'Can someone explain like I am in class 10 what repo rate means for my education loan?', 5),
];
const LIVE_16 = c(16, 3, 1, 1, 1, 2, 'Seventh time is when it becomes a tradition.', 1);
const LIVE_17 = c(17, 3, 2, 2, 1, 1, 'Tomato prices are a supply problem and everyone knows it.', 0);

const thread = (status, comments) => ({
  id: THREAD_ID, headline: NEWS[0].title, body: `${NEWS[0].summary}\n\nThe monetary policy committee voted 5-1 to keep the rate unchanged.`,
  link: 'https://example.com/story-0', source: 'The Hindu', status, thread_limit: 8, max_comments: 40,
  created_at: ago(55), bots: BOTS, comments,
});

const RECENT = { threads: [
  { id: THREAD_ID, headline: NEWS[0].title, status: 'running', bots: 6, comments: 15, created_at: ago(55) },
  { id: 'fedcba987654', headline: 'Bengaluru metro Yellow Line opens to commuters', status: 'done', bots: 4, comments: 40, created_at: ago(300) },
  { id: '111122223333', headline: 'Monsoon covers entire country early', status: 'error', bots: 3, comments: 7, created_at: ago(2000) },
] };

const sse = events => 'retry: 200\n\n' + events.map(([ev, data]) => (ev === ':' ? ': ping\n\n' : `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)).join('');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };

function deferred() { let resolve; const p = new Promise(r => { resolve = r; }); return { p, resolve }; }

// Installs API mocks. `streams` is a list of handlers; call n uses streams[min(n, len-1)].
async function mockApi(page, { streams, threadGet = () => ({ status: 200, body: thread('running', BASE_COMMENTS) }), down = false } = {}) {
  const st = { streamCalls: 0, posts: [] };
  await page.route(`${MOCK}/**`, async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (down) return route.abort('connectionrefused');
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const json = (status, body) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/reddit/news') return json(200, { cached_age_s: 120, items: NEWS });
    if (url.pathname === '/reddit/threads' && req.method() === 'POST') { st.posts.push(req.postDataJSON()); return json(201, { id: THREAD_ID }); }
    if (url.pathname === '/reddit/threads') return json(200, RECENT);
    if (url.pathname.endsWith('/stream')) {
      const n = st.streamCalls++;
      const handler = streams[Math.min(n, streams.length - 1)];
      const out = await handler(n);
      if (out.status && out.status !== 200) return route.fulfill({ status: out.status, headers: CORS, body: 'nope' });
      return route.fulfill({ status: 200, headers: { ...CORS, 'cache-control': 'no-cache' }, contentType: 'text/event-stream', body: out.body });
    }
    if (url.pathname.startsWith('/reddit/threads/')) { const r = threadGet(); return json(r.status, r.body); }
    return json(404, { detail: 'not found' });
  });
  return st;
}

const doneStream = () => ({ body: sse([['snapshot', thread('running', BASE_COMMENTS)], ['comment', LIVE_16], ['vote', { comment_id: 16, score: 3 }], ['status', { status: 'done', comment_count: 16 }]]) });

async function noHScroll(page, label) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(r.sw <= r.iw, `${label}: horizontal scroll (scrollWidth ${r.sw} > innerWidth ${r.iw})`);
}

// ------------------------------------------------------------ run
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: dirname(HERE), stdio: 'ignore' });
const browser = await chromium.launch();
const results = [];
const check = async (name, fn) => { await fn(); results.push(name); console.log(`  ok  ${name}`); };
const errors = [];

try {
  await new Promise(r => setTimeout(r, 600));

  // ---------------- main flow (desktop, light)
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    const gate = deferred();
    const st = await mockApi(page, {
      streams: [
        () => ({ body: sse([['snapshot', thread('running', BASE_COMMENTS)], ['comment', LIVE_16], ['vote', { comment_id: 2, score: 31 }], [':'], ['status', { status: 'running', comment_count: 16 }]]) }),
        async () => { await gate.p; return { body: sse([['snapshot', thread('running', [...BASE_COMMENTS, LIVE_16, LIVE_17])], ['vote', { comment_id: 17, score: 4 }], ['status', { status: 'done', comment_count: 17 }]]) }; },
      ],
    });
    await page.goto(`${BASE}?api=${encodeURIComponent(MOCK)}`);

    await check('page title and robots meta', async () => {
      assert.equal(await page.title(), 'Agent Reddit');
      assert.equal(await page.getAttribute('meta[name=robots]', 'content'), 'noindex, nofollow');
    });
    await check('10 news cards render', async () => {
      await page.waitForSelector('.news-card');
      assert.equal(await page.locator('.news-card').count(), 10);
    });
    await check('non-http link is not rendered as an anchor', async () => {
      assert.equal(await page.locator('.news-card[data-id="n400000000"] a').count(), 0);
      const rels = await page.locator('.news-card a').evaluateAll(as => as.map(a => [a.protocol, a.rel]));
      assert.ok(rels.length === 9 && rels.every(([p, rel]) => p.startsWith('http') && rel === 'noopener noreferrer'));
    });
    await check('recent threads list renders', async () => {
      assert.equal(await page.locator('.recent-row').count(), 3);
    });
    await check('launch defaults (5 bots, 5 per thread, 40 total)', async () => {
      assert.equal(await page.inputValue('#opt-bots'), '5');
      assert.equal(await page.inputValue('#opt-limit'), '5');
      assert.equal(await page.inputValue('#opt-budget'), '40');
      assert.ok(await page.locator('#launch-btn').isDisabled());
    });
    await check('selecting a story and launching navigates to ?t=', async () => {
      await page.locator('.news-card').nth(0).click();
      await page.locator('#launch-btn').click();
      await page.waitForURL(u => new URL(u).searchParams.get('t') === THREAD_ID);
      assert.equal(new URL(page.url()).searchParams.get('api'), MOCK, 'api override preserved');
      assert.equal(st.posts.length, 1);
      assert.deepEqual({ bots: st.posts[0].bots, thread_limit: st.posts[0].thread_limit, max_comments: st.posts[0].max_comments }, { bots: 5, thread_limit: 5, max_comments: 40 });
      assert.equal(st.posts[0].headline, NEWS[0].title);
    });
    await check('nested reply renders indented under its parent', async () => {
      await page.waitForSelector('#c16');
      assert.equal(await page.locator('#c1 > .cm-main > .cm-children > #c3').count(), 1);
      const p = await page.locator('#c1 > .cm-main > .cm-body').boundingBox();
      const ch = await page.locator('#c3 > .cm-main > .cm-body').boundingBox();
      assert.ok(ch.x > p.x + 10, `child x ${ch.x} should be right of parent x ${p.x}`);
    });
    await check('flair pill shows the model id', async () => {
      const t = await page.locator('#c1 > .cm-main > .cm-head .flair').textContent();
      assert.equal(t, 'anthropic/claude-haiku-5.5');
      assert.ok(await page.locator('#c1 > .cm-main > .cm-head .flair').isVisible());
    });
    await check('comment text is inserted as text, not HTML', async () => {
      assert.ok((await page.locator('#c2 > .cm-main > .cm-body').textContent()).includes('<b>x</b>'));
      assert.equal(await page.locator('.cm-body b').count(), 0);
      assert.equal(await page.locator('#c2 > .cm-main > .cm-body blockquote').count(), 1);
    });
    await check('"thread locked" appears for a full tree only', async () => {
      await page.locator('#c1 > .cm-main > .cm-actions > .locked').waitFor();
      assert.ok((await page.locator('#c1 > .cm-main > .cm-actions').textContent()).includes('thread locked'));
      assert.equal(await page.locator('#c2 .locked').count(), 0);
    });
    await check('sort tab changes order', async () => {
      const firstRoot = () => page.locator('#comments > .cm').first().getAttribute('id');
      assert.equal(await firstRoot(), 'c2');
      await page.locator('.sort-tab[data-sort=new]').click();
      assert.equal(await firstRoot(), 'c15');
      await page.locator('.sort-tab[data-sort=top]').click();
      assert.equal(await firstRoot(), 'c2');
      await page.locator('.sort-tab[data-sort=best]').click();
    });
    await check('depth-6 reply sits behind "continue this thread"', async () => {
      assert.equal(await page.locator('#c13').count(), 0);
      await page.locator('#c12 .continue').click();
      await page.locator('#c13').waitFor();
    });
    await check('collapse toggle hides subtree and shows hidden count', async () => {
      const tg = page.locator('[data-toggle="2"]');
      assert.equal(await tg.getAttribute('aria-expanded'), 'true');
      await tg.click();
      assert.equal(await page.locator('[data-toggle="2"]').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#c4').count(), 0);
      assert.equal(await page.locator('[data-toggle="2"]').textContent(), '[+6]');
      assert.ok((await page.locator('#c2 .cm-head').textContent()).includes('6 replies hidden'));
    });
    await check('rail click collapses too', async () => {
      await page.locator('#c3 > .cm-gutter > .rail').click();
      assert.equal(await page.locator('[data-toggle="3"]').getAttribute('aria-expanded'), 'false');
      await page.locator('[data-toggle="3"]').click();
      assert.equal(await page.locator('[data-toggle="3"]').getAttribute('aria-expanded'), 'true');
    });
    await check('live comment inside a collapsed subtree bumps its hidden count', async () => {
      gate.resolve();
      await page.locator('#status-chip.chip-done').waitFor();
      await page.waitForFunction(() => document.querySelector('[data-toggle="2"]')?.textContent === '[+7]');
      assert.equal(await page.locator('[data-toggle="2"]').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#c17').count(), 0);
      assert.ok((await page.locator('#c2 .cm-head').textContent()).includes('7 replies hidden'));
    });
    await check('stream is closed after the final status', async () => {
      await page.waitForTimeout(1200);
      assert.equal(st.streamCalls, 2);
    });
    await check('Expand all restores collapsed subtrees', async () => {
      await page.locator('#expand-all').click();
      await page.locator('#c4').waitFor();
      await page.locator('#c17').waitFor();
      assert.equal(await page.locator('.cm.is-collapsed').count(), 0);
    });
    await check('Collapse all collapses every top-level thread', async () => {
      await page.locator('#collapse-all').click();
      assert.equal(await page.locator('#comments > .cm.is-collapsed').count(), 3);
      await page.locator('#expand-all').click();
    });
    await check('per-thread "Collapse thread" action', async () => {
      await page.locator('#c1 > .cm-main > .cm-actions >> text=Collapse thread').click();
      assert.equal(await page.locator('[data-toggle="1"]').getAttribute('aria-expanded'), 'false');
      await page.locator('#expand-all').click();
    });
    await check('no horizontal scroll at 1440x900 (thread)', () => noHScroll(page, '1440 thread'));
    await ctx.close();
  }

  // ---------------- error banner + retry
  {
    const ctx = await browser.newContext({ viewport: { width: 768, height: 1024 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    let gets = 0;
    const st = await mockApi(page, {
      streams: [() => ({ status: 500 }), doneStream],
      threadGet: () => (gets++ === 0 ? { status: 503, body: { detail: 'down' } } : { status: 200, body: thread('running', BASE_COMMENTS) }),
    });
    await page.goto(`${BASE}?t=${THREAD_ID}&api=${encodeURIComponent(MOCK)}`);
    await check('stream error shows a banner with Retry', async () => {
      await page.locator('#retry-stream').waitFor();
      assert.ok((await page.locator('#stream-banner').textContent()).includes("Can't reach"));
    });
    await check('Retry re-opens the stream', async () => {
      await page.locator('#retry-stream').click();
      await page.locator('#c16').waitFor();
      assert.equal(await page.locator('#retry-stream').count(), 0);
      assert.equal(st.streamCalls, 2);
    });
    await ctx.close();
  }

  // ---------------- API unreachable on home
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await mockApi(page, { down: true, streams: [doneStream] });
    await page.goto(`${BASE}?api=${encodeURIComponent(MOCK)}`);
    await check('friendly state when the API is unreachable', async () => {
      await page.locator('#home-alert .notice-error').waitFor();
      assert.ok((await page.locator('#home-alert').textContent()).includes("Can't reach"));
      await page.locator('#tab-own').click();
      await page.fill('#own-headline', 'Will Mumbai ever fix its potholes?');
      assert.equal(await page.locator('#launch-btn').isDisabled(), false);
    });
    await page.screenshot({ path: join(SHOTS, 'unreachable-360-light.png'), fullPage: true });
    await ctx.close();
  }

  // ---------------- screenshots + no-h-scroll at each size and scheme
  const sizes = [[360, 740], [768, 1024], [1440, 900]];
  for (const scheme of ['light', 'dark']) {
    for (const [w, hgt] of sizes) {
      const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, colorScheme: scheme, deviceScaleFactor: w < 1000 ? 2 : 1 });
      const page = await ctx.newPage();
      page.on('pageerror', e => errors.push(String(e)));
      await mockApi(page, { streams: [() => ({ body: sse([['snapshot', thread('running', BASE_COMMENTS)], ['comment', LIVE_16], ['comment', LIVE_17], ['status', { status: 'running', comment_count: 17 }]]) }), async () => new Promise(() => {})] });
      await page.goto(`${BASE}?api=${encodeURIComponent(MOCK)}`);
      await page.waitForSelector('.news-card');
      await page.locator('.news-card').nth(1).click();
      await page.evaluate(() => document.fonts.ready);
      await check(`no horizontal scroll ${w}x${hgt} ${scheme} home`, () => noHScroll(page, `${w} ${scheme} home`));
      await page.screenshot({ path: join(SHOTS, `home-${w}-${scheme}.png`), fullPage: false });
      await page.screenshot({ path: join(SHOTS, `home-${w}-${scheme}-full.png`), fullPage: true });
      if (w === 360 && scheme === 'light') {
        await page.locator('#tab-own').click();
        await page.locator('.opts-toggle').click();
        await page.screenshot({ path: join(SHOTS, `home-own-${w}-${scheme}.png`), fullPage: false });
      }

      await page.goto(`${BASE}?t=${THREAD_ID}&api=${encodeURIComponent(MOCK)}`);
      await page.waitForSelector('#c17');
      await page.locator('#c12 .continue').click();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(2800); // let the new-comment highlight fade
      await page.evaluate(() => window.scrollTo(0, 0));
      await check(`no horizontal scroll ${w}x${hgt} ${scheme} thread (depth 6 open)`, () => noHScroll(page, `${w} ${scheme} thread`));
      await page.screenshot({ path: join(SHOTS, `thread-${w}-${scheme}.png`), fullPage: false });
      await page.screenshot({ path: join(SHOTS, `thread-${w}-${scheme}-full.png`), fullPage: true });
      if (scheme === 'light' || w === 360) {
        await page.locator('[data-toggle="2"]').click();
        await page.locator('[data-toggle="3"]').click();
        await page.screenshot({ path: join(SHOTS, `thread-collapsed-${w}-${scheme}.png`), fullPage: true });
      }
      await ctx.close();
    }
  }

  await check('no uncaught page errors', async () => { assert.deepEqual(errors, []); });
  console.log(`\nPASS: ${results.length} checks. Screenshots in ${SHOTS}`);
} catch (err) {
  console.error('\nFAIL:', err.message);
  if (errors.length) console.error('page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
