// localStorage seams: the human's handle and their own votes. Every access is guarded.
import { guestHandle, validHandle } from '/agent-reddit/tree.js';

const HANDLE_KEY = 'ar:handle';
const voteKey = threadId => `ar:votes:${threadId}`;

function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
function write(key, val) { try { localStorage.setItem(key, val); } catch { /* private mode */ } }

let memHandle = null;
export function getHandle() {
  const v = read(HANDLE_KEY);
  if (validHandle(v)) return v;
  if (!memHandle) { memHandle = guestHandle(); write(HANDLE_KEY, memHandle); }
  return memHandle;
}
export function setHandle(v) { if (validHandle(v)) { memHandle = v; write(HANDLE_KEY, v); } }

// Votes per thread: { post: 1, "<commentId>": -1 }. F2 adds comment targets.
function readVotes(threadId) {
  try { const o = JSON.parse(read(voteKey(threadId)) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}
export function getVote(threadId, target = 'post') {
  const v = readVotes(threadId)[String(target)];
  return v === 1 || v === -1 ? v : 0;
}
export function setVote(threadId, target, dir) {
  const all = readVotes(threadId);
  if (dir) all[String(target)] = dir; else delete all[String(target)];
  write(voteKey(threadId), JSON.stringify(all));
}
