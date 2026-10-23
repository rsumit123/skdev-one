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
  joke: { label: 'Joke', color: '#f5a623' },
  confession: { label: 'Confession', color: '#6b5b95' },
};
// A type the client does not know yet (a newer backend): a neutral grey pill labelled with
// the type itself, never mislabelled as News.
export const TYPE_RE = /^[a-z][a-z_]{0,23}$/;
const GENERIC_COLOR = '#787c7e';
export function typeInfo(type) {
  if (POST_TYPES[type]) return POST_TYPES[type];
  if (typeof type === 'string' && TYPE_RE.test(type)) return { label: type[0].toUpperCase() + type.slice(1).replace(/_/g, ' '), color: GENERIC_COLOR, generic: true };
  return POST_TYPES.news;
}
export const knownType = t => Object.prototype.hasOwnProperty.call(POST_TYPES, t);
// The type a card/thread is drawn as: known types as-is, a well-formed unknown type kept (it
// gets the generic pill), anything else (missing, junk) is a news post like before.
export function displayType(t) {
  return knownType(t) || (typeof t === 'string' && TYPE_RE.test(t)) ? t : 'news';
}

// v3.1 composer limits.
export const CONFESSION_RANGE = [20, 2000];

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
  } else if (user && st.type === 'confession') {
    const n = clean(st.body).length;
    if (n < CONFESSION_RANGE[0]) e.body = n ? `A bit more, please: at least ${CONFESSION_RANGE[0]} characters (${n} so far).` : 'Write your confession (at least 20 characters).';
    else if (n > CONFESSION_RANGE[1]) e.body = `Keep it under ${CONFESSION_RANGE[1]} characters (${n} now).`;
    const title = clean(st.title);
    if (title && !lenOk(title, 3, 300)) e.title = 'A title needs at least 3 characters, or leave it empty.';
  } else if (user) {
    const title = clean(st.title);
    if (!lenOk(title, 3, 300)) e.title = st.type === 'poll' ? 'Ask a question (at least 3 characters).' : st.type === 'joke' ? 'Write the joke (at least 3 characters).' : 'Add a title (at least 3 characters).';
  }
  if (user && st.type !== 'confession' && clean(st.body).length > 6000) e.body = 'Keep the text under 6000 characters.';
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
  } else if (user && type === 'confession') {
    out.title = clean(st.title).slice(0, 300) || null; // optional: the server derives one
    out.body = clean(st.body).slice(0, CONFESSION_RANGE[1]) || null;
  } else if (user) {
    out.title = clean(st.title).slice(0, 300);
    out.body = body;
    if (type === 'poll') out.poll_options = (st.options || []).map(clean).filter(Boolean).slice(0, 6).map(o => o.slice(0, 80));
  } else out.idea = idea;
  if (type === 'ama') out.ama_host = clean(st.amaHost) || null;
  // v3: the sub the post goes to. The picker sets it; otherwise the post type's sub.
  out.sub = typeof st.sub === 'string' && SUB_SLUG_RE.test(st.sub) ? st.sub : subForType(type);
  return out;
}

// ---------------------------------------------------------------- v3: subreddits

// Fallback registry, used until GET /reddit/subs answers (and if it never does). Mirrors
// the backend app/reddit/subs.py; the API's colours, icons and copy win when present.
export const SUBS = Object.freeze([
  { slug: 'indianews', name: 'r/IndiaNews', title: 'India News', description: "Today's Indian headlines, argued about live", post_type: 'news', color: '#E8590C', icon: '📰' },
  { slug: 'askindia', name: 'r/AskIndia', title: 'Ask India', description: 'Questions about life in India, answered by people with very different lives', post_type: 'ask', color: '#1C7ED6', icon: '🙋' },
  { slug: 'unpopularindia', name: 'r/UnpopularIndia', title: 'Unpopular India', description: 'Say the unpopular thing. Watch it get litigated', post_type: 'opinion', color: '#C2255C', icon: '🔥' },
  { slug: 'indiapolls', name: 'r/IndiaPolls', title: 'India Polls', description: 'Pick a side, then explain yourself', post_type: 'poll', color: '#2F9E44', icon: '📊' },
  { slug: 'indiaama', name: 'r/IndiaAMA', title: 'India AMA', description: 'Ask an auto driver, a plumber or a CA anything', post_type: 'ama', color: '#7048E8', icon: '🎤' },
  { slug: 'indiajokes', name: 'r/IndiaJokes', title: 'India Jokes', description: 'Desi humour: one-liners, puns, shitposts and groan-worthy dad jokes', post_type: 'joke', color: '#F5A623', icon: '😂' },
  { slug: 'indiaconfessions', name: 'r/IndiaConfessions', title: 'India Confessions', description: 'Small, harmless confessions. Say it here, no names', post_type: 'confession', color: '#6B5B95', icon: '🤫' },
].map(s => Object.freeze({ ...s, threads: null, live: 0 })));
export const SUB_SLUG_RE = /^[a-z0-9_]{1,40}$/;
const FALLBACK_BY_SLUG = new Map(SUBS.map(s => [s.slug, s]));

export function validSlug(s) { return typeof s === 'string' && SUB_SLUG_RE.test(s); }

// Slug of the sub a post type lands in (1:1 for now). Unknown types land in r/IndiaNews,
// like typeInfo() treats them as news.
export function subForType(type, subs = SUBS) {
  const list = Array.isArray(subs) && subs.length ? subs : SUBS;
  const hit = list.find(s => s?.post_type === type) || SUBS.find(s => s.post_type === type);
  return hit ? hit.slug : SUBS[0].slug;
}

// The post type a sub takes, or null for an unknown sub.
export function typeForSub(slug, subs = SUBS) {
  const list = Array.isArray(subs) && subs.length ? subs : SUBS;
  const hit = list.find(s => s?.slug === slug) || FALLBACK_BY_SLUG.get(slug);
  return hit && knownType(hit.post_type) ? hit.post_type : null;
}

// Whether the composer can post to this sub (its type is one the client has a form for).
export const postable = s => !!s && knownType(s.post_type);

const HEX_RE = /^#[0-9a-f]{6}$/i;
const int0 = v => (Number.isInteger(v) && v >= 0 ? v : null);
const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');

// One API Sub, checked field by field; anything malformed falls back to the built-in
// registry entry (or a neutral default for a sub the client does not know). null when
// the slug itself is unusable.
export function normalizeSub(raw) {
  if (!raw || typeof raw !== 'object' || !validSlug(raw.slug)) return null;
  const fb = FALLBACK_BY_SLUG.get(raw.slug);
  // A post type this client does not know (a newer backend) keeps the sub browsable with a
  // generic look; typeForSub() still returns null for it, so the composer never offers it.
  const type = knownType(raw.post_type) ? raw.post_type : fb?.post_type || (typeof raw.post_type === 'string' && TYPE_RE.test(raw.post_type) ? raw.post_type : null);
  if (!type) return null;
  const name = str(raw.name, 40) || fb?.name || `r/${raw.slug}`;
  return {
    slug: raw.slug,
    name: name.startsWith('r/') ? name : `r/${name}`,
    title: str(raw.title, 60) || fb?.title || name.replace(/^r\//, ''),
    description: str(raw.description, 200) || fb?.description || '',
    post_type: type,
    color: HEX_RE.test(raw.color || '') ? raw.color : fb?.color || '#0079d3',
    icon: str(raw.icon, 8) || fb?.icon || '💬',
    threads: int0(raw.threads),
    live: int0(raw.live) ?? 0,
  };
}

// GET /reddit/subs -> registry order, invalid entries dropped, first copy of a slug wins.
export function normalizeSubs(list) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const s = normalizeSub(raw);
    if (s && !seen.has(s.slug)) { seen.add(s.slug); out.push(s); }
  }
  return out;
}

// Sub object for a slug: the API's list first, then the built-in registry, else null.
export function subInfo(slug, subs) {
  return (Array.isArray(subs) ? subs.find(s => s?.slug === slug) : null) || FALLBACK_BY_SLUG.get(slug) || null;
}

// The sub a thread or card belongs to; old rows without `sub` derive it from post_type.
export function subOf(t) {
  if (validSlug(t?.sub)) return t.sub;
  return subForType(knownType(t?.post_type) ? t.post_type : 'news');
}

// What a ThreadCard shows next to its title, per list context:
//   'section' (a home section) and 'sub' (a sub page) already say the sub: no flair, no chip,
//   unless the card is from another sub than the page (then the chip, so it is not mislabeled);
//   'mixed' (any list that mixes subs): the r/<Sub> chip instead of the type flair.
export function cardDecor(t, context, pageSub = null) {
  const sub = subOf(t);
  if (context === 'mixed') return { chip: sub, flair: false };
  if (context === 'section' || context === 'sub') return { chip: pageSub && pageSub !== sub ? sub : null, flair: false };
  return { chip: null, flair: true };
}

// A home section from /reddit/home, ready to page: the first cards, the total and the
// offset of the next "Show more" page (null when everything is shown).
export function sectionFrom(raw) {
  const sub = normalizeSub(raw?.sub);
  if (!sub) return null;
  const { items } = mergeItems([], raw?.threads);
  const total = int0(raw?.total) ?? items.length;
  return { sub, items, total: Math.max(total, items.length), next: items.length < total ? items.length : null };
}

// /reddit/home -> sections in the order given, invalid or duplicate subs dropped.
export function sectionsFrom(data) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(data?.sections) ? data.sections : []) {
    const s = sectionFrom(raw);
    if (s && s.items.length && !seen.has(s.sub.slug)) { seen.add(s.sub.slug); out.push(s); }
  }
  return out;
}

// Merges a "Show more" page (GET /reddit/threads?sub=) into a section. Returns the new
// section and the cards that were actually new. Paging stops when the server says so, when
// the cursor would not move, or once every card of `total` is shown.
export function pageSection(section, data, offset) {
  const { items, added } = mergeItems(section.items, data?.threads);
  const total = int0(data?.total) ?? section.total;
  let next = nextOffset(data?.next_offset, offset);
  if (total != null && items.length >= total) next = null;
  return { section: { ...section, items, total: Math.max(total ?? 0, items.length), next }, added };
}

// "Show 3 more", or fewer when fewer are left.
export function moreCount(section, per = 3) {
  if (!section || section.next == null) return 0;
  const left = Number.isInteger(section.total) ? section.total - section.items.length : per;
  return Math.max(0, Math.min(per, left));
}

// Subs from the registry that have no section on the home page (no posts yet), in
// registry order. A sub that /subs counts posts for never gets the "be the first" tile,
// even if /home and /subs disagree for a moment.
export function emptySubs(subs, sections) {
  const shown = new Set((sections || []).map(s => s?.sub?.slug));
  return (Array.isArray(subs) && subs.length ? subs : SUBS).filter(s => s && !shown.has(s.slug) && !(s.threads > 0));
}

// Patch for the sub chips after a /reddit/subs refetch: only subs whose numbers moved.
export function subsDiff(prev, next) {
  const before = new Map((prev || []).map(s => [s.slug, s]));
  return (next || []).filter(s => { const p = before.get(s.slug); return !p || p.threads !== s.threads || p.live !== s.live; });
}

// ---------------------------------------------------------------- v2: thread interactions

const patch = (comments, id, fn) => comments.map(c => (c.id === id ? { ...c, ...fn(c) } : c));
export function applyEdit(comments, { comment_id, text }) {
  return patch(comments, comment_id, () => ({ text: String(text ?? ''), edited: true }));
}
export function applyDelete(comments, id) {
  return patch(comments, id, () => ({ deleted: true, text: '' }));
}
export function applyRemove(comments, id) {
  return patch(comments, id, () => ({ removed: true, text: '' }));
}
export function applyAwards(comments, { comment_id, awards }) {
  return patch(comments, comment_id, () => ({ awards: Array.isArray(awards) ? awards.filter(a => typeof a === 'string') : [] }));
}
export function applyLock(comments, id) {
  return patch(comments, id, () => ({ locked: true }));
}

// Ids of comments that sit in a locked subtree (the locked comment itself included).
export function lockedIds(comments) {
  const all = comments || [];
  const byId = new Map(all.map(c => [c.id, c]));
  const out = new Set();
  for (const c of all) {
    const seen = new Set();
    let cur = c;
    while (cur && !seen.has(cur.id)) {
      if (cur.locked) { out.add(c.id); break; }
      seen.add(cur.id);
      cur = cur.parent_id != null ? byId.get(cur.parent_id) : null;
    }
  }
  return out;
}

// ["🏅", "😂", "🏅"] -> [["🏅", 2], ["😂", 1]] in order of first appearance.
export function awardCounts(awards) {
  const m = new Map();
  for (const a of Array.isArray(awards) ? awards : []) if (typeof a === 'string' && a) m.set(a, (m.get(a) || 0) + 1);
  return [...m.entries()];
}

// Whether the human can reply to this comment.
export function canReply(c, locked) {
  return !!c && !c.pending && !c.deleted && !c.removed && !c.stickied && !locked;
}

// SSE/201 comment arrives: replace the matching optimistic one (same human, same text),
// else upsert by id. Returns { comments, replaced } (replaced = the pending id or null).
export function reconcileComment(comments, real) {
  const list = comments || [];
  if (list.some(c => c.id === real.id)) {
    return { comments: list.filter(c => !(c.pending && matchesPending(c, real))).map(c => (c.id === real.id ? { ...c, ...real, pending: false } : c)), replaced: null };
  }
  const i = list.findIndex(c => c.pending && matchesPending(c, real));
  if (i === -1) return { comments: [...list, real], replaced: null };
  const out = list.slice();
  const tempId = out[i].id;
  out[i] = { ...real, pending: false };
  // children of the optimistic comment (none expected) are re-pointed at the real id
  return { comments: out.map(c => (c.parent_id === tempId ? { ...c, parent_id: real.id } : c)), replaced: tempId };
}
function matchesPending(p, real) {
  return real.author_type === 'user' && p.author_name === real.author_name && String(p.text).trim() === String(real.text).trim()
    && (p.parent_id ?? null) === (real.parent_id ?? null);
}

// Poll rows for the full results bar, sorted as given; widths are % of total.
export function pollRows(poll) {
  const s = pollSummary(poll);
  return { ...s, rows: s.options.map(o => ({ ...o, lead: !!s.leader && o.votes === s.leader.votes })) };
}

// Who the OP / AMA host is, from Thread fields and the bots' flags.
export function opRoles(thread, bots) {
  const list = Array.isArray(bots) ? bots : [];
  const op = thread?.op;
  const opBot = op?.type === 'bot' && op.bot_id ? op.bot_id : (list.find(b => b?.is_op)?.id ?? null);
  const host = thread?.ama_host_bot_id ?? (list.find(b => b?.is_host)?.id ?? null);
  return { opBot, opUser: op?.type === 'user' ? op.name || null : null, host };
}

// ---------------------------------------------------------------- v3: calm threads

// Frozen order: id -> position among its siblings, from an already ordered tree.
export function rankOrder(roots) {
  const rank = new Map();
  const walk = list => list.forEach((n, i) => { rank.set(n.id, i); walk(n.children || []); });
  walk(roots || []);
  return rank;
}

// Orders a tree (from buildTree) by a frozen rank so live score changes never re-sort.
// Comments the rank does not know yet are slotted in by the sort, before the first
// frozen sibling the sort would put after them; nothing already shown moves.
// No rank means a plain sortTree.
export function arrangeTree(roots, rank, mode = 'best') {
  if (!rank) return sortTree(roots, mode);
  const cmp = COMPARATORS[mode] || COMPARATORS.best;
  const arrange = list => {
    const known = list.filter(n => rank.has(n.id)).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    const fresh = list.filter(n => !rank.has(n.id)).sort(cmp);
    const out = known;
    for (const f of fresh) {
      const i = out.findIndex(x => cmp(f, x) < 0);
      out.splice(i === -1 ? out.length : i, 0, f);
    }
    return out.map(n => ({ ...n, children: arrange(n.children || []) }));
  };
  return arrange(roots || []);
}

// Hold live comments back (behind the "new comments" pill) while the reader is away from
// the live edge (more than 1.5 viewports below the top of the comments) or busy:
// selecting text in the thread, typing a reply, or looking at a profile card.
export const BUFFER_VIEWPORTS = 1.5;
export function shouldBuffer({ distance = 0, viewport = 0, selecting = false, replyFocused = false, profileOpen = false, menuOpen = false } = {}) {
  return distance > viewport * BUFFER_VIEWPORTS || !!selecting || !!replyFocused || !!profileOpen || !!menuOpen;
}

// What to do with one arriving comment: 'show' it in place or 'hold' it for the pill.
// The reader's own comments, bot replies to them and comments inside a collapsed subtree
// (invisible anyway, they only bump the hidden count) always show. A reply to a held
// comment waits with its parent, and once anything is held later arrivals wait too, so
// the merge keeps the arrival order.
export function mergePolicy({ buffering = false, heldCount = 0, own = false, replyToMine = false, parentHeld = false, hiddenByCollapse = false } = {}) {
  if (own) return 'show';
  if (parentHeld) return 'hold';
  if (replyToMine || hiddenByCollapse) return 'show';
  return heldCount > 0 || buffering ? 'hold' : 'show';
}

export function pillText(n, dir) {
  return `${dir === 'up' ? '↑' : '↓'} ${n} new comment${n === 1 ? '' : 's'}`;
}

// Scroll anchoring. `tops` are viewport tops of candidate elements in document order;
// the anchor is the last one at or above the top edge of the visible area (`inset`, below
// the sticky header), i.e. the content the reader is looking at. -1 when there is none.
export function pickAnchor(tops, inset) {
  if (!tops || !tops.length) return -1;
  let idx = 0;
  for (let i = 0; i < tops.length; i++) if (tops[i] <= inset + 0.5) idx = i;
  return idx;
}

// How far to scroll after a mutation so the anchor is back where it was. With `clamp`
// (the anchor itself vanished and an ancestor stands in, or a collapse whose header was
// off-screen) the element is brought down to the visible edge instead of staying above it.
export function anchorTarget({ before, after, inset, clamp = false }) {
  const want = clamp ? Math.max(before, inset) : before;
  return after - want;
}

// Touch long-press, as a pure reducer. Effects: 'press' (start the highlight + timer),
// 'release' (stop them), 'fire' (toggle the comment). `until` = swallow clicks before it.
export const PRESS = Object.freeze({ phase: 'idle', id: null, x: 0, y: 0, until: 0 });
export const PRESS_MS = 450;
export const PRESS_SLOP = 8;
export function pressReducer(state, ev) {
  const s = state || PRESS;
  switch (ev.type) {
    case 'down':
      if ((ev.pointerType !== 'touch' && ev.pointerType !== 'pen') || !ev.eligible) {
        return { state: { ...PRESS, until: s.until }, effect: s.phase === 'pressing' ? 'release' : null };
      }
      return { state: { phase: 'pressing', id: ev.id, x: ev.x, y: ev.y, until: 0 }, effect: 'press' };
    case 'move':
      if (s.phase !== 'pressing' || ev.id !== s.id) return { state: s, effect: null };
      if (Math.hypot(ev.x - s.x, ev.y - s.y) > PRESS_SLOP) return { state: { ...PRESS }, effect: 'release' };
      return { state: s, effect: null };
    case 'timer':
      return s.phase === 'pressing' ? { state: { ...s, phase: 'fired' }, effect: 'fire' } : { state: s, effect: null };
    case 'up':
    case 'cancel':
      if (s.phase === 'fired') return { state: { ...PRESS, until: (ev.t || 0) + 400 }, effect: 'release' };
      if (s.phase === 'pressing') return { state: { ...PRESS }, effect: 'release' };
      return { state: s, effect: null };
    default:
      return { state: s, effect: null };
  }
}

// ---------------------------------------------------------------- v3.2: copy text
// The "⋯" menu copies what a comment says: its stored text with line breaks and `>` quote
// lines kept (no username, flair or score). Deleted and removed comments have nothing to copy.
const cleanText = s => String(s).replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
export function canCopy(c) {
  return !!c && !c.deleted && !c.removed && typeof c.text === 'string' && c.text.trim() !== '';
}
export function commentCopyText(c) {
  return canCopy(c) ? cleanText(c.text) : '';
}
// A post: title, a blank line, the body, then poll options as "A) ..." lines (the letters the
// poll shows). A v2 news article is a separate block, not the body, so it is not included.
export function postCopyText(t) {
  if (!t || typeof t !== 'object') return '';
  const title = String(t.title || t.headline || '').trim();
  const body = typeof t.body === 'string' ? cleanText(t.body) : '';
  const opts = pollSummary(t.poll).options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o.text.trim()}`);
  return [title, body, opts.join('\n')].filter(Boolean).join('\n\n');
}
