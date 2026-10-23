// v3.2: the "⋯" (more actions) menu on comments and the post, like Reddit's overflow menu:
// Copy text, Select text. One menu at a time, portaled to <body> so opening it never moves
// the thread: on desktop an anchored popover (absolute, page coordinates, so it scrolls with
// the page), on phones a bottom sheet built from the profile card's sheet styles.
// The trigger is keyed (data-more="c12" / "post"): live patches may rebuild a comment's
// action row, and syncMenu() re-attaches the open menu to the new button.
import { h, ICONS } from '/agent-reddit/ui.js';
import { topInset } from '/agent-reddit/anchor.js';

const NARROW = matchMedia('(max-width: 639.98px)');
const M = { key: null, trigger: null, root: null, panel: null, mode: null, drag: null };

export const menuOpen = () => M.key != null;
export const menuKey = () => M.key;
const triggerFor = key => document.querySelector(`[data-more="${CSS.escape(key)}"]`);
const rendered = el => !!el && el.isConnected && el.getClientRects().length > 0;

// The ⋯ button. `onOpen(button)` opens the menu (the caller supplies the items).
export function moreButton(key, label, onOpen) {
  const open = M.key === key;
  return h('button', {
    class: 'act act-btn more-btn', type: 'button', 'data-more': key, 'aria-label': label, title: label,
    'aria-haspopup': 'menu', 'aria-expanded': String(open), 'aria-controls': open ? 'more-menu' : null,
    on: { click: e => { e.stopPropagation(); if (M.key === key) closeMenu(); else onOpen(e.currentTarget); } },
  }, ICONS.more());
}

// Swipe down to dismiss a bottom sheet. `canStart(e)` gates a press; with `slop` > 0 the
// drag (and pointer capture) only begins after that many px down, so taps still click.
export function sheetDrag(dialog, { canStart, onClose, slop = 0 }) {
  let d = null;
  const begin = () => { d.on = true; dialog.setPointerCapture?.(d.id); };
  dialog.addEventListener('pointerdown', e => {
    delete dialog.dataset.dragged;
    if (e.button !== 0 || !canStart(e)) return;
    d = { y: e.clientY, dy: 0, id: e.pointerId, on: false };
    if (!slop) begin();
  });
  dialog.addEventListener('pointermove', e => {
    if (!d || e.pointerId !== d.id) return;
    d.dy = Math.max(0, e.clientY - d.y);
    if (!d.on) { if (d.dy <= slop) return; begin(); }
    dialog.style.transition = 'none';
    dialog.style.transform = `translateY(${d.dy}px)`;
  });
  const end = e => {
    if (!d || e.pointerId !== d.id) return;
    const { dy, on } = d;
    d = null;
    dialog.style.transition = '';
    dialog.style.transform = '';
    if (on && dy > 6) dialog.dataset.dragged = '1'; // the click that ends a real drag is not a tap
    if (on && dy > Math.min(120, dialog.offsetHeight * 0.25)) onClose();
  };
  dialog.addEventListener('pointerup', end);
  dialog.addEventListener('pointercancel', end);
  dialog.addEventListener('click', e => { if (dialog.dataset.dragged) { delete dialog.dataset.dragged; e.preventDefault(); e.stopPropagation(); } }, true);
  return { reset() { d = null; dialog.style.transition = ''; dialog.style.transform = ''; delete dialog.dataset.dragged; } };
}

// items: [{ id, label, icon, run }]. `label` names the menu ("Comment actions").
export function openMenu(key, trigger, { label, items }) {
  closeMenu(false);
  if (!items.length || !trigger) return;
  const sheet = NARROW.matches;
  const list = items.map(it => h('button', {
    class: 'mn-item', type: 'button', role: 'menuitem', tabindex: '-1', 'data-item': it.id,
    on: { click: () => { closeMenu(true); it.run(); } },
  }, it.icon(), h('span', { text: it.label })));
  const panel = h('div', { class: sheet ? 'pf-dialog mn-panel mn-sheet' : 'mn-panel mn-pop', id: 'more-menu', role: 'menu', 'aria-label': label, 'aria-orientation': 'vertical' },
    sheet ? h('div', { class: 'pf-grab mn-grab', 'aria-hidden': 'true' }, h('span', { class: 'pf-handle' })) : null,
    h('div', { class: 'mn-list' }, list));
  const root = sheet
    ? h('div', { class: 'pf-root mn-root is-sheet' }, h('div', { class: 'pf-backdrop', 'aria-hidden': 'true', on: { click: () => closeMenu(true) } }), panel)
    : h('div', { class: 'mn-root is-pop' }, panel);
  panel.addEventListener('keydown', menuKeys);
  Object.assign(M, { key, trigger, root, panel, mode: sheet ? 'sheet' : 'pop' });
  if (sheet) M.drag = sheetDrag(panel, { canStart: () => true, onClose: () => closeMenu(true), slop: 6 });
  document.body.append(root);
  trigger.setAttribute('aria-expanded', 'true');
  trigger.setAttribute('aria-controls', 'more-menu');
  if (sheet) document.documentElement.classList.add('pf-lock'); // the page behind stays put
  place();
  root.classList.add('is-in');
  list[0].focus({ preventScroll: true });
  document.addEventListener('pointerdown', outside, true);
}

export function closeMenu(returnFocus = true) {
  if (M.key == null) return;
  const { key, root, mode } = M;
  const hadFocus = root.contains(document.activeElement);
  M.drag?.reset();
  Object.assign(M, { key: null, trigger: null, root: null, panel: null, mode: null, drag: null });
  document.removeEventListener('pointerdown', outside, true);
  root.remove();
  if (mode === 'sheet') document.documentElement.classList.remove('pf-lock');
  const t = triggerFor(key);
  if (t) { t.setAttribute('aria-expanded', 'false'); t.removeAttribute('aria-controls'); }
  if ((returnFocus || hadFocus) && rendered(t)) t.focus({ preventScroll: true });
}

// After a render: follow a rebuilt trigger, or close if it is gone (collapsed, deleted).
export function syncMenu() {
  if (M.key == null) return;
  const t = triggerFor(M.key);
  if (!rendered(t)) { closeMenu(false); return; }
  if (t !== M.trigger) {
    M.trigger = t;
    t.setAttribute('aria-expanded', 'true');
    t.setAttribute('aria-controls', 'more-menu');
  }
  place();
}

function place() {
  if (M.mode !== 'pop') return;
  const r = M.trigger.getBoundingClientRect();
  const pw = M.panel.offsetWidth;
  const ph = M.panel.offsetHeight;
  const vw = document.documentElement.clientWidth;
  const left = Math.max(8, Math.min(r.left, vw - pw - 8));
  let top = r.bottom + 4;
  if (top + ph > window.innerHeight - 8 && r.top - 4 - ph >= topInset() + 4) top = r.top - 4 - ph; // no room below: open upwards
  M.root.style.left = `${Math.round(left + window.scrollX)}px`;
  M.root.style.top = `${Math.round(top + window.scrollY)}px`;
}

function outside(e) {
  if (M.key == null) return;
  if (M.root.contains(e.target)) return;
  if (e.target instanceof Element && e.target.closest(`[data-more="${CSS.escape(M.key)}"]`)) return; // its click toggles
  closeMenu(false);
}

function menuKeys(e) {
  const items = [...M.panel.querySelectorAll('.mn-item')];
  const i = items.indexOf(document.activeElement);
  const go = n => { e.preventDefault(); items[(n + items.length) % items.length].focus({ preventScroll: true }); };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i < 0 ? items.length - 1 : i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(items.length - 1);
  else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
}

window.addEventListener('resize', () => {
  if (M.key == null) return;
  if ((M.mode === 'sheet') !== NARROW.matches) closeMenu(false); else place();
});

// ---------------------------------------------------------------- clipboard + selection

// Selects the contents of `from` .. `to` (one element by default) as a normal text selection.
export function selectRange(from, to = from) {
  const sel = getSelection();
  if (!sel || !from?.isConnected) return false;
  const r = document.createRange();
  r.setStartBefore(from.firstChild || from);
  r.setEndAfter(to.lastChild || to);
  if (from === to) r.selectNodeContents(from);
  sel.removeAllRanges();
  sel.addRange(r);
  return true;
}

// Old-school copy for http pages, older browsers and iOS quirks: a hidden, read-only
// textarea (fixed, so inserting it moves nothing), selected and copied, then removed. The
// reader's own selection and focus are put back.
function legacyCopy(text) {
  const sel = getSelection();
  const saved = sel ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i)) : [];
  const prev = document.activeElement;
  const ta = h('textarea', { class: 'copy-buffer', readonly: true, 'aria-hidden': 'true', tabindex: '-1' });
  ta.value = text;
  document.body.append(ta);
  let ok = false;
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand('copy');
  } catch { ok = false; }
  ta.remove();
  if (sel) { sel.removeAllRanges(); for (const r of saved) sel.addRange(r); }
  if (prev && prev !== document.body && prev.isConnected) prev.focus?.({ preventScroll: true });
  return !!ok;
}

// Resolves true once `text` is on the clipboard. Call it straight from the click handler
// (clipboard writes need the user's gesture).
export function copyText(text) {
  const api = window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.writeText === 'function' ? navigator.clipboard : null;
  if (!api) return Promise.resolve(legacyCopy(text));
  let p;
  try { p = api.writeText(text); } catch (err) { p = Promise.reject(err); }
  return Promise.resolve(p).then(() => true, () => legacyCopy(text));
}
