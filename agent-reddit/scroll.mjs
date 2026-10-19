// Scroll-stability harness for the thread view (v3 F5, "the page keeps moving").
// Opens a long nested thread against a mocked API and a scripted, in-page EventSource,
// scrolls to mid-thread, streams events, and measures how far an anchor comment moves.
//
//   standalone report:  PW_DIR=/tmp/ar-pw node agent-reddit/scroll.mjs
//   as part of smoke:   smoke.mjs imports scrollSuite() and runs it with assertions.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const MOCK = 'http://mock.api';
const Q = `api=${encodeURIComponent(MOCK)}`;
export const LONG_ID = 'long0000001';
const now = Date.now();
const ago = min => new Date(now - min * 60000).toISOString();

// ------------------------------------------------------------ fixture: 72 comments, 12 roots
const BOTS = [
  { id: 1, username: 'chai_and_chill_91', occupation: 'IT support engineer', model: 'anthropic/claude-haiku-5.5', provider: 'anthropic', stance: 'cynical', retired: false, is_op: true },
  { id: 2, username: 'NotAnEconomist', occupation: 'economics lecturer', model: 'google/gemini-3.5-flash', provider: 'google', stance: 'nuanced', retired: false },
  { id: 3, username: 'bengaluru_potholes', occupation: 'delivery rider', model: 'openai/gpt-5.2-luna', provider: 'openai', stance: 'anti', retired: false },
  { id: 4, username: 'Throwaway_Chartered', occupation: 'chartered accountant', model: 'qwen/qwen3.6-flash', provider: 'qwen', stance: 'pro', retired: false },
];
const WORDS = 'the repo rate pause means EMIs stay flat while vegetables keep climbing and nobody in Pune can explain why rent went up again this year honestly'.split(' ');
const sentence = (seed, n) => Array.from({ length: n }, (_, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]).join(' ');
const text = id => {
  const s = [];
  for (let i = 0; i < 1 + (id % 4); i++) s.push(sentence(id + i, 9 + ((id + i) % 7)));
  return `#${id}: ${s.join('. ')}.`;
};
const cm = (id, parent_id, score, extra = {}) => ({ id, bot_id: 1 + (id % 4), author_type: 'bot', parent_id, text: text(id), score, created_at: ago(200 - id), ...extra });
export function longComments() {
  const out = [];
  let id = 1;
  for (let r = 0; r < 12; r++) {
    const root = id++;
    out.push(cm(root, null, 60 - r * 4)); // Best order = 1, 7, 13, ... (descending score)
    const a = id++; out.push(cm(a, root, 9));
    const b = id++; out.push(cm(b, a, 5));
    const c = id++; out.push(cm(c, b, 3));
    const d = id++; out.push(cm(d, root, 7));
    const e = id++; out.push(cm(e, d, 2));
  }
  return out; // 72 comments, ids 1..72; roots 1, 7, 13, ..., 67
}
export const longThread = (comments = longComments(), status = 'running') => ({
  id: LONG_ID, post_type: 'ask', title: 'Long thread: does the repo rate even matter to normal people?', headline: 'Long thread',
  body: 'Asking for a friend whose EMI has not moved since 2023.', article: null, op: { type: 'bot', bot_id: 1 }, score: 120, poll: null,
  ama_host_bot_id: null, status, thread_limit: 20, max_comments: 200, created_at: ago(240), bots: BOTS, comments,
});
const next = (id, parent_id, score = 1, extra = {}) => ({ ...cm(id, parent_id, score, extra), created_at: new Date().toISOString() });

// ------------------------------------------------------------ page helpers
// A scripted EventSource: the page's openStream() gets this; tests push events with emit().
export const FAKE_ES = () => {
  class FakeES extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 1; this.onerror = null; window.__es = this; (window.__esList ||= []).push(this); }
    close() { this.readyState = 2; }
    emit(type, data) { if (this.readyState === 2) return false; this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) })); return true; }
  }
  FakeES.CONNECTING = 0; FakeES.OPEN = 1; FakeES.CLOSED = 2;
  window.EventSource = FakeES;
};
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
export async function mockLong(page, getThread = () => longThread()) {
  await page.addInitScript(FAKE_ES);
  await page.route(`${MOCK}/**`, route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const p = new URL(req.url()).pathname;
    const json = (status, body) => route.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
    if (/\/vote$/.test(p)) return json(200, { score: 1 });
    if (p.startsWith('/reddit/threads/')) return json(200, getThread());
    return json(404, { detail: 'not found' });
  });
}
export const frames = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0)))));
export const emit = async (page, type, data) => { await page.evaluate(([t, d]) => window.__es.emit(t, d), [type, data]); await frames(page); };
// Anchor position, whether it is still the same DOM node, scrollY and the root order.
const probe = (page, id) => page.evaluate(i => {
  const el = document.getElementById(`c${i}`);
  return { top: el ? el.getBoundingClientRect().top : null, same: !!el && el.__mark === 1, y: window.scrollY,
    roots: [...document.querySelectorAll('#comments > .cm')].map(e => e.id).join(','), n: document.querySelectorAll('#comments .cm').length };
}, id);
const mark = (page, id) => page.evaluate(i => { const el = document.getElementById(`c${i}`); if (el) el.__mark = 1; }, id);
// Puts comment `id` at `y` px from the top of the viewport.
export const placeAt = (page, id, y) => page.evaluate(([i, yy]) => {
  const el = document.getElementById(`c${i}`);
  window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - yy, behavior: 'instant' });
}, [id, y]);

// The events of the repro, in order. Anchor: comment 39 (first child of root 37, the 7th root),
// placed 300 px down the viewport. "above"/"below" are relative to the anchor.
export const ANCHOR = 39;
export const EVENTS = [
  ['vote, no reorder (above)', 'vote', { comment_id: 2, score: 10 }],
  ['new reply above (under comment 8)', 'comment', next(201, 8, 1)],
  ['new reply below (under root 61)', 'comment', next(202, 61, 1)],
  ['new root comment', 'comment', next(203, null, 1)],
  ['vote that would reorder roots (root 67 -> 999)', 'vote', { comment_id: 67, score: 999 }],
  ['vote on a root above (1 -> 3)', 'vote', { comment_id: 1, score: 3 }],
  ['award above (comment 8)', 'award', { comment_id: 8, awards: ['🏅', '😂'] }],
  ['edit above, longer text (comment 9)', 'edit', { comment_id: 9, text: `${text(9)}\n\nEDIT: ${sentence(3, 40)}. ${sentence(5, 30)}.` }],
  ['delete above (comment 14)', 'delete', { comment_id: 14 }],
  ['remove above (comment 15)', 'remove', { comment_id: 15 }],
  ['lock above (comment 19)', 'lock', { comment_id: 19 }],
  ['post event: longer body', 'post', { score: 130, body: `Asking for a friend. ${sentence(1, 60)}. ${sentence(2, 60)}.` }],
  ['status running', 'status', { status: 'running', comment_count: 75 }],
  ['snapshot re-send (+2 new above)', 'snapshot', null],
];

// Runs EVENTS from mid-thread and returns one row per event.
export async function measure(page) {
  await placeAt(page, ANCHOR, 300);
  await frames(page);
  await mark(page, ANCHOR);
  const rows = [];
  for (const [label, type, data0] of EVENTS) {
    let data = data0;
    if (type === 'snapshot') {
      const base = longComments().map(c => (c.id === 2 ? { ...c, score: 10 } : c.id === 67 ? { ...c, score: 999 } : c.id === 1 ? { ...c, score: 3 } : c));
      data = longThread([...base, next(201, 8), next(202, 61), next(203, null), next(204, 7, 1), next(205, 2, 1)]);
    }
    const b = await probe(page, ANCHOR);
    await emit(page, type, data);
    const a = await probe(page, ANCHOR);
    rows.push({ label, type, drift: a.top == null || b.top == null ? null : Math.round((a.top - b.top) * 10) / 10, dy: Math.round(a.y - b.y),
      replaced: !a.same, reordered: a.roots !== b.roots, added: a.n - b.n });
    await mark(page, ANCHOR);
  }
  return rows;
}

export function printRows(title, rows) {
  console.log(`\n${title}`);
  console.log('  drift(px) scrollY(px) anchorNodeReplaced rootsReordered +cm  event');
  for (const r of rows) console.log(`  ${String(r.drift).padStart(8)} ${String(r.dy).padStart(11)} ${String(r.replaced).padStart(18)} ${String(r.reordered).padStart(14)} ${String(r.added).padStart(4)}  ${r.label}`);
}

export async function openLong(browser, BASE, { viewport, colorScheme = 'light', hasTouch = false, isMobile = false, getThread } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme, hasTouch, isMobile, deviceScaleFactor: isMobile ? 2 : 1 });
  await ctx.addInitScript(() => { try { localStorage.setItem('ar:handle', 'guest_0042'); } catch {} });
  const page = await ctx.newPage();
  await mockLong(page, getThread);
  await page.goto(`${BASE}?t=${LONG_ID}&${Q}`);
  await page.waitForFunction(() => window.__es);
  await page.evaluate(t => window.__es.emit('snapshot', t), longThread());
  await page.waitForSelector('#c72');
  await page.evaluate(() => document.fonts.ready);
  // a couple of collapsed subtrees, like a real reader
  for (const id of [26, 50]) await page.locator(`[data-toggle="${id}"]`).click();
  await frames(page);
  return { ctx, page };
}

// ------------------------------------------------------------ assertions (run from smoke.mjs)
const inset = page => page.evaluate(async () => (await import('/agent-reddit/anchor.js')).topInset());
const topOf = (page, sel) => page.evaluate(q => document.querySelector(q)?.getBoundingClientRect().top ?? null, sel);
const near = (a, b, label, tol = 1) => assert.ok(a != null && b != null && Math.abs(a - b) <= tol, `${label}: ${a} vs ${b}`);
const expanded = (page, id) => page.locator(`[data-toggle="${id}"]`).getAttribute('aria-expanded');
const noHScroll = async (page, label) => {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(r.sw <= r.iw, `${label}: horizontal scroll (${r.sw} > ${r.iw})`);
};
const settle = async page => { // smooth scrolls: wait until scrollY stops changing
  let last = null;
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(120); const y = await page.evaluate(() => scrollY); if (y === last) return; last = y; }
};

// Touch via CDP: real touch -> pointer events with pointerType "touch".
async function touch(cdp, type, x, y) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
}
async function longPressAt(page, cdp, sel, { hold = 600, move = 0, scroll = 0, right = false } = {}) {
  const b = await page.locator(sel).first().boundingBox();
  const x = right ? b.x + b.width - 12 : b.x + b.width / 2, y = b.y + b.height / 2;
  await touch(cdp, 'touchStart', x, y);
  if (move) { await page.waitForTimeout(60); await touch(cdp, 'touchMove', x, y + move); }
  if (scroll) { await page.waitForTimeout(60); await page.evaluate(d => window.scrollBy(0, d), scroll); }
  await page.waitForTimeout(hold);
  await touch(cdp, 'touchEnd', x, y);
  await frames(page);
}

export async function scrollSuite({ browser, BASE, check, shots }) {
  mkdirSync(shots, { recursive: true });
  for (const [w, hh, mob, scheme] of [[1440, 900, false, 'light'], [390, 844, true, 'dark']]) {
    const tag = `${w}-${scheme}`;
    const { ctx, page } = await openLong(browser, BASE, { viewport: { width: w, height: hh }, colorScheme: scheme, hasTouch: mob, isMobile: mob });
    const errs = []; page.on('pageerror', e => errs.push(String(e)));
    let rows;
    await check(`calm ${tag}: mid-thread anchor drifts <= 1px for every event type (above and below)`, async () => {
      rows = await measure(page);
      for (const r of rows) assert.ok(r.drift != null && Math.abs(r.drift) <= 1, `${r.label}: drift ${r.drift}px`);
      for (const r of rows) assert.equal(r.replaced, false, `${r.label}: anchor node was re-created`);
    });
    await check(`calm ${tag}: votes never re-sort; live comments wait while reading mid-thread`, async () => {
      for (const r of rows.filter(x => x.type === 'vote')) assert.equal(r.reordered, false, r.label);
      for (const r of rows.filter(x => x.type === 'comment' || x.type === 'snapshot')) assert.equal(r.added, 0, `${r.label} was inserted`);
      assert.equal(await page.locator('#c67').evaluate(el => el.parentElement.id === 'comments' && el.previousElementSibling?.id), 'c61', 'root 67 (999 points) kept its slot');
    });
    await check(`calm ${tag}: pill shows the held count and direction, announced politely`, async () => {
      const pill = page.locator('#live-pill');
      assert.equal(await pill.isVisible(), true);
      assert.equal(await pill.textContent(), '↑ 5 new comments', 'first one lands above (under comment 8 once sorted)');
      assert.equal(await pill.getAttribute('aria-label'), '5 new comments above. Show them');
      await page.waitForFunction(() => document.getElementById('ar-live')?.textContent.includes('5 new comments'));
      assert.equal(await page.locator('#ar-live').getAttribute('aria-live'), 'polite');
      assert.equal(await page.locator('#comments [aria-live]').count(), 0, 'no nested live regions');
      assert.equal(await page.locator('#comment-count').textContent(), '77 comments', 'count still updates live');
      assert.equal(await page.locator('#status-chip').textContent(), 'live');
      const box = await pill.boundingBox();
      assert.ok(box.y >= (await inset(page)) - 1 && box.y < (await inset(page)) + 20, `pill floats just under the sticky bars (${box.y})`);
      await noHScroll(page, `${tag} pill`);
      await page.screenshot({ path: join(shots, `pill-${tag}.png`) });
    });
    await check(`calm ${tag}: pill holds its layout (zero-height slot)`, async () => {
      assert.equal(await page.locator('.live-pill-slot').evaluate(el => el.getBoundingClientRect().height), 0);
    });
    await check(`calm ${tag}: tapping the pill merges, applies the sort and scrolls the first new comment into view`, async () => {
      await page.locator('#live-pill').click();
      await page.locator('#c205').waitFor();
      await settle(page);
      assert.equal(await page.locator('#live-pill').isHidden(), true);
      for (const id of [201, 202, 203, 204, 205]) assert.equal(await page.locator(`#c${id}`).count(), 1, `#c${id}`);
      assert.equal(await page.locator('#comments > .cm').first().getAttribute('id'), 'c67', 'Best order applied on tap');
      const first = await page.evaluate(() => [...document.querySelectorAll('#comments .cm')].find(el => [201, 202, 203, 204, 205].includes(+el.dataset.id)).id);
      assert.equal(first, 'c201', 'first new one in document order (under comment 8)');
      const r = await page.locator(`#${first}`).boundingBox();
      assert.ok(r.y >= (await inset(page)) - 1 && r.y < hh, `first new comment in view (y ${r.y})`);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset?.toggle), '201', 'focus moves to it, not lost');
    });
    await check(`calm ${tag}: collapse and expand keep the toggled comment in place`, async () => {
      await placeAt(page, 37, 250);
      await frames(page);
      const before = await topOf(page, '#c37');
      await page.locator('[data-toggle="37"]').click();
      near(await topOf(page, '#c37'), before, 'collapse');
      assert.equal(await expanded(page, 37), 'false');
      await page.locator('[data-toggle="37"]').click();
      near(await topOf(page, '#c37'), before, 'expand');
      // rail tap while the header is above the visible edge: the row comes down to that edge
      const ins = await inset(page);
      await placeAt(page, 38, ins - 60);
      await frames(page);
      const rail = await page.locator('#c38 > .cm-gutter > .rail').boundingBox();
      await page.mouse.click(rail.x + rail.width / 2, Math.max(rail.y, ins) + 40);
      assert.equal(await expanded(page, 38), 'false');
      near(await topOf(page, '#c38'), ins, 'collapsed row brought to the visible edge');
      await page.locator('[data-toggle="38"]').click();
    });
    await check(`calm ${tag}: opening a reply box does not jump; live edits above keep its text, cursor and the view`, async () => {
      await placeAt(page, 43, 260);
      await frames(page);
      const before = await topOf(page, '#c43');
      await page.locator('#c43 > .cm-main > .cm-actions .reply-btn').click();
      const ta = page.locator('#c43 > .cm-main > .cbox-reply textarea');
      await ta.waitFor();
      near(await topOf(page, '#c43'), before, 'reply box open');
      await ta.type('half a thought');
      await ta.evaluate(el => el.setSelectionRange(4, 4));
      await emit(page, 'edit', { comment_id: 2, text: `${text(2)}\n\n${sentence(4, 50)}.` });
      await emit(page, 'award', { comment_id: 8, awards: ['🏅', '🏅'] });
      await emit(page, 'comment', next(206, 43, 1));
      near(await topOf(page, '#c43'), before, 'after live events');
      assert.equal(await ta.inputValue(), 'half a thought');
      assert.deepEqual(await ta.evaluate(el => [document.activeElement === el, el.selectionStart]), [true, 4]);
      assert.equal(await page.locator('#c206').count(), 0, 'held while the reply box is focused');
      assert.equal(await page.locator('#live-pill').textContent(), '↓ 1 new comment');
      await page.locator('#c43 .cbox-cancel').click();
      await page.locator('#live-pill').click();
      await page.locator('#c206').waitFor();
      await settle(page);
    });
    await check(`calm ${tag}: at the top and idle, comments appear in place with a highlight and nothing visible shifts`, async () => {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await frames(page);
      const title = await topOf(page, '.post-title');
      const firstRoot = await topOf(page, '#c67');
      await emit(page, 'comment', next(207, null, 500)); // Best: right after root 67
      await emit(page, 'comment', next(208, 68, 1));
      assert.equal(await page.locator('#c207.is-new').count(), 1);
      assert.equal(await page.locator('#c208.is-new').count(), 1);
      assert.equal(await page.locator('#live-pill').isHidden(), true);
      assert.equal(await page.evaluate(() => window.scrollY), 0, 'no auto-scroll');
      near(await topOf(page, '.post-title'), title, 'post');
      near(await topOf(page, '#c67'), firstRoot, 'first comment');
      assert.equal(await page.locator('#c67 + #c207').count(), 1, 'slotted in by the sort');
      await page.waitForFunction(() => /New comment by|2 new comments/.test(document.getElementById('ar-live')?.textContent || ''));
    });
    await check(`calm ${tag}: selecting text in the thread buffers new comments`, async () => {
      await page.evaluate(() => { const p = document.querySelector('#c67 > .cm-main > .cm-body p'); const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r); });
      await emit(page, 'comment', next(209, 67, 1));
      assert.equal(await page.locator('#c209').count(), 0);
      assert.equal(await page.locator('#live-pill').isVisible(), true);
      assert.equal(await page.evaluate(() => getSelection().toString().length > 0), true, 'selection survives');
      await page.evaluate(() => getSelection().removeAllRanges());
      await page.locator('#live-pill').click();
      await page.locator('#c209').waitFor();
      await settle(page);
    });
    await check(`calm ${tag}: no horizontal scroll`, () => noHScroll(page, tag));
    assert.deepEqual(errs, [], `${tag} page errors`);
    await ctx.close();
  }

  // the other schemes: pill screenshot + no horizontal scroll
  for (const [w, hh, mob, scheme] of [[1440, 900, false, 'dark'], [390, 844, true, 'light']]) {
    const tag = `${w}-${scheme}`;
    const { ctx, page } = await openLong(browser, BASE, { viewport: { width: w, height: hh }, colorScheme: scheme, hasTouch: mob, isMobile: mob });
    await check(`calm ${tag}: pill + no horizontal scroll`, async () => {
      await placeAt(page, ANCHOR, 300);
      await frames(page);
      await emit(page, 'comment', next(202, 61, 1));
      await emit(page, 'comment', next(210, 62, 1));
      assert.equal(await page.locator('#live-pill').textContent(), '↓ 2 new comments');
      await noHScroll(page, tag);
      await page.screenshot({ path: join(shots, `pill-${tag}.png`) });
    });
    await ctx.close();
  }

  // ---------------- long-press (touch emulation, 390x844)
  for (const scheme of ['light', 'dark']) {
    const tag = `390-${scheme}`;
    const { ctx, page } = await openLong(browser, BASE, { viewport: { width: 390, height: 844 }, colorScheme: scheme, hasTouch: true, isMobile: true });
    const errs = []; page.on('pageerror', e => errs.push(String(e)));
    const cdp = await ctx.newCDPSession(page);
    await placeAt(page, ANCHOR, 300);
    await frames(page);
    await check(`long-press ${tag}: holding a comment body collapses it, with a toast, no selection, no jump`, async () => {
      const before = await topOf(page, `#c${ANCHOR}`);
      await longPressAt(page, cdp, `#c${ANCHOR} > .cm-main > .cm-body`);
      assert.equal(await expanded(page, ANCHOR), 'false');
      assert.equal(await page.evaluate(() => getSelection().isCollapsed), true, 'no text selected');
      assert.equal(await page.locator('#ar-toast').textContent(), 'Collapsed');
      assert.equal(await page.locator('#ar-toast').getAttribute('role'), 'status');
      assert.equal(await page.locator('#ar-toast.is-on').count(), 1);
      near(await topOf(page, `#c${ANCHOR}`), before, 'collapsed in place');
      assert.equal(await page.locator('.cm.is-pressing, .lp-active').count(), 0, 'press state cleared');
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(shots, `longpress-toast-${tag}.png`) });
    });
    await check(`long-press ${tag}: tapping the collapsed row expands it; long-press toggles back too`, async () => {
      await page.waitForTimeout(450);
      // the empty right end of the row (near the [+] button, Chrome's touch adjustment picks the button)
      const b = await page.locator(`#c${ANCHOR} > .cm-main > .cm-head`).boundingBox();
      assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y).className, [b.x + b.width - 12, b.y + b.height / 2]), 'cm-head');
      await page.touchscreen.tap(b.x + b.width - 12, b.y + b.height / 2);
      await frames(page);
      assert.equal(await expanded(page, ANCHOR), 'true');
      await longPressAt(page, cdp, `#c${ANCHOR} > .cm-main > .cm-body`);
      assert.equal(await expanded(page, ANCHOR), 'false');
      await page.waitForTimeout(450);
      await longPressAt(page, cdp, `#c${ANCHOR} > .cm-main > .cm-head`, { right: true });
      assert.equal(await expanded(page, ANCHOR), 'true', 'the click after the long-press is swallowed (no double toggle)');
      await page.waitForFunction(() => document.getElementById('ar-toast').textContent === 'Expanded');
    });
    await check(`long-press ${tag}: moving more than 8px or scrolling cancels`, async () => {
      await page.waitForTimeout(450);
      await longPressAt(page, cdp, `#c${ANCHOR} > .cm-main > .cm-body`, { move: 20 });
      assert.equal(await expanded(page, ANCHOR), 'true', 'move');
      await longPressAt(page, cdp, `#c${ANCHOR} > .cm-main > .cm-body`, { scroll: 40 });
      assert.equal(await expanded(page, ANCHOR), 'true', 'scroll');
      assert.equal(await page.locator('.cm.is-pressing, .lp-active').count(), 0);
    });
    await check(`long-press ${tag}: links, buttons, flairs and vote controls are ignored`, async () => {
      for (const sel of [' > .cm-main > .cm-head .flair', ' > .cm-main > .cm-actions .vote-btn', ' > .cm-main > .cm-actions .act']) {
        await longPressAt(page, cdp, `#c${ANCHOR}${sel}`);
        assert.equal(await expanded(page, ANCHOR), 'true', sel);
      }
    });
    await check(`long-press ${tag}: a quick tap on the body does nothing`, async () => {
      const b = await page.locator(`#c${ANCHOR} > .cm-main > .cm-body`).boundingBox();
      await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
      await frames(page);
      assert.equal(await expanded(page, ANCHOR), 'true');
    });
    await check(`long-press ${tag}: no horizontal scroll`, () => noHScroll(page, `${tag} longpress`));
    assert.deepEqual(errs, [], `${tag} page errors`);
    await ctx.close();
  }
  {
    const { ctx, page } = await openLong(browser, BASE, { viewport: { width: 1440, height: 900 } });
    await check('long-press: a mouse press-and-hold does not collapse (desktop unchanged)', async () => {
      await placeAt(page, ANCHOR, 300);
      const b = await page.locator(`#c${ANCHOR} > .cm-main > .cm-body`).boundingBox();
      await page.mouse.move(b.x + 20, b.y + 6);
      await page.mouse.down();
      await page.waitForTimeout(700);
      await page.mouse.up();
      await frames(page);
      assert.equal(await expanded(page, ANCHOR), 'true');
      await page.locator(`[data-toggle="${ANCHOR}"]`).click();
      assert.equal(await expanded(page, ANCHOR), 'false');
      const row = await page.locator(`#c${ANCHOR} .cm-collapsed-meta`).boundingBox();
      await page.mouse.click(row.x + 4, row.y + row.height / 2);
      assert.equal(await expanded(page, ANCHOR), 'false', 'mouse click on the row is unchanged (button only)');
    });
    await ctx.close();
  }
}

// ------------------------------------------------------------ standalone report
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const PW_DIR = process.env.PW_DIR || '/tmp/ar-pw';
  const PORT = Number(process.env.PORT || 8766);
  const BASE = `http://localhost:${PORT}/agent-reddit/`;
  const { chromium } = await import(pathToFileURL(join(PW_DIR, 'node_modules/playwright/index.mjs')).href);
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: dirname(HERE), stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    await new Promise(r => setTimeout(r, 600));
    for (const [w, hh, mob] of [[1440, 900, false], [390, 844, true]]) {
      const { ctx, page } = await openLong(browser, BASE, { viewport: { width: w, height: hh }, hasTouch: mob, isMobile: mob });
      const errs = []; page.on('pageerror', e => errs.push(String(e)));
      printRows(`${w}x${hh}: anchor #c${ANCHOR} at 300px`, await measure(page));
      if (errs.length) console.log('page errors:', errs);
      await ctx.close();
    }
    if (process.argv.includes('--check')) {
      let n = 0;
      await scrollSuite({ browser, BASE, shots: process.env.SHOTS || '/tmp/ar-shots-v3', check: async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); } });
      console.log(`\nPASS: ${n} checks`);
    }
  } finally { await browser.close(); server.kill(); }
}
