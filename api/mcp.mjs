// MCP server (Streamable HTTP, stateless) exposing one tool: publish_quiz.
//
// A chat session that has just written a weekly current-affairs quiz calls
// publish_quiz(slug, html). This writes the paper, updates the manifest, and
// re-renders the index at /current-affairs-paper — all via the GitHub contents
// API, so Vercel's git integration deploys it the usual way.
//
// Env: QUIZ_TOKEN      shared secret the connector sends as a bearer token
//      GITHUB_TOKEN    fine-grained PAT, contents:write, this repo only
//      GITHUB_REPO     optional, defaults to rsumit123/skdev-one
//
// No dependencies: Node 24 builtins and global fetch only.

const REPO = process.env.GITHUB_REPO || 'rsumit123/skdev-one';
const DIR = 'current-affairs-paper';
const MANIFEST = `${DIR}/weeks.json`;
const INDEX = `${DIR}/index.html`;
const SITE = 'https://skdev.one';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------- pure helpers

export function slugOk(slug) {
  return typeof slug === 'string' && /^[a-z]{3}-\d{1,2}-\d{1,2}$/.test(slug);
}

// "Current affairs quiz — 4 to 11 October 2026"      (within one month)
// "Current affairs quiz — 28 September to 4 October 2026"  (spanning two)
export function parseTitle(html) {
  const m = /<title>([^<]*)<\/title>/.exec(html);
  if (!m) throw new Error('no <title> found');
  const title = m[1].replace(/^Current affairs quiz\s*[—-]\s*/, '').trim();

  let range, endMonth, endDay, year;
  let hit = /^(\d{1,2}) to (\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(title);
  if (hit) {
    [, , endDay, endMonth, year] = hit;
    range = `${hit[1]} to ${hit[2]} ${hit[3]}`;
  } else {
    hit = /^(\d{1,2}) ([A-Za-z]+) to (\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(title);
    if (!hit) throw new Error(`cannot read a date range from "${title}"`);
    [, , , endDay, endMonth, year] = hit;
    range = `${hit[1]} ${hit[2]} to ${hit[3]} ${hit[4]}`;
  }

  const mi = MONTHS.indexOf(endMonth);
  if (mi < 0) throw new Error(`unknown month "${endMonth}"`);
  const end = `${year}-${String(mi + 1).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
  return { range, end };
}

export function extractTopics(html) {
  const found = new Set();
  for (const m of html.matchAll(/topic:\s*"([^"]+)"/g)) found.add(m[1]);
  return [...found].sort((a, b) => a.localeCompare(b, 'en'));
}

// Newest first. Re-publishing a slug replaces its entry rather than adding one.
export function upsert(weeks, entry) {
  const rest = weeks.filter((w) => w.slug !== entry.slug);
  return [...rest, entry].sort((a, b) => b.end.localeCompare(a.end));
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderIndex(weeks) {
  const items = weeks.map((w) => `
  <li>
    <a href="/${DIR}/${w.slug}">
      <p class="range">${esc(w.range)} <span class="arrow">&rarr;</span></p>
      <p class="topics">${w.topics.map(esc).join(' · ')}</p>
    </a>
  </li>
`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Current affairs quizzes</title>
<style>
  :root{ color-scheme: only light; }
  *{box-sizing:border-box}
  html{background:#F7F6F2}
  body{
    margin:0;padding:0;
    background:#F7F6F2;
    color:#1C222C;
    font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;
    line-height:1.5;
    -webkit-font-smoothing:antialiased;
  }

  .registration{display:flex;height:6px;background:#D8D5CC}
  .registration span{height:100%;flex:1 1 0}
  .reg-c{background:#0E7C9B}
  .reg-m{background:#B32570}
  .reg-y{background:#C9971B}
  .reg-k{background:#1C222C}

  .wrap{max-width:680px;margin:0 auto;padding:0 20px 96px}

  header{padding:50px 0 32px;border-bottom:1px solid #D8D5CC}
  h1{
    font-family:Georgia,"Times New Roman",serif;
    font-weight:400;font-size:40px;line-height:1.12;
    margin:0 0 14px;letter-spacing:-0.01em;color:#1C222C;
  }
  .standfirst{color:#5A6472;font-size:15px;margin:0;max-width:54ch}
  .meta{margin-top:20px;font-size:13px;color:#5A6472}

  .weeks{list-style:none;margin:0;padding:0}
  .weeks li{border-bottom:1px solid #D8D5CC}
  .weeks a{
    display:block;padding:28px 0;
    text-decoration:none;color:inherit;
  }
  .weeks a:hover .range,
  .weeks a:focus-visible .range{color:#0E7C9B}
  .weeks a:focus-visible{outline:2px solid #0E7C9B;outline-offset:4px}

  .range{
    font-family:Georgia,"Times New Roman",serif;
    font-size:24px;line-height:1.2;color:#1C222C;
    margin:0 0 8px;transition:color .15s ease;
  }
  .range .arrow{font-family:inherit;color:#5A6472;font-size:18px}
  .topics{font-size:13px;color:#5A6472;margin:0;max-width:60ch}

  @media (max-width:420px){
    header{padding:36px 0 26px}
    h1{font-size:32px}
    .range{font-size:21px}
  }
</style>
</head>
<body>

<div class="registration" aria-hidden="true">
  <span class="reg-c"></span>
  <span class="reg-m"></span>
  <span class="reg-y"></span>
  <span class="reg-k"></span>
</div>

<div class="wrap">

<header>
  <h1>Current affairs</h1>
  <p class="standfirst">A quiz a week. Ten topics, two questions each. Every question sets up its own background first, so you can reason your way through even if you missed the story when it ran.</p>
  <p class="meta">Newest first.</p>
</header>

<ul class="weeks">
${items}
</ul>

</div>

</body>
</html>
`;
}

// ------------------------------------------------------------------- GitHub IO

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'skdev-quiz-publisher',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${init.method || 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function readFile(path) {
  const got = await gh(path);
  if (!got) return { text: null, sha: undefined };
  return { text: Buffer.from(got.content, 'base64').toString('utf8'), sha: got.sha };
}

async function writeFile(path, text, message) {
  const { sha } = await readFile(path);
  const out = await gh(path, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: Buffer.from(text, 'utf8').toString('base64'),
      ...(sha ? { sha } : {}),
    }),
  });
  return out.commit.sha;
}

// ------------------------------------------------------------------- the tool

async function publishQuiz({ slug, html }) {
  if (!slugOk(slug)) {
    throw new Error(`slug "${slug}" must look like "oct-4-11" (three-letter month, start day, end day)`);
  }
  if (typeof html !== 'string' || !html.includes('<title>')) {
    throw new Error('html must be the full quiz page');
  }

  const { range, end } = parseTitle(html);
  const topics = extractTopics(html);

  // Paper first, then the manifest, then the index: no intermediate state has
  // the index pointing at a paper that is not there yet.
  await writeFile(`${DIR}/${slug}/index.html`, html, `Current affairs: publish the ${range} quiz`);

  const { text } = await readFile(MANIFEST);
  const weeks = upsert(text ? JSON.parse(text) : [], { slug, range, end, topics });

  await writeFile(MANIFEST, `${JSON.stringify(weeks, null, 2)}\n`, `Current affairs: record ${slug} in the manifest`);
  const sha = await writeFile(INDEX, renderIndex(weeks), `Current affairs: rebuild the index for ${slug}`);

  return `Committed ${sha.slice(0, 7)}. Vercel is deploying now — live in about 30 seconds at ${SITE}/${DIR}/${slug}, and listed on ${SITE}/${DIR}.`;
}

const TOOLS = [{
  name: 'publish_quiz',
  description:
    'Publish a weekly current-affairs quiz to skdev.one. Pass the complete, finished HTML page; '
    + 'it is committed as-is. The index at /current-affairs-paper is regenerated automatically — '
    + 'do not try to edit it yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description: 'URL segment for the week: three-letter lowercase month, start day, end day. E.g. "oct-4-11".',
      },
      html: {
        type: 'string',
        description: 'The full quiz page, starting <!DOCTYPE html>. Its <title> must read '
          + '"Current affairs quiz — <start> to <end> <Month> <Year>" so the date can be read off it.',
      },
    },
    required: ['slug', 'html'],
  },
}];

// -------------------------------------------------------------- HTTP transport

const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });

async function dispatch(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return rpc(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'skdev-quiz', version: '1.0.0' },
    });
  }
  if (method === 'tools/list') return rpc(id, { tools: TOOLS });
  if (method === 'ping') return rpc(id, {});

  if (method === 'tools/call') {
    if (params?.name !== 'publish_quiz') {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } };
    }
    try {
      const text = await publishQuiz(params.arguments || {});
      return rpc(id, { content: [{ type: 'text', text }] });
    } catch (err) {
      return rpc(id, { content: [{ type: 'text', text: `Not published: ${err.message}` }], isError: true });
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method === 'GET' || req.method === 'DELETE') {
    // Stateless: no server-initiated streams, no sessions to tear down.
    return res.status(req.method === 'GET' ? 405 : 204).end();
  }
  if (req.method !== 'POST') return res.status(405).end();

  const want = process.env.QUIZ_TOKEN;
  if (!want || req.headers.authorization !== `Bearer ${want}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Don't rely on the runtime having parsed the body for us: read the stream
  // ourselves when it hasn't. Getting this wrong is invisible - an unparsed
  // body looks like a notification, and the handshake 202s into silence.
  let msg = req.body;
  if (msg === undefined || msg === null) msg = await readBody(req);
  if (typeof msg === 'string') {
    try {
      msg = JSON.parse(msg || '{}');
    } catch {
      return res.status(400).json({
        jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' },
      });
    }
  }

  if (typeof msg !== 'object' || !msg.method) {
    return res.status(400).json({
      jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' },
    });
  }

  // Notifications carry a method but no id, and expect no body back.
  if (msg.id === undefined) return res.status(202).end();

  try {
    return res.status(200).json(await dispatch(msg));
  } catch (err) {
    return res.status(200).json({
      jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message },
    });
  }
}
