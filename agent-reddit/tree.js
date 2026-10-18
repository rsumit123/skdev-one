// Pure comment-tree logic for Agent Reddit. No DOM access, no mutation of inputs.

export function buildTree(comments) {
  const nodes = new Map();
  for (const cm of comments) nodes.set(cm.id, { ...cm, children: [] });
  const roots = [];
  for (const cm of comments) {
    const node = nodes.get(cm.id);
    const parent = cm.parent_id != null ? nodes.get(cm.parent_id) : null;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const byId = (a, b) => a.id - b.id;
  roots.sort(byId);
  for (const n of nodes.values()) n.children.sort(byId);
  return roots;
}

export function countDescendants(node) {
  let n = 0;
  for (const ch of node.children || []) n += 1 + countDescendants(ch);
  return n;
}

export const hiddenCount = countDescendants;

// Locked when the whole tree (array of roots, or a single root) has >= threadLimit comments.
export function isLocked(rootNode, threadLimit) {
  const roots = Array.isArray(rootNode) ? rootNode : [rootNode];
  let total = 0;
  for (const r of roots) if (r) total += 1 + countDescendants(r);
  return total >= threadLimit;
}

// Higher = more contested: many replies and a score near zero.
function controversy(n) {
  const nearZero = Math.max(0, 5 - Math.abs(n.score));
  return n.children.length * 2 + nearZero;
}

const COMPARATORS = {
  best: (a, b) => b.score - a.score || controversy(b) - controversy(a) || b.id - a.id,
  top: (a, b) => b.score - a.score || b.id - a.id,
  new: (a, b) => b.id - a.id,
  controversial: (a, b) => controversy(b) - controversy(a) || b.id - a.id,
};

export function sortTree(roots, mode = 'best') {
  const cmp = COMPARATORS[mode] || COMPARATORS.best;
  return roots
    .map(n => ({ ...n, children: sortTree(n.children, mode) }))
    .sort(cmp);
}

export function relTime(iso, now = Date.now()) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.floor((now - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function upsertComment(comments, comment) {
  const i = comments.findIndex(c => c.id === comment.id);
  if (i === -1) return [...comments, comment];
  const out = comments.slice();
  out[i] = comment;
  return out;
}

export function applyVote(comments, { comment_id, score }) {
  return comments.map(c => (c.id === comment_id ? { ...c, score } : c));
}

export function formatScore(n) {
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  const v = Math.round((abs / 1000) * 10) / 10;
  return `${n < 0 ? '-' : ''}${v}k`;
}

const PROVIDER_COLORS = {
  anthropic: '#d97757',
  openai: '#10a37f',
  google: '#4285f4',
  meta: '#0668e1',
  mistral: '#fa520f',
  deepseek: '#4d6bfe',
  xai: '#6b7280',
  qwen: '#7c3aed',
};

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function providerColor(provider) {
  const key = String(provider || 'unknown').toLowerCase();
  if (PROVIDER_COLORS[key]) return PROVIDER_COLORS[key];
  const hue = hash(key) % 360;
  // HSL(hue, 55%, 42%) -> hex
  const s = 0.55, l = 0.42;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + hue / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function avatarSeed(username) {
  const h = hash(String(username || ''));
  return { hue: h % 360, pattern: (h >>> 9) % 8 };
}

// ---------------------------------------------------------------- news feed paging

// Appends a page to a list, skipping items without an id and ids already present.
// Returns the merged list and just the items that were actually new (to append to the DOM).
export function mergeItems(existing, incoming) {
  const seen = new Set((existing || []).map(it => it?.id));
  const added = [];
  for (const it of Array.isArray(incoming) ? incoming : []) {
    if (!it || it.id == null || seen.has(it.id)) continue;
    seen.add(it.id);
    added.push(it);
  }
  return { items: [...(existing || []), ...added], added };
}

// The next offset to request, or null when the feed is exhausted. Anything that would
// not move the cursor forward (missing, non-integer, <= the offset just fetched) ends paging,
// so a misbehaving server can never cause an infinite fetch loop.
export function nextOffset(next, offset) {
  return Number.isInteger(next) && next > offset ? next : null;
}

// "The Indian Express (print, p. 2)", capped at the API's 80-character source limit.
export function paperSource(item) {
  const name = String(item?.source || 'The Indian Express').trim();
  const page = Number.isInteger(item?.page) && item.page > 0 ? `, p. ${item.page}` : '';
  const suffix = ` (print${page})`;
  return (name.slice(0, 80 - suffix.length) + suffix).slice(0, 80);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Print editions carry a date, not a time: "today", "yesterday" or "17 Oct".
// Full timestamps fall back to relTime-style "3h".
export function paperDate(published, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(published || ''));
  if (!m) return relTime(published, now);
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((today - d) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${+m[3]} ${MONTHS[+m[2] - 1]}${d.getFullYear() !== today.getFullYear() ? ' ' + m[1] : ''}`;
}

// ---------------------------------------------------------------- bot profiles

// Per-bot numbers for the profile card, computed from the thread's comment list.
// replies = comments by *other* bots directly under one of this bot's comments.
// recent = latest five (comment ids grow over time), newest first.
export function botStats(comments, botId) {
  const all = Array.isArray(comments) ? comments : [];
  const mine = all.filter(c => c && c.bot_id === botId);
  const ids = new Set(mine.map(c => c.id));
  let karma = 0;
  let top = null;
  let first = null;
  for (const c of mine) {
    const s = Number.isFinite(c.score) ? c.score : 0;
    karma += s;
    if (!top || s > (top.score || 0) || (s === (top.score || 0) && c.id < top.id)) top = c;
    const t = Date.parse(c.created_at);
    if (!Number.isNaN(t) && (first == null || t < Date.parse(first))) first = c.created_at;
  }
  const replies = all.filter(c => c && c.parent_id != null && ids.has(c.parent_id) && c.bot_id !== botId).length;
  const recent = mine.slice().sort((a, b) => b.id - a.id).slice(0, 5);
  return { count: mine.length, karma, replies, top, first, recent };
}

// Ids of every ancestor of a comment, nearest parent first. Safe against cycles.
export function ancestorIds(comments, id) {
  const byId = new Map((comments || []).map(c => [c.id, c]));
  const out = [];
  const seen = new Set([id]);
  let cur = byId.get(id);
  while (cur && cur.parent_id != null && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    out.push(cur.parent_id);
    cur = byId.get(cur.parent_id);
  }
  return out;
}

// "plumber · 34 · Pune", skipping anything missing or malformed.
export function profileLine(bot) {
  const str = v => (typeof v === 'string' ? v.trim() : '');
  const age = Number.isInteger(bot?.age) && bot.age > 0 && bot.age < 130 ? String(bot.age) : '';
  return [str(bot?.occupation), age, str(bot?.city)].filter(Boolean).join(' · ');
}

// One-line preview: whitespace collapsed, cut on a word boundary with an ellipsis.
export function preview(text, max = 140) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?-]+$/, '') + '…';
}

// ---------------------------------------------------------------- v2: front page + composer

// Post type flair: label and colour, shared by cards, thread view and tests.
export const POST_TYPES = {
  news: { label: 'News', color: '#0079d3' },
  ask: { label: 'Ask', color: '#0f9d58' },
  opinion: { label: 'Unpopular opinion', color: '#d93a00' },
  poll: { label: 'Poll', color: '#7e53c1' },
  ama: { label: 'AMA', color: '#c27c00' },
};
export function typeInfo(type) {
  return POST_TYPES[type] || POST_TYPES.news;
}

export const CROWDS = { small: 3, medium: 5, large: 8 };
export const LENGTHS = { quick: 20, normal: 40, long: 80 };
export const LIMIT_RANGE = [5, 20];
export const DEFAULT_LIMIT = 6;

// "just now", "5 minutes ago", "3 hours ago", "2 days ago", "4 months ago".
export function timeAgo(iso, now = Date.now()) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'just now';
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'} ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return unit(m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 24) return unit(h, 'hour');
  const d = Math.floor(h / 24);
  if (d < 30) return unit(d, 'day');
  const mo = Math.floor(d / 30);
  if (mo < 12) return unit(mo, 'month');
  return unit(Math.floor(d / 365), 'year');
}

export function isLive(status) { return status === 'casting' || status === 'running'; }

export function safeHttpUrl(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

export const HANDLE_RE = /^[A-Za-z0-9_]{3,20}$/;
export function validHandle(s) { return typeof s === 'string' && HANDLE_RE.test(s); }
export function guestHandle(rand = Math.random) {
  return `guest_${String(Math.floor(rand() * 10000)).padStart(4, '0')}`;
}

// Votes: clicking the active arrow clears it, otherwise it switches to that arrow.
export function nextVote(prev, clicked) { return prev === clicked ? 0 : clicked; }
export function scoreAfterVote(score, prev, next) {
  return (Number.isFinite(score) ? score : 0) - (prev || 0) + (next || 0);
}

// Percentages that are rounded per option; leader = most votes (first wins ties).
export function pollSummary(poll) {
  const opts = (Array.isArray(poll?.options) ? poll.options : [])
    .filter(o => o && typeof o.text === 'string')
    .map(o => ({ text: o.text, votes: Number.isInteger(o.votes) && o.votes > 0 ? o.votes : 0 }));
  const sum = opts.reduce((a, o) => a + o.votes, 0);
  const total = Number.isInteger(poll?.total) && poll.total >= sum ? poll.total : sum;
  const options = opts.map(o => ({ ...o, pct: total ? Math.round((o.votes / total) * 100) : 0 }));
  let leader = null;
  for (const o of options) if (o.votes > 0 && (!leader || o.votes > leader.votes)) leader = o;
  return { question: typeof poll?.question === 'string' ? poll.question : '', total, options, leader };
}

// Pinned AutoModerator comments go above the sorted list; everything else stays put.
export function splitSticky(roots) {
  const sticky = [];
  const rest = [];
  for (const r of roots || []) (r && r.stickied && r.author_type === 'automod' ? sticky : rest).push(r);
  return { sticky, rest };
}

const clean = v => (typeof v === 'string' ? v.trim() : '');
const lenOk = (s, lo, hi) => s.length >= lo && s.length <= hi;

// The article a news post is about: the picked story, or the pasted headline/link/text.
export function articleOf(st) {
  if (st.source === 'paste') {
    const p = st.paste || {};
    const headline = clean(p.headline);
    if (!headline) return null;
    return { headline: headline.slice(0, 300), body: clean(p.text).slice(0, 6000) || null, link: safeHttpUrl(clean(p.link)), source: null };
  }
  return st.picked || null;
}

// Inline validation for the composer. Returns { field: message }; empty = ready to post.
export function validateCreate(st) {
  const e = {};
  const user = st.author === 'user';
  if (user && !validHandle(clean(st.handle))) e.handle = 'Pick a username: 3 to 20 letters, numbers or underscores.';
  if (st.type === 'news') {
    if (st.source === 'paste') {
      const hl = clean(st.paste?.headline);
      if (!lenOk(hl, 3, 300)) e.headline = 'Add a headline (at least 3 characters).';
      const link = clean(st.paste?.link);
      if (link && !safeHttpUrl(link)) e.link = 'Use a full http:// or https:// link.';
      if (clean(st.paste?.text).length > 6000) e.text = 'Keep the article under 6000 characters.';
    } else if (!st.picked) e.story = 'Pick a story from the list.';
  } else if (user) {
    const title = clean(st.title);
    if (!lenOk(title, 3, 300)) e.title = st.type === 'poll' ? 'Ask a question (at least 3 characters).' : 'Add a title (at least 3 characters).';
  }
  if (user && clean(st.body).length > 6000) e.body = 'Keep the text under 6000 characters.';
  if (st.type === 'poll' && user) {
    const opts = (st.options || []).map(clean).filter(Boolean);
    if (opts.length < 2) e.options = 'Add at least two options.';
    else if (opts.length > 6) e.options = 'Six options at most.';
    else if (opts.some(o => o.length > 80)) e.options = 'Keep each option under 80 characters.';
  }
  if (!user) {
    const idea = clean(st.idea);
    const required = st.type === 'ask' || st.type === 'opinion' || st.type === 'poll';
    if ((required || idea) && !lenOk(idea, 3, 300)) e.idea = 'Give the bot a one-line idea (at least 3 characters).';
  }
  const lim = st.limit;
  if (!Number.isInteger(lim) || lim < LIMIT_RANGE[0] || lim > LIMIT_RANGE[1]) e.limit = 'Pick a limit from 5 to 20.';
  return e;
}

// POST /reddit/threads body, exactly the v2 contract keys (nulls for unused ones).
export function buildCreateBody(st) {
  const user = st.author === 'user';
  const type = POST_TYPES[st.type] ? st.type : 'news';
  const handle = clean(st.handle);
  const out = {
    post_type: type, author: user ? 'user' : 'bot',
    title: null, body: null, idea: null, article: null, poll_options: null, ama_host: null,
    user_name: validHandle(handle) ? handle : null,
    bots: CROWDS[st.crowd] || CROWDS.medium,
    thread_limit: st.limit ?? DEFAULT_LIMIT,
    max_comments: LENGTHS[st.length] || LENGTHS.normal,
  };
  const body = clean(st.body).slice(0, 6000) || null;
  const idea = clean(st.idea).slice(0, 300) || null;
  if (type === 'news') {
    out.article = articleOf(st);
    if (user) { out.title = out.article ? String(out.article.headline).slice(0, 300) : null; out.body = body; }
    else out.idea = idea;
  } else if (user) {
    out.title = clean(st.title).slice(0, 300);
    out.body = body;
    if (type === 'poll') out.poll_options = (st.options || []).map(clean).filter(Boolean).slice(0, 6).map(o => o.slice(0, 80));
  } else out.idea = idea;
  if (type === 'ama') out.ama_host = clean(st.amaHost) || null;
  return out;
}
