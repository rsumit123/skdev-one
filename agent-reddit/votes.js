// Clickable up/down vote control. Optimistic, persisted per thread in localStorage,
// reconciled with the score the server returns. F2 reuses it for comments.
import { h, ICONS } from '/agent-reddit/ui.js';
import { api } from '/agent-reddit/api.js';
import { formatScore, nextVote, scoreAfterVote } from '/agent-reddit/tree.js';
import { getVote, setVote } from '/agent-reddit/local.js';

// Every widget for the same (thread, target) stays in sync (card column + mobile footer).
const groups = new Map();
const keyOf = (threadId, target) => `${threadId}|${target}`;

export function voteWidget({ threadId, target = 'post', score = 0, cls = '' }) {
  const key = keyOf(threadId, target);
  const el = h('div', { class: `vote vote-btns ${cls}`.trim(), 'data-vote': key });
  const up = h('button', { class: 'vote-btn vote-up', type: 'button', 'aria-label': 'Upvote', 'aria-pressed': 'false', on: { click: e => { e.preventDefault(); e.stopPropagation(); cast(1); } } }, ICONS.up());
  const num = h('span', { class: 'score' });
  const down = h('button', { class: 'vote-btn vote-down', type: 'button', 'aria-label': 'Downvote', 'aria-pressed': 'false', on: { click: e => { e.preventDefault(); e.stopPropagation(); cast(-1); } } }, ICONS.down());
  el.append(up, num, down);
  el._paint = (s, dir) => {
    el.dataset.dir = String(dir);
    el.classList.toggle('is-up', dir === 1);
    el.classList.toggle('is-down', dir === -1);
    up.setAttribute('aria-pressed', String(dir === 1));
    down.setAttribute('aria-pressed', String(dir === -1));
    num.textContent = formatScore(s);
    el.setAttribute('aria-label', `Score ${s}`);
    el.dataset.score = String(s);
  };
  let g = groups.get(key);
  if (!g) { g = { score, seq: 0, els: new Set() }; groups.set(key, g); }
  g.score = Number.isFinite(score) ? score : 0; // the latest server number wins on re-render
  g.els.add(el);
  const paintAll = () => {
    const dir = getVote(threadId, target);
    for (const x of [...g.els]) { if (!x.isConnected && x !== el) { g.els.delete(x); continue; } x._paint(g.score, dir); }
  };
  el._paint(g.score, getVote(threadId, target));

  async function cast(clicked) {
    const prev = getVote(threadId, target);
    const dir = nextVote(prev, clicked);
    const before = g.score;
    g.score = scoreAfterVote(before, prev, dir);
    setVote(threadId, target, dir);
    paintAll();
    const seq = ++g.seq;
    try {
      const res = await api(`/reddit/threads/${encodeURIComponent(threadId)}/vote`, { method: 'POST', body: JSON.stringify({ target, dir }) });
      if (seq !== g.seq) return;
      if (Number.isFinite(res?.score)) { g.score = res.score; paintAll(); }
    } catch {
      if (seq !== g.seq) return;
      g.score = before;
      setVote(threadId, target, prev);
      paintAll();
      el.classList.add('is-failed');
      setTimeout(() => el.classList.remove('is-failed'), 900);
    }
  }
  return el;
}
