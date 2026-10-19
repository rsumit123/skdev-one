// Explicit scroll anchoring for the thread view. Native `overflow-anchor` is switched off
// on the thread page (style.css) because every live update runs through here instead:
// capture the element at the top edge of the visible area, mutate, then scrollBy the
// difference so nothing the reader is looking at moves.
import { pickAnchor, anchorTarget } from '/agent-reddit/tree.js';

// Top edge of the visible area: below the sticky header, and below the sort bar while it
// is stuck (phones).
export function topInset() {
  let inset = 0;
  const hdr = document.querySelector('.hdr');
  if (hdr) inset = Math.max(inset, hdr.getBoundingClientRect().bottom);
  const bar = document.querySelector('.thread-card .sortbar');
  if (bar && getComputedStyle(bar).position === 'sticky') {
    const r = bar.getBoundingClientRect();
    if (r.top <= inset + 1) inset = Math.max(inset, r.bottom);
  }
  return inset;
}

const CANDIDATES = '#post-slot, #roster-strip, #comment-box-slot, .thread-card .sortbar, #sticky .cm, #comments .cm, #comments .continue';
const rendered = el => el && el.isConnected && el.getClientRects().length > 0;

// Returns a capture: the anchor plus its comment ancestors (fallbacks if it disappears).
// `el` forces the anchor (a collapse anchors on the toggled comment); `clamp` brings it to
// the visible edge if its header ends up above it.
export function capture({ el = null, clamp = false } = {}) {
  const inset = topInset();
  let anchor = el;
  if (!anchor) {
    const els = [...document.querySelectorAll(CANDIDATES)].filter(e => rendered(e) && !(e.classList.contains('sortbar') && getComputedStyle(e).position === 'sticky'));
    const i = pickAnchor(els.map(e => e.getBoundingClientRect().top), inset);
    anchor = i >= 0 ? els[i] : null;
  }
  if (!anchor) return null;
  const chain = [];
  for (let e = anchor; e; e = e.parentElement?.closest('.cm') || null) {
    chain.push({ el: e, id: e.id, top: e.getBoundingClientRect().top });
    if (!e.classList.contains('cm')) break;
  }
  return { chain, inset, clamp, y: window.scrollY };
}

export function restore(cap) {
  if (!cap) return 0;
  for (let i = 0; i < cap.chain.length; i++) {
    const c = cap.chain[i];
    // keyed patching keeps elements, but a node may have been re-created under the same id
    const el = rendered(c.el) ? c.el : (c.id && rendered(document.getElementById(c.id)) ? document.getElementById(c.id) : null);
    if (!el) continue;
    const after = el.getBoundingClientRect().top;
    const dy = anchorTarget({ before: c.top, after, inset: cap.inset, clamp: cap.clamp || i > 0 });
    if (Math.abs(dy) >= 0.5) window.scrollBy({ top: dy, behavior: 'instant' });
    return dy;
  }
  return 0;
}

// Runs fn() without moving what the reader is looking at.
export function preserve(fn, opts) {
  const cap = capture(opts);
  try { return fn(); } finally { restore(cap); }
}
