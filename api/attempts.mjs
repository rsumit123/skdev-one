// Shared attempt records for the weekly current-affairs quizzes.
//
//   POST /api/attempts              record an attempt
//   GET  /api/attempts?week=<slug>  attempts for one week, newest first
//   GET  /api/attempts?weeks=a,b,c  per-week summary for the index
//   GET  /api/attempts              diagnostic: is this wired up?
//
// Storage is a JSON file per week in the repo, on a separate `attempts`
// branch that Vercel is told not to deploy - so recording a score neither
// clutters main's history nor triggers a rebuild of the site. It is sized for
// a handful of friends, not a leaderboard: concurrent writes are resolved by
// GitHub's own optimistic concurrency (a stale sha is rejected, and we retry
// against the fresh file) rather than by a database.
//
// The POST is deliberately open: friends have no account and no token, so
// anyone who can open the quiz page can record a score, and names are
// self-asserted. The caps below guard against runaway writes, not against
// someone typing a name that isn't theirs.
//
// No dependencies: Node builtins and global fetch only.

import { slugOk } from './mcp.mjs';

const REPO = process.env.GITHUB_REPO || 'rsumit123/skdev-one';
const BRANCH = process.env.ATTEMPTS_BRANCH || 'attempts';
const API = 'https://api.github.com';

const MAX_BODY = 8 * 1024;
const MAX_NAME = 24;
const MAX_TOTAL = 100;
const MAX_ROWS = 200;        // per week, oldest dropped beyond this
const MAX_PER_NAME = 50;     // per week
const DEDUPE_MS = 10_000;    // an identical resubmit this soon is a double-click
const WRITE_ATTEMPTS = 4;    // retries when someone else wrote first
const MAX_WEEKS_PER_QUERY = 20;

// ----------------------------------------------------------------- validation

// Names are rendered in other people's browsers. The client renders with
// textContent, never innerHTML, but don't rely on that alone.
export function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const stripped = raw
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return null;
  return stripped.slice(0, MAX_NAME);
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

export function validateAttempt(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('expected a JSON object');

  const { week, name, score, total, wrong } = body;
  if (!slugOk(week)) throw new Error('bad week');

  const cleaned = cleanName(name);
  if (!cleaned) throw new Error('a name is required');

  if (!isInt(total, 1, MAX_TOTAL)) throw new Error('bad total');
  if (!isInt(score, 0, total)) throw new Error('bad score');

  if (!Array.isArray(wrong)) throw new Error('bad wrong list');
  const indices = [...new Set(wrong)];
  for (const i of indices) if (!isInt(i, 0, total - 1)) throw new Error('bad wrong list');
  if (indices.length !== total - score) throw new Error('wrong list does not match the score');

  return {
    week,
    row: { name: cleaned, score, total, wrong: indices.sort((a, b) => a - b), at: Date.now() },
  };
}

export function isDuplicate(rows, row) {
  return rows.some((r) => r.name === row.name
    && r.score === row.score
    && Math.abs(row.at - r.at) < DEDUPE_MS
    && String(r.wrong) === String(row.wrong));
}

// Newest first, capped per name and overall.
export function addRow(rows, row) {
  if (rows.filter((r) => r.name === row.name).length >= MAX_PER_NAME) {
    throw new Error(`that name already has ${MAX_PER_NAME} attempts this week`);
  }
  return [row, ...rows].slice(0, MAX_ROWS);
}

export function summarise(week, rows) {
  if (!rows.length) return { week, attempts: 0 };
  const best = rows.reduce((a, b) => (b.score > a.score ? b : a));
  return { week, attempts: rows.length, best: best.score, total: best.total };
}

export function parseRows(text) {
  if (!text) return [];
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : data.attempts;
  if (!Array.isArray(list)) return [];
  return list.filter((r) => r && typeof r.name === 'string' && Number.isInteger(r.score));
}

// -------------------------------------------------------------------- storage

const pathFor = (week) => `attempts/${week}.json`;

async function ghFetch(path, init = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('not configured');

  return fetch(`${API}/repos/${REPO}/contents/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'skdev-quiz-attempts',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

async function readWeek(week) {
  const res = await ghFetch(`${pathFor(week)}?ref=${encodeURIComponent(BRANCH)}`);
  if (res.status === 404) return { rows: [], sha: undefined };
  if (!res.ok) throw new Error(`storage read ${res.status}`);
  const got = await res.json();
  return {
    rows: parseRows(Buffer.from(got.content, 'base64').toString('utf8')),
    sha: got.sha,
  };
}

// Read, add, write. If someone else wrote in between, GitHub rejects the stale
// sha and we start over against the fresh file rather than overwriting them.
async function recordRow(week, row) {
  let lastConflict;

  for (let i = 0; i < WRITE_ATTEMPTS; i++) {
    const { rows, sha } = await readWeek(week);
    if (isDuplicate(rows, row)) return { row, duplicate: true };

    const next = addRow(rows, row);
    const body = `${JSON.stringify({ week, attempts: next }, null, 2)}\n`;

    const res = await ghFetch(pathFor(week), {
      method: 'PUT',
      body: JSON.stringify({
        message: `Attempt: ${row.name} scored ${row.score}/${row.total} on ${week}`,
        content: Buffer.from(body, 'utf8').toString('base64'),
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });

    if (res.ok) return { row, duplicate: false };
    if (res.status === 409 || res.status === 422) {
      lastConflict = res.status;
      continue;
    }
    throw new Error(`storage write ${res.status}`);
  }

  throw new Error(`storage busy (${lastConflict}), try again`);
}

// ------------------------------------------------------------------- handlers

async function readBody(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body !== 'string') return req.body;

  let raw = typeof req.body === 'string' ? req.body : '';
  if (!raw) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw new Error('payload too large');
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  }
  if (raw.length > MAX_BODY) throw new Error('payload too large');
  return JSON.parse(raw || '{}');
}

async function handlePost(req, res) {
  let parsed;
  try {
    parsed = validateAttempt(await readBody(req));
  } catch (err) {
    return res.status(/too large/.test(err.message) ? 413 : 400).json({ error: err.message });
  }

  try {
    const out = await recordRow(parsed.week, parsed.row);
    return res.status(out.duplicate ? 200 : 201).json({ recorded: out.row, duplicate: out.duplicate });
  } catch (err) {
    if (/attempts this week/.test(err.message)) return res.status(429).json({ error: err.message });
    throw err;
  }
}

async function handleGet(req, res, query) {
  const week = query.get('week');
  const weeks = query.get('weeks');

  if (!week && !weeks) {
    // Diagnostic: enough to confirm it is wired, no secrets.
    return res.status(200).json({
      storage: process.env.GITHUB_TOKEN ? 'ok' : 'unconfigured',
      repo: REPO,
      branch: BRANCH,
    });
  }

  if (week) {
    if (!slugOk(week)) return res.status(400).json({ error: 'bad week' });
    const { rows } = await readWeek(week);
    return res.status(200).json({ week, attempts: rows });
  }

  const slugs = [...new Set(weeks.split(',').map((s) => s.trim()).filter(Boolean))];
  if (!slugs.length || slugs.length > MAX_WEEKS_PER_QUERY || !slugs.every(slugOk)) {
    return res.status(400).json({ error: 'bad weeks' });
  }
  const all = await Promise.all(slugs.map(async (s) => summarise(s, (await readWeek(s)).rows)));
  return res.status(200).json({ summary: all });
}

export default async function handler(req, res) {
  const query = new URL(req.url, 'https://skdev.one').searchParams;

  try {
    if (req.method === 'POST') return await handlePost(req, res);
    if (req.method === 'GET') return await handleGet(req, res, query);
    res.setHeader('allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    return res.status(/not configured/.test(err.message) ? 503 : 500).json({ error: err.message });
  }
}
