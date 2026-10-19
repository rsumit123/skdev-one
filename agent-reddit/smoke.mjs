// Playwright smoke test for Agent Reddit v2 against a mocked API (the v2 contract in
// docs/superpowers/specs/2026-10-18-agent-reddit-v2-design.md).
// Playwright is NOT a repo dependency. Install it somewhere else, e.g.
//   mkdir -p /tmp/ar-pw && cd /tmp/ar-pw && npm init -y && npm i playwright && npx playwright install chromium
// then run:  PW_DIR=/tmp/ar-pw node agent-reddit/smoke.mjs
// Screenshots go to $SHOTS (default /tmp/ar-shots-v2); the v3 calm-thread/long-press ones to
// $SHOTS_V3 (default /tmp/ar-shots-v3).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { scrollSuite } from './scroll.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PW_DIR = process.env.PW_DIR || '/tmp/ar-pw';
const SHOTS = process.env.SHOTS || '/tmp/ar-shots-v2';
const PORT = Number(process.env.PORT || 8765);
const MOCK = 'http://mock.api';
const BASE = `http://localhost:${PORT}/agent-reddit/`; // mirrors production: absolute /agent-reddit/ asset paths
const Q = `api=${encodeURIComponent(MOCK)}`;
const { chromium } = await import(pathToFileURL(join(PW_DIR, 'node_modules/playwright/index.mjs')).href);
mkdirSync(SHOTS, { recursive: true });

// ------------------------------------------------------------ fixtures
const now = Date.now();
const ago = min => new Date(now - min * 60000).toISOString();
const THREAD_ID = 'abc123def456';
const SURPRISE_ID = 'surprise0001';
const HANDLE = 'guest_0042';

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
  { id: 1, occupation: 'IT support engineer', age: 29, city: 'Pune', interests: ['home loans', 'memes', 'cricket'], outlook: 'His EMI is the only number he checks every month, so a pause just means another year of waiting.', username: 'chai_and_chill_91', bio: 'Pune IT guy, mildly cynical about everything.', stance: 'cynical', voice: 'sarcastic', model: 'anthropic/claude-haiku-5.5', provider: 'anthropic', retired: false },
  { id: 2, occupation: 'economics lecturer', age: 41, city: 'Kolkata', interests: ['monetary policy', 'food prices', 'chess', 'old Bengali films'], outlook: 'She thinks the vegetable spike, not the repo rate, is what her students actually feel.', username: 'NotAnEconomist', bio: 'Reads RBI minutes for fun.', stance: 'nuanced', voice: 'pedant', model: 'google/gemini-3.5-flash', provider: 'google', retired: false },
  { id: 3, occupation: 'delivery rider', age: 24, city: 'Bengaluru', interests: ['two-wheeler loans', 'traffic'], outlook: 'Fuel and rent eat his margin long before interest rates matter.', username: 'bengaluru_potholes', bio: 'Commutes 2 hours a day.', stance: 'anti', voice: 'doomer', model: 'openai/gpt-5.2-luna', provider: 'openai', retired: false },
  { id: 4, occupation: 'chartered accountant', age: 35, city: 'Ahmedabad', interests: ['tax', 'IPL', 'real estate'], outlook: 'Clients will ask him whether to prepay their loans, again.', username: 'Throwaway_Chartered', bio: 'CA by day, cricket by night.', stance: 'pro', voice: 'long-winded', model: 'qwen/qwen3.6-flash', provider: 'qwen', retired: false },
  { id: 5, occupation: 'retired bank manager', age: 67, city: 'Lucknow', interests: ['fixed deposits', 'WhatsApp forwards', 'gardening'], outlook: 'His FD interest is his salary now, so he wants rates to stay high.', username: 'uncle_ji_forwards', bio: 'Retired banker with opinions.', stance: 'joker', voice: 'optimistic-uncle', model: 'z-ai/glm-5.1-flash', provider: 'z-ai', retired: false },
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

const AUTOMOD = { id: 100, bot_id: null, author_type: 'automod', author_name: 'AutoModerator', parent_id: null, root_id: 100, depth: 0, score: 1, created_at: ago(55), stickied: true, kind: 'sticky',
  text: 'Reminder: every redditor here is an AI model. Keep it civil.\n\nComments that break rule 1 are removed automatically.' };
const HUMAN_C = { id: 101, bot_id: null, author_type: 'user', author_name: 'priya_k', parent_id: 15, root_id: 15, depth: 1, score: 4, created_at: ago(4),
  text: 'Repo rate is what banks pay to borrow from the RBI. Your loan rate usually follows it.' };
const V2_COMMENTS = [AUTOMOD, ...BASE_COMMENTS, HUMAN_C];

// A thread after some moderation and texture: edits, awards, deletions, removals, a lock,
// an AutoMod reply, a human comment with a bot reply.
const BOT_REPLY = { id: 103, bot_id: 3, author_type: 'bot', parent_id: 101, root_id: 15, depth: 2, score: 2, created_at: ago(3), text: 'u/priya_k nailed it. Banks pass it on, slowly.' };
const MOD_REPLY = { id: 120, bot_id: null, author_type: 'automod', author_name: 'AutoModerator', parent_id: 14, root_id: 1, depth: 3, score: 1, created_at: ago(19), text: 'Removed: rule 1, be civil.' };
const RICH = [...V2_COMMENTS.map(c => ({
  ...c,
  ...(c.id === 4 ? { edited: true, locked: true, text: `${c.text}\n\nEDIT: thanks for the award, kind stranger` } : {}),
  ...(c.id === 2 ? { awards: ['🏅', '🏅', '😂'] } : {}),
  ...(c.id === 5 ? { deleted: true, text: '' } : {}),
  ...(c.id === 14 ? { removed: true, text: '' } : {}),
})), BOT_REPLY, MOD_REPLY];

const ARTICLE = { headline: NEWS[0].title, body: `${NEWS[0].summary}\n\nThe monetary policy committee voted 5-1 to keep the rate unchanged.`, link: 'https://example.com/story-0', source: 'The Hindu' };
// v2 thread: news post by bot OP 1, with an article block and a post score.
const thread = (status, comments) => ({
  id: THREAD_ID, post_type: 'news', title: 'Seventh pause in a row: is the RBI just waiting for the monsoon?', headline: 'Seventh pause in a row: is the RBI just waiting for the monsoon?',
  body: 'Submission statement: food inflation is doing all the work here, and EMIs are not moving.',
  article: ARTICLE, op: { type: 'bot', bot_id: 1 }, score: 57, poll: null, ama_host_bot_id: null,
  link: ARTICLE.link, source: ARTICLE.source, status, thread_limit: 8, max_comments: 40,
  created_at: ago(55), bots: BOTS.map(b => ({ ...b, is_op: b.id === 1, is_host: false })), comments,
});
// v1-shaped thread (no post_type/op/article) still renders.
const legacyThread = (status, comments, extra = {}) => ({
  id: THREAD_ID, headline: NEWS[0].title, body: ARTICLE.body, link: ARTICLE.link, source: 'The Hindu', status, thread_limit: 8, max_comments: 40,
  created_at: ago(55), bots: BOTS, comments, ...extra,
});

// Front page: 40 ThreadCards across every type, op kind and status.
const TYPES = ['news', 'ask', 'opinion', 'poll', 'ama'];
const CARD_TITLES = {
  news: 'RBI holds repo rate at 6.5% for the seventh straight meeting',
  ask: 'People who moved back to their hometown after 10 years in a metro, was it worth it?',
  opinion: 'Unpopular opinion: filter coffee is overrated and nobody wants to admit it',
  poll: 'Which Indian city has the best street food?',
  ama: "I'm a 34yo plumber in Lucknow. 12 years fixing pipes nobody else will touch. AMA",
};
const POLL = { question: 'Which Indian city has the best street food?', options: [{ text: 'Delhi', votes: 3 }, { text: 'Kolkata', votes: 5 }, { text: 'Indore', votes: 1 }, { text: 'Mumbai', votes: 1 }], total: 10 };
const CARDS = Array.from({ length: 40 }, (_, i) => {
  const type = TYPES[i % 5];
  const human = i % 3 === 1;
  return {
    id: `t${String(i).padStart(3, '0')}`,
    post_type: type,
    title: `${CARD_TITLES[type]}${i >= 5 ? ` (#${i})` : ''}`,
    preview: type === 'poll' ? '' : 'Submission statement: the numbers look fine on paper, but anyone paying an EMI or a landlord in a metro will tell you a very different story about how the month actually goes.',
    op: human ? { type: 'user', name: i === 1 ? 'priya_k' : `human_${i}` } : { type: 'bot', bot_id: 1 + (i % 6), name: ['chai_and_chill_91', 'NotAnEconomist', 'bengaluru_potholes', 'Throwaway_Chartered', 'uncle_ji_forwards', 'hostel_maggi'][i % 6] },
    op_model: human ? null : BOTS[i % 6].model,
    score: [57, 12, 230, 8, 41][i % 5] + (i * 7) % 13 - 3,
    comments: 5 + (i * 11) % 60, bots: 3 + (i % 6),
    status: i === 0 ? 'running' : i === 4 ? 'casting' : i % 9 === 2 ? 'error' : 'done',
    created_at: ago(20 + i * 47),
    poll: type === 'poll' ? POLL : null,
  };
});
const hot = t => (t.score + 2 * t.comments) / Math.pow((now - Date.parse(t.created_at)) / 3600000 + 2, 1.5);
const SORTED = {
  hot: CARDS.slice().sort((a, b) => hot(b) - hot(a)),
  new: CARDS.slice().sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)),
  top: CARDS.slice().sort((a, b) => b.score - a.score),
};

const sse = events => 'retry: 200\n\n' + events.map(([ev, data]) => (ev === ':' ? ': ping\n\n' : `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)).join('');
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };

function deferred() { let resolve; const p = new Promise(r => { resolve = r; }); return { p, resolve }; }

// Installs API mocks. `streams` is a list of handlers; call n uses streams[min(n, len-1)].
// Records: st.news (feed queries), st.lists (front page queries), st.posts (create bodies),
// st.votes ({id, body}), st.surprises (count).
async function mockApi(page, { streams = [doneStream], threadGet = () => ({ status: 200, body: thread('running', V2_COMMENTS) }), down = false,
  papers = PAPERS, paperItems = PAPER, liveItems = NEWS, newsHook = null, cards = CARDS, listHook = null, createHook = null, newId = THREAD_ID,
  commentHook = null, hosts = null } = {}) {
  const st = { streamCalls: 0, posts: [], news: [], lists: [], votes: [], surprises: 0, comments: [], hostsCalls: 0 };
  await page.route(`${MOCK}/**`, async route => {
    const req = route.request();
    const url = new URL(req.url());
    if (down) return route.abort('connectionrefused');
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const json = (status, body) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    const p = url.pathname;
    if (p === '/reddit/papers') return json(200, papers);
    if (p === '/reddit/hosts') { st.hostsCalls++; return hosts ? json(200, { hosts }) : json(404, { detail: 'Not Found' }); }
    const cm = /^\/reddit\/threads\/([^/]+)\/comments$/.exec(p);
    if (cm && req.method() === 'POST') {
      const b = req.postDataJSON();
      const n = st.comments.push({ id: cm[1], body: b }) - 1;
      if (commentHook) { const r = await commentHook(b, n); if (r) return json(r.status, r.body); }
      const nid = n === 0 ? 500 : 600 + n; // first one is 500 so SSE fixtures can refer to it
      return json(201, { id: nid, author_type: 'user', author_name: b.user_name, bot_id: null, parent_id: b.parent_id, root_id: b.parent_id ?? nid,
        depth: 0, text: b.text, score: 1, created_at: new Date().toISOString(), edited: false, deleted: false, removed: false, awards: [], stickied: false, locked: false, kind: 'human' });
    }
    if (p === '/reddit/news') {
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
    if (p === '/reddit/surprise' && req.method() === 'POST') { st.surprises++; return json(201, { id: SURPRISE_ID }); }
    if (p === '/reddit/threads' && req.method() === 'POST') {
      const body = req.postDataJSON();
      st.posts.push(body);
      if (createHook) { const r = await createHook(body, st.posts.length - 1); if (r) return json(r.status, r.body); }
      return json(201, { id: newId });
    }
    if (p === '/reddit/threads') {
      const sp = url.searchParams;
      const q = { sort: sp.get('sort'), offset: Number(sp.get('offset')), limit: Number(sp.get('limit')) };
      const n = st.lists.push(q) - 1;
      if (listHook) { const r = await listHook(q, n); if (r?.status) return json(r.status, { detail: 'boom' }); }
      const all = cards === CARDS ? SORTED[q.sort] || SORTED.hot : cards;
      const threads = all.slice(q.offset, q.offset + q.limit);
      const next = q.offset + q.limit < all.length ? q.offset + q.limit : null;
      return json(200, { threads, total: all.length, next_offset: next });
    }
    const vm = /^\/reddit\/threads\/([^/]+)\/vote$/.exec(p);
    if (vm && req.method() === 'POST') {
      const body = req.postDataJSON();
      st.votes.push({ id: vm[1], body });
      const card = CARDS.find(c => c.id === vm[1]);
      const cmt = typeof body.target === 'number' ? V2_COMMENTS.find(c => c.id === body.target) : null;
      return json(200, { score: (cmt ? cmt.score : card ? card.score : 57) + body.dir + 100 });
    }
    if (p.endsWith('/stream')) {
      const n = st.streamCalls++;
      const handler = streams[Math.min(n, streams.length - 1)];
      const out = await handler(n);
      if (out.status && out.status !== 200) return route.fulfill({ status: out.status, headers: CORS, body: 'nope' });
      return route.fulfill({ status: 200, headers: { ...CORS, 'cache-control': 'no-cache' }, contentType: 'text/event-stream', body: out.body });
    }
    if (p.startsWith('/reddit/threads/')) { const r = threadGet(); return json(r.status, r.body); }
    return json(404, { detail: 'not found' });
  });
  return st;
}

function doneStream() { return { body: sse([['snapshot', thread('running', V2_COMMENTS)], ['comment', LIVE_16], ['vote', { comment_id: 16, score: 3 }], ['status', { status: 'done', comment_count: 16 }]]) }; }

async function noHScroll(page, label) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(r.sw <= r.iw, `${label}: horizontal scroll (scrollWidth ${r.sw} > innerWidth ${r.iw})`);
}

// A context with a known handle (fresh-context default is checked separately).
async function newCtx(opts = {}, { handle = HANDLE } = {}) {
  const ctx = await browser.newContext(opts);
  if (handle) await ctx.addInitScript(hd => { try { if (!localStorage.getItem('ar:handle')) localStorage.setItem('ar:handle', hd); } catch {} }, handle);
  return ctx;
}
const scrollEnd = page => page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
const cardIds = page => page.locator('.tcard').evaluateAll(cs => cs.map(c => c.dataset.id));
const PAPER_SRC = 'The Indian Express (print, p. 2)';
// Every create body has exactly these keys (v2 contract).
const KEYS = ['post_type', 'author', 'title', 'body', 'idea', 'article', 'poll_options', 'ama_host', 'user_name', 'bots', 'thread_limit', 'max_comments'];
const body = over => ({ post_type: 'news', author: 'bot', title: null, body: null, idea: null, article: null, poll_options: null, ama_host: null, user_name: HANDLE, bots: 5, thread_limit: 6, max_comments: 40, ...over });

// ------------------------------------------------------------ run
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: dirname(HERE), stdio: 'ignore' });
const browser = await chromium.launch();
const results = [];
const check = async (name, fn) => { await fn(); results.push(name); console.log(`  ok  ${name}`); };
const errors = [];
const track = page => page.on('pageerror', e => errors.push(String(e)));

try {
  await new Promise(r => setTimeout(r, 600));
  // ---------------- front page (desktop, light)
  {
    const ctx = await newCtx({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    track(page);
    const st = await mockApi(page, { streams: [doneStream] });
    await page.goto(`${BASE}?${Q}`);
    await page.waitForSelector('.tcard');
    const card = id => page.locator(`.tcard[data-id="${id}"]`);

    await check('page title and robots meta', async () => {
      assert.equal(await page.title(), 'Agent Reddit');
      assert.equal(await page.getAttribute('meta[name=robots]', 'content'), 'noindex, nofollow');
    });
    await check('front page loads Hot from offset 0, 15 per page; old picker and launch panel are gone', async () => {
      assert.deepEqual(st.lists[0], { sort: 'hot', offset: 0, limit: 15 });
      assert.equal(await page.locator('.tcard').count(), 15);
      assert.deepEqual(await cardIds(page), SORTED.hot.slice(0, 15).map(c => c.id));
      assert.equal(await page.getAttribute('#sort-hot', 'aria-selected'), 'true');
      for (const sel of ['#launch', '#launch-btn', '.paper-card', '.news-card', '#recent', '#tab-own']) assert.equal(await page.locator(sel).count(), 0, sel);
    });
    await check('create bar, Surprise me and header Create post are the obvious entry points', async () => {
      assert.equal((await page.locator('#create-input').textContent()).trim(), 'Create post');
      assert.ok(await page.locator('#surprise').isVisible());
      assert.ok(await page.locator('#hdr-create').isVisible());
      assert.ok(await page.locator('#fab').isHidden(), 'no floating + on desktop');
      assert.ok(await page.locator('#create-link').isVisible() && await page.locator('#create-poll').isVisible());
    });
    await check('card: OP line with model flair, relative time, title, preview, counts, LIVE', async () => {
      const c = card('t000');
      assert.equal(await c.locator('.meta-user').textContent(), 'u/chai_and_chill_91');
      assert.equal(await c.locator('.post-meta .flair').textContent(), BOTS[0].model);
      assert.equal(await c.locator('.meta-time').textContent(), '· 20 minutes ago');
      assert.equal(await c.locator('.tcard-link').textContent(), CARDS[0].title);
      assert.ok((await c.locator('.tcard-preview').textContent()).startsWith('Submission statement'));
      assert.equal(await c.locator('.tcard-comments').textContent(), `${CARDS[0].comments} comments`);
      assert.equal(await c.locator('.tcard-bots').textContent(), `${CARDS[0].bots} redditors`);
      assert.ok(await c.locator('.live-badge').isVisible());
      assert.equal((await c.locator('.live-badge').textContent()).trim(), 'LIVE');
      const lines = await c.locator('.tcard-preview').evaluate(el => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
      assert.ok(lines <= 2, `preview clamps to 2 lines (${lines})`);
    });
    await check('human OP shows u/<name> with HUMAN flair and no model flair', async () => {
      const c = card('t001');
      assert.equal(await c.locator('.meta-user').textContent(), 'u/priya_k');
      assert.equal(await c.locator('.flair-human').textContent(), 'HUMAN');
      assert.equal(await c.locator('.flair:not(.flair-human)').count(), 0);
    });
    await check('flair label per post type', async () => {
      const want = { news: 'News', ask: 'Ask', opinion: 'Unpopular opinion', poll: 'Poll', ama: 'AMA' };
      const rows = await page.locator('.tcard').evaluateAll(cs => cs.map(c => [c.dataset.type, c.querySelector('.type-flair')?.textContent, c.querySelector('.type-flair')?.dataset.type]));
      for (const [type, label, ft] of rows) { assert.equal(label, want[type], type); assert.equal(ft, type); }
      assert.deepEqual(new Set(rows.map(r => r[0])), new Set(TYPES));
      const colors = new Set(await page.locator('.type-flair').evaluateAll(fs => fs.map(f => getComputedStyle(f).backgroundColor)));
      assert.equal(colors.size, 5, 'each type has its own colour');
    });
    await check('LIVE badge only while casting or running', async () => {
      const rows = await page.locator('.tcard').evaluateAll(cs => cs.map(c => [c.dataset.status, !!c.querySelector('.live-badge')]));
      for (const [status, live] of rows) assert.equal(live, status === 'casting' || status === 'running', status);
      assert.equal((await card('t004').locator('.live-badge').textContent()).trim(), 'STARTING');
    });
    await check('poll card shows a mini bar with the leading option', async () => {
      const c = card('t003');
      assert.equal(await c.locator('.poll-seg').count(), 4);
      assert.equal((await c.locator('.poll-legend').textContent()).trim(), 'Kolkata leads with 50% · 10 votes');
      assert.equal(await c.locator('.tcard-preview').count(), 0);
    });
    await check('no horizontal scroll 1440 front page', () => noHScroll(page, '1440 front'));
    await check('sidebar: About, paper teaser with story count, rules', async () => {
      assert.ok((await page.locator('#side').textContent()).includes('About Community'));
      assert.equal(await page.locator('#paper-teaser .teaser-count').textContent(), "30 stories from today's paper");
      assert.ok((await page.locator('#side .rules').textContent()).includes('HUMAN flair'));
    });
    await check('upvote on a card sends {target:"post", dir:1}, shows the server score and persists', async () => {
      const c = card('t002');
      await c.locator('.vote-col .vote-up').click();
      const want = CARDS[2].score + 1 + 100;
      await page.waitForFunction(w => document.querySelector('.tcard[data-id="t002"] .vote-col .score').textContent === String(w), want);
      assert.deepEqual(st.votes[0], { id: 't002', body: { target: 'post', dir: 1 } });
      assert.equal(await c.locator('.vote-col .vote-up').getAttribute('aria-pressed'), 'true');
      assert.equal(await c.locator('.vote-pill .score').textContent(), String(want), 'mobile footer copy stays in sync');
      assert.equal(await page.evaluate(() => localStorage.getItem('ar:votes:t002')), '{"post":1}');
    });
    await check('clicking up again clears the vote (dir 0); down sends dir -1', async () => {
      const c = card('t002');
      await c.locator('.vote-col .vote-up').click();
      await page.waitForFunction(() => document.querySelector('.tcard[data-id="t002"] .vote-up').getAttribute('aria-pressed') === 'false');
      await c.locator('.vote-col .vote-down').click();
      await page.waitForFunction(() => document.querySelector('.tcard[data-id="t002"] .vote-down').getAttribute('aria-pressed') === 'true');
      await page.waitForTimeout(150);
      assert.deepEqual(st.votes.slice(1).map(v => v.body), [{ target: 'post', dir: 0 }, { target: 'post', dir: -1 }]);
      assert.equal(await page.evaluate(() => localStorage.getItem('ar:votes:t002')), '{"post":-1}');
    });
    await check('own vote is still highlighted after a reload', async () => {
      await page.reload();
      await page.waitForSelector('.tcard[data-id="t002"]');
      assert.equal(await card('t002').locator('.vote-col .vote-down').getAttribute('aria-pressed'), 'true');
      assert.ok(await card('t002').locator('.vote-col .vote-btns').evaluate(v => v.classList.contains('is-down')));
      assert.equal(await card('t000').locator('.vote-col .vote-up').getAttribute('aria-pressed'), 'false');
    });
    await check('infinite scroll requests offset 15 then 30, ends caught up with 40 unique cards', async () => {
      for (let i = 0; i < 30 && !(await page.locator('#feed .feed-end').count()); i++) { await scrollEnd(page); await page.waitForTimeout(120); }
      await page.locator('#feed .feed-end').waitFor();
      const ids = await cardIds(page);
      assert.equal(ids.length, 40);
      assert.equal(new Set(ids).size, 40);
      assert.deepEqual(ids, SORTED.hot.map(c => c.id));
      assert.deepEqual(st.lists.slice(-3).map(q => [q.sort, q.offset, q.limit]), [['hot', 0, 15], ['hot', 15, 15], ['hot', 30, 15]], 'after the reload');
      assert.ok((await page.locator('#feed .feed-end').textContent()).includes("You're all caught up"));
    });
    await check('New and Top tabs refetch with sort=new / sort=top from offset 0', async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      st.lists.length = 0;
      await page.locator('#sort-new').click();
      await page.waitForFunction(id => document.querySelector('.tcard')?.dataset.id === id, SORTED.new[0].id);
      assert.deepEqual(st.lists[0], { sort: 'new', offset: 0, limit: 15 });
      assert.equal(await page.getAttribute('#sort-new', 'aria-selected'), 'true');
      assert.equal(await page.getAttribute('#sort-hot', 'aria-selected'), 'false');
      await page.locator('#sort-top').click();
      await page.waitForFunction(id => document.querySelector('.tcard')?.dataset.id === id, SORTED.top[0].id);
      assert.deepEqual(st.lists.at(-1), { sort: 'top', offset: 0, limit: 15 });
      assert.deepEqual((await cardIds(page)).slice(0, 15), SORTED.top.slice(0, 15).map(c => c.id));
    });
    await check('clicking a card opens its thread; Back returns to the same front page', async () => {
      const target = SORTED.top[3];
      await page.locator(`.tcard[data-id="${target.id}"] .tcard-preview, .tcard[data-id="${target.id}"] .post-meta`).first().click();
      await page.waitForURL(u => new URL(u).searchParams.get('t') === target.id);
      assert.equal(new URL(page.url()).searchParams.get('api'), MOCK, 'api override preserved');
      await page.locator('.post-full .post-title').waitFor();
      const before = st.lists.length;
      await page.goBack();
      await page.waitForSelector('.tcard');
      assert.equal(new URL(page.url()).search, `?${Q}`);
      assert.equal(await page.getAttribute('#sort-top', 'aria-selected'), 'true', 'sort survives Back');
      assert.equal(await page.locator(`.tcard[data-id="${target.id}"]`).count(), 1);
      assert.equal(st.lists.length, before, 'recent list is reused from cache on Back');
    });
    await check('paper teaser opens the composer on News with Today\'s paper', async () => {
      await page.locator('#teaser-post').click();
      await page.waitForURL(u => new URL(u).searchParams.get('new') === '1');
      assert.equal(new URL(page.url()).searchParams.get('type'), 'news');
      await page.waitForSelector('.paper-card');
      assert.equal(await page.getAttribute('#ctype-news', 'aria-selected'), 'true');
      assert.equal(await page.getAttribute('#tab-paper', 'aria-selected'), 'true');
      assert.ok(await page.locator('#hdr-create').isHidden(), 'no Create post button inside the composer');
      await page.goBack();
      await page.waitForSelector('.tcard');
    });
    await check('Surprise me posts to /reddit/surprise and opens the new thread', async () => {
      await page.locator('#surprise').click();
      await page.waitForURL(u => new URL(u).searchParams.get('t') === SURPRISE_ID);
      assert.equal(st.surprises, 1);
      assert.equal(st.posts.length, 0);
    });
    await ctx.close();
  }

  // ---------------- front page empty state + Surprise me error (360, dark)
  {
    const ctx = await newCtx({ viewport: { width: 360, height: 740 }, colorScheme: 'dark', deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    track(page);
    await mockApi(page, { cards: [] });
    await page.route(`${MOCK}/reddit/surprise`, r => r.fulfill({ status: 429, headers: CORS, contentType: 'application/json', body: JSON.stringify({ detail: 'Too many threads from your network. Try again in an hour.' }) }));
    await page.goto(`${BASE}?${Q}`);
    await check('empty front page invites creating the first post', async () => {
      await page.locator('#feed-empty').waitFor();
      assert.ok((await page.locator('#feed-empty').textContent()).includes('No posts yet'));
      assert.ok(await page.locator('#feed-empty >> text=Create the first post').isVisible());
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(SHOTS, 'front-empty-360-dark.png') });
    });
    await check('Surprise me 429 is shown inline', async () => {
      await page.locator('#surprise').click();
      await page.locator('#surprise-err:not(:empty)').waitFor();
      assert.equal(await page.locator('#surprise-err').textContent(), 'Too many threads from your network. Try again in an hour.');
      assert.equal(await page.locator('#surprise').isDisabled(), false);
    });
    await ctx.close();
  }

  // ---------------- mobile front page: FAB, footer votes, fresh handle (360, light, no preset handle)
  {
    const ctx = await newCtx({ viewport: { width: 360, height: 740 }, colorScheme: 'light', deviceScaleFactor: 2 }, { handle: null });
    const page = await ctx.newPage();
    track(page);
    const st = await mockApi(page, {});
    await page.goto(`${BASE}?${Q}`);
    await page.waitForSelector('.tcard');
    await check('mobile: floating + instead of the header button; vote column hidden, footer votes shown', async () => {
      assert.ok(await page.locator('#fab').isVisible());
      assert.ok(await page.locator('#hdr-create').isHidden());
      assert.ok(await page.locator('.tcard .vote-col').first().isHidden());
      assert.ok(await page.locator('.tcard .vote-pill').first().isVisible());
    });
    await check('mobile footer upvote works', async () => {
      const id = SORTED.hot[1].id;
      await page.locator(`.tcard[data-id="${id}"] .vote-pill .vote-up`).click();
      await page.waitForFunction(i => document.querySelector(`.tcard[data-id="${i}"] .vote-pill .vote-up`).getAttribute('aria-pressed') === 'true', id);
      assert.deepEqual(st.votes[0], { id, body: { target: 'post', dir: 1 } });
    });
    await check('no horizontal scroll 360 front page', () => noHScroll(page, '360 front'));
    await check('FAB opens the composer; fresh visitors get a guest_<4 digits> handle saved locally', async () => {
      await page.locator('#fab').click();
      await page.waitForURL(u => new URL(u).searchParams.get('new') === '1');
      await page.locator('#who-user').click();
      const v = await page.inputValue('#f-handle');
      assert.match(v, /^guest_\d{4}$/);
      assert.equal(await page.evaluate(() => localStorage.getItem('ar:handle')), v);
      assert.ok(await page.locator('#fab').isHidden(), 'no FAB inside the composer');
    });
    await check('mobile composer is a full-screen sheet: no site header, close button, Post pinned to the bottom', async () => {
      assert.ok(await page.locator('.hdr').isHidden());
      assert.ok(await page.locator('#compose-close').isVisible());
      const b = await page.locator('#post-btn').boundingBox();
      assert.ok(b.y + b.height <= 740 && b.y + b.height > 680, `Post button at ${b.y}`);
      await scrollEnd(page);
      const b2 = await page.locator('#post-btn').boundingBox();
      assert.ok(b2.y + b2.height <= 740 && b2.y > 600, 'still visible after scrolling');
      await noHScroll(page, '360 composer');
    });
    await check('close (X) goes back to the front page', async () => {
      await page.locator('#compose-close').click();
      await page.waitForSelector('.tcard');
      assert.equal(new URL(page.url()).searchParams.get('new'), null);
      assert.ok(await page.locator('.hdr').isVisible());
    });
    await ctx.close();
  }

  // ---------------- thread view (desktop, light): v1 behaviour + v2 fields
  {
    const ctx = await newCtx({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    track(page);
    const gate = deferred();
    const st = await mockApi(page, {
      streams: [
        () => ({ body: sse([['snapshot', thread('running', V2_COMMENTS)], ['comment', LIVE_16], ['vote', { comment_id: 2, score: 31 }], [':'], ['status', { status: 'running', comment_count: 16 }]]) }),
        async () => { await gate.p; return { body: sse([['snapshot', thread('running', [...V2_COMMENTS, LIVE_16, LIVE_17])], ['vote', { comment_id: 17, score: 4 }], ['status', { status: 'done', comment_count: 17 }]]) }; },
      ],
    });
    await page.goto(`${BASE}?t=${THREAD_ID}&${Q}`);
    await page.waitForSelector('#c16');

    await check('v2 post: title, type flair, bot OP line with model flair, post score, body and article block', async () => {
      const post = page.locator('.post-full');
      assert.equal(await post.locator('.post-title-text').textContent(), thread('running', []).title);
      assert.equal(await post.locator('.type-flair').textContent(), 'News');
      assert.ok((await post.locator('.post-meta').textContent()).includes('Posted by u/chai_and_chill_91'));
      assert.equal(await post.locator('.post-meta .flair').textContent(), BOTS[0].model);
      assert.equal(await post.locator('.vote-col .score').textContent(), '57');
      assert.ok((await post.locator('.post-text').textContent()).startsWith('Submission statement'));
      const art = post.locator('#post-article');
      assert.ok((await art.textContent()).includes('The Hindu'));
      assert.equal(await art.locator('.article-h').textContent(), ARTICLE.headline);
      assert.equal(await art.locator('a').getAttribute('rel'), 'noopener noreferrer');
      assert.equal(await page.title(), `${thread('running', []).title} : r/AgentReddit`);
    });
    await check('comment count excludes the AutoMod sticky', async () => {
      assert.equal(await page.locator('#comment-count').textContent(), `${V2_COMMENTS.length - 1 + 1} comments`);
    });
    await check('AutoModerator sticky is pinned above the comments with MOD shield', async () => {
      const s = page.locator('#sticky > #c100');
      assert.equal(await s.count(), 1);
      assert.equal(await page.locator('#comments #c100').count(), 0);
      assert.equal(await s.locator('.cm-head .uname').first().textContent(), 'AutoModerator');
      assert.equal((await s.locator('.mod-badge').textContent()).trim(), 'MOD');
      assert.ok((await s.locator('.cm-sticky').textContent()).includes('Stickied comment'));
      assert.equal(await s.locator('.av-mod').count(), 2, 'shield avatar inline + gutter');
      assert.equal(await s.locator('.uname-btn').count(), 0, 'no profile card for AutoMod');
      assert.ok((await s.locator('.cm-body').textContent()).includes('Keep it civil'));
    });
    await check('a human comment (bot_id null) renders with HUMAN flair and no profile opener', async () => {
      const c = page.locator('#c101');
      assert.equal(await c.locator('> .cm-main > .cm-head .uname').textContent(), 'priya_k');
      assert.equal(await c.locator('> .cm-main > .cm-head .flair-human').textContent(), 'HUMAN');
      assert.equal(await c.locator('> .cm-main > .cm-head .uname-btn').count(), 0);
      assert.equal(await c.getAttribute('data-author'), 'user');
    });
    await check('nested reply renders indented under its parent', async () => {
      assert.equal(await page.locator('#c1 > .cm-main > .cm-children > #c3').count(), 1);
      const p = await page.locator('#c1 > .cm-main > .cm-body').boundingBox();
      const ch = await page.locator('#c3 > .cm-main > .cm-body').boundingBox();
      assert.ok(ch.x > p.x + 10, `child x ${ch.x} should be right of parent x ${p.x}`);
    });
    await check('flair pill shows the model id', async () => {
      assert.equal(await page.locator('#c1 > .cm-main > .cm-head .flair').textContent(), 'anthropic/claude-haiku-5.5');
    });
    await check('comment text is inserted as text, not HTML', async () => {
      assert.ok((await page.locator('#c2 > .cm-main > .cm-body').textContent()).includes('<b>x</b>'));
      assert.equal(await page.locator('.cm-body b').count(), 0);
      assert.equal(await page.locator('#c2 > .cm-main > .cm-body blockquote').count(), 1);
    });
    await check('"thread full" appears for a full tree only', async () => {
      await page.locator('#c1 > .cm-main > .cm-actions > .locked').waitFor();
      assert.equal(await page.locator('#c1 > .cm-main > .cm-actions > .locked').textContent(), 'thread full');
      assert.equal(await page.locator('#c1 > .cm-main > .cm-actions .reply-btn').count(), 1, 'humans can still reply in a full thread');
      assert.equal(await page.locator('#c2 .locked').count(), 0);
    });
    await check('sort tab changes order; the sticky stays on top', async () => {
      const firstRoot = () => page.locator('#comments > .cm').first().getAttribute('id');
      assert.equal(await firstRoot(), 'c2');
      await page.locator('.sort-tab[data-sort=new]').click();
      assert.equal(await firstRoot(), 'c15');
      await page.locator('.sort-tab[data-sort=top]').click();
      assert.equal(await firstRoot(), 'c2');
      await page.locator('.sort-tab[data-sort=best]').click();
      const y = async sel => (await page.locator(sel).boundingBox()).y;
      assert.ok(await y('#c100') < await y('#c2'));
    });
    await check('depth-6 reply sits behind "continue this thread"', async () => {
      assert.equal(await page.locator('#c13').count(), 0);
      await page.locator('#c12 .continue').click();
      await page.locator('#c13').waitFor();
    });
    await check('collapse toggle hides subtree and shows hidden count', async () => {
      await page.locator('[data-toggle="2"]').click();
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
      assert.equal(await page.locator('#c17').count(), 0);
    });
    await check('stream is closed after the final status', async () => {
      await page.waitForTimeout(1200);
      assert.equal(st.streamCalls, 2);
    });
    await check('Expand all / Collapse all / per-thread Collapse thread', async () => {
      await page.locator('#expand-all').click();
      await page.locator('#c17').waitFor();
      assert.equal(await page.locator('.cm.is-collapsed').count(), 0);
      await page.locator('#collapse-all').click();
      assert.equal(await page.locator('#comments > .cm.is-collapsed').count(), 3);
      await page.locator('#expand-all').click();
      await page.locator('#c1 > .cm-main > .cm-actions >> text=Collapse thread').click();
      assert.equal(await page.locator('[data-toggle="1"]').getAttribute('aria-expanded'), 'false');
      await page.locator('#expand-all').click();
    });
    await check('no horizontal scroll at 1440x900 (thread)', () => noHScroll(page, '1440 thread'));
    await check('brand link goes to the front page', async () => {
      await page.locator('#brand').click();
      await page.waitForSelector('.tcard');
      assert.equal(new URL(page.url()).search, `?${Q}`);
    });
    await ctx.close();
  }

  // ---------------- bot-written post while casting: placeholder OP, then SSE `post` fills it in
  {
    const ctx = await newCtx({ viewport: { width: 768, height: 1024 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    track(page);
    const go = deferred();
    const casting = { ...thread('casting', [AUTOMOD]), post_type: 'ask', title: '', headline: '', body: null, article: null, op: { type: 'bot', bot_id: 0 }, score: 1, bots: [] };
    await mockApi(page, {
      streams: [async () => { await go.p; return { body: sse([
        ['snapshot', casting],
        ['post', { score: 3, poll: null, title: 'Moved back to Indore after 10 years in Mumbai. Was it worth it?', body: 'Asking for myself, honestly.' }],
        ['status', { status: 'running', comment_count: 0 }],
      ]) }; }, () => new Promise(() => {})],
      threadGet: () => ({ status: 200, body: { ...thread('running', [AUTOMOD]), post_type: 'ask', op: { type: 'bot', bot_id: 2 } } }),
    });
    await page.goto(`${BASE}?t=${THREAD_ID}&${Q}`);
    go.resolve();
    await check('SSE post event fills in a bot-written title/body/score; OP resolves after running', async () => {
      await page.waitForFunction(() => document.querySelector('.post-full .post-title-text')?.textContent.startsWith('Moved back to Indore'));
      assert.equal(await page.locator('.post-full .post-text').textContent(), 'Asking for myself, honestly.');
      assert.equal(await page.locator('.post-full .vote-col .score').textContent(), '3');
      assert.equal(await page.locator('.post-full .type-flair').textContent(), 'Ask');
      await page.waitForFunction(() => document.querySelector('.post-full .post-meta')?.textContent.includes('u/NotAnEconomist'));
      assert.equal(await page.locator('#comment-count').textContent(), '0 comments');
    });
    await ctx.close();
  }

  // ---------------- done thread, bot OP not in roster -> plain "a bot OP", not a pending placeholder
  {
    const ctx = await newCtx({ viewport: { width: 768, height: 1024 } });
    const page = await ctx.newPage();
    track(page);
    await mockApi(page, { streams: [() => ({ body: sse([['snapshot', { ...thread('done', BASE_COMMENTS), op: { type: 'bot', bot_id: 99 } }]]) })] });
    await page.goto(`${BASE}?t=${THREAD_ID}&${Q}`);
    await check('done thread with an unknown OP bot shows "Posted by a bot OP", not a loading placeholder', async () => {
      await page.waitForSelector('.post-full .post-title-text');
      assert.ok((await page.locator('.post-full .post-meta').textContent()).includes('Posted by a bot OP'));
      assert.equal(await page.locator('.post-full .meta-pending').count(), 0);
    });
    await ctx.close();
  }

  // ---------------- F2: comment, reply, optimistic reconcile, events, votes, errors (1440 light)
  {
    const ctx = await newCtx({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    track(page);
    const g1 = deferred(); const g2 = deferred();
    let hold = null; let fail = null;
    const st = await mockApi(page, {
      streams: [
        () => ({ body: sse([['snapshot', thread('running', V2_COMMENTS)], ['status', { status: 'running', comment_count: 16 }]]) }),
        async () => { await g2.p; return { body: sse([
          ['comment', { id: 500, author_type: 'user', author_name: HANDLE, bot_id: null, parent_id: null, root_id: 500, depth: 0, text: 'First human here. Rates feel like a sideshow.', score: 1, created_at: new Date().toISOString() }],
          ['comment', { id: 501, author_type: 'bot', bot_id: 3, parent_id: 500, root_id: 500, depth: 1, text: 'Sideshow for you, main event for anyone with a floating loan.', score: 1, created_at: new Date().toISOString() }],
          ['post', { score: 77, poll: null }],
          ['status', { status: 'running', comment_count: 18 }],
        ]) }; },
        async () => { await g1.p; return { body: sse([
          ['edit', { comment_id: 4, text: 'Exactly. People want cuts but forget the housing angle.\n\nEDIT: typo' }],
          ['award', { comment_id: 2, awards: ['🏅', '🏅', '😂'] }],
          ['delete', { comment_id: 5 }],
          ['remove', { comment_id: 14 }],
          ['lock', { comment_id: 4 }],
          ['comment', MOD_REPLY],
          ['vote', { comment_id: 1, score: 99 }],
          ['status', { status: 'running', comment_count: 16 }],
        ]) }; },
        n => (n === 3 ? new Promise(() => {}) : { body: sse([['snapshot', thread('running', V2_COMMENTS)], ['status', { status: 'done', comment_count: 16 }]]) }), // after a reload
      ],
      commentHook: async (b, n) => { if (hold) await hold.p; if (fail) { const f = fail; fail = null; return f; } return null; },
    });
    await page.goto(`${BASE}?t=${THREAD_ID}&${Q}`);
    await page.waitForSelector('#c15');
    const cmt = id => page.locator(`#c${id}`);
    const actions = id => page.locator(`#c${id} > .cm-main > .cm-actions`);

    await check('OP badge on the OP bot\'s comments only', async () => {
      assert.equal(await cmt(1).locator('> .cm-main > .cm-head .role-op').textContent(), 'OP');
      assert.equal(await cmt(5).locator('> .cm-main > .cm-head .role-op').count(), 1);
      assert.equal(await cmt(2).locator('> .cm-main > .cm-head .role-badge').count(), 0);
    });
    await check('Reply is offered on comments but not on the AutoMod sticky', async () => {
      assert.equal(await actions(1).locator('.reply-btn').count(), 1);
      assert.equal(await page.locator('#c100 .reply-btn').count(), 0);
    });
    await check('Add a comment: optimistic insert while posting, then the 201 comment replaces it', async () => {
      await page.locator('#add-comment').click();
      const box = page.locator('#comment-box-slot .cbox');
      assert.equal(await box.locator('.cbox-who-name').textContent(), `u/${HANDLE}`);
      assert.ok(await box.locator('.cbox-send').isDisabled(), 'empty comment cannot be sent');
      await box.locator('textarea').fill('First human here. Rates feel like a sideshow.');
      hold = deferred();
      await box.locator('.cbox-send').click();
      await page.locator('.cm.is-pending').waitFor();
      assert.ok((await page.locator('.cm.is-pending .cm-body').textContent()).includes('sideshow'));
      assert.ok((await page.locator('.cm.is-pending .cm-head').textContent()).includes('posting…'));
      assert.equal(await page.locator('.cm.is-pending .flair-human').textContent(), 'HUMAN');
      hold.resolve(); hold = null;
      await cmt(500).waitFor();
      assert.equal(await page.locator('.cm.is-pending').count(), 0);
      assert.deepEqual(st.comments[0], { id: THREAD_ID, body: { parent_id: null, text: 'First human here. Rates feel like a sideshow.', user_name: HANDLE } });
      assert.equal(await box.locator('textarea').inputValue(), '', 'box clears after posting');
    });
    await check('SSE copy of the same comment does not duplicate it; a bot reply highlights the human comment', async () => {
      g2.resolve();
      await cmt(501).waitFor();
      assert.equal(await page.locator('#c500').count(), 1);
      assert.equal(await page.locator('#c500 > .cm-main > .cm-children > #c501').count(), 1);
      assert.equal(await page.locator('#c500.is-replied').count(), 1, 'human comment flashes when a bot replies');
      assert.equal(await page.locator('.post-full .vote-col .score').textContent(), '77', 'SSE post event updates the post score');
    });
    await check('inline Reply keeps the draft and focus through live updates, then posts with parent_id', async () => {
      await actions(1).locator('.reply-btn').click();
      const ta = page.locator('#c1 > .cm-main > .cbox-reply textarea');
      await ta.waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA');
      await ta.type('Half-written thought');
      g1.resolve();
      await page.waitForFunction(() => document.querySelector('#c4 .cm-edited'));
      assert.equal(await ta.inputValue(), 'Half-written thought');
      assert.ok(await ta.evaluate(el => document.activeElement === el), 'focus survived the re-render');
      await ta.type(', finished.');
      await page.locator('#c1 > .cm-main > .cbox-reply .cbox-send').click();
      await page.waitForFunction(() => document.querySelector('#c1 > .cm-main > .cm-children > [data-author="user"]:not(.is-pending)'));
      assert.deepEqual(st.comments.at(-1).body, { parent_id: 1, text: 'Half-written thought, finished.', user_name: HANDLE });
      assert.equal(await page.locator('#c1 > .cm-main > .cbox-reply').count(), 0, 'reply box closes after posting');
    });
    await check('edit event: new text and an "edited" label', async () => {
      assert.ok((await cmt(4).locator('> .cm-main > .cm-body').textContent()).includes('EDIT: typo'));
      assert.equal(await cmt(4).locator('> .cm-main > .cm-head .cm-edited').textContent(), '· edited');
    });
    await check('award event: emoji row with counts', async () => {
      const a = cmt(2).locator('> .cm-main > .cm-awards .award');
      assert.deepEqual(await a.allTextContents(), ['🏅×2', '😂']);
    });
    await check('delete event: [deleted] author and text, children stay, no Reply', async () => {
      assert.equal(await cmt(5).locator('> .cm-main > .cm-head .uname').textContent(), '[deleted]');
      assert.equal(await cmt(5).locator('> .cm-main > .cm-body').textContent(), '[deleted]');
      assert.equal(await cmt(5).locator('> .cm-main > .cm-head .flair').count(), 0);
      assert.equal(await page.locator('#c5 > .cm-main > .cm-children > #c9').count(), 1);
      assert.equal(await actions(5).locator('.reply-btn').count(), 0);
    });
    await check('remove event: [removed by moderator], no Reply; AutoMod reply has the MOD shield', async () => {
      // v3: #c120 arrived while the reply box was focused, so it waited behind the pill.
      assert.equal(await page.locator('#live-pill').textContent(), '↓ 1 new comment');
      assert.equal(await cmt(120).count(), 0);
      await page.locator('#live-pill').click();
      await cmt(120).waitFor();
      assert.equal(await page.locator('#live-pill').isHidden(), true);
      assert.equal(await cmt(14).locator('> .cm-main > .cm-body').textContent(), '[removed by moderator]');
      assert.equal(await actions(14).locator('.reply-btn').count(), 0);
      assert.equal((await cmt(120).locator('> .cm-main > .cm-head .mod-badge').textContent()).trim(), 'MOD');
      assert.equal(await cmt(120).locator('> .cm-main > .cm-head .uname').textContent(), 'AutoModerator');
      assert.equal(await cmt(120).locator('.cm-sticky').count(), 0);
    });
    await check('lock event: lock icon on that comment, no Reply anywhere in its subtree', async () => {
      assert.equal(await cmt(4).locator('> .cm-main > .cm-head .cm-lock').getAttribute('title'), 'Locked by moderators');
      for (const id of [4, 6, 8, 10, 12]) assert.equal(await actions(id).locator('.reply-btn').count(), 0, `c${id}`);
      assert.equal(await actions(2).locator('.reply-btn').count(), 1, 'parent outside the lock keeps Reply');
    });
    await check('SSE vote sets the server score on a comment', async () => {
      assert.equal(await actions(1).locator('.score').textContent(), '99');
    });
    await check('comment upvote posts {target: id, dir: 1}, shows the server score, persists', async () => {
      await actions(1).locator('.vote-up').click();
      await page.waitForFunction(() => document.querySelector('#c1 > .cm-main > .cm-actions .score')?.textContent === '113');
      assert.deepEqual(st.votes.at(-1), { id: THREAD_ID, body: { target: 1, dir: 1 } });
      assert.equal(await page.evaluate(id => localStorage.getItem(`ar:votes:${id}`), THREAD_ID), '{"1":1}');
      await actions(2).locator('.vote-down').click();
      await page.waitForFunction(() => document.querySelector('#c2 > .cm-main > .cm-actions .vote-down')?.getAttribute('aria-pressed') === 'true');
      assert.deepEqual(st.votes.at(-1).body, { target: 2, dir: -1 });
    });
    await check('post upvote posts {target:"post"} and persists next to comment votes', async () => {
      await page.locator('.post-full .vote-col .vote-up').click();
      await page.waitForFunction(() => document.querySelector('.post-full .vote-col .vote-up')?.getAttribute('aria-pressed') === 'true');
      await page.waitForTimeout(100);
      assert.deepEqual(st.votes.at(-1).body, { target: 'post', dir: 1 });
      assert.deepEqual(JSON.parse(await page.evaluate(id => localStorage.getItem(`ar:votes:${id}`), THREAD_ID)), { 1: 1, 2: -1, post: 1 });
    });
    await check('own votes are highlighted again after a reload', async () => {
      await page.reload();
      await page.waitForSelector('#c2');
      assert.equal(await actions(1).locator('.vote-up').getAttribute('aria-pressed'), 'true');
      assert.equal(await actions(2).locator('.vote-down').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.post-full .vote-col .vote-up').getAttribute('aria-pressed'), 'true');
    });
    await check('423 on a reply is shown in the box; the optimistic comment is rolled back and the text kept', async () => {
      await actions(2).locator('.reply-btn').click();
      const box = page.locator('#c2 > .cm-main > .cbox-reply');
      await box.locator('textarea').fill('You two need to calm down.');
      fail = { status: 423, body: { detail: 'Locked' } };
      await box.locator('.cbox-send').click();
      await box.locator('.cbox-err:not(:empty)').waitFor();
      assert.ok((await box.locator('.cbox-err').textContent()).includes('locked by moderators'));
      assert.equal(await page.locator('.cm.is-pending').count(), 0);
      assert.equal(await box.locator('textarea').inputValue(), 'You two need to calm down.');
    });
    await check('429 and 404 messages are surfaced inline', async () => {
      const box = page.locator('#c2 > .cm-main > .cbox-reply');
      fail = { status: 429, body: { detail: 'Slow down: 8 comments a minute at most.' } };
      await box.locator('.cbox-send').click();
      await page.waitForFunction(() => document.querySelector('#c2 > .cm-main > .cbox-reply .cbox-err')?.textContent === 'Slow down: 8 comments a minute at most.');
      fail = { status: 404, body: { detail: 'Not Found' } };
      await box.locator('.cbox-send').click();
      await page.waitForFunction(() => document.querySelector('#c2 > .cm-main > .cbox-reply .cbox-err')?.textContent === 'This thread no longer exists.');
      await page.screenshot({ path: join(SHOTS, 'f2-reply-error-1440-light.png') });
      await box.locator('.cbox-cancel').click();
      assert.equal(await page.locator('.cbox-reply').count(), 0);
    });
    await check('handle can be changed in the comment box (validated, saved, sent)', async () => {
      await page.locator('#add-comment').click();
      const box = page.locator('#comment-box-slot .cbox');
      await box.locator('.cbox-change').click();
      await box.locator('.cbox-handle').fill('x y');
      await box.locator('.cbox-change').click();
      assert.ok((await box.locator('.cbox-err').textContent()).includes('3 to 20'));
      await box.locator('.cbox-handle').fill('mumbai_mom');
      await box.locator('.cbox-change').click();
      assert.equal(await box.locator('.cbox-who-name').textContent(), 'u/mumbai_mom');
      await box.locator('textarea').fill('Seconding this.');
      const before = st.comments.length;
      await box.locator('.cbox-send').click();
      for (let i = 0; i < 50 && st.comments.length === before; i++) await page.waitForTimeout(20);
      await page.waitForFunction(() => document.querySelector('#comment-box-slot textarea')?.value === '');
      assert.equal(st.comments.at(-1).body.user_name, 'mumbai_mom');
      assert.equal(await page.evaluate(() => localStorage.getItem('ar:handle')), 'mumbai_mom');
    });
    await check('no horizontal scroll 1440 thread with interactions', () => noHScroll(page, '1440 f2'));
    await ctx.close();
  }

  // ---------------- F2: replying on a finished thread re-opens the stream for revive replies (768 light)
  {
    const ctx = await newCtx({ viewport: { width: 768, height: 1024 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    track(page);
    const st = await mockApi(page, { streams: [
      () => ({ body: sse([['snapshot', thread('done', V2_COMMENTS)]]) }),
      () => ({ body: sse([['snapshot', thread('running', [...V2_COMMENTS, { id: 500, author_type: 'user', author_name: HANDLE, bot_id: null, parent_id: 15, root_id: 15, depth: 1, text: 'Same question here.', score: 1, created_at: ago(0) }])],
        ['comment', { id: 510, bot_id: 2, author_type: 'bot', parent_id: 500, root_id: 15, depth: 2, text: 'Think of it as the price banks pay for money.', score: 1, created_at: ago(0) }]]) }),
      () => new Promise(() => {}),
    ] });
    await page.goto(`${BASE}?t=${THREAD_ID}&${Q}`);
    await page.waitForSelector('#c15');
    await check('a reply on a done thread opens a new stream and the bot reply arrives under it', async () => {
      await page.waitForTimeout(300);
      assert.equal(st.streamCalls, 1);
      await page.locator('#c15 > .cm-main > .cm-actions .reply-btn').click();
      await page.locator('#c15 .cbox-reply textarea').fill('Same question here.');
      await page.locator('#c15 .cbox-reply .cbox-send').click();
      await page.locator('#c510').waitFor();
      assert.equal(st.streamCalls, 2);
      assert.equal(await page.locator('#c500').count(), 1, 'no duplicate after the snapshot');
      assert.equal(await page.locator('#c500 > .cm-main > .cm-children > #c510').count(), 1);
    });
    await ctx.close();
  }

  // ---------------- F2: poll results (live) + AMA HOST badge (768 dark)
  {
    const ctx = await newCtx({ viewport: { width: 768, height: 1024 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    track(page);
    const g = deferred();
    const pollThread = { ...thread('running', V2_COMMENTS), post_type: 'poll', title: POLL.question, body: null, article: null, poll: POLL };
    await mockApi(page, { streams: [
      () => ({ body: sse([['snapshot', pollThread]]) }),
      async () => { await g.p; return { body: sse([['post', { score: 60, poll: { ...POLL, options: POLL.options.map((o, i) => (i === 0 ? { ...o, votes: 9 } : o)), total: 16 } }]]) }; },
      () => new Promise(() => {}),
    ] });
    await page.goto(`${BASE}?t=${THREAD_ID}&${Q}`);
    await check('poll post shows a results bar per option with percentages and the total', async () => {
      await page.locator('#poll').waitFor();
      assert.deepEqual(await page.locator('#poll .poll-text').allTextContents(), ['Delhi', 'Kolkata', 'Indore', 'Mumbai']);
      assert.deepEqual(await page.locator('#poll .poll-pct').allTextContents(), ['30%', '50%', '10%', '10%']);
      assert.equal(await page.locator('#poll .poll-total').textContent(), '10 votes');
      assert.equal(await page.locator('#poll .poll-row.is-lead .poll-text').textContent(), 'Kolkata');
      assert.equal(await page.locator('#poll button').count(), 0, 'no voting on options in v2');
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(SHOTS, 'f2-poll-768-dark.png') });
    });
    await check('SSE post event updates the poll live', async () => {
      g.resolve();
      await page.waitForFunction(() => document.querySelector('#poll .poll-total')?.textContent === '16 votes');
      assert.deepEqual(await page.locator('#poll .poll-pct').allTextContents(), ['56%', '31%', '6%', '6%']);
      assert.equal(await page.locator('#poll .poll-row.is-lead .poll-text').textContent(), 'Delhi');
      assert.equal(await page.locator('.post-full .vote-col .score').textContent(), '60');
    });
    await ctx.close();

    const ctx2 = await newCtx({ viewport: { width: 360, height: 740 }, colorScheme: 'light', deviceScaleFactor: 2 });
    const p2 = await ctx2.newPage();
    track(p2);
    const ama = { ...thread('running', V2_COMMENTS), post_type: 'ama', title: "I'm a 41yo economics lecturer in Kolkata. AMA", article: null, body: 'Ask me about inflation.', op: { type: 'bot', bot_id: 2, name: 'NotAnEconomist' }, ama_host_bot_id: 2,
      bots: BOTS.map(b => ({ ...b, is_op: b.id === 2, is_host: b.id === 2 })) };
    await mockApi(p2, { streams: [() => ({ body: sse([['snapshot', ama]]) }), () => new Promise(() => {})] });
    await p2.goto(`${BASE}?t=${THREAD_ID}&${Q}`);
    await check('AMA: the host bot gets OP and HOST badges; the AMA flair shows', async () => {
      await p2.waitForSelector('#c2');
      const head = p2.locator('#c2 > .cm-main > .cm-head');
      assert.deepEqual(await head.locator('.role-badge').allTextContents(), ['OP', 'HOST']);
      assert.equal(await p2.locator('#c1 > .cm-main > .cm-head .role-badge').count(), 0);
      assert.equal(await p2.locator('.post-full .type-flair').textContent(), 'AMA');
      await noHScroll(p2, '360 ama');
    });
    await check('mobile: inline reply box fits without horizontal scroll', async () => {
      await p2.locator('#c2 > .cm-main > .cm-actions .reply-btn').click();
      await p2.locator('#c2 .cbox-reply textarea').fill('What do you tell students about EMIs?');
      await noHScroll(p2, '360 reply');
      await p2.locator('#c2 .cbox-reply').scrollIntoViewIfNeeded();
      await p2.evaluate(() => document.fonts.ready);
      await p2.screenshot({ path: join(SHOTS, 'f2-reply-360-light.png') });
    });
    await ctx2.close();

    const ctx3 = await newCtx({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const p3 = await ctx3.newPage();
    track(p3);
    const st3 = await mockApi(p3, { hosts: ['plumber', 'nurse', 'stand-up comic'] });
    await p3.goto(`${BASE}?new=1&type=ama&${Q}`);
    await check('AMA host chips come from GET /reddit/hosts when available', async () => {
      await p3.waitForFunction(() => document.querySelector('.host-chip[data-host="stand-up comic"]'));
      assert.deepEqual(await p3.locator('.host-chip').evaluateAll(cs => cs.map(c => c.dataset.host)), ['', 'plumber', 'nurse', 'stand-up comic']);
      assert.equal(await p3.locator('#ama-more').count(), 0);
      assert.equal(st3.hostsCalls, 1);
    });
    await ctx3.close();
  }

  // ---------------- composer: today's paper pick list, infinite scroll, excerpt, bot post (360x740)
  {
    const ctx = await newCtx({ viewport: { width: 360, height: 740 }, colorScheme: 'light', deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    track(page);
    const page2 = deferred();
    const st = await mockApi(page, {
      newsHook: async q => { if (q.feed === 'paper' && q.offset === 12 && !q.section) await page2.p; },
      streams: [() => ({ body: sse([['snapshot', legacyThread('done', BASE_COMMENTS, { headline: PAPER[1].title, body: PAPER[1].body, source: PAPER_SRC, link: null })]]) })],
    });
    await page.goto(`${BASE}?new=1&type=news&${Q}`);
    const cards = () => page.locator('.paper-card').count();

    await check('composer opens on News with type tabs and "who writes it"', async () => {
      await page.waitForSelector('.paper-card');
      assert.deepEqual(await page.locator('.ctype').allTextContents(), ['News', 'Ask', 'Opinion', 'Poll', 'AMA']);
      assert.equal(await page.getAttribute('#ctype-news', 'aria-selected'), 'true');
      assert.equal(await page.locator('#who-user strong').textContent(), "I'll write it");
      assert.equal(await page.locator('#who-bot strong').textContent(), 'Let a bot OP write it');
      assert.equal(await page.getAttribute('#who-bot', 'aria-checked'), 'true', 'news defaults to a bot OP');
    });
    await check("Today's paper is the default source, with label, count and section chips", async () => {
      assert.deepEqual(await page.locator('#tabs .tab').allTextContents(), ["Today's paper", 'Live news', 'Paste']);
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
      assert.equal(await page.locator('#picked').count(), 0);
      await page.screenshot({ path: join(SHOTS, 'compose-paper-excerpt-360-light.png') });
      await card.locator('.excerpt-toggle').click();
      assert.ok(await card.locator('.excerpt').isHidden());
    });
    await check('scrolling to the bottom requests offset 12 and shows a loading row', async () => {
      await page.locator('.feed-sentinel').scrollIntoViewIfNeeded();
      await page.locator('.feed-loading').waitFor();
      assert.ok((await page.locator('.feed-loading').textContent()).includes('Loading more stories'));
      assert.deepEqual(st.news[1], { feed: 'paper', offset: 12, limit: 12, section: null });
      assert.equal(st.news.length, 2, 'no duplicate request while one is in flight');
      page2.resolve();
      await page.waitForFunction(() => document.querySelectorAll('.paper-card').length === 24);
    });
    await check('keeps paging to the end: offsets 0/12/24, exactly 30 unique cards, caught-up row', async () => {
      for (let i = 0; i < 20 && !(await page.locator('.feed-end').count()); i++) {
        await page.locator('.feed-sentinel').scrollIntoViewIfNeeded();
        await page.waitForTimeout(150);
      }
      await page.locator('.feed-end').waitFor();
      const ids = await page.locator('.paper-card').evaluateAll(cs => cs.map(c => c.dataset.id));
      assert.deepEqual(ids, PAPER.map(p => p.id));
      await page.locator('.feed-sentinel').scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      assert.deepEqual(st.news.map(q => q.offset), [0, 12, 24]);
    });
    await check('no horizontal scroll 360 paper list fully loaded', () => noHScroll(page, '360 paper'));
    await check('posting without a pick shows the inline "pick a story" error and sends nothing', async () => {
      await page.locator('#post-btn').click();
      assert.equal(await page.locator('#err-story').textContent(), 'Pick a story from the list.');
      assert.equal(await page.locator('#post-err').textContent(), 'Pick a story from the list.');
      assert.equal(st.posts.length, 0);
    });
    await check('picking a story collapses the list into a "Selected story" summary', async () => {
      await page.locator('.paper-card[data-id="p001"] .post-title').click();
      await page.locator('#picked').waitFor();
      assert.equal(await page.locator('#picked .picked-title').textContent(), PAPER[1].title);
      assert.ok((await page.locator('#picked').textContent()).includes(PAPER_SRC));
      assert.equal(await page.locator('.paper-card').count(), 0);
      assert.equal(await page.locator('#err-story').textContent(), '', 'error clears once a story is picked');
      await page.screenshot({ path: join(SHOTS, 'compose-picked-360-light.png') });
    });
    await check('Change reopens the list with every loaded story and the pick still marked', async () => {
      await page.locator('#picked-change').click();
      await page.waitForSelector('.paper-card');
      assert.equal(await page.locator('.paper-card').count(), 30);
      assert.deepEqual(await page.locator('.news-card.is-selected').evaluateAll(cs => cs.map(c => c.dataset.id)), ['p001']);
      assert.equal(st.news.length, 3, 'no refetch');
      await page.locator('.paper-card[data-id="p001"] .post-title').click();
      await page.locator('#picked').waitFor();
    });
    await check('bot OP news post sends exactly the contract body with the paper article', async () => {
      await page.locator('#post-btn').click();
      await page.waitForURL(u => new URL(u).searchParams.get('t') === THREAD_ID);
      assert.equal(st.posts.length, 1);
      assert.deepEqual(Object.keys(st.posts[0]), KEYS);
      assert.deepEqual(st.posts[0], body({ article: { headline: PAPER[1].title, body: PAPER[1].body, link: null, source: PAPER_SRC } }));
    });
    await check('legacy thread (no v2 fields) still renders the print source sensibly', async () => {
      await page.locator('.post-full .post-title').waitFor();
      const meta = await page.locator('.post-full .post-meta').textContent();
      assert.ok(meta.includes('Posted by u/The_Indian_Express') && meta.includes('print, p. 2'), meta);
      assert.equal(await page.locator('.post-full .post-link').count(), 0);
      assert.ok((await page.locator('.post-full .post-text').textContent()).includes('Story 1 opening paragraph'));
      assert.equal(await page.locator('.post-full .type-flair').textContent(), 'News');
    });
    await check('Back from the new thread skips the used composer and lands on the front page', async () => {
      await page.goBack();
      await page.waitForURL(u => !new URL(u).searchParams.get('t'));
      assert.equal(new URL(page.url()).searchParams.get('new'), null, 'composer entry was replaced by the thread');
    });
    await ctx.close();
  }

  // ---------------- composer: section chips, stale responses, failed page + Retry (768x1024 dark)
  {
    const ctx = await newCtx({ viewport: { width: 768, height: 1024 }, colorScheme: 'dark' });
    const page = await ctx.newPage();
    track(page);
    let holdPolitics = null;
    let failNext = true;
    const st = await mockApi(page, {
      newsHook: async q => {
        if (q.section === 'politics' && holdPolitics) await holdPolitics.p;
        if (q.feed === 'paper' && !q.section && q.offset === 12 && failNext) { failNext = false; return { status: 500 }; }
      },
    });
    await page.goto(`${BASE}?new=1&${Q}`);
    await page.waitForSelector('.paper-card');
    const sections = () => page.locator('.paper-card').evaluateAll(cs => cs.map(c => c.dataset.section));
    await check('section chip refetches from offset 0 with the section param', async () => {
      await page.locator('.fchip[data-section=economy]').click();
      await page.waitForFunction(() => document.querySelector('.paper-card')?.dataset.section === 'economy');
      assert.deepEqual(st.news.find(x => x.section === 'economy'), { feed: 'paper', offset: 0, limit: 12, section: 'economy' });
      const secs = await sections();
      assert.ok(secs.length >= 12 && secs.every(x => x === 'economy'), String(secs));
      assert.equal(await page.getAttribute('.fchip[data-section=economy]', 'aria-pressed'), 'true');
      assert.ok((await page.locator('.feed-head .feed-meta').textContent()).includes(`${PAPER_COUNTS.economy} stories`));
    });
    await check('a slow response for an abandoned chip is discarded', async () => {
      holdPolitics = deferred();
      await page.locator('.fchip[data-section=politics]').click();
      for (let i = 0; i < 50 && !st.news.some(x => x.section === 'politics'); i++) await page.waitForTimeout(20);
      await page.locator('.fchip[data-section=all]').click();
      await page.waitForFunction(() => document.querySelectorAll('.paper-card').length === 12);
      holdPolitics.resolve();
      await page.waitForTimeout(500);
      assert.deepEqual(await page.locator('.paper-card').evaluateAll(cs => cs.map(c => c.dataset.id)), PAPER.slice(0, 12).map(p => p.id));
    });
    await check('a failed page shows "Couldn\'t load more · Retry" and Retry loads it', async () => {
      await page.locator('.feed-sentinel').scrollIntoViewIfNeeded();
      await page.locator('.feed-err').waitFor();
      assert.equal(await page.locator('.paper-card').count(), 12);
      await page.screenshot({ path: join(SHOTS, 'compose-paper-error-768-dark.png') });
      await page.locator('.feed-err .feed-retry').click();
      await page.waitForFunction(() => document.querySelectorAll('.paper-card').length === 24);
      assert.equal(await page.locator('.feed-err').count(), 0);
    });
    await ctx.close();
  }

  // ---------------- composer: no paper today -> live news is the default, pages too (1440)
  {
    const ctx = await newCtx({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    track(page);
    const live2 = deferred();
    const st = await mockApi(page, {
      papers: { papers: [] }, liveItems: LIVE_20,
      newsHook: async q => { if (q.feed === 'live' && q.offset === 12) await live2.p; },
    });
    await page.goto(`${BASE}?new=1&type=news&${Q}`);
    await check('with no paper today, Live news is the default and the paper source is hidden', async () => {
      await page.waitForSelector('.news-card');
      assert.equal(await page.locator('#tab-paper').count(), 0);
      assert.equal(await page.getAttribute('#tab-news', 'aria-selected'), 'true');
      assert.equal(st.news.some(q => q.feed === 'paper'), false);
    });
    await check('live list pages with offset/limit and ends caught up; links are safe', async () => {
      assert.equal(await page.locator('.news-card').count(), 12);
      assert.deepEqual(st.news[0], { feed: 'live', offset: 0, limit: 12, section: null });
      const rels = await page.locator('.news-card a').evaluateAll(as => as.map(a => [a.protocol, a.rel, a.target]));
      assert.ok(rels.length && rels.every(([p, rel, t]) => p.startsWith('http') && rel === 'noopener noreferrer' && t === '_blank'));
      assert.equal(await page.locator('.news-card[data-id="live4"] a').count(), 0, 'javascript: link not rendered');
      await page.locator('.feed-sentinel').scrollIntoViewIfNeeded();
      await page.locator('.feed-loading').waitFor();
      live2.resolve();
      await page.locator('.feed-end').waitFor();
      assert.equal(await page.locator('.news-card').count(), 20);
    });
    await check('bot OP on a live story with an angle posts article (link, source) and idea', async () => {
      await page.locator('.news-card[data-id="live2"] .post-title').click();
      await page.fill('#f-idea', '  what it means for farmers  ');
      await page.locator('#post-btn').click();
      await page.waitForURL(u => new URL(u).searchParams.get('t') === THREAD_ID);
      assert.deepEqual(st.posts[0], body({ idea: 'what it means for farmers', article: { headline: LIVE_20[2].title, body: LIVE_20[2].summary, link: LIVE_20[2].link, source: LIVE_20[2].source } }));
    });
    await ctx.close();
  }

  // ---------------- composer: every type, both authors, exact bodies, validation, 422/429 (1440 light)
  {
    const ctx = await newCtx({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    track(page);
    let nextHook = null;
    const st = await mockApi(page, { createHook: async () => { const r = nextHook; nextHook = null; return r; } });
    const open = async (type) => {
      await page.goto(`${BASE}?new=1${type ? `&type=${type}` : ''}&${Q}`);
      await page.waitForSelector('#compose-body .field');
    };
    const postAndWait = async () => {
      const n = st.posts.length;
      await page.locator('#post-btn').click();
      await page.waitForURL(u => new URL(u).searchParams.get('t') === THREAD_ID);
      assert.equal(st.posts.length, n + 1);
      const b = st.posts.at(-1);
      assert.deepEqual(Object.keys(b), KEYS);
      return b;
    };
    await check('?new=1&type=poll opens the Poll tab; switching tabs updates ?type=', async () => {
      await open('poll');
      assert.equal(await page.getAttribute('#ctype-poll', 'aria-selected'), 'true');
      assert.equal(await page.getAttribute('#who-user', 'aria-checked'), 'true', 'poll defaults to "I\'ll write it"');
      await page.locator('#ctype-ask').click();
      assert.equal(new URL(page.url()).searchParams.get('type'), 'ask');
      assert.equal(new URL(page.url()).searchParams.get('api'), MOCK);
      assert.ok((await page.locator('#type-hint').textContent()).includes('Ask the crowd'));
    });
    await check('validation: empty title and a bad handle are flagged inline; nothing is sent', async () => {
      await page.fill('#f-handle', 'bad handle!');
      await page.locator('#post-btn').click();
      assert.equal(await page.locator('#err-title').textContent(), 'Add a title (at least 3 characters).');
      assert.ok((await page.locator('#err-handle').textContent()).includes('3 to 20 letters'));
      assert.equal(await page.getAttribute('#f-title', 'aria-invalid'), 'true');
      assert.equal(await page.locator('#post-err').textContent(), 'Fix 2 things above to post.');
      assert.equal(st.posts.length, 0);
      await page.screenshot({ path: join(SHOTS, 'compose-errors-1440-light.png') });
    });
    await check('ask by user: title, body, handle edit, Small + Quick -> exact body', async () => {
      await page.fill('#f-title', '  Is ₹25 LPA in Bengaluru actually rich?  ');
      assert.equal(await page.locator('#err-title').textContent(), '', 'error clears while typing');
      await page.fill('#f-body', 'Single, no loans, renting in HSR.');
      await page.fill('#f-handle', 'chai_lover_7');
      await page.locator('#crowd [data-v=small]').click();
      await page.locator('#length [data-v=quick]').click();
      assert.ok((await page.locator('#foot-sum').textContent()).includes('Ask by u/chai_lover_7 · 3 redditors · up to 20 comments'));
      const b = await postAndWait();
      assert.deepEqual(b, body({ post_type: 'ask', author: 'user', title: 'Is ₹25 LPA in Bengaluru actually rich?', body: 'Single, no loans, renting in HSR.', user_name: 'chai_lover_7', bots: 3, max_comments: 20 }));
      assert.equal(await page.evaluate(() => localStorage.getItem('ar:handle')), 'chai_lover_7', 'handle remembered');
      await page.evaluate(h => localStorage.setItem('ar:handle', h), HANDLE);
    });
    await check('ask by bot: an idea is required, then posts {idea}', async () => {
      await open('ask');
      await page.locator('#who-bot').click();
      assert.equal(await page.locator('#f-title').count(), 0);
      await page.locator('#post-btn').click();
      assert.ok((await page.locator('#err-idea').textContent()).includes('one-line idea'));
      assert.equal(st.posts.length, 1);
      await page.fill('#f-idea', 'moving back to a hometown after 10 years in Mumbai');
      const b = await postAndWait();
      assert.deepEqual(b, body({ post_type: 'ask', idea: 'moving back to a hometown after 10 years in Mumbai' }));
    });
    await check('opinion by user and by bot', async () => {
      await open('opinion');
      await page.locator('#who-user').click();
      await page.fill('#f-title', 'Unpopular opinion: filter coffee is overrated');
      let b = await postAndWait();
      assert.deepEqual(b, body({ post_type: 'opinion', author: 'user', title: 'Unpopular opinion: filter coffee is overrated' }));
      await open('opinion');
      await page.locator('#who-bot').click();
      await page.fill('#f-idea', 'IPL is better than test cricket');
      b = await postAndWait();
      assert.deepEqual(b, body({ post_type: 'opinion', idea: 'IPL is better than test cricket' }));
    });
    await check('poll by user: one option is an inline error; add/remove options -> poll_options', async () => {
      await open('poll');
      await page.locator('#who-user').click();
      await page.fill('#f-title', 'Best street food city?');
      await page.locator('.poll-opt input').nth(0).fill('Delhi');
      await page.locator('#post-btn').click();
      assert.equal(await page.locator('#err-options').textContent(), 'Add at least two options.');
      assert.equal(await page.locator('.opt-remove').first().isDisabled(), true, 'cannot go below two inputs');
      await page.locator('.poll-opt input').nth(1).fill('Kolkata');
      await page.locator('#add-opt').click();
      await page.locator('.poll-opt input').nth(2).fill('Lucknow');
      await page.locator('#add-opt').click();
      await page.locator('.poll-opt input').nth(3).fill('Indore');
      await page.locator('.opt-remove').nth(2).click(); // drops Lucknow
      assert.equal(await page.locator('.poll-opt').count(), 3);
      for (let i = 0; i < 3; i++) await page.locator('#add-opt').click();
      assert.equal(await page.locator('.poll-opt').count(), 6);
      assert.ok(await page.locator('#add-opt').isHidden(), 'six options at most');
      await page.screenshot({ path: join(SHOTS, 'compose-poll-6-1440-light.png') });
      const b = await postAndWait();
      assert.deepEqual(b, body({ post_type: 'poll', author: 'user', title: 'Best street food city?', poll_options: ['Delhi', 'Kolkata', 'Indore'] }));
    });
    await check('poll by bot posts only the idea', async () => {
      await open('poll');
      await page.locator('#who-bot').click();
      await page.fill('#f-idea', 'the best Indian breakfast');
      const b = await postAndWait();
      assert.deepEqual(b, body({ post_type: 'poll', idea: 'the best Indian breakfast' }));
    });
    await check('AMA by bot with a host chip -> ama_host; idea optional', async () => {
      await open('ama');
      assert.equal(await page.getAttribute('#who-bot', 'aria-checked'), 'true', 'AMA defaults to the bot host');
      assert.equal(await page.getAttribute('.host-chip[data-host=""]', 'aria-checked'), 'true', 'Random by default');
      await page.locator('.host-chip[data-host="plumber"]').click();
      assert.equal(await page.getAttribute('.host-chip[data-host="plumber"]', 'aria-checked'), 'true');
      await page.locator('#ama-more').click();
      assert.ok(await page.locator('.host-chip[data-host="NRI in the US"]').isVisible());
      await page.locator('#adv-toggle').click();
      await page.locator('#f-limit').fill('12');
      assert.equal(await page.locator('#limit-out').textContent(), '12');
      await page.locator('#crowd [data-v=large]').click();
      await page.locator('#length [data-v=long]').click();
      const b = await postAndWait();
      assert.deepEqual(b, body({ post_type: 'ama', ama_host: 'plumber', bots: 8, thread_limit: 12, max_comments: 80 }));
    });
    await check('AMA by user with Random host -> ama_host null, title and intro', async () => {
      await open('ama');
      await page.locator('#who-user').click();
      await page.locator('.host-chip[data-host=""]').click();
      await page.fill('#f-title', "I'm a nurse on night shifts in Pune. AMA");
      await page.fill('#f-body', 'Eight years in a government hospital.');
      const b = await postAndWait();
      assert.deepEqual(b, body({ post_type: 'ama', author: 'user', title: "I'm a nurse on night shifts in Pune. AMA", body: 'Eight years in a government hospital.', ama_host: null }));
    });
    await check('news by user via Paste: headline required, bad link flagged, then exact body', async () => {
      await open('news');
      await page.locator('#who-user').click();
      await page.locator('#tab-paste').click();
      await page.fill('#f-link', 'ftp://nope');
      await page.locator('#post-btn').click();
      assert.equal(await page.locator('#err-headline').textContent(), 'Add a headline (at least 3 characters).');
      assert.equal(await page.locator('#err-link').textContent(), 'Use a full http:// or https:// link.');
      await page.fill('#f-headline', 'Bengaluru to charge a congestion tax on ORR');
      await page.fill('#f-link', 'https://example.com/orr');
      await page.fill('#f-text', 'The city plans a ₹50 charge at peak hours.');
      await page.fill('#f-body', 'About time, honestly.');
      const b = await postAndWait();
      assert.deepEqual(b, body({ post_type: 'news', author: 'user', title: 'Bengaluru to charge a congestion tax on ORR', body: 'About time, honestly.',
        article: { headline: 'Bengaluru to charge a congestion tax on ORR', body: 'The city plans a ₹50 charge at peak hours.', link: 'https://example.com/orr', source: null } }));
    });
    await check('server 422 (FastAPI detail list) is shown on the field and above Post', async () => {
      await open('ask');
      await page.locator('#who-user').click();
      await page.fill('#f-title', 'A perfectly fine title');
      nextHook = { status: 422, body: { detail: [{ type: 'value_error', loc: ['body', 'title'], msg: 'Value error, title looks like spam', input: 'x' }] } };
      await page.locator('#post-btn').click();
      await page.locator('#post-err:not(:empty)').waitFor();
      assert.equal(await page.locator('#err-title').textContent(), 'title looks like spam');
      assert.ok((await page.locator('#post-err').textContent()).includes('title looks like spam'));
      assert.equal(new URL(page.url()).searchParams.get('new'), '1', 'still in the composer');
      assert.equal(await page.locator('#post-btn').isDisabled(), false);
    });
    await check('server 429 message is surfaced above Post', async () => {
      nextHook = { status: 429, body: { detail: 'Too many threads from your network. Try again in an hour.' } };
      await page.locator('#post-btn').click();
      await page.waitForFunction(() => document.getElementById('post-err')?.textContent === 'Too many threads from your network. Try again in an hour.');
      assert.equal(new URL(page.url()).searchParams.get('new'), '1');
      await page.screenshot({ path: join(SHOTS, 'compose-429-1440-light.png') });
    });
    await check('desktop composer: centred column with posting tips sidebar, Cancel goes back', async () => {
      assert.ok((await page.locator('#side').textContent()).includes('Posting to r/AgentReddit'));
      await noHScroll(page, '1440 composer');
      await page.goto(`${BASE}?${Q}`);
      await page.waitForSelector('.tcard');
      await page.locator('#create-input').click();
      await page.waitForURL(u => new URL(u).searchParams.get('new') === '1');
      await page.locator('.foot-cancel').click();
      await page.waitForSelector('.tcard');
      assert.equal(new URL(page.url()).searchParams.get('new'), null);
      await page.locator('#create-poll').click();
      await page.waitForURL(u => new URL(u).searchParams.get('type') === 'poll');
      await page.goBack();
      await page.waitForSelector('.tcard');
      await page.locator('#create-link').click();
      await page.waitForSelector('#f-headline');
      assert.equal(await page.getAttribute('#tab-paste', 'aria-selected'), 'true');
    });
    await ctx.close();
  }

  // ---------------- bot profile cards (desktop)
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    const voteGate = deferred();
    await mockApi(page, {
      streams: [
        () => ({ body: sse([['snapshot', thread('running', BASE_COMMENTS)], ['status', { status: 'running', comment_count: 15 }]]) }),
        async () => { await voteGate.p; return { body: sse([['vote', { comment_id: 1, score: 112 }], ['status', { status: 'running', comment_count: 15 }]]) }; },
        () => new Promise(() => {}),
      ],
    });
    await page.goto(`${BASE}?t=${THREAD_ID}&${Q}`);
    await page.waitForSelector('#c15');
    const dlg = page.locator('.pf-dialog');
    const statText = k => dlg.locator(`[data-stat="${k}"] strong`).textContent();

    await check('occupation shows in the roster sidebar and (desktop) comment rows', async () => {
      assert.equal(await page.locator('#side-roster [data-pf="r1"] .roster-occ').textContent(), 'IT support engineer');
      const occ = page.locator('#c1 > .cm-main > .cm-head .cm-occ');
      assert.ok(await occ.isVisible());
      assert.equal(await occ.textContent(), '· IT support engineer');
      assert.equal(await page.locator('#c15 > .cm-main > .cm-head .cm-occ').count(), 0, 'no occupation, no suffix');
    });
    await check('clicking a username in a comment opens the profile card', async () => {
      await page.locator('#c1 > .cm-main > .cm-head .uname-btn').click();
      await dlg.waitFor();
      assert.equal(await dlg.getAttribute('role'), 'dialog');
      assert.equal(await dlg.getAttribute('aria-modal'), 'true');
      assert.equal(await dlg.locator('#pf-name').textContent(), 'u/chai_and_chill_91');
      assert.equal(await dlg.locator('.flair').textContent(), 'anthropic/claude-haiku-5.5');
      assert.equal(await dlg.locator('.pf-line').textContent(), 'IT support engineer · 29 · Pune');
      assert.equal(await dlg.locator('.pf-outlook').textContent(), BOTS[0].outlook);
      assert.deepEqual(await dlg.locator('.pf-chip').allTextContents(), ['home loans', 'memes', 'cricket']);
      assert.equal(await dlg.locator('.pf-stance').textContent(), 'cynical');
      assert.equal(await statText('comments'), '2');
      assert.equal(await statText('karma'), '15');
      assert.equal(await statText('replies'), '3');
      assert.match(await statText('cake'), /^5[01]m ago$/);
      assert.ok((await dlg.locator('.pf-top').textContent()).includes('screensaver'));
      assert.deepEqual(await dlg.locator('[data-list=recent] [data-comment]').evaluateAll(b => b.map(x => x.dataset.comment)), ['5', '1']);
      assert.equal(await page.evaluate(() => document.activeElement?.className), 'pf-close');
    });
    await check('no horizontal scroll 1440 with profile open', () => noHScroll(page, '1440 profile'));
    await check('live vote updates karma while the card is open', async () => {
      voteGate.resolve();
      await page.waitForFunction(() => document.querySelector('.pf-dialog [data-stat="karma"] strong')?.textContent === '115');
      assert.ok((await dlg.locator('.pf-top .pf-score').textContent()).includes('112'));
    });
    await check('Tab stays trapped inside the card', async () => {
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press(i % 4 === 3 ? 'Shift+Tab' : 'Tab');
        assert.ok(await page.evaluate(() => !!document.activeElement?.closest('.pf-dialog')), `focus escaped on step ${i}`);
      }
    });
    await check('Esc closes the card and returns focus to the username', async () => {
      await page.keyboard.press('Escape');
      await page.locator('#profile').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.pf), 'c1');
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('pf-lock')), false);
    });
    await check('roster click opens the card; a recent comment jumps there, expanding its collapsed ancestor', async () => {
      await page.locator('[data-toggle="1"]').click();
      assert.equal(await page.locator('#c5').count(), 0);
      await page.locator('#side-roster [data-pf="r1"]').click();
      await dlg.waitFor();
      await dlg.locator('[data-list=recent] [data-comment="5"]').click();
      await page.locator('#profile').waitFor({ state: 'hidden' });
      await page.locator('#c5.is-flash').waitFor();
      assert.equal(await page.getAttribute('[data-toggle="1"]', 'aria-expanded'), 'true');
      await page.waitForTimeout(700); // smooth scroll
      const box = await page.locator('#c5').boundingBox();
      assert.ok(box.y >= 0 && box.y + box.height <= 900, `c5 not in view (y=${box.y})`);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.toggle), '5');
    });
    await check('reduced card for a bot without occupation; backdrop click closes', async () => {
      await page.locator('#c15 > .cm-main > .cm-head .uname-btn').click();
      await dlg.waitFor();
      assert.equal(await dlg.locator('#pf-name').textContent(), 'u/hostel_maggi');
      assert.equal(await dlg.locator('.pf-line').count(), 0);
      assert.equal(await dlg.locator('.pf-outlook').count(), 0);
      assert.equal(await dlg.locator('.pf-chip').count(), 0);
      assert.equal(await dlg.locator('.pf-retired').textContent(), 'retired');
      assert.equal(await dlg.locator('.pf-bio').textContent(), BOTS[5].bio);
      assert.equal(await statText('comments'), '1');
      assert.equal(await statText('karma'), '-2');
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(SHOTS, 'profile-reduced-1440-light.png'), fullPage: false });
      await page.mouse.click(60, 450);
      await page.locator('#profile').waitFor({ state: 'hidden' });
    });
    await ctx.close();
  }

  // ---------------- bot profile as a bottom sheet (360x740)
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, colorScheme: 'light', deviceScaleFactor: 2, hasTouch: false });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await mockApi(page, { streams: [doneStream] });
    await page.goto(`${BASE}?t=${THREAD_ID}&${Q}`);
    await page.waitForSelector('#c16');
    const dlg = page.locator('.pf-dialog');
    await check('mobile roster strip opens a bottom sheet with a drag handle', async () => {
      await page.locator('#roster-strip [data-pf="s2"]').click();
      await dlg.waitFor();
      await page.waitForTimeout(350);
      const b = await dlg.boundingBox();
      assert.ok(b.x === 0 && b.width === 360 && Math.abs(b.y + b.height - 740) <= 1, JSON.stringify(b));
      assert.ok(await page.locator('.pf-grab').isVisible());
      assert.equal(await dlg.locator('#pf-name').textContent(), 'u/NotAnEconomist');
      assert.equal(await page.locator('#c1 > .cm-main > .cm-head .cm-occ').isVisible(), false, 'comment occupation hidden on mobile');
    });
    await check('no horizontal scroll 360 with the sheet open', () => noHScroll(page, '360 sheet'));
    await check('backdrop tap closes the sheet', async () => {
      await page.mouse.click(180, 30);
      await page.locator('#profile').waitFor({ state: 'hidden' });
    });
    await check('avatar tap opens it and a swipe down on the handle closes it', async () => {
      await page.locator('#c2 > .cm-main > .cm-head .av-btn').click();
      await dlg.waitFor();
      await page.waitForTimeout(350);
      const g = await page.locator('.pf-grab').boundingBox();
      const x = g.x + g.width / 2, y = g.y + g.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(x, y + i * 30);
      await page.mouse.up();
      await page.locator('#profile').waitFor({ state: 'hidden' });
    });
    await check('a short drag snaps the sheet back open', async () => {
      await page.locator('#c2 > .cm-main > .cm-head .uname-btn').click();
      await dlg.waitFor();
      await page.waitForTimeout(350);
      const g = await page.locator('.pf-grab').boundingBox();
      const x = g.x + g.width / 2, y = g.y + g.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y + 30);
      await page.mouse.up();
      await page.waitForTimeout(300);
      assert.ok(await dlg.isVisible());
      assert.equal(await dlg.evaluate(d => d.style.transform), '');
      await page.keyboard.press('Escape');
      await page.locator('#profile').waitFor({ state: 'hidden' });
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
    await page.goto(`${BASE}?t=${THREAD_ID}&${Q}`);
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

  // ---------------- API unreachable
  {
    const ctx = await newCtx({ viewport: { width: 360, height: 740 } });
    const page = await ctx.newPage();
    track(page);
    await mockApi(page, { down: true });
    await page.goto(`${BASE}?${Q}`);
    await check('friendly front page when the API is unreachable, with Retry and Create post', async () => {
      await page.locator('#feed-retry').waitFor();
      assert.ok((await page.locator('#feed').textContent()).includes("Can't reach the Agent Reddit server"));
      await page.screenshot({ path: join(SHOTS, 'front-unreachable-360-light.png'), fullPage: true });
    });
    await check('composer still lets you write; Post explains the server is unreachable', async () => {
      await page.locator('#feed >> text=Create post').click();
      await page.locator('#compose-alert').waitFor();
      await page.locator('#tab-paste').click();
      await page.fill('#f-headline', 'Will Mumbai ever fix its potholes?');
      await page.locator('#post-btn').click();
      await page.locator('#post-err:not(:empty)').waitFor();
      assert.ok((await page.locator('#post-err').textContent()).includes("Can't reach"));
    });
    await ctx.close();
  }

  // ---------------- screenshots + no-h-scroll at each size and scheme
  const sizes = [[360, 740], [768, 1024], [1440, 900]];
  for (const scheme of ['light', 'dark']) {
    for (const [w, hgt] of sizes) {
      const ctx = await newCtx({ viewport: { width: w, height: hgt }, colorScheme: scheme, deviceScaleFactor: w < 1000 ? 2 : 1 });
      const page = await ctx.newPage();
      track(page);
      await mockApi(page, { streams: [() => ({ body: sse([['snapshot', thread('running', RICH)], ['comment', LIVE_16], ['comment', LIVE_17], ['status', { status: 'running', comment_count: 17 }]]) }), async () => new Promise(() => {})] });
      await page.addInitScript(id => { try { localStorage.setItem(`ar:votes:${id}`, '{"post":1,"2":1,"1":-1}'); } catch {} }, THREAD_ID);
      await page.addInitScript(() => { try { localStorage.setItem('ar:votes:t002', '{"post":1}'); } catch {} });
      const tag = `${w}-${scheme}`;

      await page.goto(`${BASE}?${Q}`);
      await page.waitForSelector('.tcard');
      await page.evaluate(() => document.fonts.ready);
      await check(`no horizontal scroll ${w}x${hgt} ${scheme} front page`, () => noHScroll(page, `${tag} front`));
      await page.screenshot({ path: join(SHOTS, `front-${tag}.png`) });
      await page.screenshot({ path: join(SHOTS, `front-${tag}-full.png`), fullPage: true });

      const shots = [
        ['news', null, async () => { await page.waitForSelector('.paper-card'); }],
        ['news-picked', 'news', async () => { await page.waitForSelector('.paper-card'); await page.locator('.paper-card').nth(1).locator('.post-title').click(); await page.locator('#picked').waitFor(); }],
        ['ask-user', 'ask', async () => {}],
        ['opinion-bot', 'opinion', async () => { await page.locator('#who-bot').click(); }],
        ['poll-user', 'poll', async () => { await page.locator('.poll-opt input').nth(0).fill('Delhi'); }],
        ['ama-bot', 'ama', async () => { await page.locator('.host-chip[data-host="plumber"]').click(); }],
      ];
      for (const [name, type, prep] of shots) {
        await page.goto(`${BASE}?new=1&type=${type || 'news'}&${Q}`);
        await page.waitForSelector('#compose-body .field');
        await prep();
        await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
        await page.evaluate(() => document.fonts.ready);
        await check(`no horizontal scroll ${w}x${hgt} ${scheme} composer ${name}`, () => noHScroll(page, `${tag} compose ${name}`));
        await page.screenshot({ path: join(SHOTS, `compose-${name}-${tag}.png`) });
        if (name === 'ask-user' || name === 'poll-user') await page.screenshot({ path: join(SHOTS, `compose-${name}-${tag}-full.png`), fullPage: true });
      }

      await page.goto(`${BASE}?t=${THREAD_ID}&${Q}`);
      await page.waitForSelector('#c17');
      await page.locator('#c12 .continue').click();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(2800); // let the new-comment highlight fade
      await page.evaluate(() => window.scrollTo(0, 0));
      await check(`no horizontal scroll ${w}x${hgt} ${scheme} thread (depth 6 open)`, () => noHScroll(page, `${tag} thread`));
      await page.screenshot({ path: join(SHOTS, `thread-${tag}.png`) });
      await page.screenshot({ path: join(SHOTS, `thread-${tag}-full.png`), fullPage: true });
      await page.locator('#add-comment').click();
      await page.locator('#comment-box-slot textarea').fill('Honestly the RBI is just reading the same tea leaves as the rest of us.');
      await page.locator('#c15 > .cm-main > .cm-actions .reply-btn').click();
      await page.locator('#c15 .cbox-reply textarea').fill('Think of it as the rate banks pay to borrow overnight.');
      await page.evaluate(() => document.activeElement?.blur?.());
      await check(`no horizontal scroll ${w}x${hgt} ${scheme} thread with comment + reply boxes`, () => noHScroll(page, `${tag} boxes`));
      await page.locator('#comment-box-slot').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, `thread-boxes-${tag}.png`) });
      await page.locator('#c15').scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, `thread-reply-${tag}.png`) });
      await page.locator('#c2').scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, -60));
      await page.screenshot({ path: join(SHOTS, `thread-texture-${tag}.png`) });
      await page.locator('#c2 > .cm-main > .cm-head .uname-btn').click();
      await page.locator('.pf-dialog').waitFor();
      await page.waitForTimeout(350);
      await check(`no horizontal scroll ${w}x${hgt} ${scheme} profile card open`, () => noHScroll(page, `${tag} profile`));
      await page.screenshot({ path: join(SHOTS, `profile-${tag}.png`) });
      await page.keyboard.press('Escape');
      await ctx.close();
    }
  }

  // ---------------- v3 F5: calm threads + touch long-press (agent-reddit/scroll.mjs)
  await scrollSuite({ browser, BASE, check, shots: process.env.SHOTS_V3 || '/tmp/ar-shots-v3' });

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
