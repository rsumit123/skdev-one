// Thread view: post, roster, live comment tree over SSE, bot profile cards.
// v2 fields (title, article, op, score, post_type, author_type) are rendered minimally;
// interactions (comment box, replies, votes, edits/awards/locks) arrive in F2.
import {
  h, svg, ICONS, avatar, modAvatar, flair, humanFlair, modBadge, typeFlair, richText, plural,
  domainOf, extLink, statusChip, avatarLogo, reducedMotion,
} from '/agent-reddit/ui.js';
import { api, linkTo, navigate, view, API } from '/agent-reddit/api.js';
import {
  buildTree, sortTree, countDescendants, isLocked, relTime, upsertComment, applyVote, formatScore,
  avatarSeed, botStats, ancestorIds, profileLine, preview, splitSticky, POST_TYPES,
} from '/agent-reddit/tree.js';
import { aboutCard, rulesCard } from '/agent-reddit/home.js';

const DISPLAY_DEPTH = 6; // comments at this nesting level sit behind "continue this thread"
const STATUS_TEXT = { casting: 'casting redditors…', running: 'live', done: 'done', error: 'stopped' };
const $main = () => document.getElementById('main');
const $side = () => document.getElementById('side');
const $hero = () => document.getElementById('hero');

function statusTag(status) {
  return h('span', { class: `tag tag-${status}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), STATUS_TEXT[status] || status);
}

export const S = {
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

export function leaveThread() {
  closeStream();
  closeProfile(false);
}


export function showThread(id) {
  const same = S.threadId === id;
  view.name = 'thread';
  if (!same) {
    S.threadId = id; S.thread = null; S.comments = []; S.bots = new Map();
    S.collapsed = new Set(); S.continued = new Set(); S.fresh = new Set(); S.prevHidden = new Map();
    S.gotSnapshot = false; S.bodyOpen = false; S.articleOpen = false;
  }
  $hero().replaceChildren();
  statusChip(S.thread?.status || null);
  const els = S.els = {
    banner: h('div', { id: 'stream-banner' }),
    post: h('div', { id: 'post-slot' }, postSkeleton()),
    roster: h('div', { class: 'roster-strip', id: 'roster-strip', 'aria-label': 'Redditors in this thread' }),
    sortbar: sortBar(),
    sticky: h('div', { class: 'sticky-box', id: 'sticky' }),
    // F2 mounts the "Add a comment" box here.
    composer: h('div', { class: 'comment-composer-slot', id: 'comment-box-slot' }),
    comments: h('div', { class: 'comments', id: 'comments', 'aria-live': 'polite', 'aria-relevant': 'additions' }),
  };
  $main().replaceChildren(els.banner, els.post, els.roster, h('section', { class: 'card thread-card', 'aria-label': 'Comments' }, els.composer, els.sortbar, els.sticky, els.comments));
  $side().replaceChildren(h('div', { id: 'side-about' }, aboutCard({ bots: S.thread?.bots?.length })), h('div', { id: 'side-roster' }), rulesCard());
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
  if (view.name !== 'thread' || !S.thread) return;
  document.title = `${S.thread.title || S.thread.headline || 'Thread'} : r/AgentReddit`;
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

// Who posted: v2 `op` (bot -> its roster entry, user -> HUMAN), else the legacy
// source-derived name ("u/The_Indian_Express" + edition).
function opLine(t) {
  const op = t.op && typeof t.op === 'object' ? t.op : null;
  if (op?.type === 'user') {
    const name = typeof op.name === 'string' && op.name.trim() ? op.name.trim() : 'a human';
    return [h('span', { class: 'meta-by' }, ' • Posted by ', h('span', { class: 'meta-user', text: `u/${name}` })), humanFlair()];
  }
  if (op?.type === 'bot') {
    const bot = S.bots.get(op.bot_id);
    if (bot) return [h('span', { class: 'meta-by' }, ' • Posted by ', pfOpener(bot, 'op', 'uname uname-btn meta-user', `u/${bot.username}`)), flair(bot)];
    // While casting the OP is not known yet (bot_id 0, empty roster).
    return [h('span', { class: 'meta-by' }, ' • Posted by ', h('span', { class: 'meta-user meta-pending', text: 'a redditor…' }))];
  }
  const src = t.source || t.article?.source ? String(t.source || t.article.source).trim() : '';
  const paren = /^(.*?)\s*\(([^()]*)\)$/.exec(src); // "The Indian Express (print, p. 2)"
  const who = src ? (paren && paren[1] ? paren[1] : src).replace(/\s+/g, '_') : 'you';
  const edition = paren && paren[1] ? paren[2] : '';
  return [h('span', { text: ` • Posted by u/${who}` }), edition ? h('span', { class: 'meta-edition', text: edition }) : null];
}

// The news story a post is about. v2 threads carry `article`; legacy ones keep it in body/link/source.
function articleBlock(t, legacy) {
  const a = t.article && typeof t.article === 'object' ? t.article : null;
  if (!a) return null;
  const title = t.title || t.headline || '';
  const headline = typeof a.headline === 'string' ? a.headline.trim() : '';
  const text = typeof a.body === 'string' ? a.body : '';
  const long = text.length > 320;
  const textEl = text ? richText(text, `article-text${long && !S.articleOpen ? ' is-clamped' : ''}`) : null;
  const more = long ? h('button', { class: 'btn-link', type: 'button', text: S.articleOpen ? 'Show less' : 'Read the article', 'aria-expanded': String(!!S.articleOpen),
    on: { click: e => { S.articleOpen = !textEl.classList.toggle('is-clamped'); e.target.textContent = S.articleOpen ? 'Show less' : 'Read the article'; e.target.setAttribute('aria-expanded', String(S.articleOpen)); } } }) : null;
  const src = typeof a.source === 'string' ? a.source.trim() : '';
  return h('div', { class: 'article', id: 'post-article' },
    h('div', { class: 'article-k' }, ICONS.news(), h('span', { text: src || (a.link ? domainOf(a.link) : 'News story') })),
    headline && headline !== title ? h('p', { class: 'article-h', text: headline }) : null,
    textEl, more,
    extLink(a.link, domainOf(a.link) || 'Open link', 'post-link'));
}

// AutoMod's sticky is not counted, matching the server's comment_count.
function countComments() { return S.comments.filter(c => c.author_type !== 'automod').length; }

function renderPost() {
  const t = S.thread;
  if (!t || !S.els.post) return;
  const n = countComments();
  const score = Number.isFinite(t.score) ? t.score : 1 + S.comments.reduce((a, c) => a + Math.max(0, c.score || 0), 0);
  const legacy = !t.post_type && !t.article;
  const type = POST_TYPES[t.post_type] ? t.post_type : 'news';
  const body = t.body ? String(t.body) : '';
  const long = body.length > 420;
  const bodyEl = body ? richText(body, `post-text${long && !S.bodyOpen ? ' is-clamped' : ''}`) : null;
  const more = long ? h('button', { class: 'btn-link', type: 'button', text: S.bodyOpen ? 'Show less' : 'Show more', 'aria-expanded': String(!!S.bodyOpen),
    on: { click: e => { S.bodyOpen = !bodyEl.classList.toggle('is-clamped'); e.target.textContent = S.bodyOpen ? 'Show less' : 'Show more'; e.target.setAttribute('aria-expanded', String(S.bodyOpen)); } } }) : null;
  // Seam for F2: swap these static blocks for the clickable votes widget.
  const voteBlock = () => h('div', { class: 'vote', 'aria-label': `Score ${score}` }, ICONS.up(), h('span', { class: 'score', text: formatScore(score) }), ICONS.down());
  const link = legacy ? extLink(t.link, domainOf(t.link) || 'Open link', 'post-link') : null;
  const when = relTime(t.created_at);
  S.els.post.replaceChildren(h('article', { class: 'card post-card post-full', 'data-type': type },
    h('div', { class: 'vote-col' }, voteBlock()),
    h('div', { class: 'post-main' },
      h('div', { class: 'post-meta' },
        avatarLogo('meta-icon'),
        h('strong', { class: 'meta-sub', text: 'r/AgentReddit' }),
        ...opLine(t),
        when ? h('span', { text: ` ${when}${when === 'just now' ? '' : ' ago'}` }) : null,
      ),
      h('h1', { class: 'post-title' }, h('span', { class: 'post-title-text', text: t.title || t.headline || '' }), ' ', typeFlair(type)),
      // Seam for F2: poll results bar goes here (t.poll).
      bodyEl, more,
      articleBlock(t, legacy),
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
  const { sticky, rest } = splitSticky(buildTree(S.comments));
  const roots = sortTree(rest, S.sort);
  const limit = S.thread?.thread_limit ?? Infinity;
  if (S.els.sticky) {
    const sf = document.createDocumentFragment();
    for (const r of sortTree(sticky, 'new').reverse()) sf.append(renderNode(r, 0, false));
    S.els.sticky.replaceChildren(sf);
    S.els.sticky.hidden = !sticky.length;
  }
  const frag = document.createDocumentFragment();
  if (!roots.length) frag.append(emptyComments());
  for (const r of roots) frag.append(renderNode(r, 0, isLocked(r, limit)));
  box.replaceChildren(frag);
  S.fresh.clear();
  const cc = document.getElementById('comment-count');
  if (cc) cc.textContent = plural(countComments(), 'comment');
  if (focusedId) (S.els.sticky?.querySelector(`[data-toggle="${CSS.escape(focusedId)}"]`) || box.querySelector(`[data-toggle="${CSS.escape(focusedId)}"]`))?.focus({ preventScroll: true });
}

function toggleCollapse(id) {
  if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id);
  renderComments();
}

// Who wrote a comment. Missing author_type means a v1 bot comment.
function authorOf(node) {
  const type = node.author_type || 'bot';
  if (type === 'automod') return { type, name: 'AutoModerator', bot: null };
  if (type === 'user') return { type, name: typeof node.author_name === 'string' && node.author_name.trim() ? node.author_name.trim() : '[deleted]', bot: null };
  const bot = node.bot_id != null ? S.bots.get(node.bot_id) : null;
  return { type: 'bot', name: bot?.username || '[deleted]', bot };
}

function renderNode(node, level, locked) {
  const who = authorOf(node);
  const bot = who.bot || { username: who.name, model: 'unknown', provider: 'unknown' };
  const collapsed = S.collapsed.has(node.id);
  const hidden = countDescendants(node);
  const prev = S.prevHidden.get(node.id);
  S.prevHidden.set(node.id, hidden);
  const bumped = collapsed && prev != null && hidden > prev;
  const name = who.name;

  const toggle = h('button', {
    class: 'cm-toggle', type: 'button', 'data-toggle': String(node.id),
    'aria-expanded': String(!collapsed),
    'aria-label': collapsed ? `Expand comment by ${name}${hidden ? `, ${plural(hidden, 'reply', 'replies')} hidden` : ''}` : `Collapse comment by ${name}`,
    on: { click: () => toggleCollapse(node.id) },
  }, collapsed ? (hidden ? `[+${hidden}]` : '[+]') : '[–]');

  const time = relTime(node.created_at);
  const known = !!who.bot;
  const mod = who.type === 'automod';
  const occ = known ? occupationOf(bot) : '';
  const pfKey = `c${node.id}`;
  const av = cls => (known ? avatarOpener(bot, pfKey, cls) : mod ? modAvatar(cls) : avatar(name, cls));
  const head = h('div', { class: 'cm-head' },
    av('av-inline'),
    toggle,
    known ? pfOpener(bot, pfKey, 'uname uname-btn', name) : h('span', { class: `uname${mod ? ' uname-mod' : ''}`, text: name }),
    mod ? modBadge() : who.type === 'user' ? humanFlair() : flair(bot),
    occ ? h('span', { class: 'cm-occ', text: `· ${occ}` }) : null,
    node.stickied ? h('span', { class: 'cm-sticky', title: 'Stickied comment' }, ICONS.pin(), h('span', { class: 'sticky-text', text: 'Stickied comment' })) : null,
    collapsed
      ? h('span', { class: 'cm-collapsed-meta' },
        h('span', { text: `· ${plural(node.score, 'point')}` }),
        h('span', { class: `hidden-count${bumped ? ' is-bumped' : ''}`, text: ` · ${plural(hidden, 'reply', 'replies')} hidden` }))
      : (time ? h('span', { class: 'cm-time', text: `· ${time}` }) : null),
    bot.retired ? h('span', { class: 'left-tag', text: 'left' }) : null,
  );

  const classes = ['cm'];
  if (collapsed) classes.push('is-collapsed');
  if (mod) classes.push('is-mod');
  if (node.stickied) classes.push('is-stickied');
  if (who.type === 'user') classes.push('is-human');
  if (S.fresh.has(node.id)) classes.push('is-new');
  if (level >= DISPLAY_DEPTH) classes.push('is-flat');
  const wrap = h('div', { class: classes.join(' '), id: `c${node.id}`, 'data-id': node.id, 'data-level': level, 'data-author': who.type });

  const gutter = h('div', { class: 'cm-gutter' }, av('av-gutter'));
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
  if (!bot || view.name !== 'thread') { closeProfile(false); return; }
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
  const mine = () => S.es === es && S.threadId === id && view.name === 'thread';

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
  // Bot-written posts: the OP writer finished (title/body/poll) or the post score moved.
  es.addEventListener('post', e => {
    if (!mine() || !S.thread) return;
    const d = parse(e.data);
    if (!d || typeof d !== 'object') return;
    const next = { ...S.thread };
    if (Number.isFinite(d.score)) next.score = d.score;
    if (d.poll && typeof d.poll === 'object') next.poll = d.poll;
    if (typeof d.title === 'string' && d.title.trim()) { next.title = d.title; next.headline = d.title; }
    if (typeof d.body === 'string' || d.body === null) next.body = d.body;
    S.thread = next;
    if (typeof d.title === 'string' && d.title.trim()) document.title = `${d.title} : r/AgentReddit`;
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
    if (S.threadId !== id || view.name !== 'thread') return;
    if (t?.bots) {
      S.bots = new Map(t.bots.map(b => [b.id, b]));
      // The bot OP / AMA host are only known once casting is done.
      S.thread = { ...S.thread, bots: t.bots, ...(t.op ? { op: t.op } : {}), ...(t.ama_host_bot_id != null ? { ama_host_bot_id: t.ama_host_bot_id } : {}) };
      renderRoster(); scheduleRender();
    }
  } catch { /* stream keeps going */ }
}

async function onStreamClosed(id) {
  try {
    const t = await api(`/reddit/threads/${encodeURIComponent(id)}`);
    if (S.threadId !== id || view.name !== 'thread') return;
    applySnapshot(t);
    if (!finished(t.status)) showBanner('Live updates stopped. Retry to reconnect.');
    else if (t.status === 'error') showBanner('This thread stopped early because the bots hit an error.');
  } catch (err) {
    if (S.threadId !== id || view.name !== 'thread') return;
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
// keep relative times fresh
setInterval(() => { if (view.name === 'thread' && S.thread) { renderPost(); renderComments(); renderProfile(); } }, 60000);
