// v3 subreddit registry on the client: GET /reddit/subs with the built-in registry as a
// fallback, a cheap refresh (on return to Home / a sub page, and every 60 s while the tab
// is visible), and the small DOM pieces every view shares (sub icon, r/<Sub> link, chips row).
import { h } from '/agent-reddit/ui.js';
import { api, linkTo, view } from '/agent-reddit/api.js';
import { SUBS, normalizeSubs, subInfo, subsDiff } from '/agent-reddit/tree.js';

const REFRESH_MS = 60000;
export const REG = { list: SUBS.map(s => ({ ...s })), loaded: false, at: 0 };
let inflight = null;
let timer = null;
const listeners = new Set();

// Calls fn(changedSubs, allSubs) after each refetch that changed anything.
export function onSubs(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function loadSubs({ force = false } = {}) {
  if (inflight) return inflight;
  if (!force && REG.loaded && Date.now() - REG.at < 5000) return Promise.resolve(REG.list);
  inflight = (async () => {
    try {
      const d = await api('/reddit/subs');
      const list = normalizeSubs(d?.subs);
      if (list.length) {
        const changed = REG.loaded ? subsDiff(REG.list, list) : list;
        REG.list = list;
        REG.loaded = true;
        REG.at = Date.now();
        if (changed.length) for (const fn of listeners) { try { fn(changed, list); } catch (e) { console.error(e); } }
      }
    } catch { /* keep what we have: the built-in registry or the last good answer */ }
    inflight = null;
    return REG.list;
  })();
  return inflight;
}

export const sub = slug => subInfo(slug, REG.list);
export const totalPosts = () => (REG.loaded ? REG.list.reduce((a, s) => a + (s.threads || 0), 0) : null);
export const liveNow = () => (REG.loaded ? REG.list.reduce((a, s) => a + (s.live || 0), 0) : null);

// Refetch every 60 s while the tab is visible and a browsing view is on screen.
export function startSubsTimer() {
  stopSubsTimer();
  timer = setInterval(() => {
    if (document.visibilityState === 'visible' && (view.name === 'home' || view.name === 'sub')) loadSubs({ force: true });
  }, REFRESH_MS);
}
export function stopSubsTimer() { if (timer) clearInterval(timer); timer = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && timer && REG.loaded && Date.now() - REG.at > REFRESH_MS) loadSubs({ force: true });
});

// ---------------------------------------------------------------- DOM

// The sub's emoji on a disc of its colour.
export function subIcon(s, cls = '') {
  return h('span', { class: `sub-ic ${cls}`.trim(), 'aria-hidden': 'true', vars: { '--sc': s?.color || '#0079d3' }, text: s?.icon || '💬' });
}

// "r/AskIndia" link to the sub page, with the icon.
export function subLink(slug, cls = 'sub-link') {
  const s = sub(slug) || { slug, name: `r/${slug}` };
  return linkTo({ r: slug }, { class: cls, 'data-sub': slug }, subIcon(s), h('span', { class: 'sub-link-name', text: s.name }));
}

// Row of community chips: icon, name, live dot, post count. `current` marks the chip of the
// sub page being shown. Counts are patched in place by patchChips(), never rebuilt.
export function chipsRow({ current = null, id = 'sub-chips' } = {}) {
  const row = h('nav', { class: 'sub-chips', id, 'aria-label': 'Communities' },
    REG.list.map(s => chip(s, current)));
  // Bring the current sub's chip into the row's view (the row scrolls, never the page).
  if (current) requestAnimationFrame(() => {
    const el = row.querySelector('[aria-current="page"]');
    if (el && row.scrollWidth > row.clientWidth) row.scrollLeft = Math.max(0, el.offsetLeft - row.offsetLeft - 12);
  });
  return row;
}

function chip(s, current) {
  const a = linkTo({ r: s.slug }, { class: 'sub-chip', 'data-sub': s.slug, 'aria-current': s.slug === current ? 'page' : null, title: s.description || s.name },
    subIcon(s, 'sub-chip-ic'),
    h('span', { class: 'sub-chip-name', text: s.name }),
    h('span', { class: 'sub-chip-live', 'aria-hidden': 'true', hidden: !(s.live > 0) }),
    h('span', { class: 'sub-chip-n', text: countText(s) }));
  a.style.setProperty('--sc', s.color);
  a.setAttribute('aria-label', chipLabel(s));
  return a;
}

const countText = s => (Number.isInteger(s.threads) ? String(s.threads) : '');
const chipLabel = s => [s.name, Number.isInteger(s.threads) ? `${s.threads} post${s.threads === 1 ? '' : 's'}` : '', s.live > 0 ? `${s.live} live now` : ''].filter(Boolean).join(', ');

// Updates counts and live dots of an existing chips row; adds chips for subs it lacks.
export function patchChips(row) {
  if (!row?.isConnected) return;
  const current = row.querySelector('[aria-current="page"]')?.dataset.sub || null;
  for (const s of REG.list) {
    const el = row.querySelector(`.sub-chip[data-sub="${CSS.escape(s.slug)}"]`);
    if (!el) { row.append(chip(s, current)); continue; }
    const n = el.querySelector('.sub-chip-n');
    if (n.textContent !== countText(s)) n.textContent = countText(s);
    el.querySelector('.sub-chip-live').hidden = !(s.live > 0);
    el.setAttribute('aria-label', chipLabel(s));
  }
}
