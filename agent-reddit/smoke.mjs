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

// Today's paper: 30 stories (17 politics, 13 economy), paged 12 at a time.
const PAPER_TITLES = [
  'Opposition walks out as Lok Sabha passes the delimitation amendment by voice vote',
  'GST council trims rates on 40 items, states seek compensation for the shortfall',
  'Election Commission orders recount in two Bihar assembly seats after EVM mismatch',
  'Rupee slips past 87 against the dollar as foreign investors pull out of equities',
  'Supreme Court reserves verdict on governors sitting on state bills indefinitely',
  'Why the RBI is quietly letting bank credit growth cool: an explainer',
  'Kolkata civic polls: ruling party sweeps wards, opposition alleges booth capture',
  'Retail inflation eases to 3.1% on cheaper vegetables, core stays sticky',
];
const PAPER = Array.from({ length: 30 }, (_, i) => {
  const section = i % 7 === 3 || i % 2 === 1 ? 'economy' : 'politics';
  return {
    id: `p${String(i).padStart(3, '0')}`,
    title: `${PAPER_TITLES[i % PAPER_TITLES.length]}${i >= PAPER_TITLES.length ? ` (${i})` : ''}`,
    source: 'The Indian Express', link: null, published: new Date(now).toLocaleDateString('en-CA'),
    summary: 'The move drew sharp reactions across party lines, with officials defending the timing while critics said the fine print leaves several questions unanswered for states and taxpayers alike.',
    body: `Story ${i} opening paragraph. The government said on Thursday that the measure would be rolled out in phases, beginning with the larger states.\n\nOfficials familiar with the discussions said the finance ministry had raised concerns about the revenue impact, which could run into several thousand crore in the first year. <script>alert(1)</script>`,
    section, kind: ['news', 'news', 'analysis', 'news', 'opinion'][i % 5], page: 1 + (i % 14),
    byline: i % 3 === 0 ? null : ['Liz Mathew', 'Aanchal Magazine', 'Express News Service'][i % 3],
    dateline: i % 4 === 0 ? null : ['New Delhi', 'Kolkata', 'Mumbai', 'Patna'][i % 4],
  };
});
const PAPER_COUNTS = { politics: PAPER.filter(p => p.section === 'politics').length, economy: PAPER.filter(p => p.section === 'economy').length, total: PAPER.length };
const PAPERS = { papers: [{ slug: 'indian-express-kolkata-2026-10-17', label: 'The Indian Express, Kolkata, 17 Oct 2026', source: 'The Indian Express', date: '2026-10-17', counts: PAPER_COUNTS }] };
const LIVE_20 = Array.from({ length: 20 }, (_, i) => ({ ...NEWS[i % 10], id: `live${i}`, title: `${NEWS[i % 10].title} [${i}]` }));

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
// /reddit/news is paged per the API contract; `newsHook(q, n)` may delay a request or
// return { status } to fail it. Every news request is recorded in st.news as { feed, offset, limit, section }.
async function mockApi(page, { streams, threadGet = () => ({ status: 200, body: thread('running', BASE_COMMENTS) }), down = false,
  papers = PAPERS, paperItems = PAPER, liveItems = NEWS, newsHook = null } = {}) {
  const st = { streamCalls: 0, posts: [], news: [] };
  await page.route(`${MOCK}/**`, async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (down) return route.abort('connectionrefused');
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const json = (status, body) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/reddit/papers') return json(200, papers);
    if (url.pathname === '/reddit/news') {
      const sp = url.searchParams;
      const q = { feed: sp.get('feed'), offset: Number(sp.get('offset')), limit: Number(sp.get('limit')), section: sp.get('section') };
      const n = st.news.push(q) - 1;
      if (newsHook) { const r = await newsHook(q, n); if (r?.status) return json(r.status, { detail: 'boom' }); }
      const isPaper = q.feed === 'paper';
      const all = isPaper ? paperItems.filter(it => !q.section || it.section === q.section) : liveItems;
      const items = all.slice(q.offset, q.offset + q.limit);
      const next = q.offset + q.limit < all.length ? q.offset + q.limit : null;
      return json(200, { cached_age_s: 120, items, total: all.length, next_offset: next, feed: isPaper ? 'paper' : 'live',
        paper: isPaper ? { slug: papers.papers[0]?.slug, label: papers.papers[0]?.label } : null });
    }
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
      await page.locator('#tab-news').click();
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

  // ---------------- today's paper: default tab, infinite scroll, excerpt, launch (360x740)
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, colorScheme: 'light', deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    const page2 = deferred();
    const PAPER_SRC = 'The Indian Express (print, p. 2)';
    const st = await mockApi(page, {
      newsHook: async q => { if (q.feed === 'paper' && q.offset === 12 && !q.section) await page2.p; },
      streams: [() => ({ body: sse([['snapshot', { ...thread('done', BASE_COMMENTS), headline: PAPER[1].title, body: PAPER[1].body, source: PAPER_SRC, link: null }]]) })],
    });
    await page.goto(`${BASE}?api=${encodeURIComponent(MOCK)}`);
    const cards = () => page.locator('.paper-card').count();

    await check("Today's paper is the default tab, with label, count and section chips", async () => {
      await page.waitForSelector('.paper-card');
      assert.deepEqual(await page.locator('.tabs .tab').allTextContents(), ["Today's paper", 'Live India news', 'Your own']);
      assert.equal(await page.getAttribute('#tab-paper', 'aria-selected'), 'true');
      assert.equal(await page.locator('.paper-label').textContent(), 'The Indian Express, Kolkata, 17 Oct 2026');
      assert.ok((await page.locator('.feed-head .feed-meta').textContent()).includes('30 stories'));
      assert.deepEqual(await page.locator('.fchip').allTextContents(), ['All30', `Politics${PAPER_COUNTS.politics}`, `Economy${PAPER_COUNTS.economy}`]);
      assert.equal(await page.getAttribute('.fchip[data-section=all]', 'aria-pressed'), 'true');
    });
    await check('first page shows exactly 12 paper cards from offset 0', async () => {
      assert.equal(await cards(), 12);
      assert.deepEqual(st.news[0], { feed: 'paper', offset: 0, limit: 12, section: null });
    });
    await check('paper card meta: source, section and kind pills, page, date, byline; no link', async () => {
      const meta = await page.locator('.paper-card').nth(0).locator('.post-meta').textContent();
      for (const bit of ['The Indian Express', 'Politics', 'p. 1', 'today']) assert.ok(meta.includes(bit), `meta "${meta}" lacks ${bit}`);
      assert.equal(await page.locator('.paper-card').nth(2).locator('.kind-pill').textContent(), 'Analysis');
      assert.equal(await page.locator('.paper-card').nth(1).locator('.byline').textContent(), 'Aanchal Magazine · Kolkata');
      assert.equal(await page.locator('.paper-card a').count(), 0);
    });
    await check('Read excerpt shows the full body as text without picking the card', async () => {
      const card = page.locator('.paper-card').nth(0);
      assert.ok(await card.locator('.excerpt').isHidden());
      await card.locator('.excerpt-toggle').click();
      assert.ok(await card.locator('.excerpt').isVisible());
      assert.equal(await card.locator('.excerpt-toggle').getAttribute('aria-expanded'), 'true');
      assert.ok((await card.locator('.excerpt').textContent()).includes('<script>alert(1)</script>'));
      assert.equal(await card.locator('.excerpt script').count(), 0);
      assert.equal(await page.locator('.news-card.is-selected').count(), 0);
      await page.screenshot({ path: join(SHOTS, 'paper-excerpt-360-light.png'), fullPage: false });
      await card.locator('.excerpt-toggle').click();
      assert.ok(await card.locator('.excerpt').isHidden());
    });
    await check('selecting a paper story shows its headline in the launch panel', async () => {
      await page.locator('.paper-card').nth(1).locator('.post-title').click();
      assert.equal(await page.locator('.news-card.is-selected').getAttribute('data-id'), 'p001');
      assert.equal(await page.locator('#sel-title').textContent(), PAPER[1].title);
      assert.equal(await page.locator('#launch-btn').isDisabled(), false);
    });
    await check('scrolling to the bottom requests offset 12 and shows a loading row', async () => {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.locator('.feed-loading').waitFor();
      assert.ok((await page.locator('.feed-loading').textContent()).includes('Loading more stories'));
      assert.deepEqual(st.news[1], { feed: 'paper', offset: 12, limit: 12, section: null });
      assert.equal(st.news.length, 2, 'no duplicate request while one is in flight');
      await page.locator('.feed-foot').scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, 150));
      await page.screenshot({ path: join(SHOTS, 'paper-loading-360-light.png'), fullPage: false });
      page2.resolve();
      await page.waitForFunction(() => document.querySelectorAll('.paper-card').length === 24);
    });
    await check('keeps paging to the end: offsets 0/12/24, exactly 30 unique cards, caught-up row', async () => {
      for (let i = 0; i < 20 && !(await page.locator('.feed-end').count()); i++) {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(150);
      }
      await page.locator('.feed-end').waitFor();
      assert.ok((await page.locator('.feed-end').textContent()).includes("You're all caught up"));
      const ids = await page.locator('.paper-card').evaluateAll(cs => cs.map(c => c.dataset.id));
      assert.equal(ids.length, 30);
      assert.equal(new Set(ids).size, 30);
      assert.deepEqual(ids, PAPER.map(p => p.id));
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(400);
      assert.deepEqual(st.news.map(q => q.offset), [0, 12, 24]);
    });
    await check('selection survives paging (one selected card, still p001)', async () => {
      const sel = await page.locator('.news-card.is-selected').evaluateAll(cs => cs.map(c => c.dataset.id));
      assert.deepEqual(sel, ['p001']);
      assert.equal(await page.locator('#sel-title').textContent(), PAPER[1].title);
    });
    await check('no horizontal scroll 360 paper feed fully loaded', () => noHScroll(page, '360 paper'));
    await page.screenshot({ path: join(SHOTS, 'paper-end-360-light.png'), fullPage: false });
    await check('launching a paper story posts its full body and print source', async () => {
      await page.locator('#launch-btn').click();
      await page.waitForURL(u => new URL(u).searchParams.get('t') === THREAD_ID);
      assert.equal(st.posts.length, 1);
      const { headline, body, source, link } = st.posts[0];
      assert.deepEqual({ headline, body, source, link }, { headline: PAPER[1].title, body: PAPER[1].body, source: PAPER_SRC, link: null });
    });
    await check('thread post shows the print source sensibly', async () => {
      await page.locator('.post-full .post-title').waitFor();
      const meta = await page.locator('.post-full .post-meta').textContent();
      assert.ok(meta.includes('Posted by u/The_Indian_Express') && meta.includes('print, p. 2'), meta);
      assert.equal(await page.locator('.post-full .post-link').count(), 0);
      assert.ok((await page.locator('.post-full .post-text').textContent()).includes('Story 1 opening paragraph'));
    });
    await page.screenshot({ path: join(SHOTS, 'thread-paper-360-light.png'), fullPage: false });
    await ctx.close();
  }

  // ---------------- section chips, stale responses, failed page + Retry (768x1024 dark)
  {
    const ctx = await browser.newContext({ viewport: { width: 768, height: 1024 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    let holdPolitics = null;
    let failNext = true;
    const st = await mockApi(page, {
      streams: [doneStream],
      newsHook: async q => {
        if (q.section === 'politics' && holdPolitics) await holdPolitics.p;
        if (q.feed === 'paper' && !q.section && q.offset === 12 && failNext) { failNext = false; return { status: 500 }; }
      },
    });
    await page.goto(`${BASE}?api=${encodeURIComponent(MOCK)}`);
    await page.waitForSelector('.paper-card');
    const sections = () => page.locator('.paper-card').evaluateAll(cs => cs.map(c => c.dataset.section));
    await check('section chip refetches from offset 0 with the section param', async () => {
      await page.locator('.fchip[data-section=economy]').click();
      await page.waitForFunction(() => document.querySelector('.paper-card')?.dataset.section === 'economy');
      const q = st.news.find(x => x.section === 'economy');
      assert.deepEqual(q, { feed: 'paper', offset: 0, limit: 12, section: 'economy' });
      const secs = await sections();
      assert.ok(secs.length >= 12 && secs.every(x => x === 'economy'), String(secs));
      assert.equal(await page.getAttribute('.fchip[data-section=economy]', 'aria-pressed'), 'true');
      assert.equal(await page.getAttribute('.fchip[data-section=all]', 'aria-pressed'), 'false');
      assert.ok((await page.locator('.feed-head .feed-meta').textContent()).includes(`${PAPER_COUNTS.economy} stories`));
    });
    await check('a slow response for an abandoned chip is discarded', async () => {
      holdPolitics = deferred();
      await page.locator('.fchip[data-section=politics]').click();
      await page.waitForFunction(() => document.querySelector('.fchip[data-section=politics]')?.getAttribute('aria-pressed') === 'true');
      for (let i = 0; i < 50 && !st.news.some(x => x.section === 'politics'); i++) await page.waitForTimeout(20);
      await page.locator('.fchip[data-section=all]').click();
      await page.waitForFunction(() => document.querySelectorAll('.paper-card').length === 12);
      holdPolitics.resolve();
      await page.waitForTimeout(500);
      const ids = await page.locator('.paper-card').evaluateAll(cs => cs.map(c => c.dataset.id));
      assert.deepEqual(ids, PAPER.slice(0, 12).map(p => p.id));
      assert.equal(await page.getAttribute('.fchip[data-section=all]', 'aria-pressed'), 'true');
    });
    await check('a failed page shows "Couldn\'t load more · Retry" and Retry loads it', async () => {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.locator('.feed-err').waitFor();
      assert.ok((await page.locator('.feed-err').textContent()).includes("Couldn't load more"));
      assert.equal(await page.locator('.paper-card').count(), 12);
      await page.screenshot({ path: join(SHOTS, 'paper-error-768-dark.png'), fullPage: false });
      await page.locator('.feed-err .feed-retry').click();
      await page.waitForFunction(() => document.querySelectorAll('.paper-card').length === 24);
      assert.equal(await page.locator('.feed-err').count(), 0);
      const ids = await page.locator('.paper-card').evaluateAll(cs => cs.map(c => c.dataset.id));
      assert.equal(new Set(ids).size, 24);
    });
    await ctx.close();
  }

  // ---------------- live tab pages too; no papers -> live is the default (1440x900)
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    const live2 = deferred();
    const st = await mockApi(page, {
      streams: [doneStream], papers: { papers: [] }, liveItems: LIVE_20,
      newsHook: async q => { if (q.feed === 'live' && q.offset === 12) await live2.p; },
    });
    await page.goto(`${BASE}?api=${encodeURIComponent(MOCK)}`);
    await check('with no paper today, live news is the default and the paper tab is hidden', async () => {
      await page.waitForSelector('.news-card');
      assert.equal(await page.locator('#tab-paper').count(), 0);
      assert.equal(await page.getAttribute('#tab-news', 'aria-selected'), 'true');
      assert.equal(st.news.some(q => q.feed === 'paper'), false);
    });
    await check('live tab pages with offset/limit and ends caught up', async () => {
      assert.equal(await page.locator('.news-card').count(), 12);
      assert.deepEqual(st.news[0], { feed: 'live', offset: 0, limit: 12, section: null });
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.locator('.feed-loading').waitFor();
      live2.resolve();
      await page.locator('.feed-end').waitFor();
      assert.equal(await page.locator('.news-card').count(), 20);
      assert.deepEqual(st.news.map(q => [q.feed, q.offset]), [['live', 0], ['live', 12]]);
    });
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
      await page.waitForSelector('.paper-card');
      await page.locator('.news-card').nth(1).click();
      await page.evaluate(() => document.fonts.ready);
      await check(`no horizontal scroll ${w}x${hgt} ${scheme} home`, () => noHScroll(page, `${w} ${scheme} home`));
      await page.screenshot({ path: join(SHOTS, `home-${w}-${scheme}.png`), fullPage: false });
      await page.screenshot({ path: join(SHOTS, `home-${w}-${scheme}-full.png`), fullPage: true });
      if (scheme === 'light' || w === 360) {
        await page.locator('.paper-card').nth(1).locator('.excerpt-toggle').click();
        await page.screenshot({ path: join(SHOTS, `home-excerpt-${w}-${scheme}.png`), fullPage: false });
        await page.locator('#tab-news').click();
        await page.waitForSelector('.news-card:not(.paper-card)');
        await page.screenshot({ path: join(SHOTS, `home-live-${w}-${scheme}.png`), fullPage: false });
        await page.locator('#tab-paper').click();
      }
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
