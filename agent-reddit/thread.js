// Thread view: post, roster, live comment tree over SSE, bot profile cards.
// v2: human comments and replies (optimistic, reconciled with SSE), votes on the post and
// every comment, OP/HOST badges, poll results, AutoMod, edits/deletions/removals/awards/locks.
// v3 (calm threads): live events patch the DOM per comment (keyed, no full re-render),
// every mutation runs through the scroll anchor (anchor.js), the order is frozen while
// reading (sort applies on load, on a sort change and when the reader taps the pill), and
// comments that arrive while the reader is away from the live edge wait behind a
// "new comments" pill. Touch long-press on a comment toggles its subtree (longpress.js).
import {
  h, svg, ICONS, avatar, modAvatar, flair, humanFlair, modBadge, typeFlair, richText, plural,
  domainOf, extLink, statusChip, reducedMotion,
} from '/agent-reddit/ui.js';
import { api, linkTo, navigate, view, API, errorText } from '/agent-reddit/api.js';
import { voteWidget } from '/agent-reddit/votes.js';
import { commentBox } from '/agent-reddit/commentbox.js';
import { getHandle } from '/agent-reddit/local.js';
import {
  buildTree, sortTree, countDescendants, isLocked, relTime, applyVote, formatScore,
  avatarSeed, botStats, ancestorIds, profileLine, preview, splitSticky, displayType,
  applyEdit, applyDelete, applyRemove, applyAwards, applyLock, lockedIds, awardCounts, canReply,
  reconcileComment, pollRows, opRoles,
  rankOrder, arrangeTree, shouldBuffer, mergePolicy, pillText, subOf, subInfo,
} from '/agent-reddit/tree.js';
import { REG, subLink } from '/agent-reddit/subs.js';
import { preserve, topInset } from '/agent-reddit/anchor.js';
import { longPress } from '/agent-reddit/longpress.js';
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
  replyTo: null,      // comment id with an open inline Reply box
  replyBox: null,     // that box (kept across re-renders so typing survives live updates)
  topBox: null,       // the "Add a comment" box
  replied: new Map(), // human comment id -> highlight-until time (a bot just replied)
  locked: new Set(),
  tempSeq: 0,
  rank: null,         // frozen order (id -> index among siblings); null = sort on next render
  held: new Set(),    // live comments waiting behind the "new comments" pill
  recs: new Map(),    // comment id -> rendered record { el, main, kids, part, sig, vote, score }
  postSig: null,
  rosterSig: null,
};
const TEMP_BASE = 9e15; // optimistic ids sort after every real id

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
    S.replyTo = null; S.replyBox = null; S.topBox = null; S.replied = new Map();
    S.rank = null; S.held = new Set();
  }
  S.recs = new Map(); S.postSig = null; S.rosterSig = null; S.emptyKey = null;
  $hero().replaceChildren();
  statusChip(S.thread?.status || null);
  const pill = h('button', { class: 'live-pill', type: 'button', id: 'live-pill', hidden: true, on: { click: mergeHeld } });
  const els = S.els = {
    banner: h('div', { id: 'stream-banner' }),
    post: h('div', { id: 'post-slot' }, postSkeleton()),
    roster: h('div', { class: 'roster-strip', id: 'roster-strip', 'aria-label': 'Redditors in this thread' }),
    sortbar: sortBar(),
    sticky: h('div', { class: 'sticky-box', id: 'sticky' }),
    composer: h('div', { class: 'comment-composer-slot', id: 'comment-box-slot' }),
    pill,
    // zero-height sticky slot: the pill floats over the comments and never takes layout space
    pillSlot: h('div', { class: 'live-pill-slot' }, pill),
    comments: h('div', { class: 'comments', id: 'comments' }),
  };
  const card = h('section', { class: 'card thread-card', 'aria-label': 'Comments' }, els.composer, els.sortbar, els.sticky, els.pillSlot, els.comments);
  $main().replaceChildren(els.banner, els.post, els.roster, card);
  $side().replaceChildren(h('div', { id: 'side-about' }, aboutCard({ bots: S.thread?.bots?.length })), h('div', { id: 'side-roster' }), rulesCard());
  ensureLiveRegions();
  longPress(card, {
    onFire: cm => {
      const cid = Number(cm.dataset.id);
      const was = S.collapsed.has(cid);
      toggleCollapse(cid);
      toast(was ? 'Expanded' : 'Collapsed');
    },
    onTapRow: cm => toggleCollapse(Number(cm.dataset.id)),
  });
  renderTopBox();
  if (S.thread) renderAll();
  openStream(id);
}

// ---------------------------------------------------------------- human comments

function renderTopBox() {
  const slot = S.els.composer;
  if (!slot) return;
  if (S.topBox) { slot.replaceChildren(S.topBox); return; }
  const open = h('button', { class: 'cbox-open', type: 'button', id: 'add-comment', on: { click: () => {
    S.topBox = commentBox({ onSubmit: (text, handle) => submitComment(null, text, handle) });
    preserve(() => slot.replaceChildren(S.topBox));
    S.topBox.focusInput();
  } } }, ICONS.comment(), h('span', { text: 'Add a comment' }));
  slot.replaceChildren(open);
}

function openReply(id) {
  if (S.replyTo === id) { S.replyBox?.focusInput(); return; }
  const target = S.comments.find(c => c.id === id);
  if (!target) return;
  S.replyTo = id;
  S.replyBox = commentBox({
    reply: true, replyName: authorOf(target).name,
    onSubmit: (text, handle) => submitComment(id, text, handle),
    onCancel: closeReply,
  });
  renderComments();
  S.replyBox.focusInput();
}

function closeReply() {
  const id = S.replyTo;
  S.replyTo = null; S.replyBox = null;
  renderComments();
  if (id != null) document.querySelector(`#c${id} > .cm-main > .cm-actions .reply-btn`)?.focus({ preventScroll: true });
}

function commentError(err) {
  if (err?.status === 423) return 'This conversation is locked by moderators, so it cannot take replies.';
  if (err?.status === 429) return err.message && !/^Request failed/.test(err.message) ? err.message : 'You are commenting too fast. Wait a minute and try again.';
  if (err?.status === 404) return 'This thread no longer exists.';
  return errorText(err, 'Could not post the comment.');
}

// The optimistic comment's slot in the frozen order passes to the real id.
function inheritRank(fromId, toId) {
  if (S.rank?.has(fromId) && !S.rank.has(toId)) S.rank.set(toId, S.rank.get(fromId));
}

// Optimistic insert, replaced by the 201 body (or the SSE copy, whichever lands first).
async function submitComment(parentId, text, handle) {
  const threadId = S.threadId;
  const temp = {
    id: TEMP_BASE + (++S.tempSeq), pending: true, author_type: 'user', author_name: handle, bot_id: null,
    parent_id: parentId, text, score: 1, created_at: new Date().toISOString(), awards: [],
  };
  S.comments = [...S.comments, temp];
  if (parentId != null) { S.collapsed.delete(parentId); for (const a of ancestorIds(S.comments, parentId)) { S.collapsed.delete(a); S.continued.add(a); } }
  renderComments();
  let res;
  try {
    res = await api(`/reddit/threads/${encodeURIComponent(threadId)}/comments`, { method: 'POST', body: JSON.stringify({ parent_id: parentId, text, user_name: handle }) });
  } catch (err) {
    if (S.threadId === threadId) { S.comments = S.comments.filter(c => c.id !== temp.id); renderComments(); }
    throw new Error(commentError(err));
  }
  if (S.threadId !== threadId) return;
  if (res && typeof res.id === 'number') {
    const real = { author_type: 'user', author_name: handle, bot_id: null, parent_id: parentId, text, ...res };
    const still = S.comments.some(c => c.id === temp.id);
    S.comments = still ? S.comments.map(c => (c.id === temp.id ? { ...real, pending: false } : c)).filter((c, i, arr) => arr.findIndex(x => x.id === c.id) === i) : reconcileComment(S.comments, real).comments;
    inheritRank(temp.id, real.id);
    S.held.delete(real.id);
    S.fresh.add(real.id);
  }
  if (parentId != null && S.replyTo === parentId) { S.replyTo = null; S.replyBox = null; }
  renderComments();
  // The reader's own action, so bringing their comment into view is fine (live events never scroll).
  const el = document.getElementById(`c${res?.id ?? temp.id}`);
  el?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  // A finished thread starts a "revive" run on the server: listen again for bot replies.
  if (!S.es && view.name === 'thread') openStream(threadId);
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
      on: { click: () => {
        S.sort = k;
        document.querySelectorAll('.sort-tab').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sort === k)));
        // A new order: the held comments join it, and the viewport stays where it is.
        for (const hid of S.held) S.fresh.add(hid);
        S.held.clear();
        renderComments({ resort: true, anchor: false });
      } },
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

// A (re-)sent snapshot is diffed, not re-rendered: unknown comments go through the
// arrival policy, known ones are patched in place. Only the first one sorts.
function applySnapshot(t) {
  if (!t || typeof t !== 'object') return;
  const firstLoad = !S.gotSnapshot;
  const known = new Set(S.comments.map(c => c.id));
  S.thread = t;
  S.bots = new Map((t.bots || []).map(b => [b.id, b]));
  const pending = S.comments.filter(c => c.pending);
  S.comments = Array.isArray(t.comments) ? t.comments.slice() : [];
  const same = (a, b) => a.author_type === 'user' && a.author_name === b.author_name && String(a.text).trim() === String(b.text).trim() && (a.parent_id ?? null) === (b.parent_id ?? null);
  for (const p of pending) {
    const real = S.comments.find(c => same(c, p));
    if (!real) S.comments.push(p); // not on the server yet
    else inheritRank(p.id, real.id);
  }
  if (firstLoad) S.rank = null;
  else {
    const buffering = shouldBuffer(readingState());
    for (const c of S.comments.slice().sort((a, b) => a.id - b.id)) if (!known.has(c.id) && !c.pending) admit(c, buffering);
    const present = new Set(S.comments.map(c => c.id));
    for (const hid of [...S.held]) if (!present.has(hid)) S.held.delete(hid);
  }
  S.gotSnapshot = true;
  renderAll();
}

function renderAll() {
  if (view.name !== 'thread' || !S.thread) return;
  document.title = `${S.thread.title || S.thread.headline || 'Thread'} : r/AgentReddit`;
  statusChip(S.thread.status);
  preserve(() => { renderPost(); renderRoster(); patchComments(false); });
  renderProfile();
  refreshPill();
}

function scheduleRender() {
  if (S.renderQueued) return;
  S.renderQueued = true;
  requestAnimationFrame(() => {
    S.renderQueued = false;
    if (view.name !== 'thread' || !S.els.comments?.isConnected) return;
    preserve(() => { renderPost(); renderRoster(); patchComments(false); });
    renderProfile();
    refreshPill();
  });
}

// ---------------------------------------------------------------- live buffer + pill

function readingState() {
  const box = S.els.comments;
  if (!box?.isConnected) return {};
  const sel = getSelection();
  const card = box.closest('.thread-card');
  return {
    distance: topInset() - box.getBoundingClientRect().top,
    viewport: window.innerHeight,
    selecting: !!sel && !sel.isCollapsed && sel.rangeCount > 0 && !!card?.contains(sel.anchorNode),
    replyFocused: !!S.replyBox?.contains(document.activeElement),
    profileOpen: P.botId != null,
  };
}

// One arriving comment (already in S.comments): show it in place or hold it for the pill.
function admit(c, buffering) {
  const handle = getHandle();
  const parent = c.parent_id != null ? S.comments.find(x => x.id === c.parent_id) : null;
  const anc = ancestorIds(S.comments, c.id);
  const gate = anc.length >= DISPLAY_DEPTH ? anc[anc.length - DISPLAY_DEPTH] : null; // its "continue this thread" parent
  const decision = mergePolicy({
    buffering,
    heldCount: S.held.size,
    own: c.author_type === 'user' && c.author_name === handle,
    replyToMine: parent?.author_type === 'user' && parent.author_name === handle,
    parentHeld: parent != null && S.held.has(parent.id),
    hiddenByCollapse: anc.some(a => S.collapsed.has(a)) || (gate != null && !S.continued.has(gate)),
  });
  if (decision === 'hold') S.held.add(c.id);
  else { S.fresh.add(c.id); S.shownSince = (S.shownSince || 0) + 1; S.shownName = authorOf(c).name; }
}

// Where the first held comment will land once merged (the merge re-sorts): above or below.
function heldDirection() {
  const { rest } = splitSticky(buildTree(S.comments));
  const order = [];
  const walk = list => { for (const n of list) { order.push(n.id); if (!S.collapsed.has(n.id)) walk(n.children); } };
  walk(sortTree(rest, S.sort));
  const i = order.findIndex(id => S.held.has(id));
  if (i < 0) return 'down';
  let prev = null;
  for (let j = i - 1; j >= 0 && !prev; j--) { const el = S.recs.get(order[j])?.el; if (el?.isConnected) prev = el; }
  const inset = topInset();
  return (prev ? prev.getBoundingClientRect().bottom : S.els.comments.getBoundingClientRect().top) < inset ? 'up' : 'down';
}

function refreshPill() {
  const pill = S.els.pill;
  if (!pill) return;
  const n = S.held.size;
  if (!n) {
    if (!pill.hidden) { pill.hidden = true; S.heldAnnounced = 0; }
  } else {
    const dir = heldDirection();
    const text = pillText(n, dir);
    if (pill.textContent !== text) pill.textContent = text;
    pill.setAttribute('aria-label', `${plural(n, 'new comment')} ${dir === 'up' ? 'above' : 'below'}. Show them`);
    pill.dataset.dir = dir;
    pill.hidden = false;
    if (n !== S.heldAnnounced) { S.heldAnnounced = n; announce(`${plural(n, 'new comment')} waiting. Use the new comments button to show them.`); }
  }
  if (S.shownSince) {
    announce(S.shownSince === 1 ? `New comment by ${S.shownName}` : `${S.shownSince} new comments`);
    S.shownSince = 0;
  }
}
let pillQueued = false;
window.addEventListener('scroll', () => {
  if (pillQueued || view.name !== 'thread' || !S.held.size) return;
  pillQueued = true;
  requestAnimationFrame(() => { pillQueued = false; if (view.name === 'thread') refreshPill(); });
}, { passive: true });

// Tap on the pill: merge, apply the sort, keep the anchor, then bring the first new one into view.
function mergeHeld() {
  const ids = new Set(S.held);
  if (!ids.size) return;
  S.held.clear();
  for (const id of ids) S.fresh.add(id);
  renderComments({ resort: true });
  const first = [...S.els.comments.querySelectorAll('.cm')].find(el => ids.has(Number(el.dataset.id)));
  if (first) {
    first.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    first.querySelector('.cm-toggle')?.focus({ preventScroll: true }); // the pill is gone; keep keyboard focus nearby
  }
  announce(`${plural(ids.size, 'new comment')} shown.`);
}

// Screen-reader announcements (polite, at most about once a second) and the touch toast.
function ensureLiveRegions() {
  if (!document.getElementById('ar-live')) document.body.append(h('div', { id: 'ar-live', class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' }));
  if (!document.getElementById('ar-toast')) document.body.append(h('div', { id: 'ar-toast', class: 'toast', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }));
}
const ANN = { last: 0, timer: 0, text: '' };
function announce(text) {
  ANN.text = text;
  if (ANN.timer) return;
  const wait = Math.max(0, ANN.last + 1000 - Date.now());
  ANN.timer = setTimeout(() => {
    ANN.timer = 0; ANN.last = Date.now();
    const el = document.getElementById('ar-live');
    if (el) el.textContent = ANN.text;
  }, wait);
}
let toastTimer = 0;
function toast(text) {
  ensureLiveRegions();
  const el = document.getElementById('ar-toast');
  el.textContent = text;
  el.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-on'), 1400);
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
    const named = typeof op.name === 'string' && op.name.trim() ? op.name.trim() : '';
    if (named) return [h('span', { class: 'meta-by' }, ' • Posted by ', h('span', { class: 'meta-user', text: `u/${named}` }))];
    if (t.status !== 'casting' && t.status !== 'running') return [h('span', { class: 'meta-by' }, ' • Posted by ', h('span', { class: 'meta-user', text: 'a bot OP' }))];
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

// Live poll results. Humans can't vote on options in v2; the bots vote in their comments.
function pollResults(poll) {
  const r = pollRows(poll);
  if (!r.rows.length) return h('div', { class: 'poll-full is-empty', id: 'poll' }, h('p', { class: 'poll-note', text: 'The poll options appear once the OP finishes writing.' }));
  return h('div', { class: 'poll-full', id: 'poll', role: 'group', 'aria-label': `Poll results, ${plural(r.total, 'vote')}` },
    h('ul', { class: 'poll-rows' }, r.rows.map((o, i) => h('li', { class: `poll-row${o.lead ? ' is-lead' : ''}`, vars: { '--w': `${o.pct}%` }, 'data-votes': o.votes },
      h('span', { class: 'poll-fill', 'aria-hidden': 'true' }),
      // Bots write "voted B", so show the letter each option is known by.
      h('span', { class: 'poll-letter', text: String.fromCharCode(65 + i) }),
      h('span', { class: 'poll-text', text: o.text }),
      h('span', { class: 'poll-pct', text: `${o.pct}%` })))),
    h('p', { class: 'poll-note' }, h('strong', { class: 'poll-total', text: plural(r.total, 'vote') }), ' · The redditors vote in the comments'));
}

// AutoMod's sticky is not counted, matching the server's comment_count.
function countComments() { return S.comments.filter(c => c.author_type !== 'automod').length; }

// Replaces a vote widget with one carrying the new server score (same size), keeping focus.
function swapVote(old, make) {
  const act = document.activeElement;
  const focused = old.contains(act) ? (act.classList.contains('vote-down') ? '.vote-down' : '.vote-up') : null;
  const nv = make();
  old.replaceWith(nv);
  if (focused) nv.querySelector(focused)?.focus({ preventScroll: true });
  return nv;
}

// The post card is rebuilt only when what it shows changes; score and comment count are
// patched in place, so live comment/vote events never touch it.
function renderPost() {
  const t = S.thread;
  if (!t || !S.els.post) return;
  const n = countComments();
  const score = Number.isFinite(t.score) ? t.score : 1 + S.comments.reduce((a, c) => a + Math.max(0, c.score || 0), 0);
  const opBot = t.op?.type === 'bot' ? S.bots.get(t.op.bot_id) : null;
  const sig = JSON.stringify([subOf(t), subInfo(subOf(t), REG.list), t.title, t.headline, t.body, t.poll, t.article, t.op, t.post_type, t.link, t.source, t.created_at,
    t.thread_limit, t.max_comments, t.status, S.bots.size, opBot ? [opBot.username, opBot.model, opBot.provider] : null]);
  const voteBlock = cls => voteWidget({ threadId: t.id || S.threadId, target: 'post', score, cls, onScore: v => { if (S.thread) S.thread = { ...S.thread, score: v }; } });
  if (sig === S.postSig && S.els.post.querySelector('.post-full')) {
    const cc = document.getElementById('comment-count');
    if (cc && cc.textContent !== plural(n, 'comment')) cc.textContent = plural(n, 'comment');
    if (score !== S.postScore) {
      S.postScore = score;
      S.postVotes = S.postVotes.map(([el, cls]) => [swapVote(el, () => voteBlock(cls)), cls]);
    }
    return;
  }
  S.postSig = sig;
  S.postScore = score;
  const legacy = !t.post_type && !t.article;
  const type = displayType(t.post_type);
  const body = t.body ? String(t.body) : '';
  const long = body.length > 420;
  const bodyEl = body ? richText(body, `post-text${long && !S.bodyOpen ? ' is-clamped' : ''}`) : null;
  const more = long ? h('button', { class: 'btn-link', type: 'button', text: S.bodyOpen ? 'Show less' : 'Show more', 'aria-expanded': String(!!S.bodyOpen),
    on: { click: e => { S.bodyOpen = !bodyEl.classList.toggle('is-clamped'); e.target.textContent = S.bodyOpen ? 'Show less' : 'Show more'; e.target.setAttribute('aria-expanded', String(S.bodyOpen)); } } }) : null;
  const link = legacy ? extLink(t.link, domainOf(t.link) || 'Open link', 'post-link') : null;
  const when = relTime(t.created_at);
  const colVote = voteBlock('vote-stack');
  const inlineCls = 'vote-inline vote-pill post-vote-inline';
  const inlineVote = voteBlock(inlineCls);
  S.postVotes = [[colVote, 'vote-stack'], [inlineVote, inlineCls]];
  S.els.post.replaceChildren(h('article', { class: 'card post-card post-full', 'data-type': type },
    h('div', { class: 'vote-col' }, colVote),
    h('div', { class: 'post-main' },
      h('div', { class: 'post-meta' },
        subLink(subOf(t), 'sub-link meta-sub post-sub'),
        ...opLine(t),
        when ? h('span', { 'data-t': t.created_at, 'data-fmt': 'ago', text: ` ${when}${when === 'just now' ? '' : ' ago'}` }) : null,
      ),
      h('h1', { class: 'post-title' }, h('span', { class: 'post-title-text', text: t.title || t.headline || '' }), ' ', typeFlair(type)),
      type === 'poll' || t.poll ? pollResults(t.poll) : null,
      bodyEl, more,
      articleBlock(t, legacy),
      link,
      h('div', { class: 'post-actions' },
        inlineVote,
        h('span', { class: 'act' }, ICONS.comment(), h('span', { id: 'comment-count', text: plural(n, 'comment') })),
        h('span', { class: 'act' }, ICONS.users(), h('span', { text: plural(S.bots.size, 'redditor') })),
        statusTag(t.status),
        h('span', { class: 'act act-muted', text: `${t.thread_limit ?? '?'} per thread · ${t.max_comments ?? '?'} max` }),
      ),
    ),
  ), type === 'confession' ? confessionNote() : null);
}

// v3.1: a quiet line under a confession post. AutoMod's sticky says the same at more length.
export const CONFESSION_NOTE = 'Anonymous confession. No real names. Tele-MANAS 14416 is free, 24x7';
function confessionNote() {
  return h('p', { class: 'confession-note', id: 'confession-note', role: 'note' },
    h('span', { class: 'confession-note-ic', 'aria-hidden': 'true', text: '🤫' }),
    h('span', {}, 'Anonymous confession. No real names. ', h('a', { href: 'tel:14416', class: 'confession-tel', text: 'Tele-MANAS 14416' }), ' is free, 24x7'));
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
  const sig = JSON.stringify(bots.map(b => [b.id, b.username, b.retired, b.occupation, b.model, b.provider, b.bio]));
  if (sig === S.rosterSig) return;
  S.rosterSig = sig;
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

// ---------------------------------------------------------------- keyed comment patching

// Makes `parent`'s children exactly `els`, in order, touching only what changed (elements
// that stay are never detached, so focus, selection and running animations survive).
function sync(parent, els) {
  const want = new Set(els);
  let cur = parent.firstChild;
  for (const el of els) {
    while (cur && !want.has(cur)) { const n = cur.nextSibling; cur.remove(); cur = n; }
    if (el === cur) { cur = cur.nextSibling; continue; }
    parent.insertBefore(el, cur);
  }
  while (cur) { const n = cur.nextSibling; cur.remove(); cur = n; }
}

// Re-renders the comment list (patching), inside the scroll anchor unless told otherwise.
function renderComments({ resort = false, anchor = true, anchorEl = null, clamp = false } = {}) {
  if (!S.els.comments) return;
  if (anchor) preserve(() => patchComments(resort), anchorEl ? { el: anchorEl, clamp } : undefined);
  else patchComments(resort);
  refreshPill();
}

const FOCUS_CLS = ['cm-toggle', 'reply-btn', 'vote-up', 'vote-down', 'uname-btn', 'continue', 'act-btn', 'rail'];
function focusKey(el) {
  const cm = el?.closest?.('.cm');
  if (!cm || !el.closest('#comments, #sticky') || el.closest('.cbox')) return null;
  const cls = FOCUS_CLS.find(c => el.classList.contains(c));
  return cls ? { id: cm.id, cls, text: el.textContent } : null;
}

function patchComments(resort) {
  const box = S.els.comments;
  if (!box) return;
  const act = document.activeElement;
  const fk = focusKey(act);
  const boxFocus = S.replyBox && S.replyBox.contains(act) ? { el: act, a: act.selectionStart, b: act.selectionEnd } : null;
  S.locked = lockedIds(S.comments);
  S.roles = opRoles(S.thread, [...S.bots.values()]);
  const visible = S.held.size ? S.comments.filter(c => !S.held.has(c.id)) : S.comments;
  const { sticky, rest } = splitSticky(buildTree(visible));
  if (resort) S.rank = null;
  const roots = arrangeTree(rest, S.rank, S.sort);
  S.rank = rankOrder(roots);
  const limit = S.thread?.thread_limit ?? Infinity;
  const seen = new Set();
  if (S.els.sticky) {
    sync(S.els.sticky, sortTree(sticky, 'new').reverse().map(r => renderNode(r, 0, false, seen)));
    S.els.sticky.hidden = !sticky.length;
  }
  let list;
  if (roots.length) list = roots.map(r => renderNode(r, 0, isLocked(r, limit), seen));
  else {
    const key = `${!!S.thread}|${S.thread?.status}`;
    if (S.emptyKey !== key || !S.emptyEl) { S.emptyKey = key; S.emptyEl = emptyComments(); }
    list = [S.emptyEl];
  }
  sync(box, list);
  for (const id of [...S.recs.keys()]) if (!seen.has(id)) S.recs.delete(id);
  const lost = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;
  if (boxFocus?.el.isConnected && document.activeElement !== boxFocus.el) {
    boxFocus.el.focus({ preventScroll: true });
    try { if (boxFocus.a != null) boxFocus.el.setSelectionRange(boxFocus.a, boxFocus.b); } catch { /* not a text field */ }
  } else if (fk && lost) {
    const w = document.getElementById(fk.id);
    const mine = w ? [...w.querySelectorAll(`.${fk.cls}`)].filter(x => x.closest('.cm') === w) : [];
    (mine.find(x => x.textContent === fk.text) || mine[0])?.focus({ preventScroll: true });
  }
  S.fresh.clear();
  const cc = document.getElementById('comment-count');
  if (cc && cc.textContent !== plural(countComments(), 'comment')) cc.textContent = plural(countComments(), 'comment');
}

// Relative times are refreshed in place (no re-render) once a minute.
function refreshTimes() {
  for (const el of document.querySelectorAll('#main [data-t]')) {
    const t = relTime(el.dataset.t);
    if (!t) continue;
    const text = el.dataset.fmt === 'ago' ? ` ${t}${t === 'just now' ? '' : ' ago'}` : `· ${t}`;
    if (el.textContent !== text) el.textContent = text;
  }
}

// Collapse/expand keeps the toggled comment where it is; if its header was above the
// visible edge (a rail tap or long-press inside a tall comment), the collapsed row is
// brought down to that edge instead of disappearing upwards: one controlled move beats
// landing the reader in unrelated content.
function toggleCollapse(id) {
  if (S.collapsed.has(id)) S.collapsed.delete(id); else S.collapsed.add(id);
  renderComments({ anchorEl: document.getElementById(`c${id}`), clamp: true });
}

// Who wrote a comment. Missing author_type means a v1 bot comment.
function authorOf(node) {
  const type = node.author_type || 'bot';
  if (type === 'automod') return { type, name: 'AutoModerator', bot: null };
  if (type === 'user') return { type, name: typeof node.author_name === 'string' && node.author_name.trim() ? node.author_name.trim() : '[deleted]', bot: null };
  const bot = node.bot_id != null ? S.bots.get(node.bot_id) : null;
  return { type: 'bot', name: bot?.username || '[deleted]', bot };
}

function roleFlags(node, who) {
  const r = S.roles || {};
  const isOp = (who.type === 'bot' && r.opBot != null && node.bot_id === r.opBot) || (who.type === 'user' && r.opUser && who.name === r.opUser);
  const isHost = who.type === 'bot' && r.host != null && node.bot_id === r.host;
  return [!!isOp, !!isHost];
}

function flashNew(el) {
  el.classList.add('is-new');
  const done = () => el.classList.remove('is-new');
  el.addEventListener('animationend', e => { if (e.target === el && e.animationName === 'new-flash') done(); });
  setTimeout(done, 3000);
}

// One comment, patched in place. The wrapper element is keyed by id and kept for as long
// as the comment is rendered; its parts (gutter, head, body, awards, actions, "continue")
// are rebuilt only when their own inputs change. Scores swap just the vote widget.
function renderNode(node, level, locked, seen) {
  seen.add(node.id);
  let rec = S.recs.get(node.id);
  if (!rec) {
    rec = { el: h('div', { class: 'cm', id: `c${node.id}`, 'data-id': node.id }), main: h('div', { class: 'cm-main' }), kids: h('div', { class: 'cm-children' }), part: {}, sig: {}, vote: null, score: null };
    S.recs.set(node.id, rec);
    if (S.fresh.has(node.id)) flashNew(rec.el);
  }
  const el = rec.el;
  const who0 = authorOf(node);
  const who = node.deleted ? { type: 'deleted', name: '[deleted]', bot: null } : who0;
  const bot = who.bot || { username: who.name, model: 'unknown', provider: 'unknown' };
  const collapsed = S.collapsed.has(node.id);
  const hidden = countDescendants(node);
  const prev = S.prevHidden.get(node.id);
  S.prevHidden.set(node.id, hidden);
  const bumped = collapsed && prev != null && hidden > prev;
  const name = who.name;
  const known = !!who.bot;
  const mod = who.type === 'automod';
  const occ = known ? occupationOf(bot) : '';
  const pfKey = `c${node.id}`;
  const [isOp, isHost] = who.type === 'deleted' ? [false, false] : roleFlags(node, who);
  const score = Number.isFinite(node.score) ? node.score : 0;

  const state = {
    'is-collapsed': collapsed, 'is-mod': mod, 'is-stickied': !!node.stickied, 'is-human': who.type === 'user',
    'is-pending': !!node.pending, 'is-deleted': !!node.deleted, 'is-removed': !!node.removed,
    'is-locked': S.locked.has(node.id), 'is-flat': level >= DISPLAY_DEPTH,
  };
  for (const [k, v] of Object.entries(state)) el.classList.toggle(k, v);
  el.dataset.level = String(level);
  el.dataset.author = who.type;
  const until = S.replied.get(node.id) || 0;
  if (until > Date.now() && !el.classList.contains('is-replied')) {
    el.classList.add('is-replied');
    setTimeout(() => el.classList.remove('is-replied'), until - Date.now());
  }

  const part = (key, sig, build) => {
    if (key in rec.sig && rec.sig[key] === sig) return rec.part[key];
    const n = build();
    const old = rec.part[key];
    if (old?.parentNode) { if (n) old.replaceWith(n); else old.remove(); }
    rec.part[key] = n; rec.sig[key] = sig;
    return n;
  };
  const av = cls => (known ? avatarOpener(bot, pfKey, cls) : mod ? modAvatar(cls) : who.type === 'deleted' ? deletedAvatar(cls) : avatar(name, cls));

  const gutter = part('gutter', JSON.stringify([who.type, name, known, collapsed]), () => {
    const g = h('div', { class: 'cm-gutter' }, av('av-gutter'));
    if (!collapsed) g.append(h('button', { class: 'rail', type: 'button', tabindex: '-1', 'aria-hidden': 'true', title: `Collapse ${name}'s comment`, on: { click: () => toggleCollapse(node.id) } }));
    return g;
  });

  const head = part('head', JSON.stringify([who.type, name, known && bot.model, known && bot.provider, isOp, isHost, occ, !!node.stickied, collapsed,
    collapsed ? score : null, collapsed ? hidden : null, bumped, !!node.pending, !!node.edited, !!node.deleted, !!node.removed, !!node.locked, !!bot.retired, node.created_at]), () => {
    const toggle = h('button', {
      class: 'cm-toggle', type: 'button', 'data-toggle': String(node.id),
      'aria-expanded': String(!collapsed),
      'aria-label': collapsed ? `Expand comment by ${name}${hidden ? `, ${plural(hidden, 'reply', 'replies')} hidden` : ''}` : `Collapse comment by ${name}`,
      on: { click: () => toggleCollapse(node.id) },
    }, collapsed ? (hidden ? `[+${hidden}]` : '[+]') : '[–]');
    const time = relTime(node.created_at);
    return h('div', { class: 'cm-head' },
      av('av-inline'),
      toggle,
      known ? pfOpener(bot, pfKey, 'uname uname-btn', name) : h('span', { class: `uname${mod ? ' uname-mod' : ''}`, text: name }),
      who.type === 'deleted' ? null : mod ? modBadge() : who.type === 'user' ? humanFlair() : flair(bot),
      isOp ? h('span', { class: 'role-badge role-op', title: 'Original poster' }, 'OP') : null,
      isHost ? h('span', { class: 'role-badge role-host', title: 'AMA host' }, 'HOST') : null,
      occ ? h('span', { class: 'cm-occ', text: `· ${occ}` }) : null,
      node.stickied ? h('span', { class: 'cm-sticky', title: 'Stickied comment' }, ICONS.pin(), h('span', { class: 'sticky-text', text: 'Stickied comment' })) : null,
      collapsed
        ? h('span', { class: 'cm-collapsed-meta' },
          h('span', { text: `· ${plural(node.score, 'point')}` }),
          h('span', { class: `hidden-count${bumped ? ' is-bumped' : ''}`, text: ` · ${plural(hidden, 'reply', 'replies')} hidden` }))
        : node.pending ? h('span', { class: 'cm-time cm-posting', text: '· posting…' })
          : (time ? h('span', { class: 'cm-time', 'data-t': node.created_at, text: `· ${time}` }) : null),
      node.edited && !collapsed && !node.deleted && !node.removed ? h('span', { class: 'cm-edited', title: 'Edited', text: '· edited' }) : null,
      node.locked ? h('span', { class: 'cm-lock', title: 'Locked by moderators', 'aria-label': 'Locked by moderators', role: 'img' }, ICONS.lock(), h('span', { class: 'cm-lock-text', text: 'locked' })) : null,
      bot.retired ? h('span', { class: 'left-tag', text: 'left' }) : null,
    );
  });

  if (el.firstChild !== gutter || el.lastChild !== rec.main || el.childNodes.length !== 2) sync(el, [gutter, rec.main]);
  if (collapsed) { sync(rec.main, [head]); return el; }

  const body = part('body', JSON.stringify([!!node.deleted, !!node.removed, node.text]), () => (node.deleted
    ? h('div', { class: 'cm-body cm-gone' }, h('p', { text: '[deleted]' }))
    : node.removed ? h('div', { class: 'cm-body cm-gone' }, h('p', { text: '[removed by moderator]' }))
      : richText(node.text, 'cm-body')));
  const awardList = node.deleted || node.removed ? [] : awardCounts(node.awards);
  const awards = part('awards', JSON.stringify(awardList), () => (awardList.length
    ? h('div', { class: 'cm-awards', 'aria-label': `Awards: ${awardList.map(([a, n]) => `${a} ${n}`).join(', ')}` },
      awardList.map(([a, n]) => h('span', { class: 'award', title: `${n} × ${a}` }, h('span', { class: 'award-ic', text: a }), n > 1 ? h('span', { class: 'award-n', text: `×${n}` }) : null)))
    : null));
  const subLocked = S.locked.has(node.id);
  const replyOk = canReply(node, subLocked);
  const replyOpen = S.replyTo === node.id;
  const showFull = level === 0 && locked;
  const actions = part('actions', JSON.stringify([!!node.pending, hidden, replyOk, replyOpen, level === 0 && node.children.length > 0, showFull]), () => {
    rec.score = score;
    rec.vote = node.pending
      ? h('div', { class: 'vote vote-inline', 'aria-label': `Score ${node.score}` }, ICONS.up(), h('span', { class: 'score', text: formatScore(node.score) }), ICONS.down())
      : voteWidget({ threadId: S.threadId, target: node.id, score, cls: 'vote-inline' });
    return h('div', { class: 'cm-actions' },
      rec.vote,
      h('span', { class: 'act' }, ICONS.comment(), h('span', { text: hidden ? plural(hidden, 'reply', 'replies') : 'No replies' })),
      replyOk ? h('button', { class: 'act act-btn reply-btn', type: 'button', 'aria-expanded': String(replyOpen), on: { click: () => openReply(node.id) } }, 'Reply') : null,
      level === 0 && node.children.length ? h('button', { class: 'act act-btn', type: 'button', text: 'Collapse thread', on: { click: () => toggleCollapse(node.id) } }) : null,
      showFull ? h('span', { class: 'locked locked-full', title: 'The bots have reached this thread\'s comment limit. Humans can still reply.' }, 'thread full') : null,
    );
  });
  if (!node.pending && rec.score !== score && rec.vote) {
    rec.score = score;
    rec.vote = swapVote(rec.vote, () => voteWidget({ threadId: S.threadId, target: node.id, score, cls: 'vote-inline' }));
  }

  let kids = null;
  if (node.children.length) {
    kids = rec.kids;
    const childLevel = level + 1;
    if (childLevel >= DISPLAY_DEPTH && !S.continued.has(node.id) && level < DISPLAY_DEPTH) {
      sync(kids, [part('cont', String(hidden), () => h('button', { class: 'continue', type: 'button',
        on: { click: () => { S.continued.add(node.id); renderComments(); } } },
      `continue this thread →`, h('span', { class: 'continue-n', text: ` (${plural(hidden, 'reply', 'replies')})` })))]);
    } else {
      sync(kids, node.children.map(ch => renderNode(ch, childLevel, locked, seen)));
    }
  }
  const replyBox = replyOpen && S.replyBox && replyOk ? S.replyBox : null;
  sync(rec.main, [head, body, awards, actions, replyBox, kids].filter(Boolean));
  return el;
}

function deletedAvatar(cls) {
  return svg('0 0 20 20', [['circle', { cx: 10, cy: 10, r: 10, fill: 'currentColor', opacity: '.25' }]], `av av-deleted ${cls}`.trim());
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
    const isNew = !S.comments.some(x => x.id === c.id);
    const r = reconcileComment(S.comments, c);
    S.comments = r.comments;
    if (r.replaced != null) { inheritRank(r.replaced, c.id); S.fresh.add(c.id); } // our optimistic comment, confirmed
    else if (isNew) admit(c, shouldBuffer(readingState()));
    // A bot answering a human: flash the human's comment so they notice.
    const parent = c.parent_id != null ? S.comments.find(x => x.id === c.parent_id) : null;
    if (parent && parent.author_type === 'user' && (c.author_type || 'bot') === 'bot') S.replied.set(parent.id, Date.now() + 2400);
    scheduleRender();
  });
  const onPatch = (name, fn) => es.addEventListener(name, e => {
    if (!mine()) return;
    const d = parse(e.data);
    if (!d || typeof d.comment_id !== 'number') return;
    S.comments = fn(S.comments, d);
    if (name === 'lock' && S.replyTo != null && lockedIds(S.comments).has(S.replyTo)) { S.replyTo = null; S.replyBox = null; }
    if ((name === 'delete' || name === 'remove') && S.replyTo === d.comment_id) { S.replyTo = null; S.replyBox = null; }
    scheduleRender();
  });
  onPatch('edit', (cs, d) => applyEdit(cs, d));
  onPatch('delete', (cs, d) => applyDelete(cs, d.comment_id));
  onPatch('remove', (cs, d) => applyRemove(cs, d.comment_id));
  onPatch('award', (cs, d) => applyAwards(cs, d));
  onPatch('lock', (cs, d) => applyLock(cs, d.comment_id));
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
      scheduleRender();
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
      S.els.comments?.replaceChildren(); S.recs = new Map(); S.held.clear(); refreshPill();
      statusChip(null);
      return;
    }
    if (!S.thread) S.els.post?.replaceChildren(postSkeleton());
    showBanner(`Can't reach the Agent Reddit server at ${API}. Check your connection and retry.`);
  }
}

// keep relative times fresh, in place
setInterval(() => { if (view.name === 'thread' && S.thread) { preserve(refreshTimes); renderProfile(); } }, 60000);
