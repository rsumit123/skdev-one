// v3.3 smoke checks: import a post from a screenshot (POST /reddit/import mocked).
// Run from smoke.mjs (importSuite), alone with SMOKE_ONLY=import:
//   SMOKE_ONLY=import PW_DIR=/tmp/ar-pw node agent-reddit/smoke.mjs
// Screenshots of the import card, the loading state and a filled draft with hints go to
// `shots` (default /tmp/ar-shots-import).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import assert from 'node:assert/strict';

// ------------------------------------------------------------ a real PNG, generated
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
// A "screenshot": white with grey text-like bars and an orange header strip.
export function makePng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h, 255);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 3;
      if (y < h * 0.06) { raw[i] = 255; raw[i + 1] = 69; raw[i + 2] = 0; }
      else if ((y % 40) < 14 && x > w * 0.06 && x < w * (0.5 + ((y * 7) % 40) / 100)) { raw[i] = raw[i + 1] = raw[i + 2] = 90; }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export async function importSuite(T) {
  const { browser, BASE, Q, check, track, mockApi, newCtx, noHScroll, deferred, KEYS, body, THREAD_ID, thread, CARDS, SUB_OF, sse, BASE_COMMENTS, shots } = T;
  mkdirSync(shots, { recursive: true });
  const PNG = makePng(1200, 2600); // tall phone screenshot: must come back <= 1600 px on the long edge
  const SMALL = makePng(300, 200);
  const file = (buffer = PNG, name = 'shot.png', mimeType = 'image/png') => ({ name, mimeType, buffer });

  const D = (post_type, over = {}) => ({
    post_type, sub: SUB_OF[post_type], title: 'Is it worth moving back to Kochi after 10 years in Bengaluru?',
    body: 'Rent is eating half my salary and my parents are getting older.', poll_options: null,
    source_sub: 'r/india', confidence: 'high', notes: null, ...over,
  });
  const ok = d => ({ status: 200, body: { draft: d } });

  // One page, an import hook that answers from a queue (or holds a request until released).
  async function setup(viewport, { colorScheme = 'light', mobile = false } = {}) {
    const ctx = await newCtx({ viewport, colorScheme, ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    const page = await ctx.newPage();
    track(page);
    const q = [];
    const st = await mockApi(page, { importHook: async () => { const next = q.shift(); if (!next) return { status: 502, body: { detail: 'no answer queued' } }; return typeof next === 'function' ? next() : next; } });
    const go = async (r = 'indianews') => { await page.goto(`${BASE}?new=1&r=${r}&${Q}`); await page.waitForSelector('#imp-card'); await page.waitForSelector('#compose-body .field'); };
    const upload = (f = file()) => page.setInputFiles('#imp-file', f);
    const filled = () => page.waitForSelector('#imp-banner');
    const val = sel => page.locator(sel).inputValue();
    const checked = slug => page.getAttribute(`#sub-opt-${slug}`, 'aria-checked');
    return { ctx, page, st, q, go, upload, filled, val, checked };
  }
  const hints = page => page.locator('.check-hint').evaluateAll(es => es.map(e => e.dataset.hint).sort());

  // ---------------- desktop 1440 light: the whole flow
  {
    const { ctx, page, st, q, go, upload, filled, val, checked } = await setup({ width: 1440, height: 900 });

    await check('import: the card sits above "Post to" with one line of copy and a real image file input', async () => {
      await go('indianews');
      const order = await page.evaluate(() => { const a = document.getElementById('imp-card'); const b = document.getElementById('sub-field'); return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING); });
      assert.ok(order, 'import card before the picker');
      assert.equal(await page.locator('#imp-card .imp-h').textContent(), 'Import from screenshot');
      assert.equal(await page.locator('#imp-sub').textContent(), "Got a Reddit screenshot? We'll turn it into a post you can edit");
      assert.equal(await page.getAttribute('#imp-file', 'type'), 'file');
      assert.equal(await page.getAttribute('#imp-file', 'accept'), 'image/*');
      assert.ok(await page.locator('#imp-card .imp-desk').isVisible(), 'desktop says paste or drop');
      assert.ok(await page.locator('#imp-card .ic-camera').count());
      await page.screenshot({ path: join(shots, 'card-1440-light.png') });
    });

    await check('import: loading state, then an ask draft fills the form and switches the sub; nothing is posted', async () => {
      const hold = deferred();
      q.push(async () => { await hold.p; return ok(D('ask')); });
      await upload();
      await page.waitForSelector('#imp-busy');
      assert.equal((await page.locator('#imp-busy .imp-busy-h').textContent()).trim(), 'Reading your screenshot…');
      assert.ok(await page.locator('#imp-busy .imp-sk .sk').count() >= 3, 'skeleton fields');
      assert.ok(await page.locator('#imp-cancel').isVisible());
      await page.waitForSelector('#imp-side img');
      assert.ok(await page.locator('#imp-side img').isVisible(), 'desktop: the screenshot in the side column');
      for (let i = 0; i < 50 && !st.imports.length; i++) await page.waitForTimeout(50);
      assert.equal(await page.locator('#side .tips-card').isVisible(), false, 'tips make room for it');
      await page.screenshot({ path: join(shots, 'loading-1440-light.png') });
      assert.equal(st.imports.length, 1);
      const img = st.imports[0].image;
      assert.match(img, /^data:image\/(png|jpeg);base64,/);
      assert.deepEqual(Object.keys(st.imports[0]), ['image']);
      const dims = await page.evaluate(async src => { const i = new Image(); i.src = src; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, img);
      assert.ok(Math.max(...dims) <= 1600, `downscaled to ${dims}`);
      assert.equal(dims[1], 1600, 'long edge exactly 1600');
      assert.equal(Math.round(dims[0]), Math.round(1200 * 1600 / 2600), 'aspect kept');
      hold.resolve();
      await filled();
      assert.equal(await checked('askindia'), 'true');
      assert.equal(await page.getAttribute('#who-user', 'aria-checked'), 'true');
      assert.equal(await val('#f-title'), D('ask').title);
      assert.equal(await val('#f-body'), D('ask').body);
      assert.equal(await page.locator('#imp-banner-text').textContent(), 'Imported from r/india. Check the text before posting');
      assert.equal(await page.locator('#imp-conf').textContent(), 'High confidence');
      assert.equal(await page.locator('#imp-notes').count(), 0);
      assert.equal(await page.locator('.check-hint').count(), 0, 'high confidence, no notes: no hints');
      assert.equal(new URL(page.url()).searchParams.get('r'), 'askindia');
      await page.waitForTimeout(300);
      assert.equal(st.posts.length, 0, 'an import never posts');
      await noHScroll(page, 'import filled 1440');
    });

    await check('import: posting sends the draft with imported {kind, source_sub} only on tap', async () => {
      await page.locator('#post-btn').click();
      await page.waitForURL(u => new URL(u).searchParams.get('t') === THREAD_ID);
      assert.equal(st.posts.length, 1);
      const b = st.posts[0];
      assert.deepEqual(Object.keys(b), [...KEYS, 'imported']);
      assert.deepEqual(b, { ...body({ post_type: 'ask', author: 'user', title: D('ask').title, body: D('ask').body }), imported: { kind: 'screenshot', source_sub: 'r/india' } });
    });

    await check('import: a draft without source_sub posts imported.source_sub null and says "from a screenshot"', async () => {
      await go('indianews');
      q.push(ok(D('opinion', { title: 'Unpopular opinion: filter coffee is overrated', body: null, source_sub: null })));
      await upload();
      await filled();
      assert.equal(await checked('unpopularindia'), 'true');
      assert.equal(await page.locator('#imp-banner-text').textContent(), 'Imported from a screenshot. Check the text before posting');
      assert.equal(await val('#f-title'), 'Unpopular opinion: filter coffee is overrated');
      assert.equal(await val('#f-body'), '');
      await page.locator('#post-btn').click();
      await page.waitForURL(u => new URL(u).searchParams.get('t') === THREAD_ID);
      assert.deepEqual(st.posts.at(-1).imported, { kind: 'screenshot', source_sub: null });
      assert.equal(st.posts.at(-1).post_type, 'opinion');
      assert.equal(st.posts.at(-1).body, null);
    });

    await check('import: a normal post after an import has no imported key', async () => {
      await go('askindia');
      assert.equal(await page.locator('#imp-banner').count(), 0, 'posting cleared the import');
      await page.fill('#f-title', 'Is Pune better than Bengaluru for a first job?');
      await page.locator('#post-btn').click();
      await page.waitForURL(u => new URL(u).searchParams.get('t') === THREAD_ID);
      assert.deepEqual(Object.keys(st.posts.at(-1)), KEYS);
    });

    await check('import: each type maps into its own form (poll, joke, confession, news, ama)', async () => {
      const cases = [
        ['poll', D('poll', { title: 'Which city has the best street food?', body: 'Asking for a food trip', poll_options: ['Delhi', 'Indore', 'Kolkata', 'Lucknow'] }), 'indiapolls', async () => {
          assert.equal(await val('#f-title'), 'Which city has the best street food?');
          assert.deepEqual(await page.locator('#poll-opts input').evaluateAll(es => es.map(e => e.value)), ['Delhi', 'Indore', 'Kolkata', 'Lucknow']);
          assert.equal(await val('#f-body'), 'Asking for a food trip');
        }],
        ['joke', D('joke', { title: 'Why did the auto driver cross the road?', body: 'He did not. The meter was already running.' }), 'indiajokes', async () => {
          assert.equal(await val('#f-title'), 'Why did the auto driver cross the road?');
          assert.equal(await val('#f-body'), 'He did not. The meter was already running.');
          assert.equal((await page.locator('label[for=f-body] .field-label').textContent()).startsWith('Punchline'), true);
        }],
        ['confession', D('confession', { title: 'Confession: cricket fraud', body: 'I have pretended to understand cricket for 11 years at office lunches.' }), 'indiaconfessions', async () => {
          assert.equal(await val('#f-body'), 'I have pretended to understand cricket for 11 years at office lunches.');
          assert.equal(await val('#f-title'), 'Confession: cricket fraud');
        }],
        ['news', D('news', { title: 'Bengaluru to charge a congestion tax on ORR', body: 'The tax applies from 8 am to 11 am on weekdays.' }), 'indianews', async () => {
          assert.equal(await page.getAttribute('#tab-paste', 'aria-selected'), 'true', 'the paste tab');
          assert.equal(await val('#f-headline'), 'Bengaluru to charge a congestion tax on ORR');
          assert.equal(await val('#f-text'), 'The tax applies from 8 am to 11 am on weekdays.');
          assert.equal(await val('#f-body'), '', 'your take stays empty');
        }],
        ['ama', D('ama', { title: "I'm a nurse on night shifts in Pune. AMA", body: '12 years, three hospitals, a lot of chai.' }), 'indiaama', async () => {
          assert.equal(await val('#f-title'), "I'm a nurse on night shifts in Pune. AMA");
          assert.equal(await val('#f-body'), '12 years, three hospitals, a lot of chai.');
          assert.equal((await page.locator('label[for=f-body] .field-label').textContent()).startsWith('Intro'), true);
        }],
      ];
      for (const [type, d, slug, verify] of cases) {
        await go(type === 'news' ? 'askindia' : 'indianews');
        q.push(ok(d));
        await upload();
        await filled();
        assert.equal(await checked(slug), 'true', `${type}: sub switched`);
        assert.equal(await page.getAttribute('#who-user', 'aria-checked'), 'true', `${type}: I'll write it`);
        await verify();
        const n = st.posts.length;
        await page.locator('#post-btn').click();
        await page.waitForURL(u => new URL(u).searchParams.get('t') === THREAD_ID);
        assert.equal(st.posts.length, n + 1);
        const b = st.posts.at(-1);
        assert.equal(b.post_type, type);
        assert.equal(b.sub, slug);
        assert.deepEqual(b.imported, { kind: 'screenshot', source_sub: 'r/india' });
        if (type === 'news') assert.deepEqual(b.article, { headline: d.title, body: d.body, link: null, source: null });
        if (type === 'poll') assert.deepEqual(b.poll_options, d.poll_options);
        if (type === 'confession') assert.equal(b.body, d.body);
        if (type === 'ama') assert.equal(b.ama_host, null);
      }
    });

    await check('import: a too-short confession keeps the usual validation (and its note gets a hint)', async () => {
      await go('indianews');
      q.push(ok(D('confession', { title: 'Confession: I eat Maggi raw', body: 'Every night.', notes: 'Confessions need at least 20 characters of text' })));
      await upload();
      await filled();
      assert.equal(await page.locator('#imp-notes').textContent(), 'Confessions need at least 20 characters of text');
      assert.deepEqual(await hints(page), ['body']);
      const n = st.posts.length;
      await page.locator('#post-btn').click();
      assert.equal(await page.locator('#err-body').textContent(), 'A bit more, please: at least 20 characters (12 so far).');
      await page.waitForTimeout(150);
      assert.equal(st.posts.length, n, 'validation blocks it');
    });

    await check('import: low confidence + notes: banner shows both, amber "Check this" on title and body until edited', async () => {
      await go('indianews');
      q.push(ok(D('ask', { confidence: 'low', notes: 'Title was cut off at the edge' })));
      await upload();
      await filled();
      assert.equal(await page.locator('#imp-conf').textContent(), 'Low confidence');
      assert.equal(await page.locator('#imp-notes').textContent(), 'Title was cut off at the edge');
      assert.deepEqual(await hints(page), ['body', 'title']);
      assert.ok((await page.locator('label[for=f-title] .field-label').textContent()).includes('Check this'));
      assert.ok(await page.locator('label[for=f-title]').evaluate(e => e.classList.contains('needs-check')));
      await page.screenshot({ path: join(shots, 'filled-hints-1440-light.png') });
      await page.locator('#f-title').fill('Is moving back to Kochi after 10 years worth it?');
      assert.deepEqual(await hints(page), ['body'], 'an edited field is checked');
    });

    await check('import: Re-read keeps the fields the user edited and refreshes the rest', async () => {
      q.push(ok(D('ask', { title: 'A different reading of the title', body: 'A better reading of the body.', confidence: 'high', notes: null })));
      await page.locator('#imp-reread').click();
      await page.waitForSelector('#imp-banner');
      assert.equal(await val('#f-title'), 'Is moving back to Kochi after 10 years worth it?', 'user edit kept');
      assert.equal(await val('#f-body'), 'A better reading of the body.', 'untouched field re-read');
      assert.equal(await page.locator('.check-hint').count(), 0);
      assert.equal(st.imports.length >= 2, true);
      assert.equal(st.imports.at(-1).image, st.imports.at(-2).image, 'the same image again');
    });

    await check('import: typing while it reads is never overwritten by the response', async () => {
      await go('askindia');
      const hold = deferred();
      q.push(async () => { await hold.p; return ok(D('ask')); });
      await upload();
      await page.waitForSelector('#imp-busy');
      await page.fill('#f-title', 'My own title while it reads');
      hold.resolve();
      await filled();
      assert.equal(await val('#f-title'), 'My own title while it reads');
      assert.equal(await val('#f-body'), D('ask').body);
    });

    await check('import: switching sub after an import re-maps the draft without losing text', async () => {
      await go('indianews');
      q.push(ok(D('poll', { title: 'Best street food city?', body: 'Asking for a trip', poll_options: ['Delhi', 'Indore', 'Kolkata'] })));
      await upload();
      await filled();
      await page.locator('#sub-opt-unpopularindia').click();
      assert.equal(await val('#f-title'), 'Best street food city?');
      assert.equal(await val('#f-body'), 'Asking for a trip\n\nA) Delhi\nB) Indore\nC) Kolkata');
      assert.ok(await page.locator('#imp-banner').isVisible(), 'still an import');
      await page.locator('#sub-opt-indiapolls').click();
      assert.deepEqual(await page.locator('#poll-opts input').evaluateAll(es => es.map(e => e.value)), ['Delhi', 'Indore', 'Kolkata']);
      assert.equal(await val('#f-body'), 'Asking for a trip');
      await page.locator('#sub-opt-indianews').click();
      assert.equal(await val('#f-headline'), 'Best street food city?');
      assert.ok((await val('#f-text')).includes('C) Kolkata'));
      await page.locator('#sub-opt-indiaconfessions').click();
      const conf = await val('#f-body');
      assert.ok(conf.includes('Asking for a trip') && conf.includes('A) Delhi'), 'confession keeps the text');
      assert.equal(await val('#f-title'), 'Best street food city?');
    });

    await check('import: Remove import resets the fields, thumbnail and banner; Undo brings them back', async () => {
      await go('askindia');
      q.push(ok(D('joke', { title: 'A pun about paneer', body: 'It was cheesy.' })));
      await upload();
      await filled();
      assert.equal(await checked('indiajokes'), 'true');
      await page.locator('#imp-remove').click();
      assert.equal(await page.locator('#imp-banner').count(), 0);
      assert.equal(await page.locator('#imp-side').count(), 0, 'thumbnail gone');
      assert.ok(await page.locator('#imp-open').isVisible(), 'back to the idle card');
      assert.equal(await checked('askindia'), 'true', 'back to the sub it was on');
      assert.equal(await val('#f-title'), '');
      assert.equal(await val('#f-body'), '');
      assert.ok(await page.locator('#imp-toast').isVisible());
      assert.equal(await page.locator('#imp-toast').textContent(), 'Import removedUndo');
      await page.locator('#imp-undo').click();
      assert.equal(await checked('indiajokes'), 'true');
      assert.equal(await val('#f-title'), 'A pun about paneer');
      assert.ok(await page.locator('#imp-banner').isVisible());
      assert.ok(await page.locator('#imp-side img').isVisible(), 'thumbnail back');
      await page.locator('#imp-remove').click();
      await page.waitForSelector('#imp-toast', { state: 'detached', timeout: 7000 });
    });

    await check('import: Cancel returns to the card and a late response is ignored', async () => {
      await go('askindia');
      await page.fill('#f-title', 'Typed before importing');
      const hold = deferred();
      q.push(async () => { await hold.p; return ok(D('joke', { title: 'Should never appear' })); });
      const n0 = st.imports.length;
      await upload();
      await page.waitForSelector('#imp-busy');
      for (let i = 0; i < 100 && st.imports.length === n0; i++) await page.waitForTimeout(30); // the request is in flight
      await page.locator('#imp-cancel').click();
      assert.ok(await page.locator('#imp-open').isVisible());
      hold.resolve();
      await page.waitForTimeout(300);
      assert.equal(await val('#f-title'), 'Typed before importing');
      assert.equal(await checked('askindia'), 'true');
      assert.equal(await page.locator('#imp-banner').count(), 0);
    });

    await check('import: each server error shows its message inline with Retry, and Retry works', async () => {
      const ERR = [
        [{ status: 413, body: { detail: 'Image too large' } }, 'That image is too big'],
        [{ status: 415, body: { detail: 'Unsupported image' } }, "That doesn't look like an image we can read (PNG, JPEG or WebP)"],
        [{ status: 422, body: { detail: "We couldn't find a Reddit post in that image" } }, "We couldn't find a Reddit post in that image"],
        [{ status: 429, body: { detail: 'Import limit reached. Try again in a bit.' } }, 'Too many imports, try again in a minute'],
        [{ status: 502, body: { detail: "Couldn't read the screenshot right now, try again" } }, "Couldn't read the screenshot right now, try again"],
        ['abort', "Couldn't read the screenshot right now, try again"],
      ];
      await go('askindia');
      q.length = 0;
      for (const [resp, msg] of ERR) {
        q.push(resp);
        if (await page.locator('#imp-retry').count()) await page.locator('#imp-retry').click(); else await upload();
        await page.waitForSelector('#imp-err', { timeout: 8000 }).catch(async e => { throw new Error(`${msg}: no error shown (${e.message.split('\n')[0]}) imports=${st.imports.length} q=${q.length} card=${await page.locator('#imp-card').evaluate(x => x.className + ' | ' + x.textContent).catch(() => '?')}`); });
        assert.equal(await page.locator('#imp-err-msg').textContent(), msg);
        assert.ok(await page.locator('#imp-retry').isVisible(), `${msg}: Retry`);
        assert.equal(await page.locator('#imp-banner').count(), 0);
        if (resp.status === 422) await page.screenshot({ path: join(shots, 'error-422-1440-light.png') });
      }
      const n = st.imports.length;
      q.push(ok(D('ask')));
      await page.locator('#imp-retry').click();
      await filled();
      assert.equal(st.imports.length, n + 1);
      assert.equal(await page.locator('#imp-err').count(), 0);
      assert.equal(await val('#f-title'), D('ask').title);
    });

    await check('import: non-images and files over 15 MB are refused before any request', async () => {
      await go('askindia');
      const n = st.imports.length;
      await page.setInputFiles('#imp-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
      assert.equal(await page.locator('#imp-err-msg').textContent(), "That doesn't look like an image we can read (PNG, JPEG or WebP)");
      assert.equal(await page.locator('#imp-retry').count(), 0, 'nothing to retry');
      assert.ok(await page.locator('#imp-another').isVisible());
      await page.setInputFiles('#imp-file', { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(15 * 1024 * 1024 + 10) });
      assert.ok((await page.locator('#imp-err-msg').textContent()).startsWith('That image is too big'));
      await page.setInputFiles('#imp-file', { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not really a png') });
      await page.waitForFunction(() => document.getElementById('imp-err-msg')?.textContent.startsWith("That doesn't look like"));
      assert.equal(st.imports.length, n, 'no request sent');
      await page.locator('#imp-dismiss').click();
      assert.ok(await page.locator('#imp-open').isVisible());
    });

    await check('import: pasting an image imports it; a text paste into a field stays a text paste', async () => {
      await go('askindia');
      q.push(ok(D('ask', { title: 'Pasted screenshot title' })));
      const paste = (focusSel, withText) => page.evaluate(async ([sel, txt, bytes]) => {
        if (sel) document.querySelector(sel).focus(); else document.activeElement?.blur();
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(bytes)], 'clip.png', { type: 'image/png' }));
        if (txt) dt.setData('text/plain', txt);
        const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        (document.activeElement || document.body).dispatchEvent(ev);
        return ev.defaultPrevented;
      }, [focusSel, withText, [...SMALL]]);
      const n = st.imports.length;
      assert.equal(await paste('#f-title', 'some copied words'), false, 'text + image into a text field: the text paste goes ahead');
      await page.waitForTimeout(200);
      assert.equal(st.imports.length, n);
      assert.equal(await paste(null, null), true, 'image paste outside a field is taken');
      await filled();
      assert.equal(await val('#f-title'), 'Pasted screenshot title');
      await go('askindia');
      q.push(ok(D('ask', { title: 'Pasted into the title field' })));
      assert.equal(await paste('#f-title', null), true, 'an image-only clipboard still imports from a field');
      await filled();
      assert.equal(await val('#f-title'), 'Pasted into the title field');
    });

    await check('import: drag and drop highlights the card and imports the dropped image', async () => {
      await go('askindia');
      q.push(ok(D('ama', { title: 'Dropped AMA title' })));
      await page.evaluate(bytes => {
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array(bytes)], 'drop.png', { type: 'image/png' }));
        window.__dt = dt;
        const card = document.getElementById('imp-card');
        card.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
        card.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      }, [...SMALL]);
      assert.ok(await page.locator('#imp-card').evaluate(e => e.classList.contains('is-drop')), 'drop target highlighted');
      assert.ok(await page.locator('#imp-card .imp-drop-msg').isVisible());
      await page.screenshot({ path: join(shots, 'drop-1440-light.png') });
      const prevented = await page.evaluate(() => {
        const ev = new DragEvent('drop', { dataTransfer: window.__dt, bubbles: true, cancelable: true });
        document.getElementById('compose-body').dispatchEvent(ev);
        return ev.defaultPrevented;
      });
      assert.equal(prevented, true, 'the browser never opens the file');
      await filled();
      assert.equal(await checked('indiaama'), 'true');
      assert.equal(await val('#f-title'), 'Dropped AMA title');
      assert.equal(await page.locator('#imp-card').evaluate(e => e.classList.contains('is-drop')), false);
    });

    await check('import: the image is never stored, and its object URL is revoked on leaving', async () => {
      const src = await page.locator('#imp-side img').getAttribute('src');
      assert.match(src, /^blob:/);
      assert.equal(await page.evaluate(async u => { try { await (await fetch(u)).blob(); return true; } catch { return false; } }, src), true);
      const stored = await page.evaluate(async () => ({
        ls: Object.keys(localStorage).map(k => localStorage.getItem(k)).filter(v => /data:image|blob:/.test(v || '')).length,
        ss: Object.keys(sessionStorage).length,
        idb: (await indexedDB.databases?.() || []).length,
      }));
      assert.deepEqual(stored, { ls: 0, ss: 0, idb: 0 });
      await page.locator('#compose-close, .foot-cancel').last().click();
      await page.waitForSelector('.home-sec, .feed-empty, main .tcard', { timeout: 5000 }).catch(() => {});
      assert.equal(await page.evaluate(async u => { try { await (await fetch(u)).blob(); return true; } catch { return false; } }, src), false, 'revoked');
    });

    await check('import: no horizontal scroll on desktop', async () => {
      await go('askindia');
      q.push(ok(D('poll', { poll_options: ['A long option that says quite a lot about the thing', 'B'], confidence: 'low', notes: 'Second option was blurry and the title was cut off' })));
      await upload();
      await filled();
      await noHScroll(page, 'import 1440');
    });
    await ctx.close();
  }

  // ---------------- thread line + card badge
  {
    const ctx = await newCtx({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
    const page = await ctx.newPage();
    track(page);
    const base = { ...thread('done', BASE_COMMENTS.slice(0, 4)), post_type: 'ask', sub: 'askindia', article: null, link: null, source: null, op: { type: 'user', name: 'priya_k' },
      title: 'Is it worth moving back to Kochi after 10 years in Bengaluru?', headline: null };
    let T = { ...base, imported: { kind: 'screenshot', source_sub: 'r/india' } };
    const cards = CARDS.map((c, i) => (i === 1 ? { ...c, imported: { kind: 'screenshot', source_sub: 'r/india' } } : i === 6 ? { ...c, imported: { kind: 'screenshot', source_sub: null } } : { ...c, imported: null }));
    await mockApi(page, { cards, threadGet: () => ({ status: 200, body: T }), streams: [() => ({ body: sse([['snapshot', T], ['status', { status: 'done', comment_count: 4 }]]) })] });
    await check('import: thread shows "📷 Imported from a screenshot of r/india" under the post', async () => {
      await page.goto(`${BASE}?t=${THREAD_ID}&${Q}`);
      await page.waitForSelector('#post-imported');
      assert.equal(await page.locator('#post-imported').textContent(), '📷Imported from a screenshot of r/india');
      assert.ok(await page.locator('.post-full #post-imported').isVisible());
      await page.screenshot({ path: join(shots, 'thread-line-1440-light.png') });
    });
    await check('import: "of a Reddit post" when source_sub is null; nothing for a normal post', async () => {
      T = { ...base, imported: { kind: 'screenshot', source_sub: null } };
      await page.goto(`${BASE}?t=${THREAD_ID}&${Q}`);
      await page.waitForSelector('#post-imported');
      assert.equal(await page.locator('#post-imported').textContent(), '📷Imported from a screenshot of a Reddit post');
      T = { ...base, imported: null };
      await page.goto(`${BASE}?t=${THREAD_ID}&${Q}`);
      await page.waitForSelector('.post-full .post-title');
      await page.waitForTimeout(200);
      assert.equal(await page.locator('#post-imported').count(), 0);
    });
    await check('import: cards show a labelled camera icon only on imported posts', async () => {
      await page.goto(`${BASE}?${Q}`);
      await page.waitForSelector('.home-sec .tcard');
      const card1 = page.locator('.tcard[data-id="t001"]');
      await card1.waitFor();
      assert.equal(await card1.locator('.imp-badge').getAttribute('aria-label'), 'Imported from a screenshot of r/india');
      assert.equal(await card1.locator('.imp-badge').getAttribute('role'), 'img');
      const flairThenBadge = await card1.locator('.post-meta').evaluate(m => { const f = m.querySelector('.flair'); const b = m.querySelector('.imp-badge'); return !!f && f.nextElementSibling === b; });
      assert.ok(flairThenBadge, 'right after the flair');
      const others = await page.locator('.tcard:not([data-id="t001"]):not([data-id="t006"]) .imp-badge').count();
      assert.equal(others, 0);
      await page.goto(`${BASE}?r=askindia&${Q}`);
      await page.waitForSelector('.tcard[data-id="t006"]');
      assert.equal(await page.locator('.tcard[data-id="t006"] .imp-badge').getAttribute('aria-label'), 'Imported from a screenshot of a Reddit post', 'sub page too');
      await page.locator('.tcard[data-id="t006"]').screenshot({ path: join(shots, 'card-badge-1440-light.png') });
    });
    await ctx.close();
  }

  // ---------------- phone 390x844 + desktop, light + dark: thumbnail, zoom viewer, screenshots
  for (const [vw, vh, scheme, mobile] of [[390, 844, 'light', true], [390, 844, 'dark', true], [1440, 900, 'dark', false]]) {
    const tag = `${vw}-${scheme}`;
    const { ctx, page, q, go, upload, filled } = await setup({ width: vw, height: vh }, { colorScheme: scheme, mobile });
    await check(`import ${tag}: card, loading, filled draft with hints; no horizontal scroll`, async () => {
      await go('indianews');
      if (mobile) assert.equal(await page.locator('#imp-card .imp-desk').isVisible(), false, 'no paste/drop hint on touch');
      await page.screenshot({ path: join(shots, `card-${tag}.png`) });
      await noHScroll(page, `card ${tag}`);
      const hold = deferred();
      q.push(async () => { await hold.p; return ok(D('poll', { title: 'Which city has the best street food?', body: null, poll_options: ['Delhi', 'Indore', 'Kolkata'], confidence: 'low', notes: 'Third option was hard to read' })); });
      await upload();
      await page.waitForSelector('#imp-busy');
      await page.waitForFunction(() => document.querySelector('#imp-card .imp-thumb img, #imp-side img')?.complete);
      await page.screenshot({ path: join(shots, `loading-${tag}.png`) });
      hold.resolve();
      await filled();
      assert.deepEqual(await hints(page), ['options', 'title'], 'the empty context is not flagged');
      await noHScroll(page, `filled ${tag}`);
      await page.screenshot({ path: join(shots, `filled-hints-${tag}.png`) });
      await page.screenshot({ path: join(shots, `filled-hints-${tag}-full.png`), fullPage: true });
      if (mobile) {
        assert.ok(await page.locator('#imp-card .imp-thumb-inline').isVisible(), 'phone: thumbnail in the card');
        assert.equal(await page.locator('#imp-side').isVisible(), false);
      } else {
        assert.equal(await page.locator('#imp-card .imp-thumb-inline').isVisible(), false);
        assert.ok(await page.locator('#imp-side').isVisible(), 'desktop: side by side');
        const pos = await page.locator('#imp-side').evaluate(e => getComputedStyle(e).position);
        assert.equal(pos, 'sticky');
      }
    });
    if (mobile) {
      await check(`import ${tag}: tap the thumbnail for a full-screen viewer; Close and Esc close it`, async () => {
        await page.locator('#imp-card .imp-thumb-inline').tap();
        await page.waitForSelector('#imp-viewer');
        const box = await page.locator('#imp-viewer').boundingBox();
        assert.deepEqual([box.width, box.height], [390, 844], 'full screen');
        assert.ok(await page.locator('#imp-viewer-close').isVisible());
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'imp-viewer-close');
        await page.screenshot({ path: join(shots, `viewer-${tag}.png`) });
        await page.locator('#imp-viewer-close').tap();
        assert.equal(await page.locator('#imp-viewer').count(), 0);
        await page.locator('#imp-card .imp-thumb-inline').tap();
        await page.waitForSelector('#imp-viewer');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#imp-viewer').count(), 0);
        await noHScroll(page, `viewer closed ${tag}`);
      });
    }
    await ctx.close();
  }
}
