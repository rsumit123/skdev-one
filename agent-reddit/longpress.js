// Touch long-press on a comment toggles its subtree, like Reddit's mobile app. Pointer
// Events only (touch + pen); mouse and keyboard keep the [-]/[+] button and the rail.
//
// Trade-off: a long-press on a comment's text normally starts the browser's text selection
// (and the iOS callout). While a press is live we turn both off for the thread
// (`.lp-active`: user-select / -webkit-touch-callout none, and selectstart + contextmenu
// are cancelled), so the gesture collapses instead of selecting. Text can still be
// selected with a long-press anywhere else on the page, and inside a comment that already
// has a selection (the press is ignored there so the handles can be dragged). Taps are
// unaffected: nothing is suppressed until a press starts, and only the click that ends a
// completed long-press is swallowed.
import { pressReducer, PRESS, PRESS_MS } from '/agent-reddit/tree.js';

// Not a long-press target: anything interactive or that carries its own meaning.
const NOT = 'a, button, input, textarea, select, label, summary, [role="button"], [contenteditable], .flair, .uname, .vote, .cm-actions, .cm-awards, .cbox, .role-badge, .mod-badge, .cm-lock';

// One gesture at a time across the page; the document-level guards read this.
let st = PRESS;
let docHooked = false;
const busy = e => st.phase !== 'idle' || e.timeStamp < st.until;

export function longPress(root, { onFire, onTapRow }) {
  let timer = 0;
  let target = null;
  let lastType = '';
  st = PRESS;

  const commentAt = node => {
    if (!(node instanceof Element) || node.closest(NOT)) return null;
    const zone = node.closest('.cm-body, .cm-head');
    const cm = zone?.parentElement?.parentElement;
    if (!cm || !cm.classList.contains('cm') || !root.contains(cm)) return null;
    const sel = getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount && cm.contains(sel.anchorNode)) return null;
    return cm;
  };
  const onScroll = () => { if (st.phase === 'pressing') step({ type: 'cancel', t: performance.now() }); };
  const run = effect => {
    if (effect === 'press') {
      root.classList.add('lp-active');
      target.classList.add('is-pressing');
      clearTimeout(timer);
      timer = setTimeout(() => step({ type: 'timer' }), PRESS_MS);
      window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    } else if (effect === 'release') {
      clearTimeout(timer);
      target?.classList.remove('is-pressing');
      root.classList.remove('lp-active');
      window.removeEventListener('scroll', onScroll, { capture: true });
      target = null;
    } else if (effect === 'fire') {
      target.classList.remove('is-pressing');
      try { navigator.vibrate?.(10); } catch { /* not allowed */ }
      const sel = getSelection();
      if (sel && !sel.isCollapsed && root.contains(sel.anchorNode)) sel.removeAllRanges();
      onFire(target);
    }
  };
  const step = ev => { const r = pressReducer(st, ev); st = r.state; if (r.effect) run(r.effect); };

  root.addEventListener('pointerdown', e => {
    lastType = e.pointerType;
    const cm = e.isPrimary ? commentAt(e.target) : null;
    if (st.phase !== 'idle') step({ type: 'cancel', t: e.timeStamp }); // a second finger
    if (cm) target = cm;
    step({ type: 'down', pointerType: e.pointerType, x: e.clientX, y: e.clientY, id: e.pointerId, eligible: !!cm, t: e.timeStamp });
  });
  root.addEventListener('pointermove', e => step({ type: 'move', x: e.clientX, y: e.clientY, id: e.pointerId }));
  root.addEventListener('pointerup', e => step({ type: 'up', id: e.pointerId, t: e.timeStamp }));
  root.addEventListener('pointercancel', e => step({ type: 'cancel', id: e.pointerId, t: e.timeStamp }));
  // During the gesture only: no selection, no context menu / callout (also over whatever
  // ends up under the finger after the collapse, hence document level).
  if (!docHooked) {
    docHooked = true;
    document.addEventListener('selectstart', e => { if (st.phase !== 'idle') e.preventDefault(); }, true);
    document.addEventListener('contextmenu', e => { if (busy(e)) e.preventDefault(); }, true);
  }
  root.addEventListener('click', e => {
    if (e.timeStamp < st.until) { st = { ...st, until: 0 }; e.preventDefault(); e.stopPropagation(); return; }
    if (lastType !== 'touch' && lastType !== 'pen') return;
    // Tapping a collapsed comment's one-line row expands it (touch only; mouse unchanged).
    const t = e.target instanceof Element ? e.target : null;
    if (!t || t.closest(NOT)) return;
    const head = t.closest('.cm-head');
    const cm = head?.parentElement?.parentElement;
    if (cm?.classList.contains('cm') && cm.classList.contains('is-collapsed') && root.contains(cm)) onTapRow(cm);
  }, true);
}
