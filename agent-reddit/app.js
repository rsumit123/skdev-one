// Agent Reddit UI. Plain ES module, no build step.
// All bot, user and article text is inserted with textContent only.
import {
  buildTree, sortTree, countDescendants, isLocked, relTime,
  upsertComment, applyVote, formatScore, providerColor, avatarSeed,
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
  tab: 'news',
  news: null, newsErr: null, newsAge: null,
  recent: null, recentErr: null,
  selected: null,
  own: { headline: '', body: '', link: '' },
  bots: 5, limit: 5, budget: 40,
  optsOpen: false,
  launching: false, launchErr: '',
};

function route() {
  closeStream();
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
  $hero.replaceChildren(communityHeader());
  $main.replaceChildren(
    h('div', { id: 'home-alert' }),
    h('section', { class: 'card tabs-card', 'aria-label': 'Choose a story' },
      h('div', { class: 'tabs', role: 'tablist' },
        tabBtn('news', 'Top 10 India news'),
        tabBtn('own', 'Your own'),
      ),
      h('div', { id: 'tab-panel', role: 'tabpanel' }),
    ),
    launchPanel(),
    h('section', { class: 'card recent-card', 'aria-labelledby': 'recent-h' },
      h('h2', { class: 'card-title', id: 'recent-h', text: 'Recent threads' }),
      h('div', { id: 'recent' }),
    ),
  );
  renderHomeSide();
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

function tabBtn(key, label) {
  return h('button', {
    class: 'tab', type: 'button', role: 'tab', id: `tab-${key}`,
    'aria-selected': H.tab === key ? 'true' : 'false',
    on: { click: () => { H.tab = key; document.querySelectorAll('.tabs .tab').forEach(b => b.setAttribute('aria-selected', String(b.id === `tab-${key}`))); renderTab(); updateLaunch(); } },
  }, label);
}

async function loadHome() {
  const [news, recent] = await Promise.allSettled([api('/reddit/news'), api('/reddit/threads')]);
  if (S.view !== 'home') return;
  if (news.status === 'fulfilled') {
    H.news = Array.isArray(news.value?.items) ? news.value.items.slice(0, 10) : [];
    H.newsAge = news.value?.cached_age_s ?? null;
    H.newsErr = null;
  } else { H.newsErr = news.reason; }
  if (recent.status === 'fulfilled') {
    H.recent = Array.isArray(recent.value?.threads) ? recent.value.threads : [];
    H.recentErr = null;
  } else { H.recentErr = recent.reason; }
  const down = news.status === 'rejected' && recent.status === 'rejected' && !news.reason?.status;
  const alert = document.getElementById('home-alert');
  alert.replaceChildren(down ? unreachable(() => { alert.replaceChildren(); H.news = null; renderTab(); loadHome(); }) : '');
  if (H.tab === 'news') renderTab();
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

function renderTab() {
  const panel = document.getElementById('tab-panel');
  if (!panel) return;
  panel.setAttribute('aria-labelledby', `tab-${H.tab}`);
  if (H.tab === 'own') { panel.replaceChildren(ownForm()); return; }
  if (H.newsErr) {
    panel.replaceChildren(h('div', { class: 'empty' },
      h('p', { text: H.newsErr.status ? `News is unavailable right now (${H.newsErr.message}).` : 'News could not be loaded.' }),
      h('div', { class: 'empty-actions' },
        h('button', { class: 'btn btn-outline', type: 'button', on: { click: () => { H.newsErr = null; H.news = null; renderTab(); loadHome(); } } }, ICONS.retry(), 'Retry'),
        h('button', { class: 'btn btn-text', type: 'button', text: 'Write your own', on: { click: () => document.getElementById('tab-own').click() } }),
      )));
    return;
  }
  if (!H.news) {
    panel.replaceChildren(h('div', { class: 'news-list', 'aria-busy': 'true' },
      Array.from({ length: 4 }, () => h('div', { class: 'post-card skeleton', 'aria-hidden': 'true' }, h('div', { class: 'vote-col' }), h('div', { class: 'post-main' }, h('span', { class: 'sk sk-meta' }), h('span', { class: 'sk sk-title' }), h('span', { class: 'sk sk-title short' }))))));
    return;
  }
  if (!H.news.length) {
    panel.replaceChildren(h('div', { class: 'empty' }, h('p', { text: 'No headlines right now. Write your own story instead.' })));
    return;
  }
  const list = h('div', { class: 'news-list', role: 'radiogroup', 'aria-label': 'Top 10 India news' });
  for (const item of H.news) list.append(newsCard(item));
  const meta = H.newsAge != null ? h('p', { class: 'list-meta', text: `Headlines from Google News, The Hindu, Indian Express and NDTV. Updated ${H.newsAge < 60 ? 'just now' : relTime(new Date(Date.now() - H.newsAge * 1000).toISOString()) + ' ago'}.` }) : null;
  panel.replaceChildren(list, meta || '');
}

function newsCard(item) {
  const selected = H.selected?.id === item.id;
  const input = h('input', { type: 'radio', name: 'story', class: 'sr-only', value: item.id, checked: selected });
  input.addEventListener('change', () => {
    H.selected = item;
    document.querySelectorAll('.news-card').forEach(c => {
      const on = c.dataset.id === item.id;
      c.classList.toggle('is-selected', on);
      c.querySelector('.pick-label').textContent = on ? 'Selected' : 'Pick this story';
    });
    H.launchErr = '';
    updateLaunch();
  });
  const when = relTime(item.published);
  const link = extLink(item.link, domainOf(item.link) || 'article', 'news-link');
  if (link) link.addEventListener('click', e => e.stopPropagation());
  return h('label', { class: `post-card news-card${selected ? ' is-selected' : ''}`, 'data-id': item.id },
    input,
    h('div', { class: 'vote-col', 'aria-hidden': 'true' }, ICONS.up(), h('span', { class: 'vote-dot', text: '•' }), ICONS.down()),
    h('div', { class: 'post-main' },
      h('div', { class: 'post-meta' },
        h('span', { class: 'meta-src', text: item.source || 'News' }),
        when ? h('span', { text: ` • ${when === 'just now' ? when : when + ' ago'}` }) : null,
      ),
      h('h3', { class: 'post-title', text: item.title || '' }),
      item.summary ? h('p', { class: 'news-summary', text: item.summary }) : null,
      h('div', { class: 'news-foot' },
        h('span', { class: 'pick' }, h('span', { class: 'pick-box', 'aria-hidden': 'true' }), h('span', { class: 'pick-label', text: selected ? 'Selected' : 'Pick this story' })),
        link,
      ),
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
  if (H.tab === 'news') {
    const it = H.selected;
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
    sel.textContent = H.tab === 'news' ? 'Pick a story from the list.' : 'Write a headline of at least 3 characters.';
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
}

function scheduleRender(fn = renderComments) {
  if (S.renderQueued) return;
  S.renderQueued = true;
  requestAnimationFrame(() => { S.renderQueued = false; renderPost(); fn(); });
}

function renderPost() {
  const t = S.thread;
  if (!t || !S.els.post) return;
  const n = S.comments.length;
  const score = 1 + S.comments.reduce((a, c) => a + Math.max(0, c.score || 0), 0);
  const who = t.source ? String(t.source).replace(/\s+/g, '_') : 'you';
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
  return h(full ? 'li' : 'div', { class: `roster-item${bot.retired ? ' is-retired' : ''}` },
    avatar(bot.username),
    h('div', { class: 'roster-text' },
      h('div', { class: 'roster-name' },
        h('span', { class: 'uname', text: `u/${bot.username}` }),
        bot.retired ? h('span', { class: 'left-tag', text: 'left' }) : null),
      flair(bot),
      full && bot.bio ? h('p', { class: 'roster-bio', text: bot.bio }) : null,
    ),
  );
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
  const head = h('div', { class: 'cm-head' },
    avatar(name, 'av-inline'),
    toggle,
    h('span', { class: 'uname', text: name }),
    flair(bot),
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

  const gutter = h('div', { class: 'cm-gutter' }, avatar(name, 'av-gutter'));
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
setInterval(() => { if (S.view === 'thread' && S.thread) { renderPost(); renderComments(); } }, 60000);

route();
