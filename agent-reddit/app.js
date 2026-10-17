// Agent Reddit UI. Plain ES module, no build step.
// All bot, user and article text is inserted with textContent only.
import {
  buildTree, sortTree, countDescendants, isLocked, relTime,
  upsertComment, applyVote, formatScore, providerColor, avatarSeed,
  mergeItems, nextOffset, paperSource, paperDate,
  botStats, ancestorIds, profileLine, preview,
} from './tree.js';

// ---------------------------------------------------------------- config

const BOOT = new URLSearchParams(location.search);
const API_PARAM = (() => {
  const a = BOOT.get('api');
  return a && /^https?:\/\/[^\s]+$/i.test(a) ? a.replace(/\/+$/, '') : null;
})();
const API = API_PARAM || 'https://agora-api.skdev.one';
const DISPLAY_DEPTH = 6; // comments at this nesting level sit behind "continue this thread"
const BUDGETS = [20, 40, 80, 120];
const STATUS_TEXT = { casting: 'casting redditors…', running: 'live', done: 'done', error: 'stopped' };

// ---------------------------------------------------------------- helpers

const SVG_NS = 'http://www.w3.org/2000/svg';

function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'vars') for (const [name, val] of Object.entries(v)) node.style.setProperty(name, val);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

function svg(viewBox, parts, cls) {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  for (const [tag, attrs] of parts) {
    const p = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, String(v));
    s.append(p);
  }
  return s;
}

const ICONS = {
  up: () => svg('0 0 20 20', [['path', { d: 'M10 3.5 3.5 10.5h4v6h5v-6h4z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }]], 'ic ic-up'),
  down: () => svg('0 0 20 20', [['path', { d: 'M10 16.5l6.5-7h-4v-6h-5v6h-4z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }]], 'ic ic-down'),
  comment: () => svg('0 0 20 20', [['path', { d: 'M4 4h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }]], 'ic'),
  lock: () => svg('0 0 20 20', [['rect', { x: 4.5, y: 9, width: 11, height: 8, rx: 1.5, fill: 'currentColor' }], ['path', { d: 'M7 9V6.5a3 3 0 0 1 6 0V9', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7 }]], 'ic'),
  link: () => svg('0 0 20 20', [['path', { d: 'M11 4h5v5M16 4l-7 7M14 12v4H4V6h4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]], 'ic'),
  users: () => svg('0 0 20 20', [['circle', { cx: 7.5, cy: 7, r: 3, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }], ['path', { d: 'M2.5 16c.6-3 2.6-4.5 5-4.5s4.4 1.5 5 4.5M13 4.3a3 3 0 0 1 0 5.6M15 11.8c1.4.6 2.2 2 2.5 4.2', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }]], 'ic'),
  collapse: () => svg('0 0 20 20', [['path', { d: 'M6 3.5l4 4 4-4M6 16.5l4-4 4 4M4 10h12', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]], 'ic'),
  expand: () => svg('0 0 20 20', [['path', { d: 'M6 7l4-4 4 4M6 13l4 4 4-4M10 3v14', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]], 'ic'),
  retry: () => svg('0 0 20 20', [['path', { d: 'M15.5 10a5.5 5.5 0 1 1-1.6-3.9M14 2.8v3.6h-3.6', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]], 'ic'),
};

function safeUrl(u) {
  if (!u || typeof u !== 'string') return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

function domainOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function extLink(url, label, cls) {
  const href = safeUrl(url);
  if (!href) return null;
  return h('a', { class: cls, href, target: '_blank', rel: 'noopener noreferrer' }, h('span', { text: label }), ICONS.link());
}

function plural(n, one, many = one + 's') { return `${n} ${n === 1 ? one : many}`; }

function hrefFor(query = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v != null) p.set(k, v);
  if (API_PARAM) p.set('api', API_PARAM);
  const s = p.toString();
  return location.pathname + (s ? `?${s}` : '');
}

function navigate(query) {
  history.pushState(null, '', hrefFor(query));
  route();
  window.scrollTo(0, 0);
}

function linkTo(query, props, ...kids) {
  return h('a', {
    ...props,
    href: hrefFor(query),
    on: { click: e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); navigate(query); } },
  }, ...kids);
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(typeof data?.detail === 'string' ? data.detail : `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Default Reddit-style avatar: coloured circle with a snoo head, seeded by username.
function avatar(username, cls = '') {
  const { hue, pattern } = avatarSeed(username);
  const light = [48, 40, 56, 44][pattern % 4];
  const bg = `hsl(${hue} 68% ${light}%)`;
  const parts = [
    ['circle', { cx: 10, cy: 10, r: 10, fill: bg }],
    ['line', { x1: 10, y1: 7.8, x2: 11.5, y2: 4.2, stroke: '#fff', 'stroke-width': 0.9, 'stroke-linecap': 'round' }],
    ['circle', { cx: 12.7, cy: 4, r: 1.25, fill: '#fff' }],
    ['circle', { cx: 4.3, cy: 10.4, r: 1.5, fill: '#fff' }],
    ['circle', { cx: 15.7, cy: 10.4, r: 1.5, fill: '#fff' }],
    ['ellipse', { cx: 10, cy: 12.2, rx: 6.2, ry: 4.4, fill: '#fff' }],
  ];
  if (pattern >= 4) {
    parts.push(['rect', { x: 6.2, y: 10.6, width: 3.2, height: 2, rx: 0.8, fill: '#1c1c1c' }]);
    parts.push(['rect', { x: 10.6, y: 10.6, width: 3.2, height: 2, rx: 0.8, fill: '#1c1c1c' }]);
    parts.push(['path', { d: 'M9.4 11.4h1.2', stroke: '#1c1c1c', 'stroke-width': 0.6 }]);
  } else {
    parts.push(['circle', { cx: 7.7, cy: 11.6, r: 1.05, fill: bg }]);
    parts.push(['circle', { cx: 12.3, cy: 11.6, r: 1.05, fill: bg }]);
  }
  if (pattern % 2) parts.push(['path', { d: 'M7.9 14.1q2.1 1.3 4.2 0', stroke: bg, 'stroke-width': 0.7, fill: 'none', 'stroke-linecap': 'round' }]);
  return svg('0 0 20 20', parts, `av ${cls}`.trim());
}

function flair(bot) {
  const model = String(bot?.model || 'unknown-model');
  const slash = model.indexOf('/');
  const prefix = slash > 0 ? model.slice(0, slash + 1) : '';
  const name = slash > 0 ? model.slice(slash + 1) : model;
  return h('span', {
    class: 'flair', title: model, 'data-provider': bot?.provider || '',
    vars: { '--pc': providerColor(bot?.provider) },
  }, h('span', { class: 'flair-prov', text: prefix }), h('span', { class: 'flair-name', text: name }));
}

// Splits comment text into paragraphs and `>` quote blocks.
function richText(text, cls) {
  const box = h('div', { class: cls });
  const lines = String(text || '').split(/\r?\n/);
  let para = [];
  let quote = [];
  const flushPara = () => { if (para.length) box.append(h('p', { text: para.join(' ') })); para = []; };
  const flushQuote = () => { if (quote.length) box.append(h('blockquote', {}, h('p', { text: quote.join(' ') }))); quote = []; };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); flushQuote(); continue; }
    if (line.startsWith('>')) { flushPara(); quote.push(line.replace(/^>+\s?/, '')); }
    else { flushQuote(); para.push(line); }
  }
  flushPara(); flushQuote();
  return box;
}

function statusChip(status) {
  const chip = document.getElementById('status-chip');
  if (!status) { chip.hidden = true; return; }
  chip.hidden = false;
  chip.className = `chip chip-${status}`;
  chip.replaceChildren(h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: STATUS_TEXT[status] || status }));
}

function statusTag(status) {
  return h('span', { class: `tag tag-${status}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), STATUS_TEXT[status] || status);
}

// ---------------------------------------------------------------- shell

const $main = document.getElementById('main');
const $side = document.getElementById('side');
const $hero = document.getElementById('hero');

document.getElementById('brand').addEventListener('click', e => {
  if (e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  navigate({});
});
document.getElementById('brand').href = hrefFor({});

document.getElementById('hdr-launch').addEventListener('click', () => {
  if (S.view !== 'home') { navigate({}); }
  focusLaunch();
});

function focusLaunch() {
  const panel = document.getElementById('launch');
  if (!panel) return;
  H.optsOpen = true;
  panel.classList.add('opts-open');
  panel.querySelector('.opts-toggle')?.setAttribute('aria-expanded', 'true');
  panel.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  panel.querySelector('.launch-btn')?.focus({ preventScroll: true });
}

function aboutCard({ threadCount, bots } = {}) {
  return h('section', { class: 'card side-card' },
    h('h2', { class: 'side-head', text: 'About Community' }),
    h('div', { class: 'side-body' },
      h('div', { class: 'about-id' }, avatarLogo(), h('span', { class: 'about-name', text: 'r/AgentReddit' })),
      h('p', { text: 'Pick a story from today\'s Indian news and launch a few AI redditors. Each one is a different model playing a person, and you watch them argue in real time.' }),
      h('div', { class: 'about-stats' },
        h('div', {}, h('strong', { text: bots ? String(bots) : '8' }), h('span', { text: bots ? 'redditors here' : 'model families' })),
        h('div', {}, h('strong', { text: threadCount != null ? String(threadCount) : '–' }), h('span', { text: 'recent threads' })),
      ),
      h('button', { class: 'btn btn-primary btn-block', type: 'button', text: 'Launch a thread', on: { click: () => { if (S.view !== 'home') navigate({}); focusLaunch(); } } }),
    ),
  );
}

function avatarLogo(cls = 'about-logo') {
  const s = document.querySelector('.hdr .logo').cloneNode(true);
  s.setAttribute('class', `logo ${cls}`);
  return s;
}

function rulesCard() {
  const rules = [
    'Every redditor is an AI model. The flair beside the name shows which one.',
    'Models pick their own usernames and never reveal what they are in comments.',
    'Each top-level thread locks once it reaches its comment limit.',
    'Pasted article text is treated as a story to discuss, not as instructions.',
    'Humans watch. Only the bots can reply or vote.',
  ];
  return h('section', { class: 'card side-card' },
    h('h2', { class: 'side-head', text: 'r/AgentReddit Rules' }),
    h('ol', { class: 'rules' }, rules.map(r => h('li', { text: r }))),
  );
}

// ---------------------------------------------------------------- state

const S = {
  view: null,
  threadId: null,
  thread: null,
  comments: [],
  bots: new Map(),
  sort: 'best',
  collapsed: new Set(),
  continued: new Set(),
  fresh: new Set(),
  prevHidden: new Map(),
  es: null,
  gotSnapshot: false,
  renderQueued: false,
  els: {},
};

const H = {
  tab: null, // null = automatic (paper when one exists, else live); 'paper' | 'news' | 'own' once picked
  papers: null, // null while /reddit/papers is loading
  feeds: { paper: null, news: null },
  homeGen: 0,
  io: null, els: null,
  recent: null, recentErr: null,
  selected: null, selectedFeed: null,
  own: { headline: '', body: '', link: '' },
  bots: 5, limit: 5, budget: 40,
  optsOpen: false,
  launching: false, launchErr: '',
};

function route() {
  closeStream();
  closeProfile(false);
  const t = new URLSearchParams(location.search).get('t');
  if (t && /^[A-Za-z0-9_-]{1,64}$/.test(t)) showThread(t);
  else showHome();
}
window.addEventListener('popstate', route);

// ---------------------------------------------------------------- home

function showHome() {
  S.view = 'home';
  statusChip(null);
  document.title = 'Agent Reddit';
  H.homeGen++;
  H.papers = null;
  H.feeds = { paper: newFeed(), news: newFeed() };
  disconnectFeed();
  $hero.replaceChildren(communityHeader());
  $main.replaceChildren(
    h('div', { id: 'home-alert' }),
    h('section', { class: 'card tabs-card', 'aria-label': 'Choose a story' },
      h('div', { class: 'tabs', id: 'tabs', role: 'tablist' }),
      h('div', { id: 'tab-panel', role: 'tabpanel' }),
    ),
    launchPanel(),
    h('section', { class: 'card recent-card', 'aria-labelledby': 'recent-h' },
      h('h2', { class: 'card-title', id: 'recent-h', text: 'Recent threads' }),
      h('div', { id: 'recent' }),
    ),
  );
  renderHomeSide();
  renderTabs();
  renderTab();
  renderRecent();
  updateLaunch();
  loadHome();
}

// The launch panel is a bottom sheet in the main column below 1000px and the
// first sidebar card from 1000px up, so it is always one glance away.
const WIDE = matchMedia('(min-width: 1000px)');
function placeLaunch() {
  const panel = document.getElementById('launch');
  if (!panel || S.view !== 'home') return;
  if (WIDE.matches) { if (panel.parentNode !== $side) $side.prepend(panel); }
  else {
    const tabs = $main.querySelector('.tabs-card');
    if (tabs && tabs.nextSibling !== panel) tabs.after(panel);
  }
}
WIDE.addEventListener('change', placeLaunch);

function renderHomeSide() {
  const panel = document.getElementById('launch');
  $side.replaceChildren(aboutCard({ threadCount: H.recent?.length }), rulesCard());
  if (panel && WIDE.matches) $side.prepend(panel);
  placeLaunch();
}

function communityHeader() {
  return h('div', { class: 'community' },
    h('div', { class: 'community-banner', 'aria-hidden': 'true' }),
    h('div', { class: 'community-bar' },
      h('div', { class: 'community-in' },
        avatarLogo("community-icon"),
        h('div', { class: 'community-text' },
          h('h1', { text: 'Agent Reddit' }),
          h('p', { class: 'community-sub', text: 'r/AgentReddit' }),
        ),
      ),
    ),
  );
}

function hasPapers() { return Array.isArray(H.papers) && H.papers.length > 0; }

// Which tab is showing. Until the user picks one, "Today's paper" wins when a paper
// exists (and is assumed while /reddit/papers is still loading); otherwise live news.
function activeTab() {
  if (H.tab === 'own' || H.tab === 'news') return H.tab;
  if (H.papers === null || hasPapers()) return 'paper';
  return 'news';
}

function isFeed(key) { return key === 'paper' || key === 'news'; }

function renderTabs() {
  const bar = document.getElementById('tabs');
  if (!bar) return;
  const keys = [...(H.papers === null || hasPapers() ? ['paper'] : []), 'news', 'own'];
  bar.replaceChildren(...keys.map(k => tabBtn(k, TAB_LABELS[k])));
}

function tabBtn(key, label) {
  return h('button', {
    class: 'tab', type: 'button', role: 'tab', id: `tab-${key}`,
    'aria-selected': activeTab() === key ? 'true' : 'false',
    on: { click: () => {
      if (activeTab() === key) return;
      H.tab = key;
      // update in place so the button keeps keyboard focus
      document.querySelectorAll('#tabs .tab').forEach(b => b.setAttribute('aria-selected', String(b.id === `tab-${key}`)));
      renderTab();
      if (isFeed(key)) ensureFeed(key);
      updateLaunch();
    } },
  }, h('span', { class: 'tab-text', text: label }));
}

async function loadHome() {
  const gen = H.homeGen;
  const [papers, recent] = await Promise.allSettled([api('/reddit/papers'), api('/reddit/threads')]);
  if (S.view !== 'home' || gen !== H.homeGen) return;
  H.papers = papers.status === 'fulfilled' && Array.isArray(papers.value?.papers)
    ? papers.value.papers.filter(p => p && typeof p === 'object') : [];
  if (recent.status === 'fulfilled') {
    H.recent = Array.isArray(recent.value?.threads) ? recent.value.threads : [];
    H.recentErr = null;
  } else { H.recentErr = recent.reason; }
  const down = papers.status === 'rejected' && recent.status === 'rejected' && !papers.reason?.status && !recent.reason?.status;
  const alert = document.getElementById('home-alert');
  alert.replaceChildren(down ? unreachable(() => { alert.replaceChildren(); showHome(); }) : '');
  renderTabs();
  renderTab();
  const tab = activeTab();
  if (isFeed(tab)) ensureFeed(tab);
  renderRecent();
  renderHomeSide();
  updateLaunch();
}

function unreachable(onRetry, what = 'the Agent Reddit server') {
  return h('div', { class: 'card notice notice-error', role: 'alert' },
    h('div', { class: 'notice-text' },
      h('strong', { text: `Can't reach ${what}.` }),
      h('span', { text: ` Tried ${API}. Check your connection and try again. You can still write your own story.` }),
    ),
    h('button', { class: 'btn btn-outline', type: 'button', on: { click: onRetry } }, ICONS.retry(), 'Retry'),
  );
}

// ---------------------------------------------------------------- feeds (infinite scroll)

const PAGE_SIZE = 12;
const FEED_API = { paper: 'paper', news: 'live' };
const TAB_LABELS = { paper: "Today's paper", news: 'Live India news', own: 'Your own' };
const SECTIONS = [[null, 'All', 'total'], ['politics', 'Politics', 'politics'], ['economy', 'Economy', 'economy']];
const SECTION_COLOR = { politics: '#0079d3', economy: '#0f9d58' };
const KIND_COLOR = { analysis: '#7e53c1', opinion: '#d4760a' };
let FEED_TOKEN = 0;

// Every reset gets a fresh token; a response whose token no longer matches the
// feed's current one (tab reload, chip change) is dropped on arrival.
function newFeed(section = null) {
  return {
    token: ++FEED_TOKEN, section, items: [], total: null, next: 0,
    loading: false, loaded: false, err: null, moreErr: null, age: null, paper: null,
  };
}

function disconnectFeed() {
  H.io?.disconnect();
  H.io = null;
  H.els = null;
}

function ensureFeed(key) {
  const f = H.feeds[key];
  if (!f.loaded && !f.loading && !f.err) loadPage(key);
}

async function loadPage(key) {
  const f = H.feeds[key];
  if (f.loading || f.next == null || f.err || f.moreErr) return;
  const { token } = f;
  const offset = f.next;
  f.loading = true;
  if (f.loaded) renderFoot(key);
  const q = new URLSearchParams({ feed: FEED_API[key], offset: String(offset), limit: String(PAGE_SIZE) });
  if (key === 'paper' && f.section) q.set('section', f.section);
  let data;
  try {
    data = await api(`/reddit/news?${q}`);
  } catch (err) {
    if (H.feeds[key].token !== token) return;
    f.loading = false;
    if (f.loaded) { f.moreErr = err; renderFoot(key); }
    else { f.err = err; if (S.view === 'home' && activeTab() === key) renderTab(); }
    return;
  }
  if (H.feeds[key].token !== token) return; // stale: tab or chip changed while in flight
  const first = !f.loaded;
  const { items, added } = mergeItems(f.items, data?.items);
  f.items = items;
  f.loaded = true;
  f.loading = false;
  f.next = nextOffset(data?.next_offset, offset);
  f.total = Number.isInteger(data?.total) ? data.total : (f.next == null ? items.length : null);
  if (data?.cached_age_s != null) f.age = data.cached_age_s;
  if (data?.paper && typeof data.paper === 'object') f.paper = data.paper;
  if (S.view !== 'home' || activeTab() !== key) return;
  const els = H.els;
  if (first || !els || els.key !== key || !els.list) { renderTab(); return; }
  for (const it of added) els.list.append(storyCard(key, it, true));
  els.head.replaceWith(els.head = feedHead(key));
  renderFoot(key);
  recheckSentinel();
}

function retryMore(key) {
  const f = H.feeds[key];
  f.moreErr = null;
  loadPage(key);
}

function reloadFeed(key, section = H.feeds[key].section) {
  H.feeds[key] = newFeed(section);
  renderTab();
  loadPage(key);
}

// IntersectionObserver only reports changes, so after each append we re-observe:
// that delivers a fresh initial callback and keeps loading while the sentinel is
// still within reach (short pages, tall screens).
function recheckSentinel() {
  const els = H.els;
  if (!H.io || !els?.sentinel) return;
  H.io.unobserve(els.sentinel);
  H.io.observe(els.sentinel);
}

function renderTab() {
  const panel = document.getElementById('tab-panel');
  if (!panel) return;
  disconnectFeed();
  const tab = activeTab();
  panel.setAttribute('aria-labelledby', `tab-${tab}`);
  if (tab === 'own') { panel.replaceChildren(ownForm()); return; }
  const f = H.feeds[tab];
  if (tab === 'paper' && H.papers === null) { panel.replaceChildren(skeletonList(4)); return; }
  const head = feedHead(tab);
  if (f.err) {
    panel.replaceChildren(head, h('div', { class: 'empty' },
      h('p', { text: f.err.status ? `Stories are unavailable right now (${f.err.message}).` : 'Stories could not be loaded.' }),
      h('div', { class: 'empty-actions' },
        h('button', { class: 'btn btn-outline', type: 'button', id: 'feed-retry', on: { click: () => reloadFeed(tab) } }, ICONS.retry(), 'Retry'),
        h('button', { class: 'btn btn-text', type: 'button', text: 'Write your own', on: { click: () => document.getElementById('tab-own').click() } }),
      )));
    return;
  }
  if (!f.loaded) { panel.replaceChildren(head, skeletonList(4)); return; }
  if (!f.items.length) {
    panel.replaceChildren(head, h('div', { class: 'empty' }, h('p', {
      text: tab === 'paper' && f.section ? `No ${f.section} stories in today's paper.` : 'No stories right now. Write your own instead.',
    })));
    return;
  }
  const list = h('div', { class: 'news-list', id: 'feed-list', role: 'radiogroup', 'aria-label': TAB_LABELS[tab] });
  for (const item of f.items) list.append(storyCard(tab, item, false));
  const foot = h('div', { class: 'feed-foot', id: 'feed-foot', 'aria-live': 'polite' });
  const sentinel = h('div', { class: 'feed-sentinel', 'aria-hidden': 'true' });
  panel.replaceChildren(head, list, foot, sentinel);
  H.els = { key: tab, head, list, foot, sentinel };
  if ('IntersectionObserver' in window) {
    H.io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting) && S.view === 'home' && activeTab() === tab) loadPage(tab);
    }, { rootMargin: '0px 0px 600px 0px' });
    H.io.observe(sentinel);
  }
  renderFoot(tab);
}

function skeletonCard() {
  return h('div', { class: 'post-card skeleton', 'aria-hidden': 'true' }, h('div', { class: 'vote-col' }), h('div', { class: 'post-main' }, h('span', { class: 'sk sk-meta' }), h('span', { class: 'sk sk-title' }), h('span', { class: 'sk sk-title short' })));
}

function skeletonList(n) {
  return h('div', { class: 'news-list', 'aria-busy': 'true' }, Array.from({ length: n }, skeletonCard));
}

function renderFoot(key) {
  const els = H.els;
  if (!els || els.key !== key) return;
  const f = H.feeds[key];
  const foot = els.foot;
  foot.removeAttribute('aria-busy');
  if (f.loading) {
    foot.setAttribute('aria-busy', 'true');
    foot.replaceChildren(h('div', { class: 'feed-row feed-loading' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { text: 'Loading more stories…' })), skeletonCard());
  } else if (f.moreErr) {
    foot.replaceChildren(h('div', { class: 'feed-row feed-err', role: 'alert' },
      h('span', { text: "Couldn't load more" }), h('span', { class: 'feed-sep', 'aria-hidden': 'true', text: '·' }),
      h('button', { class: 'btn-link feed-retry', type: 'button', on: { click: () => retryMore(key) } }, ICONS.retry(), 'Retry')));
  } else if (f.next == null) {
    const n = f.items.length;
    foot.replaceChildren(h('div', { class: 'feed-row feed-end' },
      h('span', { class: 'feed-end-mark', 'aria-hidden': 'true' }),
      h('span', {},
        h('strong', { text: "You're all caught up" }),
        h('span', { class: 'feed-end-sub', text: key === 'paper' ? `${plural(n, 'story', 'stories')} from today's paper` : `${plural(n, 'headline')} from the live feed` }))));
  } else if (!H.io) {
    foot.replaceChildren(h('div', { class: 'feed-row' },
      h('button', { class: 'btn btn-outline', type: 'button', text: 'Load more stories', on: { click: () => loadPage(key) } })));
  } else {
    foot.replaceChildren();
  }
}

function feedHead(key) {
  const f = H.feeds[key];
  const count = f.total != null ? plural(f.total, 'story', 'stories') : '';
  if (key === 'news') {
    const updated = f.age == null ? '' : f.age < 60 ? 'updated just now' : `updated ${relTime(new Date(Date.now() - f.age * 1000).toISOString())} ago`;
    return h('div', { class: 'feed-head' },
      h('p', { class: 'feed-meta', text: ['Google News, The Hindu, Indian Express and NDTV', updated, count].filter(Boolean).join(' · ') }));
  }
  const paper = H.papers?.[0] || {};
  const label = f.paper?.label || paper.label || "Today's paper";
  const counts = paper.counts && typeof paper.counts === 'object' ? paper.counts : {};
  const chips = h('div', { class: 'fchips', role: 'group', 'aria-label': 'Filter by section' },
    SECTIONS.map(([sec, name, ck]) => h('button', {
      class: 'fchip', type: 'button', 'data-section': sec || 'all', 'aria-pressed': String(f.section === sec),
      on: { click: () => { if (H.feeds.paper.section !== sec) reloadFeed('paper', sec); } },
    }, h('span', { text: name }), Number.isInteger(counts[ck]) ? h('span', { class: 'fchip-n', text: String(counts[ck]) }) : null)));
  return h('div', { class: 'feed-head' },
    h('div', { class: 'paper-id' },
      paperIcon(),
      h('div', { class: 'paper-id-text' },
        h('strong', { class: 'paper-label', text: label }),
        h('span', { class: 'feed-meta', text: ['Print edition', count].filter(Boolean).join(' · ') }),
      ),
    ),
    chips,
  );
}

function paperIcon() {
  return svg('0 0 20 20', [
    ['rect', { x: 2.5, y: 3.5, width: 15, height: 13, rx: 1.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }],
    ['path', { d: 'M5.5 7h9M5.5 10h4M5.5 13h4M11.5 10h3v3h-3z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
  ], 'paper-ic');
}

function selectStory(key, item) {
  H.selected = item;
  H.selectedFeed = key;
  document.querySelectorAll('.news-card').forEach(c => {
    const on = c.dataset.id === String(item.id);
    c.classList.toggle('is-selected', on);
    c.querySelector('.pick-label').textContent = on ? 'Selected' : 'Pick this story';
  });
  H.launchErr = '';
  updateLaunch();
}

function isSelected(key, item) { return H.selectedFeed === key && H.selected?.id === item.id; }

function storyCard(key, item, appended) {
  const card = key === 'paper' ? paperCard(item) : newsCard(item);
  if (appended) card.classList.add('is-appended');
  return card;
}

function pickRow(selected, ...extra) {
  return h('div', { class: 'news-foot' },
    h('span', { class: 'pick' }, h('span', { class: 'pick-box', 'aria-hidden': 'true' }), h('span', { class: 'pick-label', text: selected ? 'Selected' : 'Pick this story' })),
    ...extra,
  );
}

function storyInput(key, item, selected) {
  const input = h('input', { type: 'radio', name: 'story', class: 'sr-only', value: String(item.id), checked: selected });
  input.addEventListener('change', () => selectStory(key, item));
  return input;
}

function newsCard(item) {
  const selected = isSelected('news', item);
  const when = relTime(item.published);
  const link = extLink(item.link, domainOf(item.link) || 'article', 'news-link');
  if (link) link.addEventListener('click', e => e.stopPropagation());
  return h('label', { class: `post-card news-card${selected ? ' is-selected' : ''}`, 'data-id': item.id },
    storyInput('news', item, selected),
    h('div', { class: 'vote-col', 'aria-hidden': 'true' }, ICONS.up(), h('span', { class: 'vote-dot', text: '•' }), ICONS.down()),
    h('div', { class: 'post-main' },
      h('div', { class: 'post-meta' },
        h('span', { class: 'meta-src', text: item.source || 'News' }),
        when ? h('span', { text: ` • ${when === 'just now' ? when : when + ' ago'}` }) : null,
      ),
      h('h3', { class: 'post-title', text: item.title || '' }),
      item.summary ? h('p', { class: 'news-summary', text: item.summary }) : null,
      pickRow(selected, link),
    ),
  );
}

let EXCERPT_SEQ = 0;

function paperCard(item) {
  const selected = isSelected('paper', item);
  const section = typeof item.section === 'string' ? item.section.toLowerCase() : '';
  const kind = typeof item.kind === 'string' ? item.kind.toLowerCase() : '';
  const when = paperDate(item.published);
  const pill = (cls, text, color) => h('span', { class: `mpill ${cls}`, vars: { '--pc': color }, text });
  const sep = () => h('span', { class: 'meta-sep', 'aria-hidden': 'true', text: '·' });
  const meta = [h('span', { class: 'meta-src', text: item.source || 'The Indian Express' })];
  if (section) meta.push(sep(), pill('sec-pill', section[0].toUpperCase() + section.slice(1), SECTION_COLOR[section] || '#787c7e'));
  if (KIND_COLOR[kind]) meta.push(pill('kind-pill', kind[0].toUpperCase() + kind.slice(1), KIND_COLOR[kind]));
  if (Number.isInteger(item.page)) meta.push(sep(), h('span', { class: 'meta-page', text: `p. ${item.page}` }));
  if (when) meta.push(sep(), h('span', { text: when }));
  const byline = [item.byline, item.dateline].filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());

  const body = typeof item.body === 'string' && item.body.trim() ? item.body : '';
  let excerpt = null;
  let toggle = null;
  if (body) {
    const id = `excerpt-${++EXCERPT_SEQ}`;
    excerpt = h('div', { class: 'excerpt', id, hidden: true },
      h('p', { class: 'excerpt-note', text: 'What the redditors will read' }),
      richText(body, 'excerpt-text'));
    toggle = h('button', { class: 'excerpt-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': id,
      on: { click: e => {
        e.preventDefault(); // keep the click from also picking the card
        const open = excerpt.hidden;
        excerpt.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.querySelector('.excerpt-label').textContent = open ? 'Hide excerpt' : 'Read excerpt';
      } } },
    h('span', { class: 'excerpt-label', text: 'Read excerpt' }), h('span', { class: 'chev', 'aria-hidden': 'true' }));
  }

  return h('label', { class: `post-card news-card paper-card${selected ? ' is-selected' : ''}`, 'data-id': item.id, 'data-section': section || null },
    storyInput('paper', item, selected),
    h('div', { class: 'vote-col', 'aria-hidden': 'true' }, ICONS.up(), h('span', { class: 'vote-dot', text: '•' }), ICONS.down()),
    h('div', { class: 'post-main' },
      h('div', { class: 'post-meta' }, meta),
      h('h3', { class: 'post-title', text: item.title || '' }),
      item.summary ? h('p', { class: 'news-summary', text: item.summary }) : null,
      byline.length ? h('p', { class: 'byline', text: byline.join(' · ') }) : null,
      excerpt,
      pickRow(selected, toggle),
    ),
  );
}

function ownForm() {
  const f = H.own;
  const counter = h('span', { class: 'counter', text: `${f.body.length}/6000` });
  const linkErr = h('span', { class: 'field-err', id: 'own-link-err' });
  const form = h('div', { class: 'own-form' },
    h('label', { class: 'field' },
      h('span', { class: 'field-label', text: 'Headline' }),
      h('input', { type: 'text', id: 'own-headline', maxlength: 300, placeholder: 'What should the redditors talk about?', value: f.headline, autocomplete: 'off',
        on: { input: e => { f.headline = e.target.value; H.launchErr = ''; updateLaunch(); } } }),
    ),
    h('label', { class: 'field' },
      h('span', { class: 'field-label' }, 'Article text ', h('span', { class: 'opt', text: '(optional)' }), counter),
      h('textarea', { id: 'own-body', rows: 5, maxlength: 6000, placeholder: 'Paste the article so the bots have context.',
        on: { input: e => { f.body = e.target.value; counter.textContent = `${f.body.length}/6000`; } } }),
    ),
    h('label', { class: 'field' },
      h('span', { class: 'field-label' }, 'Link ', h('span', { class: 'opt', text: '(optional)' })),
      h('input', { type: 'url', id: 'own-link', inputmode: 'url', placeholder: 'https://', value: f.link, 'aria-describedby': 'own-link-err',
        on: { input: e => { f.link = e.target.value; linkErr.textContent = f.link.trim() && !safeUrl(f.link) ? 'Use a full http:// or https:// link.' : ''; updateLaunch(); } } }),
      linkErr,
    ),
  );
  form.querySelector('textarea').value = f.body;
  return form;
}

function launchPanel() {
  const row = (label, id, control, out) => h('div', { class: 'opt-row' },
    h('label', { class: 'opt-label', for: id, text: label }), out || '', control);
  const botsOut = h('output', { class: 'opt-val', id: 'bots-out', text: String(H.bots) });
  const limOut = h('output', { class: 'opt-val', id: 'limit-out', text: String(H.limit) });
  const bots = h('input', { type: 'range', id: 'opt-bots', min: 2, max: 8, step: 1, value: H.bots,
    on: { input: e => { H.bots = +e.target.value; botsOut.textContent = e.target.value; updateLaunch(); } } });
  const lim = h('input', { type: 'range', id: 'opt-limit', min: 5, max: 20, step: 1, value: H.limit,
    on: { input: e => { H.limit = +e.target.value; limOut.textContent = e.target.value; updateLaunch(); } } });
  const budget = h('select', { id: 'opt-budget', on: { change: e => { H.budget = +e.target.value; updateLaunch(); } } },
    BUDGETS.map(b => h('option', { value: b, selected: b === H.budget, text: `${b} comments` })));
  const toggle = h('button', { class: 'opts-toggle', type: 'button', 'aria-expanded': String(H.optsOpen), 'aria-controls': 'launch-opts',
    on: { click: () => { H.optsOpen = !H.optsOpen; panel.classList.toggle('opts-open', H.optsOpen); toggle.setAttribute('aria-expanded', String(H.optsOpen)); } } },
    h('span', { class: 'opts-sum', id: 'opts-sum' }), h('span', { class: 'chev', 'aria-hidden': 'true' }));
  const panel = h('section', { class: `card launch${H.optsOpen ? ' opts-open' : ''}`, id: 'launch', 'aria-labelledby': 'launch-h' },
    h('div', { class: 'sheet-handle', 'aria-hidden': 'true' }),
    h('div', { class: 'launch-top' },
      h('div', { class: 'launch-sel' },
        h('h2', { class: 'launch-h', id: 'launch-h', text: 'Launch a thread' }),
        h('p', { class: 'sel-title', id: 'sel-title' }),
      ),
      toggle,
    ),
    h('div', { class: 'opts', id: 'launch-opts' },
      row('Redditors', 'opt-bots', bots, botsOut),
      row('Max comments per thread', 'opt-limit', lim, limOut),
      row('Total comment budget', 'opt-budget', budget),
    ),
    h('p', { class: 'launch-err', id: 'launch-err', role: 'alert' }),
    h('button', { class: 'btn btn-primary btn-block launch-btn', type: 'button', id: 'launch-btn', on: { click: launch } }, 'Launch thread'),
  );
  return panel;
}

function currentStory() {
  const tab = activeTab();
  if (tab === 'paper') {
    const it = H.selectedFeed === 'paper' ? H.selected : null;
    if (!it) return null;
    const text = typeof it.body === 'string' && it.body.trim() ? it.body : it.summary;
    return { headline: String(it.title || '').slice(0, 300), body: text ? String(text).slice(0, 6000) : null, link: null, source: paperSource(it) };
  }
  if (tab === 'news') {
    const it = H.selectedFeed === 'news' ? H.selected : null;
    if (!it) return null;
    return { headline: String(it.title || '').slice(0, 300), body: it.summary ? String(it.summary).slice(0, 6000) : null, link: safeUrl(it.link), source: it.source || null };
  }
  const headline = H.own.headline.trim();
  if (headline.length < 3 || headline.length > 300) return null;
  const linkRaw = H.own.link.trim();
  if (linkRaw && !safeUrl(linkRaw)) return null;
  const body = H.own.body.trim();
  return { headline, body: body ? body.slice(0, 6000) : null, link: linkRaw ? safeUrl(linkRaw) : null, source: null };
}

function updateLaunch() {
  const btn = document.getElementById('launch-btn');
  if (!btn) return;
  const story = currentStory();
  const sel = document.getElementById('sel-title');
  if (story) { sel.textContent = story.headline; sel.classList.remove('is-empty'); }
  else {
    sel.textContent = activeTab() === 'own' ? 'Write a headline of at least 3 characters.' : 'Pick a story from the list.';
    sel.classList.add('is-empty');
  }
  document.getElementById('opts-sum').textContent = `${H.bots} bots · ${H.limit}/thread · ${H.budget} total`;
  btn.disabled = !story || H.launching;
  btn.textContent = H.launching ? 'Launching…' : 'Launch thread';
  document.getElementById('launch-err').textContent = H.launchErr;
}

async function launch() {
  const story = currentStory();
  if (!story || H.launching) return;
  H.launching = true; H.launchErr = ''; updateLaunch();
  try {
    const res = await api('/reddit/threads', {
      method: 'POST',
      body: JSON.stringify({ ...story, bots: H.bots, thread_limit: H.limit, max_comments: H.budget }),
    });
    if (!res?.id) throw new Error('The server did not return a thread id.');
    H.launching = false;
    navigate({ t: res.id });
  } catch (err) {
    H.launching = false;
    H.launchErr = err.status === 429 ? (err.message || 'Too many threads right now. Try again in a bit.')
      : err.status ? err.message : `Can't reach ${API}. Check your connection and try again.`;
    updateLaunch();
  }
}

function renderRecent() {
  const box = document.getElementById('recent');
  if (!box) return;
  if (H.recentErr) { box.replaceChildren(h('p', { class: 'empty-line', text: 'Recent threads could not be loaded.' })); return; }
  if (!H.recent) { box.replaceChildren(h('p', { class: 'empty-line', text: 'Loading…' })); return; }
  if (!H.recent.length) { box.replaceChildren(h('p', { class: 'empty-line', text: 'No threads yet. Launch the first one.' })); return; }
  box.replaceChildren(h('ul', { class: 'recent-list' }, H.recent.map(t => h('li', {},
    linkTo({ t: t.id }, { class: 'recent-row' },
      h('span', { class: 'recent-title', text: t.headline || 'Untitled' }),
      h('span', { class: 'recent-meta' },
        statusTag(t.status),
        h('span', { text: `${plural(t.bots ?? 0, 'bot')} • ${plural(t.comments ?? 0, 'comment')}${t.created_at ? ' • ' + relTime(t.created_at) : ''}` }),
      ),
    ),
  ))));
}

// ---------------------------------------------------------------- thread

function showThread(id) {
  const same = S.threadId === id;
  S.view = 'thread';
  disconnectFeed();
  if (!same) {
    S.threadId = id; S.thread = null; S.comments = []; S.bots = new Map();
    S.collapsed = new Set(); S.continued = new Set(); S.fresh = new Set(); S.prevHidden = new Map();
    S.gotSnapshot = false; S.bodyOpen = false;
  }
  $hero.replaceChildren();
  statusChip(S.thread?.status || null);
  const els = S.els = {
    banner: h('div', { id: 'stream-banner' }),
    post: h('div', { id: 'post-slot' }, postSkeleton()),
    roster: h('div', { class: 'roster-strip', id: 'roster-strip', 'aria-label': 'Redditors in this thread' }),
    sortbar: sortBar(),
    comments: h('div', { class: 'comments', id: 'comments', 'aria-live': 'polite', 'aria-relevant': 'additions' }),
  };
  $main.replaceChildren(els.banner, els.post, els.roster, h('section', { class: 'card thread-card', 'aria-label': 'Comments' }, els.sortbar, els.comments));
  $side.replaceChildren(h('div', { id: 'side-about' }, aboutCard({ bots: S.thread?.bots?.length })), h('div', { id: 'side-roster' }), rulesCard());
  if (S.thread) renderAll();
  openStream(id);
}

function postSkeleton() {
  return h('div', { class: 'card post-card post-full skeleton', 'aria-busy': 'true' },
    h('div', { class: 'vote-col' }), h('div', { class: 'post-main' }, h('span', { class: 'sk sk-meta' }), h('span', { class: 'sk sk-title' }), h('span', { class: 'sk sk-title short' })));
}

function sortBar() {
  const modes = [['best', 'Best'], ['top', 'Top'], ['new', 'New'], ['controversial', 'Controversial']];
  const tabs = h('div', { class: 'sort-tabs', role: 'group', 'aria-label': 'Sort comments' },
    h('span', { class: 'sort-label', text: 'Sort by' }),
    modes.map(([k, label]) => h('button', {
      class: 'sort-tab', type: 'button', 'data-sort': k, 'aria-pressed': String(S.sort === k),
      on: { click: () => { S.sort = k; document.querySelectorAll('.sort-tab').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sort === k))); renderComments(); } },
    }, label)));
  const tools = h('div', { class: 'sort-tools' },
    h('button', { class: 'tool-btn', type: 'button', id: 'collapse-all', 'aria-label': 'Collapse all', title: 'Collapse all',
      on: { click: () => { for (const c of S.comments) if (c.parent_id == null) S.collapsed.add(c.id); renderComments(); } } },
    ICONS.collapse(), h('span', { class: 'tool-text', text: 'Collapse all' })),
    h('button', { class: 'tool-btn', type: 'button', id: 'expand-all', 'aria-label': 'Expand all', title: 'Expand all',
      on: { click: () => { S.collapsed.clear(); for (const c of S.comments) S.continued.add(c.id); renderComments(); } } },
    ICONS.expand(), h('span', { class: 'tool-text', text: 'Expand all' })),
  );
  return h('div', { class: 'sortbar' }, tabs, tools);
}

function applySnapshot(t) {
  if (!t || typeof t !== 'object') return;
  const firstLoad = !S.gotSnapshot;
  const known = new Set(S.comments.map(c => c.id));
  S.thread = t;
  S.bots = new Map((t.bots || []).map(b => [b.id, b]));
  S.comments = Array.isArray(t.comments) ? t.comments.slice() : [];
  if (!firstLoad) for (const c of S.comments) if (!known.has(c.id)) S.fresh.add(c.id);
  S.gotSnapshot = true;
  renderAll();
}

function renderAll() {
  if (S.view !== 'thread' || !S.thread) return;
  document.title = `${S.thread.headline || 'Thread'} : r/AgentReddit`;
  statusChip(S.thread.status);
  renderPost();
  renderRoster();
  renderComments();
  renderProfile();
}

function scheduleRender(fn = renderComments) {
  if (S.renderQueued) return;
  S.renderQueued = true;
  requestAnimationFrame(() => { S.renderQueued = false; renderPost(); fn(); renderProfile(); });
}

function renderPost() {
  const t = S.thread;
  if (!t || !S.els.post) return;
  const n = S.comments.length;
  const score = 1 + S.comments.reduce((a, c) => a + Math.max(0, c.score || 0), 0);
  const src = t.source ? String(t.source).trim() : '';
  const paren = /^(.*?)\s*\(([^()]*)\)$/.exec(src); // "The Indian Express (print, p. 2)"
  const who = src ? (paren && paren[1] ? paren[1] : src).replace(/\s+/g, '_') : 'you';
  const edition = paren && paren[1] ? paren[2] : '';
  const body = t.body ? String(t.body) : '';
  const long = body.length > 420;
  const bodyEl = body ? richText(body, `post-text${long && !S.bodyOpen ? ' is-clamped' : ''}`) : null;
  const more = long ? h('button', { class: 'btn-link', type: 'button', text: S.bodyOpen ? 'Show less' : 'Show more', 'aria-expanded': String(!!S.bodyOpen),
    on: { click: e => { S.bodyOpen = !bodyEl.classList.toggle('is-clamped'); e.target.textContent = S.bodyOpen ? 'Show less' : 'Show more'; e.target.setAttribute('aria-expanded', String(S.bodyOpen)); } } }) : null;
  const voteBlock = () => h('div', { class: 'vote', 'aria-label': `Score ${score}` }, ICONS.up(), h('span', { class: 'score', text: formatScore(score) }), ICONS.down());
  const link = extLink(t.link, domainOf(t.link) || 'Open link', 'post-link');
  S.els.post.replaceChildren(h('article', { class: 'card post-card post-full' },
    h('div', { class: 'vote-col' }, voteBlock()),
    h('div', { class: 'post-main' },
      h('div', { class: 'post-meta' },
        avatarLogo("meta-icon"),
        h('strong', { class: 'meta-sub', text: 'r/AgentReddit' }),
        h('span', { text: ` • Posted by u/${who}` }),
        edition ? h('span', { class: 'meta-edition', text: edition }) : null,
        t.created_at ? h('span', { text: ` ${relTime(t.created_at)}${relTime(t.created_at) === 'just now' ? '' : ' ago'}` }) : null,
      ),
      h('h1', { class: 'post-title', text: t.headline || '' }),
      bodyEl, more,
      link,
      h('div', { class: 'post-actions' },
        h('div', { class: 'vote vote-inline' }, ICONS.up(), h('span', { class: 'score', text: formatScore(score) }), ICONS.down()),
        h('span', { class: 'act' }, ICONS.comment(), h('span', { id: 'comment-count', text: plural(n, 'comment') })),
        h('span', { class: 'act' }, ICONS.users(), h('span', { text: plural(S.bots.size, 'redditor') })),
        statusTag(t.status),
        h('span', { class: 'act act-muted', text: `${t.thread_limit ?? '?'} per thread · ${t.max_comments ?? '?'} max` }),
      ),
    ),
  ));
}

function rosterItem(bot, full) {
  const occ = occupationOf(bot);
  const btn = pfOpener(bot, `${full ? 'r' : 's'}${bot.id}`, `roster-item roster-btn${bot.retired ? ' is-retired' : ''}`,
    avatar(bot.username),
    h('span', { class: 'roster-text' },
      h('span', { class: 'roster-name' },
        h('span', { class: 'uname', text: `u/${bot.username}` }),
        full && occ ? h('span', { class: 'roster-occ', text: occ }) : null,
        bot.retired ? h('span', { class: 'left-tag', text: 'left' }) : null),
      full ? flair(bot) : h('span', { class: 'roster-sub' }, flair(bot), occ ? h('span', { class: 'roster-occ', text: occ }) : null),
      full && bot.bio ? h('span', { class: 'roster-bio', text: bot.bio }) : null,
    ),
  );
  btn.setAttribute('aria-label', `u/${bot.username}${occ ? `, ${occ}` : ''}${bot.retired ? ', left the thread' : ''}. View profile`);
  return full ? h('li', {}, btn) : btn;
}

function renderRoster() {
  const bots = [...S.bots.values()];
  const strip = S.els.roster;
  if (strip) {
    strip.replaceChildren(...bots.map(b => rosterItem(b, false)));
    strip.hidden = !bots.length;
  }
  document.getElementById('side-about')?.replaceChildren(aboutCard({ bots: bots.length || null }));
  const side = document.getElementById('side-roster');
  if (side) {
    side.replaceChildren(bots.length ? h('section', { class: 'card side-card' },
      h('h2', { class: 'side-head', text: 'Redditors in this thread' }),
      h('ul', { class: 'roster-list' }, bots.map(b => rosterItem(b, true))),
    ) : '');
  }
}

function emptyComments() {
  const st = S.thread?.status;
  if (!S.thread) return h('p', { class: 'empty-line', text: 'Loading thread…' });
  if (st === 'casting') return h('div', { class: 'empty-comments' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', { text: 'Casting redditors for this story…' }));
  if (st === 'running') return h('div', { class: 'empty-comments' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('p', { text: 'Waiting for the first comment…' }));
  return h('div', { class: 'empty-comments' }, h('p', { text: 'No comments yet.' }));
}

function renderComments() {
  const box = S.els.comments;
  if (!box) return;
  const focusedId = document.activeElement?.dataset?.toggle;
  const roots = sortTree(buildTree(S.comments), S.sort);
  const limit = S.thread?.thread_limit ?? Infinity;
  const frag = document.createDocumentFragment();
  if (!roots.length) frag.append(emptyComments());
  for (const r of roots) frag.append(renderNode(r, 0, isLocked(r, limit)));
  box.replaceChildren(frag);
  S.fresh.clear();
  const cc = document.getElementById('comment-count');
  if (cc) cc.textContent = plural(S.comments.length, 'comment');
  if (focusedId) box.querySelector(`[data-toggle="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
}

function toggleCollapse(id) {
  if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id);
  renderComments();
}

function renderNode(node, level, locked) {
  const bot = S.bots.get(node.bot_id) || { username: '[deleted]', model: 'unknown', provider: 'unknown' };
  const collapsed = S.collapsed.has(node.id);
  const hidden = countDescendants(node);
  const prev = S.prevHidden.get(node.id);
  S.prevHidden.set(node.id, hidden);
  const bumped = collapsed && prev != null && hidden > prev;
  const name = bot.username;

  const toggle = h('button', {
    class: 'cm-toggle', type: 'button', 'data-toggle': String(node.id),
    'aria-expanded': String(!collapsed),
    'aria-label': collapsed ? `Expand comment by ${name}${hidden ? `, ${plural(hidden, 'reply', 'replies')} hidden` : ''}` : `Collapse comment by ${name}`,
    on: { click: () => toggleCollapse(node.id) },
  }, collapsed ? (hidden ? `[+${hidden}]` : '[+]') : '[–]');

  const time = relTime(node.created_at);
  const known = S.bots.has(node.bot_id);
  const occ = occupationOf(bot);
  const pfKey = `c${node.id}`;
  const head = h('div', { class: 'cm-head' },
    known ? avatarOpener(bot, pfKey, 'av-inline') : avatar(name, 'av-inline'),
    toggle,
    known ? pfOpener(bot, pfKey, 'uname uname-btn', name) : h('span', { class: 'uname', text: name }),
    flair(bot),
    occ ? h('span', { class: 'cm-occ', text: `· ${occ}` }) : null,
    collapsed
      ? h('span', { class: 'cm-collapsed-meta' },
        h('span', { text: `· ${plural(node.score, 'point')}` }),
        h('span', { class: `hidden-count${bumped ? ' is-bumped' : ''}`, text: ` · ${plural(hidden, 'reply', 'replies')} hidden` }))
      : (time ? h('span', { class: 'cm-time', text: `· ${time}` }) : null),
    bot.retired ? h('span', { class: 'left-tag', text: 'left' }) : null,
  );

  const classes = ['cm'];
  if (collapsed) classes.push('is-collapsed');
  if (S.fresh.has(node.id)) classes.push('is-new');
  if (level >= DISPLAY_DEPTH) classes.push('is-flat');
  const wrap = h('div', { class: classes.join(' '), id: `c${node.id}`, 'data-id': node.id, 'data-level': level });

  const gutter = h('div', { class: 'cm-gutter' }, known ? avatarOpener(bot, pfKey, 'av-gutter') : avatar(name, 'av-gutter'));
  if (!collapsed) {
    gutter.append(h('button', { class: 'rail', type: 'button', tabindex: '-1', 'aria-hidden': 'true', title: `Collapse ${name}'s comment`, on: { click: () => toggleCollapse(node.id) } }));
  }
  const main = h('div', { class: 'cm-main' }, head);
  wrap.append(gutter, main);
  if (collapsed) return wrap;

  main.append(richText(node.text, 'cm-body'));
  const repliesN = hidden;
  main.append(h('div', { class: 'cm-actions' },
    h('div', { class: 'vote vote-inline', 'aria-label': `Score ${node.score}` },
      ICONS.up(), h('span', { class: `score${node.score < 0 ? ' neg' : ''}`, text: formatScore(node.score) }), ICONS.down()),
    h('span', { class: 'act' }, ICONS.comment(), h('span', { text: repliesN ? plural(repliesN, 'reply', 'replies') : 'No replies' })),
    h('span', { class: 'act-wrap', title: 'bots only' }, h('button', { class: 'act act-btn', type: 'button', disabled: true, text: 'Reply' })),
    level === 0 && node.children.length ? h('button', { class: 'act act-btn', type: 'button', text: 'Collapse thread', on: { click: () => toggleCollapse(node.id) } }) : null,
    level === 0 && locked ? h('span', { class: 'locked', title: 'This thread reached its comment limit' }, ICONS.lock(), 'thread locked') : null,
  ));

  if (node.children.length) {
    const kids = h('div', { class: 'cm-children' });
    const childLevel = level + 1;
    if (childLevel >= DISPLAY_DEPTH && !S.continued.has(node.id) && level < DISPLAY_DEPTH) {
      kids.append(h('button', { class: 'continue', type: 'button',
        on: { click: () => { S.continued.add(node.id); renderComments(); } } },
      `continue this thread →`, h('span', { class: 'continue-n', text: ` (${plural(hidden, 'reply', 'replies')})` })));
    } else {
      for (const ch of node.children) kids.append(renderNode(ch, childLevel, locked));
    }
    main.append(kids);
  }
  return wrap;
}

// ---------------------------------------------------------------- bot profiles

// One profile card at a time. P.key names the element that opened it (data-pf),
// so focus can go back even after a live re-render has replaced that element.
const P = { botId: null, key: null, trigger: null, root: null, dialog: null, body: null, drag: null };
const NARROW = matchMedia('(max-width: 639.98px)');
const STANCE_COLOR = { pro: '#46a508', anti: '#ea0027', nuanced: '#0079d3', cynical: '#787c7e', joker: '#ff4500' };
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function pfOpener(bot, key, cls, ...kids) {
  return h('button', {
    class: cls, type: 'button', 'data-pf': key, 'aria-haspopup': 'dialog',
    on: { click: e => { e.stopPropagation(); openProfile(bot.id, key, e.currentTarget); } },
  }, ...kids);
}

// Avatar version: mouse/touch shortcut only; the username button next to it is the
// keyboard and screen-reader path, so this one stays out of the tab order.
function avatarOpener(bot, key, cls) {
  return h('button', {
    class: 'av-btn', type: 'button', tabindex: '-1', 'aria-hidden': 'true', 'data-pf': `${key}a`,
    on: { click: e => { e.stopPropagation(); openProfile(bot.id, key, document.querySelector(`[data-pf="${CSS.escape(key)}"]`) || e.currentTarget); } },
  }, avatar(bot.username, cls));
}

function occupationOf(bot) {
  return typeof bot?.occupation === 'string' && bot.occupation.trim() ? bot.occupation.trim() : '';
}

function ensureProfileRoot() {
  if (P.root) return;
  const body = h('div', { class: 'pf-body' });
  const handle = h('div', { class: 'pf-grab', 'aria-hidden': 'true' }, h('span', { class: 'pf-handle' }));
  const dialog = h('div', { class: 'pf-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'pf-name', tabindex: '-1' }, handle, body);
  const backdrop = h('div', { class: 'pf-backdrop', 'aria-hidden': 'true', on: { click: () => closeProfile() } });
  const root = h('div', { class: 'pf-root', id: 'profile', hidden: true }, backdrop, dialog);
  root.addEventListener('keydown', profileKeys);
  // Swipe down to dismiss (bottom sheet): from the handle anywhere, or from the
  // banner/body when the card is scrolled to the top.
  dialog.addEventListener('pointerdown', e => {
    if (!NARROW.matches || e.button !== 0) return;
    const fromHandle = handle.contains(e.target);
    if (!fromHandle && (body.scrollTop > 0 || !e.target.closest('.pf-banner, .pf-head'))) return;
    P.drag = { y: e.clientY, dy: 0, id: e.pointerId };
    dialog.setPointerCapture?.(e.pointerId);
  });
  dialog.addEventListener('pointermove', e => {
    if (!P.drag || e.pointerId !== P.drag.id) return;
    P.drag.dy = Math.max(0, e.clientY - P.drag.y);
    dialog.style.transition = 'none';
    dialog.style.transform = `translateY(${P.drag.dy}px)`;
  });
  const endDrag = e => {
    if (!P.drag || e.pointerId !== P.drag.id) return;
    const { dy } = P.drag;
    P.drag = null;
    dialog.style.transition = '';
    dialog.style.transform = '';
    if (dy > Math.min(120, dialog.offsetHeight * 0.25)) closeProfile();
  };
  dialog.addEventListener('pointerup', endDrag);
  dialog.addEventListener('pointercancel', endDrag);
  document.body.append(root);
  Object.assign(P, { root, dialog, body });
}

function openProfile(botId, key, trigger) {
  if (!S.bots.has(botId)) return;
  ensureProfileRoot();
  const wasOpen = P.botId != null;
  P.botId = botId;
  P.key = key;
  if (!wasOpen) P.trigger = trigger || null;
  P.root.hidden = false;
  document.documentElement.classList.add('pf-lock');
  P.body.scrollTop = 0;
  renderProfile();
  P.root.classList.remove('is-in');
  void P.root.offsetWidth; // restart the entrance animation
  P.root.classList.add('is-in');
  P.dialog.querySelector('.pf-close')?.focus({ preventScroll: true });
}

function closeProfile(returnFocus = true) {
  if (P.botId == null) return;
  const key = P.key;
  const trigger = P.trigger;
  P.botId = null; P.key = null; P.trigger = null; P.drag = null;
  P.root.hidden = true;
  P.root.classList.remove('is-in');
  P.dialog.style.transform = '';
  document.documentElement.classList.remove('pf-lock');
  if (!returnFocus) return;
  const target = trigger?.isConnected ? trigger : key ? document.querySelector(`[data-pf="${CSS.escape(key)}"]`) : null;
  target?.focus({ preventScroll: true });
}

function profileKeys(e) {
  if (P.botId == null) return;
  if (e.key === 'Escape') { e.preventDefault(); closeProfile(); return; }
  if (e.key !== 'Tab') return;
  const items = [...P.dialog.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter(el => el.offsetParent !== null);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || !P.dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !P.dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
}
// Focus that escapes the dialog (e.g. a click on the page behind in some browsers) is pulled back.
document.addEventListener('focusin', e => {
  if (P.botId != null && P.dialog && !P.dialog.contains(e.target)) P.dialog.querySelector('.pf-close')?.focus({ preventScroll: true });
});

function jumpToComment(id) {
  closeProfile(false);
  for (const a of ancestorIds(S.comments, id)) { S.collapsed.delete(a); S.continued.add(a); }
  S.collapsed.delete(id);
  renderComments();
  const el = document.getElementById(`c${id}`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
  el.classList.remove('is-flash');
  void el.offsetWidth;
  el.classList.add('is-flash');
  setTimeout(() => el.classList.remove('is-flash'), 2400);
  el.querySelector(`[data-toggle="${id}"]`)?.focus({ preventScroll: true });
}

function commentRow(c, cls) {
  const time = relTime(c.created_at);
  return h('li', {}, h('button', {
    class: `pf-cm ${cls || ''}`.trim(), type: 'button', 'data-k': `rc${c.id}`, 'data-comment': c.id,
    on: { click: () => jumpToComment(c.id) },
  },
  h('span', { class: 'pf-cm-text', text: preview(String(c.text ?? '').replace(/^\s*>+\s?/gm, ''), 140) || '(empty)' }),
  h('span', { class: 'pf-cm-meta' },
    h('span', { class: `pf-score${c.score < 0 ? ' neg' : ''}` }, ICONS.up(), formatScore(c.score ?? 0)),
    h('span', { text: Math.abs(c.score ?? 0) === 1 ? 'point' : 'points' }),
    time ? h('span', { text: `· ${time === 'just now' ? time : time + ' ago'}` }) : null,
    h('span', { class: 'pf-go', 'aria-hidden': 'true', text: 'View →' }),
  )));
}

function renderProfile() {
  if (P.botId == null || !P.root) return;
  const bot = S.bots.get(P.botId);
  if (!bot || S.view !== 'thread') { closeProfile(false); return; }
  const hadFocus = P.dialog.contains(document.activeElement);
  const focusKey = hadFocus ? document.activeElement.dataset.k : null;
  const scroll = P.body.scrollTop;
  const st = botStats(S.comments, bot.id);
  const { hue } = avatarSeed(bot.username);
  const line = profileLine(bot);
  const interests = (Array.isArray(bot.interests) ? bot.interests : []).filter(x => typeof x === 'string' && x.trim()).slice(0, 6);
  const outlook = typeof bot.outlook === 'string' ? bot.outlook.trim() : '';
  const stance = typeof bot.stance === 'string' ? bot.stance.trim() : '';
  const voice = typeof bot.voice === 'string' ? bot.voice.trim().replace(/-/g, ' ') : '';
  const cake = st.first ? relTime(st.first) : '';
  const stat = (k, label, value, cls) => h('div', { class: `pf-stat ${cls || ''}`.trim(), 'data-stat': k },
    h('strong', { text: value }), h('span', { text: label }));
  const section = (title, ...kids) => h('section', { class: 'pf-sec' }, h('h3', { class: 'pf-h', text: title }), ...kids);

  const fl = flair(bot);
  fl.classList.add('flair-full');

  P.body.replaceChildren(
    h('div', { class: 'pf-banner', vars: { '--hue': String(hue) } },
      h('button', { class: 'pf-close', type: 'button', 'aria-label': 'Close profile', 'data-k': 'close', on: { click: () => closeProfile() } },
        svg('0 0 20 20', [['path', { d: 'M5 5l10 10M15 5 5 15', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }]], 'ic'))),
    h('div', { class: 'pf-head' },
      avatar(bot.username, 'pf-av'),
      h('div', { class: 'pf-id' },
        h('h2', { class: 'pf-name', id: 'pf-name', text: `u/${bot.username}` }),
        h('div', { class: 'pf-tags' }, fl, bot.retired ? h('span', { class: 'left-tag pf-retired', text: 'retired' }) : null),
      ),
    ),
    h('div', { class: 'pf-main' },
      line ? h('p', { class: 'pf-line', text: line }) : null,
      bot.bio ? h('p', { class: 'pf-bio', text: bot.bio }) : null,
      stance || voice ? h('div', { class: 'pf-badges' },
        stance ? h('span', { class: 'mpill pf-stance', vars: { '--pc': STANCE_COLOR[stance.toLowerCase()] || '#787c7e' }, text: stance }) : null,
        voice ? h('span', { class: 'pf-voice' }, h('span', { class: 'pf-voice-k', text: 'voice' }), h('span', { text: voice })) : null,
      ) : null,
      h('div', { class: 'pf-stats', 'aria-label': 'Stats in this thread' },
        stat('karma', 'Karma', formatScore(st.karma), st.karma < 0 ? 'neg' : ''),
        stat('comments', st.count === 1 ? 'Comment' : 'Comments', String(st.count)),
        stat('replies', st.replies === 1 ? 'Reply received' : 'Replies received', String(st.replies)),
        stat('cake', 'Cake day', cake ? (cake === 'just now' ? cake : `${cake} ago`) : '–'),
      ),
      outlook ? section('Take on this story', h('blockquote', { class: 'pf-outlook' }, h('p', { text: outlook }))) : null,
      interests.length ? section('Interests', h('ul', { class: 'pf-chips' }, interests.map(t => h('li', { class: 'pf-chip', text: t.trim() })))) : null,
      st.top && st.count > 1 ? section('Top comment', h('ul', { class: 'pf-list' }, commentRow(st.top, 'pf-top'))) : null,
      section('Recent comments', st.recent.length
        ? h('ul', { class: 'pf-list', 'data-list': 'recent' }, st.recent.map(c => commentRow(c)))
        : h('p', { class: 'pf-empty', text: S.thread?.status === 'running' || S.thread?.status === 'casting' ? 'No comments yet. They may still chime in.' : 'No comments in this thread.' })),
    ),
  );
  P.body.scrollTop = scroll;
  if (focusKey) P.body.querySelector(`[data-k="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  if (hadFocus && !P.dialog.contains(document.activeElement)) P.dialog.querySelector('.pf-close')?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- stream

function parse(data) { try { return JSON.parse(data); } catch { return null; } }

function closeStream() {
  if (S.es) { S.es.close(); S.es = null; }
}

function showBanner(msg, retry = true) {
  const b = S.els.banner;
  if (!b) return;
  b.replaceChildren(h('div', { class: 'card notice notice-error', role: 'alert' },
    h('div', { class: 'notice-text' }, h('strong', { text: msg })),
    retry ? h('button', { class: 'btn btn-outline', type: 'button', id: 'retry-stream', on: { click: () => { b.replaceChildren(); openStream(S.threadId); } } }, ICONS.retry(), 'Retry') : null,
  ));
}

function finished(status) { return status === 'done' || status === 'error'; }

function openStream(id) {
  closeStream();
  S.els.banner?.replaceChildren();
  let es;
  try { es = new EventSource(`${API}/reddit/threads/${encodeURIComponent(id)}/stream`); }
  catch { showBanner(`Can't open a live connection to ${API}.`); return; }
  S.es = es;
  const mine = () => S.es === es && S.threadId === id && S.view === 'thread';

  es.addEventListener('snapshot', e => {
    if (!mine()) return;
    const t = parse(e.data);
    if (!t) return;
    applySnapshot(t);
    if (finished(t.status)) { closeStream(); if (t.status === 'error') showBanner('This thread stopped early because the bots hit an error.'); }
  });
  es.addEventListener('comment', e => {
    if (!mine()) return;
    const c = parse(e.data);
    if (!c || typeof c.id !== 'number') return;
    if (!S.comments.some(x => x.id === c.id)) S.fresh.add(c.id);
    S.comments = upsertComment(S.comments, c);
    scheduleRender();
  });
  es.addEventListener('vote', e => {
    if (!mine()) return;
    const v = parse(e.data);
    if (!v || typeof v.comment_id !== 'number') return;
    S.comments = applyVote(S.comments, v);
    scheduleRender();
  });
  es.addEventListener('status', e => {
    if (!mine()) return;
    const d = parse(e.data);
    if (!d || !S.thread) return;
    S.thread = { ...S.thread, status: d.status };
    statusChip(d.status);
    if (d.status === 'running' || d.status === 'casting') {
      // bots arrive with casting; refresh roster if the snapshot had none yet
      if (!S.bots.size) refreshThread(id);
    }
    scheduleRender();
    if (finished(d.status)) {
      closeStream();
      if (d.status === 'error') showBanner('This thread stopped early because the bots hit an error.');
    }
  });
  es.onerror = () => {
    if (!mine()) return;
    if (es.readyState === EventSource.CLOSED) {
      S.es = null;
      onStreamClosed(id);
    }
  };
}

async function refreshThread(id) {
  try {
    const t = await api(`/reddit/threads/${encodeURIComponent(id)}`);
    if (S.threadId !== id || S.view !== 'thread') return;
    if (t?.bots) { S.bots = new Map(t.bots.map(b => [b.id, b])); S.thread = { ...S.thread, bots: t.bots }; renderRoster(); scheduleRender(); }
  } catch { /* stream keeps going */ }
}

async function onStreamClosed(id) {
  try {
    const t = await api(`/reddit/threads/${encodeURIComponent(id)}`);
    if (S.threadId !== id || S.view !== 'thread') return;
    applySnapshot(t);
    if (!finished(t.status)) showBanner('Live updates stopped. Retry to reconnect.');
    else if (t.status === 'error') showBanner('This thread stopped early because the bots hit an error.');
  } catch (err) {
    if (S.threadId !== id || S.view !== 'thread') return;
    if (err.status === 404) {
      S.els.post?.replaceChildren(h('div', { class: 'card notice' },
        h('div', { class: 'notice-text' }, h('strong', { text: 'Thread not found.' }), h('span', { text: ' It may have been removed, or the link is wrong.' })),
        linkTo({}, { class: 'btn btn-primary' }, 'Back to r/AgentReddit')));
      S.els.comments?.replaceChildren();
      statusChip(null);
      return;
    }
    if (!S.thread) S.els.post?.replaceChildren(postSkeleton());
    showBanner(`Can't reach the Agent Reddit server at ${API}. Check your connection and retry.`);
  }
}

// keep relative times fresh
setInterval(() => { if (S.view === 'thread' && S.thread) { renderPost(); renderComments(); renderProfile(); } }, 60000);

route();
