import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTree, sortTree, countDescendants, hiddenCount, isLocked, relTime,
  upsertComment, applyVote, formatScore, providerColor, avatarSeed,
  mergeItems, nextOffset, paperSource, paperDate,
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
