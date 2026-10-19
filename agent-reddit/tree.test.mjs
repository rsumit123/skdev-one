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

const KEYS = ['post_type', 'author', 'title', 'body', 'idea', 'article', 'poll_options', 'ama_host', 'user_name', 'bots', 'thread_limit', 'max_comments', 'sub'];
const base = (extra = {}) => ({
  type: 'news', author: 'bot', source: 'paper', picked: null, paste: { headline: '', link: '', text: '' },
  title: '', body: '', idea: '', options: ['', ''], amaHost: null, handle: 'guest_0042',
  crowd: 'medium', length: 'normal', limit: 6, ...extra,
});
const ART = { headline: 'RBI holds rates', body: 'Full text', link: null, source: 'The Indian Express (print, p. 2)' };

test('typeInfo labels and fallback', () => {
  assert.equal(typeInfo('opinion').label, 'Unpopular opinion');
  assert.equal(typeInfo('ama').label, 'AMA');
  assert.equal(typeInfo(undefined), POST_TYPES.news);
  assert.equal(typeInfo('Bad Type!'), POST_TYPES.news, 'junk is still a news post');
  assert.deepEqual(typeInfo('bogus'), { label: 'Bogus', color: '#787c7e', generic: true }, 'a well-formed unknown type gets a neutral pill, not News');
  assert.deepEqual(Object.keys(POST_TYPES), ['news', 'ask', 'opinion', 'poll', 'ama', 'joke', 'confession']);
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
    user_name: 'guest_0042', bots: 5, thread_limit: 6, max_comments: 40, sub: 'indianews',
  });
  assert.deepEqual(buildCreateBody(base({ author: 'user', source: 'paste', paste: { headline: 'Potholes again', link: 'https://e.com/p', text: '' }, body: ' my take ', crowd: 'large', length: 'long', limit: 12 })), {
    post_type: 'news', author: 'user', title: 'Potholes again', body: 'my take', idea: null,
    article: { headline: 'Potholes again', body: null, link: 'https://e.com/p', source: null }, poll_options: null, ama_host: null,
    user_name: 'guest_0042', bots: 8, thread_limit: 12, max_comments: 80, sub: 'indianews',
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

// ---------------------------------------------------------------- v3 F5: calm threads
import {
  rankOrder, arrangeTree, shouldBuffer, mergePolicy, pillText, pickAnchor, anchorTarget, pressReducer, PRESS,
} from './tree.js';

const ser = roots => roots.map(r => (r.children.length ? `${r.id}(${ser(r.children)})` : `${r.id}`)).join(' ');

test('rankOrder + arrangeTree: frozen order survives score changes', () => {
  const sorted = sortTree(buildTree(sample()), 'best'); // roots 4 (9), 1 (5); under 1: 5 (7), 2 (3)
  const rank = rankOrder(sorted);
  assert.equal(ser(sorted), '4 1(5 2(3))');
  const bumped = sample().map(x => (x.id === 1 ? { ...x, score: 99 } : x.id === 2 ? { ...x, score: 50 } : x));
  assert.equal(ser(arrangeTree(buildTree(bumped), rank, 'best')), '4 1(5 2(3))', 'scores moved, order did not');
  assert.equal(ser(sortTree(buildTree(bumped), 'best')), '1(2(3) 5) 4', 'a re-sort would reorder');
});

test('arrangeTree places arrivals by the sort among frozen siblings, then they stay put', () => {
  const base = sample();
  const rank = rankOrder(sortTree(buildTree(base), 'best'));
  const withNew = [...base, c(6, null, 6), c(7, 1, 1)];
  const a = arrangeTree(buildTree(withNew), rank, 'best');
  assert.deepEqual(a.map(r => r.id), [4, 6, 1], 'score 6 lands between 9 and 5');
  assert.deepEqual(a[2].children.map(r => r.id), [5, 2, 7], 'score 1 reply goes last');
  const rank2 = rankOrder(a);
  const later = withNew.map(x => (x.id === 6 ? { ...x, score: -5 } : x));
  assert.deepEqual(arrangeTree(buildTree(later), rank2, 'best').map(r => r.id), [4, 6, 1], 'once shown, an arrival keeps its slot');
  assert.deepEqual(arrangeTree(buildTree(withNew), rank, 'new').map(r => r.id)[0], 6, 'New puts arrivals first');
  assert.deepEqual(arrangeTree(buildTree(base), null, 'best').map(r => r.id), [4, 1], 'no rank = plain sort');
});

test('shouldBuffer: far from the live edge or interacting', () => {
  const base = { distance: 0, viewport: 800, selecting: false, replyFocused: false, profileOpen: false };
  assert.equal(shouldBuffer(base), false);
  assert.equal(shouldBuffer({ ...base, distance: 1199 }), false);
  assert.equal(shouldBuffer({ ...base, distance: 1201 }), true, '> 1.5 viewports');
  assert.equal(shouldBuffer({ ...base, distance: -400 }), false, 'above the comments');
  assert.equal(shouldBuffer({ ...base, selecting: true }), true);
  assert.equal(shouldBuffer({ ...base, replyFocused: true }), true);
  assert.equal(shouldBuffer({ ...base, profileOpen: true }), true);
  assert.equal(shouldBuffer({}), false);
});

test('mergePolicy: hold vs show', () => {
  const b = { buffering: false, heldCount: 0, own: false, replyToMine: false, parentHeld: false, hiddenByCollapse: false };
  assert.equal(mergePolicy(b), 'show');
  assert.equal(mergePolicy({ ...b, buffering: true }), 'hold');
  assert.equal(mergePolicy({ ...b, heldCount: 2 }), 'hold', 'keep arrival order: once holding, keep holding');
  assert.equal(mergePolicy({ ...b, buffering: true, own: true }), 'show', 'the reader\'s own comment always shows');
  assert.equal(mergePolicy({ ...b, buffering: true, replyToMine: true }), 'show');
  assert.equal(mergePolicy({ ...b, buffering: true, hiddenByCollapse: true }), 'show', 'invisible anyway; bumps the hidden count');
  assert.equal(mergePolicy({ ...b, parentHeld: true, replyToMine: true, own: false }), 'hold', 'a reply to a held comment waits with it');
  assert.equal(mergePolicy({ ...b, parentHeld: true, own: true }), 'show');
});

test('pillText', () => {
  assert.equal(pillText(1, 'up'), '↑ 1 new comment');
  assert.equal(pillText(4, 'down'), '↓ 4 new comments');
});

test('pickAnchor: the item at the top edge of the visible area', () => {
  assert.equal(pickAnchor([], 48), -1);
  assert.equal(pickAnchor([100, 300], 48), 0, 'nothing above the edge: the first item');
  assert.equal(pickAnchor([-900, -200, 30, 48, 400], 48), 3, 'last top at or above the edge');
  assert.equal(pickAnchor([-900, -200, 49.6, 400], 48), 1);
});

test('anchorTarget: keep the offset, clamp fallbacks into view', () => {
  assert.equal(anchorTarget({ before: -120, after: 80, inset: 48, clamp: false }), 200);
  assert.equal(anchorTarget({ before: 300, after: 300, inset: 48, clamp: false }), 0);
  assert.equal(anchorTarget({ before: -120, after: -120, inset: 48, clamp: true }), -168, 'scroll back so it sits at the inset');
  assert.equal(anchorTarget({ before: 300, after: 280, inset: 48, clamp: true }), -20);
});

test('pressReducer: touch long-press state machine', () => {
  const r = (s, e) => pressReducer(s, e);
  let { state, effect } = r(PRESS, { type: 'down', pointerType: 'mouse', x: 0, y: 0, id: 1, eligible: true, t: 0 });
  assert.equal(state.phase, 'idle'); assert.equal(effect, null, 'mouse never long-presses');
  ({ state, effect } = r(PRESS, { type: 'down', pointerType: 'touch', x: 0, y: 0, id: 1, eligible: false, t: 0 }));
  assert.equal(state.phase, 'idle'); assert.equal(effect, null, 'links/buttons are not eligible');
  ({ state, effect } = r(PRESS, { type: 'down', pointerType: 'touch', x: 10, y: 10, id: 1, eligible: true, t: 0 }));
  assert.equal(state.phase, 'pressing'); assert.equal(effect, 'press');
  const pressing = state;
  ({ state, effect } = r(pressing, { type: 'move', x: 15, y: 15, id: 1 }));
  assert.equal(state.phase, 'pressing', '7 px is still a press'); assert.equal(effect, null);
  ({ state, effect } = r(pressing, { type: 'move', x: 10, y: 19, id: 1 }));
  assert.equal(state.phase, 'idle', '9 px cancels'); assert.equal(effect, 'release');
  ({ state, effect } = r(pressing, { type: 'cancel', t: 100 }));
  assert.equal(state.phase, 'idle'); assert.equal(effect, 'release', 'scroll / pointercancel cancels');
  ({ state, effect } = r(pressing, { type: 'up', id: 1, t: 200 }));
  assert.equal(state.phase, 'idle'); assert.equal(effect, 'release'); assert.equal(state.until, 0, 'a tap is not swallowed');
  ({ state, effect } = r(pressing, { type: 'timer' }));
  assert.equal(state.phase, 'fired'); assert.equal(effect, 'fire');
  ({ state, effect } = r(state, { type: 'up', id: 1, t: 500 }));
  assert.equal(state.phase, 'idle'); assert.equal(state.until, 900, 'the click after a long-press is swallowed for 400 ms');
  assert.equal(r(PRESS, { type: 'timer' }).effect, null);
  assert.equal(r({ ...pressing }, { type: 'move', x: 99, y: 99, id: 2 }).state.phase, 'pressing', 'other pointers are ignored');
  assert.equal(r(PRESS, { type: 'down', pointerType: 'pen', x: 0, y: 0, id: 3, eligible: true, t: 0 }).effect, 'press', 'pen too');
});

// ---------------------------------------------------------------- v3: subreddits
import {
  SUBS, subForType, typeForSub, normalizeSub, normalizeSubs, subInfo, subOf, cardDecor,
  sectionFrom, sectionsFrom, pageSection, moreCount, emptySubs, subsDiff, validSlug,
} from './tree.js';

const API_SUBS = [
  { slug: 'indianews', name: 'r/IndiaNews', title: 'India News', description: 'News d', post_type: 'news', color: '#E8590C', icon: '📰', threads: 9, live: 1 },
  { slug: 'askindia', name: 'r/AskIndia', title: 'Ask India', description: 'Ask d', post_type: 'ask', color: '#1C7ED6', icon: '🙋', threads: 0, live: 0 },
];

test('registry: seven subs in order, 1:1 with post types', () => {
  assert.deepEqual(SUBS.map(s => s.slug), ['indianews', 'askindia', 'unpopularindia', 'indiapolls', 'indiaama', 'indiajokes', 'indiaconfessions']);
  assert.deepEqual(SUBS.map(s => s.post_type), Object.keys(POST_TYPES));
  for (const s of SUBS) assert.match(s.color, /^#[0-9A-F]{6}$/i);
});

test('subForType / typeForSub map both ways, with fallbacks', () => {
  assert.equal(subForType('ask'), 'askindia');
  assert.equal(subForType('poll'), 'indiapolls');
  assert.equal(subForType('nope'), 'indianews', 'unknown types land in r/IndiaNews');
  assert.equal(typeForSub('indiaama'), 'ama');
  assert.equal(typeForSub('unpopularindia'), 'opinion');
  assert.equal(typeForSub('r/whatever'), null);
  assert.equal(typeForSub(undefined), null);
  // An API registry wins over the built-in one.
  const custom = [{ slug: 'desi_polls', post_type: 'poll' }];
  assert.equal(subForType('poll', custom), 'desi_polls');
  assert.equal(typeForSub('desi_polls', custom), 'poll');
  assert.equal(subForType('ask', custom), 'askindia', 'types the API list lacks fall back');
});

test('normalizeSub: validates every field and falls back per field', () => {
  assert.deepEqual(normalizeSub(API_SUBS[0]), API_SUBS[0]);
  const bad = normalizeSub({ slug: 'askindia', color: 'red; background:url(x)', icon: '', threads: -3, live: 'x', name: 'AskIndia' });
  assert.equal(bad.color, '#1C7ED6');
  assert.equal(bad.icon, '🙋');
  assert.equal(bad.post_type, 'ask');
  assert.equal(bad.name, 'r/AskIndia');
  assert.equal(bad.threads, null);
  assert.equal(bad.live, 0);
  assert.equal(normalizeSub({ slug: 'Bad Slug!' }), null);
  assert.equal(normalizeSub({ slug: 'mystery' }), null, 'unknown sub without a usable post type');
  assert.equal(normalizeSub({ slug: 'mystery', post_type: 'poll' }).name, 'r/mystery');
  assert.equal(normalizeSub(null), null);
  assert.ok(validSlug('indiaama') && !validSlug('../x') && !validSlug(''));
});

test('normalizeSubs keeps order, drops junk and duplicate slugs', () => {
  const out = normalizeSubs([API_SUBS[1], null, { slug: '' }, API_SUBS[0], { ...API_SUBS[1], threads: 5 }]);
  assert.deepEqual(out.map(s => s.slug), ['askindia', 'indianews']);
  assert.equal(out[0].threads, 0);
  assert.deepEqual(normalizeSubs('nope'), []);
});

test('subInfo / subOf: API first, registry next, post_type derivation for old rows', () => {
  assert.equal(subInfo('askindia', API_SUBS).description, 'Ask d');
  assert.equal(subInfo('indiaama', API_SUBS).name, 'r/IndiaAMA');
  assert.equal(subInfo('nope', API_SUBS), null);
  assert.equal(subOf({ sub: 'askindia', post_type: 'news' }), 'askindia');
  assert.equal(subOf({ post_type: 'ama' }), 'indiaama');
  assert.equal(subOf({ sub: 'Bad!', post_type: 'opinion' }), 'unpopularindia');
  assert.equal(subOf({}), 'indianews', 'v1 rows without post_type are news');
});

test('cardDecor: sections and sub pages drop the flair, mixed lists get the sub chip', () => {
  const t = { sub: 'askindia', post_type: 'ask' };
  assert.deepEqual(cardDecor(t, 'section', 'askindia'), { chip: null, flair: false });
  assert.deepEqual(cardDecor(t, 'sub', 'askindia'), { chip: null, flair: false });
  assert.deepEqual(cardDecor(t, 'sub', 'indianews'), { chip: 'askindia', flair: false }, 'a stray card is labelled');
  assert.deepEqual(cardDecor(t, 'mixed'), { chip: 'askindia', flair: false });
  assert.deepEqual(cardDecor({ post_type: 'poll' }, 'mixed'), { chip: 'indiapolls', flair: false });
  assert.deepEqual(cardDecor(t), { chip: null, flair: true });
});

const card = id => ({ id, title: id });
test('sectionFrom / sectionsFrom: first cards, total and the next offset', () => {
  const s = sectionFrom({ sub: API_SUBS[0], threads: [card('a'), card('b'), card('a'), null, card('c')], total: 9 });
  assert.deepEqual(s.items.map(x => x.id), ['a', 'b', 'c']);
  assert.equal(s.total, 9);
  assert.equal(s.next, 3);
  assert.equal(sectionFrom({ sub: API_SUBS[0], threads: [card('a')], total: 1 }).next, null);
  assert.equal(sectionFrom({ sub: API_SUBS[0], threads: [card('a'), card('b')] }).total, 2, 'missing total = what was sent');
  assert.equal(sectionFrom({ sub: { slug: 'x y' }, threads: [card('a')] }), null);
  const all = sectionsFrom({ sections: [
    { sub: API_SUBS[0], threads: [card('a')], total: 1 },
    { sub: API_SUBS[1], threads: [], total: 0 },
    { sub: API_SUBS[0], threads: [card('z')], total: 1 },
    'junk',
  ] });
  assert.deepEqual(all.map(x => x.sub.slug), ['indianews'], 'empty and duplicate sections dropped');
  assert.deepEqual(sectionsFrom(null), []);
});

test('pageSection: appends a page in place, dedupes, stops at the end', () => {
  let s = sectionFrom({ sub: API_SUBS[0], threads: [card('a'), card('b'), card('c')], total: 7 });
  let r = pageSection(s, { threads: [card('c'), card('d'), card('e')], total: 7, next_offset: 6 }, 3);
  assert.deepEqual(r.added.map(x => x.id), ['d', 'e']);
  assert.deepEqual(r.section.items.map(x => x.id), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(r.section.next, 6);
  assert.equal(moreCount(r.section), 2);
  r = pageSection(r.section, { threads: [card('f'), card('g')], total: 7, next_offset: null }, 6);
  assert.equal(r.section.next, null);
  assert.equal(moreCount(r.section), 0);
  s = sectionFrom({ sub: API_SUBS[0], threads: [card('a')], total: 3 });
  r = pageSection(s, { threads: [card('b'), card('c')], total: 3, next_offset: 99 }, 1);
  assert.equal(r.section.next, null, 'everything of total is shown');
  r = pageSection(sectionFrom({ sub: API_SUBS[0], threads: [card('a')], total: 9 }), { threads: [card('b')], total: 9, next_offset: 1 }, 1);
  assert.equal(r.section.next, null, 'a cursor that does not move ends paging');
  assert.equal(moreCount(sectionFrom({ sub: API_SUBS[0], threads: [card('a'), card('b'), card('c')], total: 20 })), 3);
});

test('emptySubs: registry subs without a section, in order', () => {
  const secs = sectionsFrom({ sections: [{ sub: API_SUBS[0], threads: [card('a')], total: 1 }] });
  assert.deepEqual(emptySubs(SUBS, secs).map(s => s.slug), ['askindia', 'unpopularindia', 'indiapolls', 'indiaama', 'indiajokes', 'indiaconfessions']);
  assert.deepEqual(emptySubs(normalizeSubs(API_SUBS), secs).map(s => s.slug), ['askindia']);
  assert.deepEqual(emptySubs(normalizeSubs([{ ...API_SUBS[1], threads: 4 }]), []).map(s => s.slug), [], 'a sub with posts never gets the tile');
  assert.deepEqual(emptySubs(null, []).map(s => s.slug), SUBS.map(s => s.slug));
});

test('subsDiff: only subs whose counts or live numbers moved', () => {
  const a = normalizeSubs(API_SUBS);
  assert.deepEqual(subsDiff(a, a), []);
  const b = normalizeSubs([{ ...API_SUBS[0], live: 2 }, API_SUBS[1]]);
  assert.deepEqual(subsDiff(a, b).map(s => s.slug), ['indianews']);
});

test('buildCreateBody: sub from the picker, else the post type\'s sub', () => {
  assert.equal(buildCreateBody(base({ type: 'ask', author: 'user', title: 'Why?' })).sub, 'askindia');
  assert.equal(buildCreateBody(base({ type: 'poll', idea: 'x', sub: 'indiapolls' })).sub, 'indiapolls');
  assert.equal(buildCreateBody(base({ type: 'poll', idea: 'x', sub: 'Bad Slug' })).sub, 'indiapolls');
  assert.equal(buildCreateBody(base({ type: 'ama', sub: 'askindia' })).sub, 'askindia', 'sent as picked so the server can 422');
});

// ---------------------------------------------------------------- v3.1: jokes and confessions
import { knownType, displayType, postable, CONFESSION_RANGE } from './tree.js';

test('v3.1 registry: r/IndiaJokes and r/IndiaConfessions after r/IndiaAMA, with the contract copy', () => {
  const j = SUBS.find(s => s.slug === 'indiajokes');
  const c = SUBS.find(s => s.slug === 'indiaconfessions');
  assert.deepEqual([j.name, j.post_type, j.icon, j.color.toLowerCase(), j.description],
    ['r/IndiaJokes', 'joke', '😂', '#f5a623', 'Desi humour: one-liners, puns, shitposts and groan-worthy dad jokes']);
  assert.deepEqual([c.name, c.post_type, c.icon, c.color.toLowerCase(), c.description],
    ['r/IndiaConfessions', 'confession', '🤫', '#6b5b95', 'Small, harmless confessions. Say it here, no names']);
  assert.equal(SUBS.length, 7);
  assert.deepEqual([typeInfo('joke').label, typeInfo('confession').label], ['Joke', 'Confession']);
  for (const t of ['joke', 'confession']) assert.match(typeInfo(t).color, /^#[0-9a-f]{6}$/i);
});

test('v3.1 subForType / typeForSub for the new types, also before /subs answers', () => {
  assert.equal(subForType('joke'), 'indiajokes');
  assert.equal(subForType('confession'), 'indiaconfessions');
  assert.equal(typeForSub('indiajokes'), 'joke');
  assert.equal(typeForSub('indiaconfessions'), 'confession');
  // An older /subs answer without the new subs: the built-in registry fills in.
  assert.equal(subForType('joke', API_SUBS), 'indiajokes');
  assert.equal(typeForSub('indiaconfessions', API_SUBS), 'confession');
  assert.equal(subInfo('indiajokes', API_SUBS).icon, '😂');
  assert.equal(subOf({ post_type: 'confession' }), 'indiaconfessions', 'old rows without sub');
  assert.equal(normalizeSub({ slug: 'indiajokes' }).post_type, 'joke', 'a sparse API row falls back to the built-in entry');
});

test('v3.1 unknown future subs/types degrade to a generic look instead of breaking', () => {
  const s = normalizeSub({ slug: 'indiahaiku', post_type: 'haiku', name: 'IndiaHaiku' });
  assert.deepEqual({ n: s.name, t: s.post_type, c: s.color, i: s.icon }, { n: 'r/IndiaHaiku', t: 'haiku', c: '#0079d3', i: '💬' });
  assert.equal(typeForSub('indiahaiku', [s]), null, 'the composer never offers a type it has no form for');
  assert.equal(postable(s), false);
  assert.equal(postable(SUBS[5]), true);
  assert.equal(postable(null), false);
  assert.equal(normalizeSub({ slug: 'weird', post_type: 'Not A Type' }), null, 'junk post types still drop the sub');
  assert.deepEqual(normalizeSubs([{ slug: 'indiahaiku', post_type: 'haiku' }, API_SUBS[0]]).map(x => x.slug), ['indiahaiku', 'indianews']);
  assert.equal(displayType('haiku'), 'haiku');
  assert.equal(displayType('joke'), 'joke');
  assert.equal(displayType(undefined), 'news');
  assert.equal(displayType('<b>'), 'news');
  assert.ok(knownType('confession') && !knownType('haiku') && !knownType('toString'));
  assert.equal(subOf({ post_type: 'haiku' }), 'indianews', 'an unknown type without a sub lands in r/IndiaNews like before');
});

test('v3.1 validateCreate: joke by user needs the joke; punchline optional; bot theme optional', () => {
  assert.deepEqual(validateCreate(base({ type: 'joke', author: 'user', title: '' })), { title: 'Write the joke (at least 3 characters).' });
  assert.deepEqual(validateCreate(base({ type: 'joke', author: 'user', title: 'Why did the auto driver cross the road?' })), {});
  assert.deepEqual(validateCreate(base({ type: 'joke', author: 'user', title: 'Setup', body: 'Punchline' })), {});
  assert.ok(validateCreate(base({ type: 'joke', author: 'user', title: 'x'.repeat(301) })).title);
  assert.deepEqual(validateCreate(base({ type: 'joke' })), {}, 'bot: no theme is fine (a random one)');
  assert.deepEqual(Object.keys(validateCreate(base({ type: 'joke', idea: 'x' }))), ['idea'], 'a theme, if given, is 3+ characters');
  assert.deepEqual(validateCreate(base({ type: 'joke', idea: 'Indian wedding WhatsApp groups' })), {});
});

test('v3.1 validateCreate: confession by user is 20..2000 characters, title optional', () => {
  const [lo, hi] = CONFESSION_RANGE;
  assert.deepEqual([lo, hi], [20, 2000]);
  assert.deepEqual(validateCreate(base({ type: 'confession', author: 'user' })), { body: 'Write your confession (at least 20 characters).' });
  assert.deepEqual(validateCreate(base({ type: 'confession', author: 'user', body: 'too short' })), { body: 'A bit more, please: at least 20 characters (9 so far).' });
  assert.deepEqual(validateCreate(base({ type: 'confession', author: 'user', body: `  ${'x'.repeat(19)}  ` })).body, 'A bit more, please: at least 20 characters (19 so far).', 'trimmed');
  assert.deepEqual(validateCreate(base({ type: 'confession', author: 'user', body: 'x'.repeat(20) })), {});
  assert.deepEqual(validateCreate(base({ type: 'confession', author: 'user', body: 'x'.repeat(2000) })), {});
  assert.deepEqual(validateCreate(base({ type: 'confession', author: 'user', body: 'x'.repeat(2001) })), { body: 'Keep it under 2000 characters (2001 now).' });
  assert.deepEqual(validateCreate(base({ type: 'confession', author: 'user', body: 'x'.repeat(30), title: 'ab' })), { title: 'A title needs at least 3 characters, or leave it empty.' });
  assert.deepEqual(validateCreate(base({ type: 'confession', author: 'user', body: 'x'.repeat(30), title: 'My confession' })), {});
  assert.deepEqual(validateCreate(base({ type: 'confession' })), {}, 'bot: theme optional');
  assert.deepEqual(validateCreate(base({ type: 'confession', body: 'short' })), {}, 'bot: the body field is not used');
  assert.deepEqual(Object.keys(validateCreate(base({ type: 'confession', author: 'user', body: 'x'.repeat(30), handle: 'no way' }))), ['handle']);
});

test('v3.1 buildCreateBody: joke and confession, user and bot, exact shapes', () => {
  const common = { idea: null, article: null, poll_options: null, ama_host: null, user_name: 'guest_0042', bots: 5, thread_limit: 6, max_comments: 40 };
  assert.deepEqual(buildCreateBody(base({ type: 'joke', author: 'user', title: ' Why did the auto driver cross the road? ', body: ' Meter was running. ' })),
    { post_type: 'joke', author: 'user', title: 'Why did the auto driver cross the road?', body: 'Meter was running.', ...common, sub: 'indiajokes' });
  assert.deepEqual(buildCreateBody(base({ type: 'joke', author: 'user', title: 'One-liner', body: '' })),
    { post_type: 'joke', author: 'user', title: 'One-liner', body: null, ...common, sub: 'indiajokes' });
  assert.deepEqual(buildCreateBody(base({ type: 'joke', idea: ' Indian wedding WhatsApp groups ', title: 'ignored', body: 'ignored' })),
    { post_type: 'joke', author: 'bot', title: null, body: null, ...common, idea: 'Indian wedding WhatsApp groups', sub: 'indiajokes' });
  assert.deepEqual(buildCreateBody(base({ type: 'joke' })).idea, null, 'no theme = null, the server picks one');
  const conf = 'I still pretend to understand cricket at office lunches.';
  assert.deepEqual(buildCreateBody(base({ type: 'confession', author: 'user', body: `  ${conf}  `, title: '   ' })),
    { post_type: 'confession', author: 'user', title: null, body: conf, ...common, sub: 'indiaconfessions' });
  assert.equal(buildCreateBody(base({ type: 'confession', author: 'user', body: conf, title: ' Guilty ' })).title, 'Guilty');
  assert.deepEqual(buildCreateBody(base({ type: 'confession', idea: 'office secrets', body: 'ignored' })),
    { post_type: 'confession', author: 'bot', title: null, body: null, ...common, idea: 'office secrets', sub: 'indiaconfessions' });
  assert.equal(buildCreateBody(base({ type: 'confession', author: 'user', body: 'y'.repeat(2500) })).body.length, 2000);
  assert.equal(buildCreateBody(base({ type: 'joke', idea: 'x x x', sub: 'indiaconfessions' })).sub, 'indiaconfessions', 'sent as picked so the server can 422');
});
