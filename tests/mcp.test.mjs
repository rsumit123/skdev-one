// node --test tests/mcp.test.mjs
//
// Covers the pure helpers in api/mcp.mjs. Nothing here touches the network:
// the GitHub calls live behind publishQuiz, which these tests never invoke.

import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/mcp.mjs';
import { slugOk, parseTitle, extractTopics, upsert, renderIndex, injectAttempts, ATTEMPTS_TAG } from '../api/mcp.mjs';

const PAPER = [
  '<!DOCTYPE html><html><head><title>Current affairs quiz — 4 to 11 October 2026</title></head>',
  '<body><div class="wrap"></div>',
  '<script>',
  'const QUESTIONS = [{ topic: "GST reform", a: 0 }];',
  '</script>',
  '</body></html>',
].join('\n');

test('injectAttempts puts the tag after the paper\'s own script, so QUESTIONS exists', () => {
  const out = injectAttempts(PAPER);
  assert.ok(out.includes(ATTEMPTS_TAG));
  assert.ok(out.indexOf(ATTEMPTS_TAG) > out.lastIndexOf('const QUESTIONS'),
    'the tag must come after the inline script that defines QUESTIONS');
  assert.ok(out.indexOf(ATTEMPTS_TAG) < out.indexOf('</body>'));
});

test('injectAttempts leaves the rest of the paper byte-for-byte alone', () => {
  const out = injectAttempts(PAPER);
  assert.equal(out.replace(`\n${ATTEMPTS_TAG}`, ''), PAPER);
});

test('injectAttempts is idempotent, so republishing does not double up', () => {
  const once = injectAttempts(PAPER);
  assert.equal(injectAttempts(once), once);
  assert.equal(once.split('attempts.js').length - 1, 1);
});

test('injectAttempts copes with a paper that has no inline script', () => {
  const bare = '<html><body><p>hi</p></body></html>';
  const out = injectAttempts(bare);
  assert.ok(out.includes(ATTEMPTS_TAG));
  assert.ok(out.indexOf(ATTEMPTS_TAG) < out.indexOf('</body>'));
});

test('injectAttempts still adds the tag to a fragment with no body', () => {
  assert.ok(injectAttempts('<p>hi</p>').includes(ATTEMPTS_TAG));
});

test('renderIndex carries the slug and a placeholder for scores', () => {
  const html = renderIndex([{ slug: 'oct-4-11', range: '4 to 11 October', end: '2026-10-11', topics: ['GST reform'] }]);
  assert.match(html, /<li data-slug="oct-4-11">/);
  assert.match(html, /<p class="scores" hidden><\/p>/);
  assert.match(html, /attempts-summary\.js/);
});

test('slugOk accepts the shape we publish under', () => {
  for (const s of ['oct-4-11', 'sep-9-13', 'sep-14-20', 'jan-1-7']) {
    assert.equal(slugOk(s), true, s);
  }
});

test('slugOk rejects traversal and junk', () => {
  for (const s of ['../../etc/passwd', 'oct-4-11/../..', 'October-4-11', 'oct_4_11',
    'oct-4', '', 'oct-4-11 ', undefined, null, 42]) {
    assert.equal(slugOk(s), false, String(s));
  }
});

test('parseTitle reads a week inside one month', () => {
  const { range, end } = parseTitle('<title>Current affairs quiz — 4 to 11 October 2026</title>');
  assert.equal(range, '4 to 11 October');
  assert.equal(end, '2026-10-11');
});

test('parseTitle reads a week spanning two months', () => {
  const { range, end } = parseTitle('<title>Current affairs quiz — 28 September to 4 October 2026</title>');
  assert.equal(range, '28 September to 4 October');
  assert.equal(end, '2026-10-04');
});

test('parseTitle pads single-digit days and months', () => {
  assert.equal(parseTitle('<title>Current affairs quiz — 1 to 7 January 2027</title>').end, '2027-01-07');
});

test('parseTitle refuses a title it cannot date', () => {
  assert.throws(() => parseTitle('<title>Current affairs quiz — sometime last week</title>'), /cannot read a date range/);
  assert.throws(() => parseTitle('<title>Current affairs quiz — 4 to 11 Octobre 2026</title>'), /unknown month "Octobre"/);
  assert.throws(() => parseTitle('<html><body>no title</body></html>'), /no <title>/);
});

test('extractTopics dedupes and sorts', () => {
  const html = 'topic: "Ukraine war", topic: "AI governance", topic: "Ukraine war", topic: "GST reform"';
  assert.deepEqual(extractTopics(html), ['AI governance', 'GST reform', 'Ukraine war']);
});

test('upsert adds newest first', () => {
  const a = { slug: 'sep-9-13', end: '2026-09-13', range: '9 to 13 September', topics: [] };
  const b = { slug: 'oct-4-11', end: '2026-10-11', range: '4 to 11 October', topics: [] };
  assert.deepEqual(upsert([a], b).map((w) => w.slug), ['oct-4-11', 'sep-9-13']);
});

test('upsert replaces a republished week instead of duplicating it', () => {
  const first = { slug: 'oct-4-11', end: '2026-10-11', range: '4 to 11 October', topics: ['old'] };
  const again = { slug: 'oct-4-11', end: '2026-10-11', range: '4 to 11 October', topics: ['new'] };
  const out = upsert([first], again);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].topics, ['new']);
});

test('renderIndex links every week and escapes topic text', () => {
  const html = renderIndex([
    { slug: 'oct-4-11', range: '4 to 11 October', end: '2026-10-11', topics: ['Tata & Sons', 'GST reform'] },
  ]);
  assert.match(html, /href="\/current-affairs-paper\/oct-4-11"/);
  assert.match(html, /4 to 11 October/);
  assert.match(html, /Tata &amp; Sons · GST reform/);
  assert.doesNotMatch(html, /Tata & Sons/);
});

test('renderIndex uses root-absolute links, never relative', () => {
  const html = renderIndex([{ slug: 'oct-4-11', range: '4 to 11 October', end: '2026-10-11', topics: [] }]);
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    assert.ok(m[1].startsWith('/'), `relative href would 404: ${m[1]}`);
  }
});

// A bare response double: enough for the handler's status/json/end calls.
function fakeRes() {
  const r = { code: null, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

test('handler rejects a request with no bearer token', async () => {
  process.env.QUIZ_TOKEN = 'secret';
  const res = fakeRes();
  await handler({ method: 'POST', headers: {}, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, res);
  assert.equal(res.code, 401);
});

test('handler rejects a wrong bearer token', async () => {
  process.env.QUIZ_TOKEN = 'secret';
  const res = fakeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer nope' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, res);
  assert.equal(res.code, 401);
});

test('handler refuses everything when QUIZ_TOKEN is unset', async () => {
  delete process.env.QUIZ_TOKEN;
  const res = fakeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer ' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, res);
  assert.equal(res.code, 401);
});

test('handler lists both tools once authorized', async () => {
  process.env.QUIZ_TOKEN = 'secret';
  const res = fakeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer secret' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.result.tools.map((t) => t.name), ['publish_quiz', 'list_weeks']);
});

test('list_weeks takes no required arguments', async () => {
  process.env.QUIZ_TOKEN = 'secret';
  const res = fakeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer secret' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, res);
  const listed = res.body.result.tools.find((t) => t.name === 'list_weeks');
  assert.deepEqual(listed.inputSchema.required, undefined);
});

test('an unknown tool name is a protocol error, not a silent success', async () => {
  process.env.QUIZ_TOKEN = 'secret';
  const res = fakeRes();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer secret' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } },
  }, res);
  assert.equal(res.body.error.code, -32602);
  assert.match(res.body.error.message, /unknown tool delete_everything/);
});

test('handler answers initialize with the protocol the client asked for', async () => {
  process.env.QUIZ_TOKEN = 'secret';
  const res = fakeRes();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer secret' },
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
  }, res);
  assert.equal(res.body.result.protocolVersion, '2024-11-05');
  assert.equal(res.body.result.serverInfo.name, 'skdev-quiz');
});

test('handler acks notifications with 202 and no body', async () => {
  process.env.QUIZ_TOKEN = 'secret';
  const res = fakeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer secret' }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } }, res);
  assert.equal(res.code, 202);
  assert.equal(res.body, null);
});

// The runtime may hand us a parsed object, a string, or nothing at all. The
// last case is the dangerous one: an unread body looks exactly like a
// notification, so the handshake would 202 into silence.
function streamReq(raw, headers = { authorization: 'Bearer secret' }) {
  return {
    method: 'POST',
    headers,
    body: undefined,
    async* [Symbol.asyncIterator]() { yield Buffer.from(raw, 'utf8'); },
  };
}

test('handler reads the body off the stream when the runtime did not parse it', async () => {
  process.env.QUIZ_TOKEN = 'secret';
  const res = fakeRes();
  await handler(streamReq('{"jsonrpc":"2.0","id":7,"method":"tools/list"}'), res);
  assert.equal(res.code, 200);
  assert.equal(res.body.id, 7);
  assert.deepEqual(res.body.result.tools.map((t) => t.name), ['publish_quiz', 'list_weeks']);
});

test('handler accepts a body handed over as a string', async () => {
  process.env.QUIZ_TOKEN = 'secret';
  const res = fakeRes();
  await handler({ method: 'POST', headers: { authorization: 'Bearer secret' }, body: '{"jsonrpc":"2.0","id":2,"method":"ping"}' }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.result, {});
});

test('handler reports malformed JSON rather than mistaking it for a notification', async () => {
  process.env.QUIZ_TOKEN = 'secret';
  const res = fakeRes();
  await handler(streamReq('{not json'), res);
  assert.equal(res.code, 400);
  assert.equal(res.body.error.code, -32700);
});

test('handler rejects an empty body rather than 202-ing into silence', async () => {
  process.env.QUIZ_TOKEN = 'secret';
  const res = fakeRes();
  await handler(streamReq(''), res);
  assert.equal(res.code, 400);
  assert.equal(res.body.error.code, -32600);
});

test('a bad slug is reported as a tool error, not a crash, and never reaches GitHub', async () => {
  process.env.QUIZ_TOKEN = 'secret';
  process.env.GITHUB_TOKEN = 'must-not-be-used';
  const res = fakeRes();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer secret' },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'publish_quiz', arguments: { slug: '../evil', html: '<title>Current affairs quiz — 4 to 11 October 2026</title>' } },
    },
  }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /must look like/);
});
