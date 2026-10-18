import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTree, sortTree, countDescendants, hiddenCount, isLocked, relTime,
  upsertComment, applyVote, formatScore, providerColor, avatarSeed,
  mergeItems, nextOffset, paperSource, paperDate,
  botStats, ancestorIds, profileLine, preview,
  POST_TYPES, typeInfo, timeAgo, isLive, safeHttpUrl, validHandle, guestHandle,
  nextVote, scoreAfterVote, pollSummary, splitSticky, articleOf, validateCreate, buildCreateBody,
} from './tree.js';

const c = (id, parent_id, score = 1, extra = {}) => ({
  id, bot_id: 1, parent_id, root_id: id, depth: parent_id ? 1 : 0,
  text: 't' + id, score, created_at: '2026-10-17T10:00:00Z', ...extra,
});
const sample = () => [c(1, null, 5), c(2, 1, 3), c(3, 2, 1), c(4, null, 9), c(5, 1, 7)];

test('buildTree nests children and keeps roots', () => {
  const roots = buildTree(sample());
  assert.deepEqual(roots.map(r => r.id), [1, 4]);
  assert.deepEqual(roots[0].children.map(r => r.id), [2, 5]);
  assert.equal(roots[0].children[0].children[0].id, 3);
  assert.deepEqual(roots[1].children, []);
});

test('buildTree is order-independent and treats orphans as roots', () => {
  const roots = buildTree([c(3, 2), c(2, 1), c(1, null), c(9, 77)]);
  assert.deepEqual(roots.map(r => r.id).sort(), [1, 9]);
  assert.equal(roots.find(r => r.id === 1).children[0].children[0].id, 3);
});

test('buildTree does not mutate input', () => {
  const input = sample();
  const copy = JSON.parse(JSON.stringify(input));
  buildTree(input);
  assert.deepEqual(input, copy);
  assert.ok(!('children' in input[0]));
});

test('sortTree top: score desc, recursive', () => {
  const sorted = sortTree(buildTree(sample()), 'top');
  assert.deepEqual(sorted.map(r => r.id), [4, 1]);
  assert.deepEqual(sorted[1].children.map(r => r.id), [5, 2]);
});

test('sortTree new: id desc', () => {
  const sorted = sortTree(buildTree(sample()), 'new');
  assert.deepEqual(sorted.map(r => r.id), [4, 1]);
  assert.deepEqual(sorted[1].children.map(r => r.id), [5, 2]);
});

test('sortTree best: score then recency; tie broken by controversy then id', () => {
  const roots = buildTree([c(1, null, 4), c(2, null, 4), c(3, null, 8)]);
  assert.deepEqual(sortTree(roots, 'best').map(r => r.id), [3, 2, 1]);
  // equal score: the one with more replies wins over the newer one
  const r2 = buildTree([c(1, null, 4), c(2, null, 4), c(3, 1, 1)]);
  assert.deepEqual(sortTree(r2, 'best').map(r => r.id), [1, 2]);
});

test('sortTree controversial: replies plus near-zero score rank first', () => {
  const roots = buildTree([c(1, null, 50), c(2, null, 0), c(3, null, 1), c(4, 3, 1), c(5, 3, 1)]);
  const order = sortTree(roots, 'controversial').map(r => r.id);
  assert.equal(order[0], 3);
  assert.equal(order[order.length - 1], 1);
});

test('sortTree does not mutate input and unknown mode falls back to best', () => {
  const roots = buildTree(sample());
  const snap = JSON.stringify(roots);
  const a = sortTree(roots, 'top');
  assert.equal(JSON.stringify(roots), snap);
  assert.notEqual(a, roots);
  assert.deepEqual(sortTree(roots, 'bogus').map(r => r.id), sortTree(roots, 'best').map(r => r.id));
});

test('countDescendants / hiddenCount', () => {
  const [root] = buildTree(sample());
  assert.equal(countDescendants(root), 3);
  assert.equal(hiddenCount(root), 3);
  assert.equal(hiddenCount(root.children[0]), 1);
  assert.equal(hiddenCount(root.children[0].children[0]), 0);
});

test('isLocked when total comment count reaches the limit', () => {
  const [r1, r4] = buildTree(sample());
  assert.equal(isLocked([r1, r4], 5), true);
  assert.equal(isLocked([r1, r4], 6), false);
  assert.equal(isLocked(r4, 1), true);
  assert.equal(isLocked(r1, 5), false); // subtree of 4 nodes
  assert.equal(isLocked([], 5), false);
});

test('relTime', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  assert.equal(relTime('2026-10-17T11:59:40Z', now), 'just now');
  assert.equal(relTime('2026-10-17T11:55:00Z', now), '5m');
  assert.equal(relTime('2026-10-17T10:00:00Z', now), '2h');
  assert.equal(relTime('2026-10-14T12:00:00Z', now), '3d');
  assert.equal(relTime('2026-10-17T12:05:00Z', now), 'just now'); // future
  assert.equal(relTime(null, now), '');
  assert.equal(relTime('garbage', now), '');
});

test('upsertComment adds, replaces, does not mutate', () => {
  const list = [c(1, null, 1)];
  const added = upsertComment(list, c(2, 1));
  assert.equal(list.length, 1);
  assert.equal(added.length, 2);
  const replaced = upsertComment(added, c(2, 1, 9));
  assert.equal(replaced.length, 2);
  assert.equal(replaced[1].score, 9);
  assert.equal(added[1].score, 1);
});

test('applyVote updates score immutably; unknown id is a no-op', () => {
  const list = [c(1, null, 1), c(2, 1, 1)];
  const out = applyVote(list, { comment_id: 2, score: 6 });
  assert.equal(out[1].score, 6);
  assert.equal(list[1].score, 1);
  assert.equal(out[0], list[0]);
  assert.deepEqual(applyVote(list, { comment_id: 99, score: 3 }), list);
});

test('formatScore', () => {
  assert.equal(formatScore(0), '0');
  assert.equal(formatScore(999), '999');
  assert.equal(formatScore(1234), '1.2k');
  assert.equal(formatScore(1000), '1k');
  assert.equal(formatScore(15600), '15.6k');
  assert.equal(formatScore(-1500), '-1.5k');
  assert.equal(formatScore(-7), '-7');
});

test('providerColor is stable hex per provider, case-insensitive', () => {
  const a = providerColor('anthropic');
  assert.match(a, /^#[0-9a-f]{6}$/i);
  assert.equal(providerColor('Anthropic'), a);
  assert.notEqual(providerColor('openai'), a);
  assert.match(providerColor('some-new-provider'), /^#[0-9a-f]{6}$/i);
  assert.equal(providerColor('some-new-provider'), providerColor('some-new-provider'));
  assert.match(providerColor(undefined), /^#[0-9a-f]{6}$/i);
});

test('avatarSeed deterministic', () => {
  const a = avatarSeed('snarky_panda');
  assert.deepEqual(a, avatarSeed('snarky_panda'));
  assert.ok(a.hue >= 0 && a.hue < 360 && Number.isInteger(a.hue));
  assert.ok(Number.isInteger(a.pattern) && a.pattern >= 0 && a.pattern < 8);
  assert.notDeepEqual(a, avatarSeed('quiet_owl'));
});

test('mergeItems appends new ids only, keeps order, does not mutate', () => {
  const a = [{ id: 'a' }, { id: 'b' }];
  const frozen = JSON.stringify(a);
  const { items, added } = mergeItems(a, [{ id: 'b', title: 'dup' }, { id: 'c' }, null, { title: 'no id' }, { id: 'c' }, { id: 'd' }]);
  assert.deepEqual(items.map(i => i.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(added.map(i => i.id), ['c', 'd']);
  assert.equal(items[1].title, undefined, 'existing item wins over a duplicate');
  assert.equal(JSON.stringify(a), frozen);
  assert.deepEqual(mergeItems([], undefined), { items: [], added: [] });
  assert.deepEqual(mergeItems(null, [{ id: 1 }]).items, [{ id: 1 }]);
});

test('nextOffset only moves forward', () => {
  assert.equal(nextOffset(12, 0), 12);
  assert.equal(nextOffset(24, 12), 24);
  assert.equal(nextOffset(null, 12), null);
  assert.equal(nextOffset(undefined, 0), null);
  assert.equal(nextOffset(12, 12), null);
  assert.equal(nextOffset(5, 12), null);
  assert.equal(nextOffset('24', 12), null);
  assert.equal(nextOffset(12.5, 0), null);
});

test('paperSource formats print page and caps at 80 chars', () => {
  assert.equal(paperSource({ source: 'The Indian Express', page: 2 }), 'The Indian Express (print, p. 2)');
  assert.equal(paperSource({ source: 'The Indian Express' }), 'The Indian Express (print)');
  assert.equal(paperSource({}), 'The Indian Express (print)');
  assert.equal(paperSource({ source: 'The Indian Express', page: 0 }), 'The Indian Express (print)');
  const long = paperSource({ source: 'X'.repeat(200), page: 14 });
  assert.equal(long.length, 80);
  assert.ok(long.endsWith(' (print, p. 14)'));
});

test('paperDate: today, yesterday, short date, timestamps', () => {
  const now = new Date(2026, 9, 17, 15, 30).getTime();
  assert.equal(paperDate('2026-10-17', now), 'today');
  assert.equal(paperDate('2026-10-16', now), 'yesterday');
  assert.equal(paperDate('2026-10-03', now), '3 Oct');
  assert.equal(paperDate('2025-12-31', now), '31 Dec 2025');
  assert.equal(paperDate(new Date(now - 2 * 3600e3).toISOString(), now), '2h');
  assert.equal(paperDate(null, now), '');
});

test('botStats: count, karma, replies from others, top, first, recent', () => {
  const at = m => `2026-10-17T10:${String(m).padStart(2, '0')}:00Z`;
  const cs = [
    { id: 1, bot_id: 1, parent_id: null, score: 12, created_at: at(5) },
    { id: 2, bot_id: 2, parent_id: 1, score: 3, created_at: at(6) },
    { id: 3, bot_id: 1, parent_id: 2, score: 12, created_at: at(7) },
    { id: 4, bot_id: 1, parent_id: 3, score: -4, created_at: at(8) }, // self-reply: not a reply received
    { id: 5, bot_id: 3, parent_id: 3, score: 1, created_at: at(9) },
    { id: 6, bot_id: 3, parent_id: 4, score: 1, created_at: at(10) },
  ];
  const frozen = JSON.stringify(cs);
  const s = botStats(cs, 1);
  assert.equal(s.count, 3);
  assert.equal(s.karma, 20);
  assert.equal(s.replies, 3);
  assert.equal(s.top.id, 1, 'ties go to the earlier comment');
  assert.equal(s.first, at(5));
  assert.deepEqual(s.recent.map(c => c.id), [4, 3, 1]);
  assert.equal(JSON.stringify(cs), frozen);
  const none = botStats(cs, 99);
  assert.deepEqual(none, { count: 0, karma: 0, replies: 0, top: null, first: null, recent: [] });
  assert.equal(botStats(undefined, 1).count, 0);
  const many = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, bot_id: 7, parent_id: null, score: 0, created_at: at(i) }));
  assert.deepEqual(botStats(many, 7).recent.map(c => c.id), [8, 7, 6, 5, 4]);
});

test('ancestorIds walks to the root and survives cycles', () => {
  const cs = [{ id: 1, parent_id: null }, { id: 2, parent_id: 1 }, { id: 3, parent_id: 2 }, { id: 9, parent_id: 10 }, { id: 10, parent_id: 9 }];
  assert.deepEqual(ancestorIds(cs, 3), [2, 1]);
  assert.deepEqual(ancestorIds(cs, 1), []);
  assert.deepEqual(ancestorIds(cs, 42), []);
  assert.deepEqual(ancestorIds(cs, 9), [10]);
});

test('profileLine skips missing parts', () => {
  assert.equal(profileLine({ occupation: 'plumber', age: 34, city: 'Pune' }), 'plumber · 34 · Pune');
  assert.equal(profileLine({ occupation: ' plumber ', age: null, city: 'Pune' }), 'plumber · Pune');
  assert.equal(profileLine({ age: 61 }), '61');
  assert.equal(profileLine({ age: '34', city: '' }), '');
  assert.equal(profileLine(undefined), '');
});

test('preview collapses whitespace and cuts on a word boundary', () => {
  assert.equal(preview('short\n\n text'), 'short text');
  const long = 'word '.repeat(60);
  const p = preview(long, 140);
  assert.ok(p.length <= 140 && p.endsWith('…') && !p.includes('  '));
  assert.equal(preview('x'.repeat(200), 10), 'xxxxxxxxx…');
  assert.equal(preview(null), '');
});

// ---------------------------------------------------------------- v2

const KEYS = ['post_type', 'author', 'title', 'body', 'idea', 'article', 'poll_options', 'ama_host', 'user_name', 'bots', 'thread_limit', 'max_comments'];
const base = (extra = {}) => ({
  type: 'news', author: 'bot', source: 'paper', picked: null, paste: { headline: '', link: '', text: '' },
  title: '', body: '', idea: '', options: ['', ''], amaHost: null, handle: 'guest_0042',
  crowd: 'medium', length: 'normal', limit: 6, ...extra,
});
const ART = { headline: 'RBI holds rates', body: 'Full text', link: null, source: 'The Indian Express (print, p. 2)' };

test('typeInfo labels and fallback', () => {
  assert.equal(typeInfo('opinion').label, 'Unpopular opinion');
  assert.equal(typeInfo('ama').label, 'AMA');
  assert.equal(typeInfo('bogus'), POST_TYPES.news);
  assert.deepEqual(Object.keys(POST_TYPES), ['news', 'ask', 'opinion', 'poll', 'ama']);
});

test('timeAgo long labels', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const at = s => new Date(now - s * 1000).toISOString();
  assert.equal(timeAgo(at(5), now), 'just now');
  assert.equal(timeAgo(at(60), now), '1 minute ago');
  assert.equal(timeAgo(at(150), now), '2 minutes ago');
  assert.equal(timeAgo(at(3600 * 3), now), '3 hours ago');
  assert.equal(timeAgo(at(86400), now), '1 day ago');
  assert.equal(timeAgo(at(86400 * 65), now), '2 months ago');
  assert.equal(timeAgo(at(86400 * 800), now), '2 years ago');
  assert.equal(timeAgo(at(-30), now), 'just now');
  assert.equal(timeAgo(null, now), '');
  assert.equal(timeAgo('nope', now), '');
});

test('isLive and safeHttpUrl', () => {
  assert.ok(isLive('casting') && isLive('running'));
  assert.ok(!isLive('done') && !isLive('error') && !isLive(undefined));
  assert.equal(safeHttpUrl('https://x.com/a'), 'https://x.com/a');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('x.com'), null);
});

test('handles: validation and guest default', () => {
  assert.ok(validHandle('guest_0042') && validHandle('abc') && validHandle('A'.repeat(20)));
  assert.ok(!validHandle('ab') && !validHandle('A'.repeat(21)) && !validHandle('has space') && !validHandle('dash-y') && !validHandle(null));
  assert.equal(guestHandle(() => 0.0042), 'guest_0042');
  assert.equal(guestHandle(() => 0.99999), 'guest_9999');
  assert.match(guestHandle(), /^guest_\d{4}$/);
});

test('nextVote toggles and scoreAfterVote adjusts', () => {
  assert.equal(nextVote(0, 1), 1);
  assert.equal(nextVote(1, 1), 0);
  assert.equal(nextVote(1, -1), -1);
  assert.equal(nextVote(-1, -1), 0);
  assert.equal(scoreAfterVote(10, 0, 1), 11);
  assert.equal(scoreAfterVote(10, 1, -1), 8);
  assert.equal(scoreAfterVote(10, -1, 0), 11);
  assert.equal(scoreAfterVote(undefined, 0, 1), 1);
});

test('pollSummary percentages, total and leader', () => {
  const s = pollSummary({ question: 'Q?', options: [{ text: 'A', votes: 1 }, { text: 'B', votes: 3 }, { text: 'C', votes: 0 }], total: 4 });
  assert.deepEqual(s.options.map(o => o.pct), [25, 75, 0]);
  assert.equal(s.leader.text, 'B');
  assert.equal(s.total, 4);
  const empty = pollSummary({ question: 'Q', options: [{ text: 'A', votes: 0 }], total: 0 });
  assert.equal(empty.leader, null);
  assert.deepEqual(empty.options.map(o => o.pct), [0]);
  assert.equal(pollSummary(null).options.length, 0);
  assert.equal(pollSummary({ options: [{ text: 'A', votes: 2 }], total: 'x' }).total, 2);
});

test('splitSticky pulls stickied automod roots only', () => {
  const roots = [{ id: 1 }, { id: 2, stickied: true, author_type: 'automod' }, { id: 3, stickied: true, author_type: 'bot' }];
  const { sticky, rest } = splitSticky(roots);
  assert.deepEqual(sticky.map(r => r.id), [2]);
  assert.deepEqual(rest.map(r => r.id), [1, 3]);
});

test('articleOf: picked story or pasted fields', () => {
  assert.equal(articleOf(base({ picked: ART })), ART);
  assert.equal(articleOf(base({ source: 'paste' })), null);
  assert.deepEqual(articleOf(base({ source: 'paste', paste: { headline: '  Potholes  ', link: 'javascript:x', text: '' } })),
    { headline: 'Potholes', body: null, link: null, source: null });
  assert.deepEqual(articleOf(base({ source: 'paste', paste: { headline: 'H', link: 'https://e.com/a', text: ' txt ' } })),
    { headline: 'H', body: 'txt', link: 'https://e.com/a', source: null });
});

test('validateCreate: news needs a story or a pasted headline; link must be http(s)', () => {
  assert.deepEqual(Object.keys(validateCreate(base())), ['story']);
  assert.deepEqual(validateCreate(base({ picked: ART })), {});
  assert.deepEqual(Object.keys(validateCreate(base({ source: 'paste', paste: { headline: 'ab', link: 'ftp://x', text: '' } }))).sort(), ['headline', 'link']);
  assert.deepEqual(validateCreate(base({ source: 'paste', paste: { headline: 'Real headline', link: '', text: '' } })), {});
});

test('validateCreate: user posts need title, handle; polls need 2-6 options', () => {
  assert.deepEqual(Object.keys(validateCreate(base({ type: 'ask', author: 'user', title: 'hi' }))), ['title']);
  assert.deepEqual(Object.keys(validateCreate(base({ type: 'ask', author: 'user', title: 'Why?', handle: 'x y' }))), ['handle']);
  assert.deepEqual(Object.keys(validateCreate(base({ type: 'poll', author: 'user', title: 'Best city?', options: ['Pune', ' '] }))), ['options']);
  assert.deepEqual(validateCreate(base({ type: 'poll', author: 'user', title: 'Best city?', options: ['Pune', 'Kochi', ''] })), {});
  assert.ok(validateCreate(base({ type: 'poll', author: 'user', title: 'Q?', options: Array(7).fill('x') })).options);
  assert.ok(validateCreate(base({ type: 'poll', author: 'user', title: 'Q?', options: ['a', 'b'.repeat(81)] })).options);
  assert.ok(validateCreate(base({ type: 'opinion', author: 'user', title: 'Okay title', body: 'x'.repeat(6001) })).body);
});

test('validateCreate: bot posts need an idea except news and AMA; limit range', () => {
  assert.deepEqual(Object.keys(validateCreate(base({ type: 'ask' }))), ['idea']);
  assert.deepEqual(Object.keys(validateCreate(base({ type: 'poll', idea: 'no' }))), ['idea']);
  assert.deepEqual(validateCreate(base({ type: 'opinion', idea: 'Dosa beats idli' })), {});
  assert.deepEqual(validateCreate(base({ type: 'ama' })), {});
  assert.deepEqual(Object.keys(validateCreate(base({ type: 'ama', idea: 'x' }))), ['idea']);
  assert.deepEqual(validateCreate(base({ type: 'ama', handle: 'bad handle' })), {}, 'handle only matters when the user writes');
  assert.deepEqual(Object.keys(validateCreate(base({ picked: ART, limit: 21 }))), ['limit']);
  assert.deepEqual(Object.keys(validateCreate(base({ picked: ART, limit: 4 }))), ['limit']);
});

test('buildCreateBody: exact key set for every type x author', () => {
  for (const type of Object.keys(POST_TYPES)) for (const author of ['user', 'bot']) {
    const b = buildCreateBody(base({ type, author, picked: ART, title: 'T title', idea: 'an idea', options: ['a', 'b'] }));
    assert.deepEqual(Object.keys(b), KEYS, `${type}/${author}`);
    assert.equal(b.post_type, type);
    assert.equal(b.author, author);
  }
});

test('buildCreateBody: news by bot and by user', () => {
  assert.deepEqual(buildCreateBody(base({ picked: ART })), {
    post_type: 'news', author: 'bot', title: null, body: null, idea: null, article: ART, poll_options: null, ama_host: null,
    user_name: 'guest_0042', bots: 5, thread_limit: 6, max_comments: 40,
  });
  assert.deepEqual(buildCreateBody(base({ author: 'user', source: 'paste', paste: { headline: 'Potholes again', link: 'https://e.com/p', text: '' }, body: ' my take ', crowd: 'large', length: 'long', limit: 12 })), {
    post_type: 'news', author: 'user', title: 'Potholes again', body: 'my take', idea: null,
    article: { headline: 'Potholes again', body: null, link: 'https://e.com/p', source: null }, poll_options: null, ama_host: null,
    user_name: 'guest_0042', bots: 8, thread_limit: 12, max_comments: 80,
  });
  assert.equal(buildCreateBody(base({ picked: ART, idea: '  focus on EMIs ' })).idea, 'focus on EMIs');
});

test('buildCreateBody: ask, opinion, poll, ama', () => {
  const ask = buildCreateBody(base({ type: 'ask', author: 'user', title: ' Why is rent so high? ', body: '', crowd: 'small', length: 'quick' }));
  assert.deepEqual({ t: ask.title, b: ask.body, a: ask.article, i: ask.idea, bots: ask.bots, max: ask.max_comments }, { t: 'Why is rent so high?', b: null, a: null, i: null, bots: 3, max: 20 });
  const op = buildCreateBody(base({ type: 'opinion', idea: 'Dosa beats idli', title: 'ignored' }));
  assert.deepEqual({ t: op.title, i: op.idea }, { t: null, i: 'Dosa beats idli' });
  const poll = buildCreateBody(base({ type: 'poll', author: 'user', title: 'Best city?', options: [' Pune ', '', 'Kochi', 'Indore'] }));
  assert.deepEqual(poll.poll_options, ['Pune', 'Kochi', 'Indore']);
  assert.equal(buildCreateBody(base({ type: 'poll', idea: 'cities', options: ['a', 'b'] })).poll_options, null);
  const ama = buildCreateBody(base({ type: 'ama', amaHost: 'plumber' }));
  assert.deepEqual({ h: ama.ama_host, i: ama.idea, t: ama.title }, { h: 'plumber', i: null, t: null });
  const amaU = buildCreateBody(base({ type: 'ama', author: 'user', amaHost: null, title: "I'm a nurse, AMA", body: 'Night shifts.' }));
  assert.deepEqual({ h: amaU.ama_host, t: amaU.title, b: amaU.body }, { h: null, t: "I'm a nurse, AMA", b: 'Night shifts.' });
  assert.equal(buildCreateBody(base({ type: 'ask', author: 'user', title: 'x?', handle: 'bad handle' })).user_name, null);
});

// ---------------------------------------------------------------- v2 thread interactions
import {
  applyEdit, applyDelete, applyRemove, applyAwards, applyLock, lockedIds, awardCounts, canReply,
  reconcileComment, pollRows, opRoles,
} from './tree.js';

test('edit/delete/remove/awards/lock patch one comment immutably', () => {
  const list = [c(1, null), c(2, 1)];
  const e = applyEdit(list, { comment_id: 2, text: 'new' });
  assert.deepEqual([e[1].text, e[1].edited, list[1].edited], ['new', true, undefined]);
  assert.deepEqual([applyDelete(list, 1)[0].deleted, applyDelete(list, 1)[0].text], [true, '']);
  assert.deepEqual([applyRemove(list, 1)[0].removed, applyRemove(list, 1)[0].text], [true, '']);
  assert.deepEqual(applyAwards(list, { comment_id: 1, awards: ['🏅', 3, '😂'] })[0].awards, ['🏅', '😂']);
  assert.equal(applyLock(list, 1)[0].locked, true);
  assert.deepEqual(applyLock(list, 99), list); // unknown id: unchanged
});

test('lockedIds covers the locked comment and its whole subtree only', () => {
  const list = [c(1, null), c(2, 1, 1, { locked: true }), c(3, 2), c(4, 3), c(5, 1), c(6, null)];
  assert.deepEqual([...lockedIds(list)].sort(), [2, 3, 4]);
  assert.deepEqual([...lockedIds([c(1, 2), c(2, 1)])], []); // cycle-safe
});

test('awardCounts groups in first-seen order', () => {
  assert.deepEqual(awardCounts(['🏅', '😂', '🏅', '', 7]), [['🏅', 2], ['😂', 1]]);
  assert.deepEqual(awardCounts(null), []);
});

test('canReply: not pending/deleted/removed/sticky/locked', () => {
  assert.ok(canReply(c(1, null), false));
  for (const x of [{ pending: true }, { deleted: true }, { removed: true }, { stickied: true }]) assert.ok(!canReply(c(1, null, 1, x), false));
  assert.ok(!canReply(c(1, null), true));
});

test('reconcileComment replaces the optimistic comment or upserts', () => {
  const temp = { id: 9e15, pending: true, author_type: 'user', author_name: 'me', text: 'hi there', parent_id: 1 };
  const real = { id: 40, author_type: 'user', author_name: 'me', text: 'hi there ', parent_id: 1, score: 1 };
  const r = reconcileComment([c(1, null), temp], real);
  assert.equal(r.replaced, 9e15);
  assert.deepEqual(r.comments.map(x => x.id), [1, 40]);
  assert.equal(r.comments[1].pending, false);
  const again = reconcileComment(r.comments, { ...real, score: 3 });
  assert.deepEqual([again.comments.length, again.comments[1].score], [2, 3]);
  const both = reconcileComment([real, temp], real); // 201 and SSE both arrived
  assert.deepEqual(both.comments.map(x => x.id), [40]);
  const bot = reconcileComment([temp], { id: 41, author_type: 'bot', bot_id: 2, text: 'hi there', parent_id: 1 });
  assert.deepEqual(bot.comments.map(x => x.id), [9e15, 41]);
  const other = reconcileComment([temp], { ...real, parent_id: null });
  assert.equal(other.comments.length, 2, 'different parent does not match');
});

test('pollRows marks the leader(s)', () => {
  const r = pollRows({ question: 'Q', options: [{ text: 'A', votes: 2 }, { text: 'B', votes: 2 }, { text: 'C', votes: 1 }], total: 5 });
  assert.deepEqual(r.rows.map(x => [x.pct, x.lead]), [[40, true], [40, true], [20, false]]);
  assert.deepEqual(pollRows({ options: [{ text: 'A', votes: 0 }] }).rows.map(x => x.lead), [false]);
});

test('opRoles from op, flags and ama_host_bot_id', () => {
  assert.deepEqual(opRoles({ op: { type: 'bot', bot_id: 3 }, ama_host_bot_id: 5 }, []), { opBot: 3, opUser: null, host: 5 });
  assert.deepEqual(opRoles({ op: { type: 'user', name: 'me' } }, [{ id: 2, is_host: true }]), { opBot: null, opUser: 'me', host: 2 });
  assert.deepEqual(opRoles({ op: { type: 'bot', bot_id: 0 } }, [{ id: 4, is_op: true }]), { opBot: 4, opUser: null, host: null });
  assert.deepEqual(opRoles({}, []), { opBot: null, opUser: null, host: null });
});
