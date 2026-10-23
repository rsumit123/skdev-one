// v3.2 smoke checks: the "⋯" menu on comments and the post (Copy text / Select text).
// Run from smoke.mjs (copySuite) or alone:  PW_DIR=/tmp/ar-pw node agent-reddit/copy.mjs
// Screenshots of the popover (desktop) and the sheet (mobile) go to `shots`
// (default /tmp/ar-shots-copy).
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { LONG_ID, longComments, longThread, mockLong, frames, emit, placeAt } from './scroll.mjs';

const MOCK = 'http://mock.api';
const Q = `api=${encodeURIComponent(MOCK)}`;
const now = new Date().toISOString();

// The long thread plus an AutoMod sticky, a deleted and a removed comment, and one with a
// quote line and two paragraphs.
const QUOTE_TEXT = '> the repo rate is a screensaver\nNot quite, it keeps the rupee steady.\n\nAnd small businesses pay for it.';
const STICKY_TEXT = 'Reminder: every redditor here is an AI model.\n\nKeep it civil.';
const extra = [
  { id: 300, bot_id: null, author_type: 'automod', author_name: 'AutoModerator', parent_id: null, score: 1, stickied: true, kind: 'sticky', text: STICKY_TEXT, created_at: now },
  { id: 301, bot_id: 2, author_type: 'bot', parent_id: null, score: 0, deleted: true, text: '', created_at: now },
  { id: 302, bot_id: 3, author_type: 'bot', parent_id: null, score: 0, removed: true, text: '', created_at: now },
  { id: 303, bot_id: 4, author_type: 'bot', parent_id: null, score: 100, text: QUOTE_TEXT, created_at: now },
];
const fixture = () => longThread([...longComments(), ...extra]);
const C1 = longComments().find(c => c.id === 1).text; // one paragraph
const POLL = { question: 'Will the RBI cut in December?', options: [{ text: 'Yes, 25 bps', votes: 4 }, { text: 'No, another pause', votes: 9 }, { text: 'A hike, surprisingly', votes: 1 }], total: 14 };

async function open(browser, BASE, { viewport, colorScheme, mobile }) {
  const ctx = await browser.newContext({ viewport, colorScheme, hasTouch: mobile, isMobile: mobile, deviceScaleFactor: mobile ? 2 : 1, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.addInitScript(() => { try { localStorage.setItem('ar:handle', 'guest_0042'); } catch {} });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  await mockLong(page, fixture);
  await page.goto(`${BASE}?t=${LONG_ID}&${Q}`);
  await page.waitForFunction(() => window.__es);
  await page.evaluate(t => window.__es.emit('snapshot', t), fixture());
  await page.waitForSelector('#c72');
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, errs };
}

const more = id => `#c${id} > .cm-main > .cm-actions .more-btn`;
const menu = '#more-menu';
const topOf = (page, sel) => page.evaluate(q => document.querySelector(q)?.getBoundingClientRect().top ?? null, sel);
const items = page => page.locator(`${menu} [role="menuitem"]`).evaluateAll(els => els.map(e => e.textContent.trim()));
const focused = page => page.evaluate(() => { const a = document.activeElement; return a?.dataset?.item || a?.dataset?.more || a?.tagName; });
const clip = page => page.evaluate(() => navigator.clipboard.readText());
const setClip = (page, t) => page.evaluate(x => navigator.clipboard.writeText(x), t);
const selText = page => page.evaluate(() => getSelection().toString());
const toastIs = (page, t) => page.waitForFunction(x => { const el = document.getElementById('ar-toast'); return el?.textContent === x && el.classList.contains('is-on'); }, t);
const noHScroll = async (page, label) => {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  assert.ok(r.sw <= r.iw, `${label}: horizontal scroll (${r.sw} > ${r.iw})`);
};
const next = (id, parent_id) => ({ id, bot_id: 2, author_type: 'bot', parent_id, text: `live reply ${id}`, score: 1, created_at: new Date().toISOString() });
// Everything the reader sees stays put: the anchor's top and scrollY.
async function still(page, anchorSel, fn, label) {
  const b = await page.evaluate(q => ({ top: document.querySelector(q).getBoundingClientRect().top, y: scrollY }), anchorSel);
  await fn();
  await frames(page);
  const a = await page.evaluate(q => ({ top: document.querySelector(q).getBoundingClientRect().top, y: scrollY }), anchorSel);
  assert.ok(Math.abs(a.top - b.top) <= 0.5, `${label}: ${anchorSel} moved ${a.top - b.top}px`);
  assert.equal(a.y, b.y, `${label}: scrollY changed`);
}
async function touch(cdp, type, x, y) { await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] }); }
async function swipe(page, cdp, x, y, dy) {
  await touch(cdp, 'touchStart', x, y);
  for (let i = 1; i <= 6; i++) { await page.waitForTimeout(16); await touch(cdp, 'touchMove', x, y + (dy * i) / 6); }
  await touch(cdp, 'touchEnd', x, y + dy);
  await frames(page);
}
// Clicks a menu item once its entrance animation is over (Playwright scrolls the page while
// it waits for a moving element to be stable, which would fail the no-movement checks).
const pick = async (page, id) => { await page.waitForTimeout(180); await page.locator(`${menu} [data-item="${id}"]`).click(); };
const tapSel = async (page, sel) => { const b = await page.locator(sel).boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); await frames(page); };

export async function copySuite({ browser, BASE, check, shots = '/tmp/ar-shots-copy' }) {
  mkdirSync(shots, { recursive: true });

  // ---------------- desktop 1440x900: popover
  for (const scheme of ['light', 'dark']) {
    const tag = `1440-${scheme}`;
    const { ctx, page, errs } = await open(browser, BASE, { viewport: { width: 1440, height: 900 }, colorScheme: scheme, mobile: false });
    await placeAt(page, 7, 260);
    await frames(page);
    if (scheme === 'light') {
      await check(`copy ${tag}: ⋯ on comments, the sticky and the post; none on deleted/removed or collapsed rows`, async () => {
        const b = page.locator(more(1));
        assert.equal(await b.getAttribute('aria-label'), 'More actions');
        assert.equal(await b.getAttribute('aria-haspopup'), 'menu');
        assert.equal(await b.getAttribute('aria-expanded'), 'false');
        assert.equal(await page.locator(more(1)).evaluate(el => el === el.parentElement.lastElementChild), true, 'ends the action row');
        assert.equal(await page.locator('#sticky #c300 > .cm-main > .cm-actions .more-btn').count(), 1, 'AutoMod sticky');
        assert.equal(await page.locator('.post-full .post-actions .more-btn').count(), 1, 'post');
        assert.equal(await page.locator('#post-slot').evaluate(el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())), false, 'no stray text under the post (was "null")');
        assert.equal(await page.locator(`${more(301)}, ${more(302)}`).count(), 0, 'deleted / removed');
        assert.equal(await page.locator('#c301 > .cm-main > .cm-actions').count(), 1, 'their action row is still there');
        await page.locator('[data-toggle="13"]').click();
        assert.equal(await page.locator('#c13 > .cm-main .more-btn').count(), 0, 'collapsed row has no ⋯');
        await page.locator('[data-toggle="13"]').click();
        assert.equal(await page.locator(more(13)).count(), 1);
      });
      await check(`copy ${tag}: click opens an anchored popover without moving the page; Esc closes and focus returns`, async () => {
        await placeAt(page, 7, 260);
        await frames(page);
        await still(page, '#c7', () => page.locator(more(7)).click(), 'open');
        assert.equal(await page.locator(menu).getAttribute('role'), 'menu');
        assert.deepEqual(await items(page), ['Copy text', 'Select text']);
        assert.equal(await page.locator(more(7)).getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator(more(7)).getAttribute('aria-controls'), 'more-menu');
        assert.equal(await focused(page), 'copy', 'first item focused');
        await page.waitForTimeout(200); // entrance animation
        const btn = await page.locator(more(7)).boundingBox();
        const m = await page.locator(menu).boundingBox();
        assert.ok(Math.abs(m.y - (btn.y + btn.height + 4)) <= 1.5 && Math.abs(m.x - btn.x) <= 1.5, `popover under the button (${m.x},${m.y} vs ${btn.x},${btn.y + btn.height})`);
        assert.equal(await page.locator(menu).evaluate(el => el.closest('.thread-card') === null && el.parentElement.parentElement === document.body), true, 'portaled to body');
        await noHScroll(page, `${tag} popover`);
        await page.screenshot({ path: join(shots, `popover-${tag}.png`) });
        await still(page, '#c7', () => page.keyboard.press('Escape'), 'Esc');
        assert.equal(await page.locator(menu).count(), 0);
        assert.equal(await focused(page), 'c7', 'focus back on ⋯');
        assert.equal(await page.locator(more(7)).getAttribute('aria-expanded'), 'false');
      });
      await check(`copy ${tag}: keyboard: Enter opens, arrows wrap, Home/End, Tab closes`, async () => {
        await page.locator(more(7)).focus();
        await page.keyboard.press('Enter');
        assert.equal(await focused(page), 'copy');
        await page.keyboard.press('ArrowDown'); assert.equal(await focused(page), 'select');
        await page.keyboard.press('ArrowDown'); assert.equal(await focused(page), 'copy', 'wraps');
        await page.keyboard.press('ArrowUp'); assert.equal(await focused(page), 'select', 'wraps up');
        await page.keyboard.press('Home'); assert.equal(await focused(page), 'copy');
        await page.keyboard.press('End'); assert.equal(await focused(page), 'select');
        await page.keyboard.press('Tab');
        assert.equal(await page.locator(menu).count(), 0);
        assert.equal(await focused(page), 'c7');
        await page.keyboard.press(' ');
        assert.equal(await page.locator(menu).count(), 1, 'Space opens too');
        await page.keyboard.press('Escape');
      });
      await check(`copy ${tag}: outside click and a second click on ⋯ close it`, async () => {
        await page.locator(more(7)).click();
        await page.locator('#c7 > .cm-main > .cm-body').click();
        assert.equal(await page.locator(menu).count(), 0, 'outside click');
        await page.locator(more(7)).click();
        await page.locator(more(7)).click();
        assert.equal(await page.locator(menu).count(), 0, 'toggle');
        await page.locator(more(7)).click();
        await page.locator(more(1)).click();
        assert.equal(await page.locator(more(1)).getAttribute('aria-expanded'), 'true', 'another ⋯ moves the menu');
        assert.equal(await page.locator(more(7)).getAttribute('aria-expanded'), 'false');
        await page.keyboard.press('Escape');
      });
      await check(`copy ${tag}: Copy text puts the exact stored text on the clipboard (quote line, paragraphs), toast, no movement`, async () => {
        await setClip(page, 'before');
        await placeAt(page, 303, 300);
        await frames(page);
        await page.locator(more(303)).click();
        await still(page, '#c303', () => pick(page, 'copy'), 'copy');
        await toastIs(page, 'Copied');
        assert.equal(await clip(page), QUOTE_TEXT);
        assert.equal(await page.locator('#ar-toast').getAttribute('aria-live'), 'polite');
        assert.equal(await page.locator(menu).count(), 0, 'menu closed');
        assert.equal(await focused(page), 'c303');
        await page.locator('#sticky #c300 .more-btn').click();
        await pick(page, 'copy');
        await page.waitForFunction(t => navigator.clipboard.readText().then(x => x === t), STICKY_TEXT);
      });
      await check(`copy ${tag}: execCommand fallback when navigator.clipboard is missing`, async () => {
        await page.evaluate(() => {
          window.__realClip = navigator.clipboard;
          Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
          const orig = document.execCommand.bind(document);
          window.__copied = [];
          document.execCommand = cmd => { const a = document.activeElement; window.__copied.push([cmd, a?.tagName, a?.value, a?.selectionStart, a?.selectionEnd]); return window.__failCopy ? false : orig(cmd); };
        });
        await placeAt(page, 303, 300);
        await frames(page);
        await page.locator(more(303)).click();
        await still(page, '#c303', () => pick(page, 'copy'), 'fallback copy');
        await toastIs(page, 'Copied');
        const [[cmd, tagName, value, s, e]] = await page.evaluate(() => window.__copied);
        assert.deepEqual([cmd, tagName, value, s, e], ['copy', 'TEXTAREA', QUOTE_TEXT, 0, QUOTE_TEXT.length]);
        assert.equal(await page.locator('.copy-buffer').count(), 0, 'buffer removed');
        assert.equal(await focused(page), 'c303', 'focus restored');
      });
      await check(`copy ${tag}: when copying fails: "Couldn't copy" and the text is selected instead`, async () => {
        await page.evaluate(() => { window.__failCopy = true; });
        await page.locator(more(1)).click();
        await pick(page, 'copy');
        await toastIs(page, 'Couldn\'t copy');
        assert.equal(await selText(page), C1);
        await page.evaluate(() => { getSelection().removeAllRanges(); window.__failCopy = false; Object.defineProperty(navigator, 'clipboard', { value: window.__realClip, configurable: true }); });
      });
      await check(`copy ${tag}: Select text selects the comment body and holds live comments; clearing it releases`, async () => {
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await frames(page);
        await page.locator(more(1)).click();
        await still(page, '#c1', () => pick(page, 'select'), 'select');
        assert.equal(await page.locator(menu).count(), 0);
        assert.equal(await selText(page), C1, 'selection = the comment text');
        assert.equal(await page.evaluate(() => getSelection().getRangeAt(0).commonAncestorContainer === document.querySelector('#c1 > .cm-main > .cm-body')), true, 'range over the body');
        await page.waitForFunction(() => document.getElementById('ar-live').textContent === 'Comment text selected');
        await emit(page, 'comment', next(401, 1));
        assert.equal(await page.locator('#c401').count(), 0, 'held while text is selected');
        assert.equal(await page.locator('#live-pill').isVisible(), true, 'pill');
        await page.locator('.post-title-text').click(); // a click elsewhere clears the selection
        assert.equal(await page.evaluate(() => getSelection().isCollapsed), true, 'selection cleared');
        await page.locator('#live-pill').click();
        await page.locator('#c401').waitFor();
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await frames(page);
        await emit(page, 'comment', next(402, 1));
        assert.equal(await page.locator('#c402').count(), 1, 'shows in place once the selection is gone');
      });
      await check(`copy ${tag}: Space on Select text works; multi-paragraph selection matches what is shown`, async () => {
        await page.locator(more(303)).focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press(' ');
        const [sel, shown] = await page.evaluate(() => [getSelection().toString(), document.querySelector('#c303 > .cm-main > .cm-body').innerText]);
        const norm = s => s.replace(/\s+/g, ' ').trim();
        assert.equal(norm(sel), norm(shown));
        assert.ok(sel.includes('the repo rate is a screensaver') && sel.includes('small businesses'));
        await page.evaluate(() => getSelection().removeAllRanges());
      });
      await check(`copy ${tag}: an open menu holds live comments and stays attached while its comment is patched`, async () => {
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await frames(page);
        await page.locator(more(1)).click();
        await page.evaluate(() => { document.querySelector('#c1 > .cm-main > .cm-actions .more-btn').__old = 1; });
        await emit(page, 'comment', next(403, 1));
        assert.equal(await page.locator('#c403').count(), 0, 'held while the menu is open');
        assert.equal(await page.locator(menu).count(), 1);
        await emit(page, 'vote', { comment_id: 1, score: 77 });
        await emit(page, 'award', { comment_id: 1, awards: ['🏅'] });
        await emit(page, 'edit', { comment_id: 1, text: `${C1}\nEDIT: typo` });
        await emit(page, 'lock', { comment_id: 1 }); // the action row is rebuilt (no Reply now)
        assert.equal(await page.locator('#c1 > .cm-main > .cm-actions .reply-btn').count(), 0);
        assert.equal(await page.evaluate(() => document.querySelector('#c1 > .cm-main > .cm-actions .more-btn').__old), undefined, 'button was rebuilt');
        assert.equal(await page.locator(menu).count(), 1, 'menu still open');
        assert.equal(await page.locator(more(1)).getAttribute('aria-expanded'), 'true');
        await page.waitForTimeout(200);
        const btn = await page.locator(more(1)).boundingBox();
        const m = await page.locator(menu).boundingBox();
        assert.ok(Math.abs(m.y - (btn.y + btn.height + 4)) <= 1.5, 'still attached to the new button');
        await setClip(page, 'before');
        await pick(page, 'copy');
        await page.waitForFunction(t => navigator.clipboard.readText().then(x => x === t), `${C1}\nEDIT: typo`);
        assert.equal(await focused(page), 'c1', 'focus on the rebuilt ⋯');
        await page.locator('#live-pill').click();
        await page.locator('#c403').waitFor();
      });
      await check(`copy ${tag}: deleting the comment closes its open menu`, async () => {
        await placeAt(page, 13, 300);
        await frames(page);
        await page.locator(more(13)).click();
        await emit(page, 'delete', { comment_id: 13 });
        assert.equal(await page.locator(menu).count(), 0);
        assert.equal(await page.locator(more(13)).count(), 0);
      });
      await check(`copy ${tag}: near the bottom of the window the popover opens upwards`, async () => {
        await page.evaluate(q => { const b = document.querySelector(q).getBoundingClientRect(); window.scrollBy({ top: b.bottom - (900 - 40), behavior: 'instant' }); }, more(19));
        await frames(page);
        await page.locator(more(19)).click();
        await page.waitForTimeout(200);
        const btn = await page.locator(more(19)).boundingBox();
        const m = await page.locator(menu).boundingBox();
        assert.ok(m.y + m.height <= btn.y - 2 && m.y + m.height >= btn.y - 6, `above the button (${m.y + m.height} vs ${btn.y})`);
        await page.keyboard.press('Escape');
      });
      await check(`copy ${tag}: post Copy text: title, body and the poll options`, async () => {
        await emit(page, 'post', { poll: POLL });
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await frames(page);
        await page.locator('#poll').waitFor();
        const pb = page.locator('.post-full .post-actions .more-btn');
        await still(page, '.post-title', () => pb.click(), 'post menu');
        assert.deepEqual(await items(page), ['Copy text']);
        await page.waitForTimeout(200);
        await page.screenshot({ path: join(shots, `popover-post-${tag}.png`) });
        await pick(page, 'copy');
        const t = fixture();
        await page.waitForFunction(x => navigator.clipboard.readText().then(c => c === x),
          `${t.title}\n\n${t.body}\n\nA) Yes, 25 bps\nB) No, another pause\nC) A hike, surprisingly`);
        await toastIs(page, 'Copied');
      });
    } else {
      await check(`copy ${tag}: popover screenshot, no horizontal scroll`, async () => {
        await still(page, '#c7', () => page.locator(more(7)).click(), 'open');
        await page.waitForTimeout(200);
        await noHScroll(page, tag);
        await page.screenshot({ path: join(shots, `popover-${tag}.png`) });
        await page.keyboard.press('ArrowDown');
        await page.screenshot({ path: join(shots, `popover-focus-${tag}.png`), clip: { x: 0, y: 0, width: 1440, height: 900 } });
        await page.keyboard.press('Escape');
      });
    }
    assert.deepEqual(errs, [], `${tag} page errors`);
    await ctx.close();
  }

  // ---------------- mobile 390x844 (touch): bottom sheet
  for (const scheme of ['light', 'dark']) {
    const tag = `390-${scheme}`;
    const { ctx, page, errs } = await open(browser, BASE, { viewport: { width: 390, height: 844 }, colorScheme: scheme, mobile: true });
    const cdp = await ctx.newCDPSession(page);
    await placeAt(page, 7, 300);
    await frames(page);
    await check(`copy ${tag}: ⋯ has a 44px touch target without making the action row taller`, async () => {
      const b = await page.locator(more(7)).boundingBox();
      assert.ok(b.height <= 32.5, `button ${b.height}px tall`);
      const hit = await page.evaluate(([x, y, w, hgt]) => [[x + w / 2, y - 5], [x + w / 2, y + hgt + 5], [x - 5, y + hgt / 2], [x + w + 5, y + hgt / 2]]
        .map(([px, py]) => !!document.elementFromPoint(px, py)?.closest('.more-btn')), [b.x, b.y, b.width, b.height]);
      assert.deepEqual(hit, [true, true, true, true], 'hit area reaches 44px');
      const rows = await page.evaluate(() => ['#c7', '#c301', '#c8'].map(q => document.querySelector(`${q} > .cm-main > .cm-actions`).getBoundingClientRect().height));
      assert.equal(rows[0], rows[1], 'row with ⋯ = row without (deleted comment)');
      assert.equal(rows[0], 32);
    });
    await check(`copy ${tag}: tap opens a bottom sheet (48px rows, handle) without moving the page`, async () => {
      await still(page, '#c7', () => tapSel(page, more(7)), 'open sheet');
      await page.locator('.mn-sheet').waitFor();
      assert.deepEqual(await items(page), ['Copy text', 'Select text']);
      await page.waitForTimeout(350); // slide-up animation
      const s = await page.locator(menu).boundingBox();
      assert.ok(Math.abs(s.y + s.height - 844) <= 1 && s.width === 390, `docked to the bottom, full width (${JSON.stringify(s)})`);
      for (const hgt of await page.locator(`${menu} .mn-item`).evaluateAll(els => els.map(e => e.getBoundingClientRect().height))) assert.ok(hgt >= 48, `row ${hgt}`);
      assert.equal(await page.locator('.mn-root .pf-handle').isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('pf-lock')), true);
      await page.waitForTimeout(350);
      await noHScroll(page, `${tag} sheet`);
      await page.screenshot({ path: join(shots, `sheet-${tag}.png`) });
    });
    await check(`copy ${tag}: backdrop tap closes the sheet, nothing moves`, async () => {
      await still(page, '#c7', async () => { await page.touchscreen.tap(195, 120); await frames(page); }, 'backdrop');
      assert.equal(await page.locator(menu).count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('pf-lock')), false);
      assert.equal(await page.locator('#c7 > .cm-main > .cm-head [data-toggle]').getAttribute('aria-expanded'), 'true', 'the tap did not reach the thread');
    });
    await check(`copy ${tag}: swipe down on the sheet closes it; a small drag does not`, async () => {
      await tapSel(page, more(7));
      await page.locator('.mn-sheet').waitFor();
      await page.waitForTimeout(300);
      const s = await page.locator(menu).boundingBox();
      await swipe(page, cdp, 195, s.y + 10, 20);
      assert.equal(await page.locator(menu).count(), 1, 'small drag');
      assert.equal(await page.locator(menu).evaluate(el => el.style.transform), '', 'snaps back');
      await page.waitForTimeout(300); // the snap-back transition
      await still(page, '#c7', () => swipe(page, cdp, 195, s.y + 10, 160), 'swipe');
      assert.equal(await page.locator(menu).count(), 0, 'swiped away');
    });
    await check(`copy ${tag}: Copy text from the sheet`, async () => {
      await setClip(page, 'before');
      await placeAt(page, 303, 300);
      await frames(page);
      await tapSel(page, more(303));
      await page.locator('.mn-sheet').waitFor();
      await page.waitForTimeout(300);
      await tapSel(page, `${menu} [data-item="copy"]`);
      await toastIs(page, 'Copied');
      assert.equal(await clip(page), QUOTE_TEXT);
      assert.equal(await page.locator(menu).count(), 0);
      await page.waitForTimeout(200);
      await page.screenshot({ path: join(shots, `sheet-copied-${tag}.png`) });
    });
    await check(`copy ${tag}: Select text on touch: a real selection that long-press leaves alone and live comments respect`, async () => {
      await placeAt(page, 7, 300);
      await frames(page);
      await tapSel(page, more(7));
      await page.locator('.mn-sheet').waitFor();
      await page.waitForTimeout(300);
      await tapSel(page, `${menu} [data-item="select"]`);
      const t7 = longComments().find(c => c.id === 7).text;
      assert.equal(await selText(page), t7);
      await emit(page, 'comment', next(404, 7));
      assert.equal(await page.locator('#c404').count(), 0, 'held');
      // holding the selected comment does not collapse it (its handles can be dragged)
      const b = await page.locator('#c7 > .cm-main > .cm-body').boundingBox();
      await touch(cdp, 'touchStart', b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(600);
      await touch(cdp, 'touchEnd', b.x + b.width / 2, b.y + b.height / 2);
      await frames(page);
      assert.equal(await page.locator('[data-toggle="7"]').getAttribute('aria-expanded'), 'true', 'not collapsed');
      await page.screenshot({ path: join(shots, `select-${tag}.png`) });
      await page.evaluate(() => getSelection().removeAllRanges());
      await page.locator('#live-pill').click();
      await page.locator('#c404').waitFor();
    });
    await check(`copy ${tag}: long-press on ⋯ does not collapse the comment`, async () => {
      await placeAt(page, 7, 300);
      await frames(page);
      const b = await page.locator(more(7)).boundingBox();
      await touch(cdp, 'touchStart', b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(650);
      await touch(cdp, 'touchEnd', b.x + b.width / 2, b.y + b.height / 2);
      await frames(page);
      assert.equal(await page.locator('[data-toggle="7"]').getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('.cm.is-pressing, .lp-active').count(), 0);
      if (await page.locator(menu).count()) await page.touchscreen.tap(195, 120);
      // long-press elsewhere still works
      const body = await page.locator('#c7 > .cm-main > .cm-body').boundingBox();
      await touch(cdp, 'touchStart', body.x + body.width / 2, body.y + body.height / 2);
      await page.waitForTimeout(600);
      await touch(cdp, 'touchEnd', body.x + body.width / 2, body.y + body.height / 2);
      await frames(page);
      assert.equal(await page.locator('[data-toggle="7"]').getAttribute('aria-expanded'), 'false', 'long-press on the body collapses');
      await page.locator('[data-toggle="7"]').click();
    });
    await check(`copy ${tag}: post sheet + no horizontal scroll`, async () => {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await frames(page);
      await still(page, '.post-title', () => tapSel(page, '.post-full .post-actions .more-btn'), 'post sheet');
      assert.deepEqual(await items(page), ['Copy text']);
      await noHScroll(page, `${tag} post sheet`);
      await page.touchscreen.tap(195, 120);
    });
    assert.deepEqual(errs, [], `${tag} page errors`);
    await ctx.close();
  }
}

// ------------------------------------------------------------ standalone
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const PW_DIR = process.env.PW_DIR || '/tmp/ar-pw';
  const PORT = Number(process.env.PORT || 8767);
  const BASE = `http://localhost:${PORT}/agent-reddit/`;
  const { chromium } = await import(pathToFileURL(join(PW_DIR, 'node_modules/playwright/index.mjs')).href);
  const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: dirname(HERE), stdio: 'ignore' });
  const browser = await chromium.launch();
  let n = 0;
  try {
    await new Promise(r => setTimeout(r, 600));
    await copySuite({ browser, BASE, shots: process.env.SHOTS_COPY || '/tmp/ar-shots-copy', check: async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); } });
    console.log(`\nPASS: ${n} checks`);
  } catch (err) {
    console.error('\nFAIL:', err.message);
    process.exitCode = 1;
  } finally { await browser.close(); server.kill(); }
}
