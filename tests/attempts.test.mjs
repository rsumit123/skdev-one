// node --test tests/attempts.test.mjs
//
// Pure helpers only: nothing here reaches GitHub.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanName, validateAttempt, isDuplicate, addRow, summarise, parseRows } from '../api/attempts.mjs';

const ok = (over = {}) => ({ week: 'oct-4-11', name: 'Sumit', score: 18, total: 20, wrong: [3, 11], ...over });

test('cleanName trims, collapses whitespace and caps length', () => {
  assert.equal(cleanName('  Sumit   K  '), 'Sumit K');
  assert.equal(cleanName('x'.repeat(50)).length, 24);
});

test('cleanName strips control characters rather than storing them', () => {
  assert.equal(cleanName('Su\u0000mit\u001b[31m'), 'Su mit [31m');
  assert.equal(cleanName('a\nb\tc'), 'a b c');
});

test('cleanName rejects names that are empty once cleaned', () => {
  for (const n of ['', '   ', '\n\t', '\u0000', undefined, null, 42, {}]) {
    assert.equal(cleanName(n), null, JSON.stringify(n));
  }
});

test('cleanName keeps markup as literal text, to be rendered inert via textContent', () => {
  // Not escaped here on purpose - the renderer uses textContent, never
  // innerHTML, so the characters stay harmless without being mangled.
  assert.equal(cleanName('<b>Ana</b>'), '<b>Ana</b>');
  // Anything longer still hits the length cap, which is its own defence.
  assert.equal(cleanName('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert');
});

test('validateAttempt accepts a well-formed attempt', () => {
  const { week, row } = validateAttempt(ok());
  assert.equal(week, 'oct-4-11');
  assert.equal(row.name, 'Sumit');
  assert.equal(row.score, 18);
  assert.deepEqual(row.wrong, [3, 11]);
  assert.ok(row.at > 0);
});

test('validateAttempt refuses a week that is not a real slug', () => {
  for (const w of ['../../etc', 'October', '', undefined]) {
    assert.throws(() => validateAttempt(ok({ week: w })), /bad week/);
  }
});

test('validateAttempt requires the wrong list to match the score', () => {
  assert.throws(() => validateAttempt(ok({ score: 18, wrong: [1] })), /does not match/);
  assert.throws(() => validateAttempt(ok({ score: 20, wrong: [1, 2] })), /does not match/);
  assert.doesNotThrow(() => validateAttempt(ok({ score: 20, wrong: [] })));
});

test('validateAttempt refuses out-of-range and non-integer scores', () => {
  assert.throws(() => validateAttempt(ok({ score: 21, wrong: [] })), /bad score/);
  assert.throws(() => validateAttempt(ok({ score: -1 })), /bad score/);
  assert.throws(() => validateAttempt(ok({ score: 18.5 })), /bad score/);
  assert.throws(() => validateAttempt(ok({ total: 0 })), /bad total/);
});

test('validateAttempt refuses question indices outside the paper', () => {
  assert.throws(() => validateAttempt(ok({ wrong: [3, 20] })), /bad wrong list/);
  assert.throws(() => validateAttempt(ok({ wrong: [3, -1] })), /bad wrong list/);
  assert.throws(() => validateAttempt(ok({ wrong: [3, '11'] })), /bad wrong list/);
});

test('validateAttempt dedupes repeated indices before checking the score', () => {
  const { row } = validateAttempt(ok({ score: 19, wrong: [5, 5] }));
  assert.deepEqual(row.wrong, [5]);
});

test('validateAttempt rejects a non-object body', () => {
  for (const b of [null, undefined, 'x', 42, []]) {
    assert.throws(() => validateAttempt(b), /expected a JSON object/);
  }
});

test('isDuplicate catches a double-click but not a genuine retake', () => {
  const now = Date.now();
  const rows = [{ name: 'Sumit', score: 18, total: 20, wrong: [3, 11], at: now }];
  assert.equal(isDuplicate(rows, { name: 'Sumit', score: 18, wrong: [3, 11], at: now + 500 }), true);
  // Same score much later is a real second attempt.
  assert.equal(isDuplicate(rows, { name: 'Sumit', score: 18, wrong: [3, 11], at: now + 60_000 }), false);
  // Same moment, different answers.
  assert.equal(isDuplicate(rows, { name: 'Sumit', score: 18, wrong: [4, 12], at: now + 500 }), false);
  // Same moment, different person.
  assert.equal(isDuplicate(rows, { name: 'Ana', score: 18, wrong: [3, 11], at: now + 500 }), false);
});

test('addRow puts the newest attempt first', () => {
  const rows = addRow([{ name: 'Ana', score: 1, at: 1 }], { name: 'Sumit', score: 2, at: 2 });
  assert.deepEqual(rows.map((r) => r.name), ['Sumit', 'Ana']);
});

test('addRow caps the file so it cannot grow without bound', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ name: `p${i}`, score: 1, at: i }));
  assert.equal(addRow(many, { name: 'new', score: 1, at: 999 }).length, 200);
});

test('addRow refuses one name monopolising a week', () => {
  const mine = Array.from({ length: 50 }, (_, i) => ({ name: 'Sumit', score: 1, at: i }));
  assert.throws(() => addRow(mine, { name: 'Sumit', score: 1, at: 99 }), /already has 50 attempts/);
  assert.doesNotThrow(() => addRow(mine, { name: 'Ana', score: 1, at: 99 }));
});

test('summarise reports the best score, not the latest', () => {
  const rows = [{ name: 'a', score: 11, total: 20 }, { name: 'b', score: 19, total: 20 }];
  assert.deepEqual(summarise('oct-4-11', rows), { week: 'oct-4-11', attempts: 2, best: 19, total: 20 });
});

test('summarise handles a week nobody has attempted', () => {
  assert.deepEqual(summarise('oct-4-11', []), { week: 'oct-4-11', attempts: 0 });
});

test('parseRows survives a corrupt or empty file instead of failing the request', () => {
  assert.deepEqual(parseRows(''), []);
  assert.deepEqual(parseRows('{not json'), []);
  assert.deepEqual(parseRows('{"week":"x"}'), []);
  assert.deepEqual(parseRows('[{"name":"a","score":1},{"bad":true},{"name":"b"}]'), [{ name: 'a', score: 1 }]);
});

test('parseRows accepts both the wrapped and bare array shapes', () => {
  assert.deepEqual(parseRows('{"week":"x","attempts":[{"name":"a","score":2}]}'), [{ name: 'a', score: 2 }]);
  assert.deepEqual(parseRows('[{"name":"a","score":2}]'), [{ name: 'a', score: 2 }]);
});
