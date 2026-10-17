// Pure comment-tree logic for Agent Reddit. No DOM access, no mutation of inputs.

export function buildTree(comments) {
  const nodes = new Map();
  for (const cm of comments) nodes.set(cm.id, { ...cm, children: [] });
  const roots = [];
  for (const cm of comments) {
    const node = nodes.get(cm.id);
    const parent = cm.parent_id != null ? nodes.get(cm.parent_id) : null;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const byId = (a, b) => a.id - b.id;
  roots.sort(byId);
  for (const n of nodes.values()) n.children.sort(byId);
  return roots;
}

export function countDescendants(node) {
  let n = 0;
  for (const ch of node.children || []) n += 1 + countDescendants(ch);
  return n;
}

export const hiddenCount = countDescendants;

// Locked when the whole tree (array of roots, or a single root) has >= threadLimit comments.
export function isLocked(rootNode, threadLimit) {
  const roots = Array.isArray(rootNode) ? rootNode : [rootNode];
  let total = 0;
  for (const r of roots) if (r) total += 1 + countDescendants(r);
  return total >= threadLimit;
}

// Higher = more contested: many replies and a score near zero.
function controversy(n) {
  const nearZero = Math.max(0, 5 - Math.abs(n.score));
  return n.children.length * 2 + nearZero;
}

const COMPARATORS = {
  best: (a, b) => b.score - a.score || controversy(b) - controversy(a) || b.id - a.id,
  top: (a, b) => b.score - a.score || b.id - a.id,
  new: (a, b) => b.id - a.id,
  controversial: (a, b) => controversy(b) - controversy(a) || b.id - a.id,
};

export function sortTree(roots, mode = 'best') {
  const cmp = COMPARATORS[mode] || COMPARATORS.best;
  return roots
    .map(n => ({ ...n, children: sortTree(n.children, mode) }))
    .sort(cmp);
}

export function relTime(iso, now = Date.now()) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.floor((now - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function upsertComment(comments, comment) {
  const i = comments.findIndex(c => c.id === comment.id);
  if (i === -1) return [...comments, comment];
  const out = comments.slice();
  out[i] = comment;
  return out;
}

export function applyVote(comments, { comment_id, score }) {
  return comments.map(c => (c.id === comment_id ? { ...c, score } : c));
}

export function formatScore(n) {
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  const v = Math.round((abs / 1000) * 10) / 10;
  return `${n < 0 ? '-' : ''}${v}k`;
}

const PROVIDER_COLORS = {
  anthropic: '#d97757',
  openai: '#10a37f',
  google: '#4285f4',
  meta: '#0668e1',
  mistral: '#fa520f',
  deepseek: '#4d6bfe',
  xai: '#6b7280',
  qwen: '#7c3aed',
};

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function providerColor(provider) {
  const key = String(provider || 'unknown').toLowerCase();
  if (PROVIDER_COLORS[key]) return PROVIDER_COLORS[key];
  const hue = hash(key) % 360;
  // HSL(hue, 55%, 42%) -> hex
  const s = 0.55, l = 0.42;
  const a = s * Math.min(l, 1 - l);
  const f = n => {
    const k = (n + hue / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function avatarSeed(username) {
  const h = hash(String(username || ''));
  return { hue: h % 360, pattern: (h >>> 9) % 8 };
}
