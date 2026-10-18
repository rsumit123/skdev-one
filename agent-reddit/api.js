// API base, fetch wrapper and query-param navigation.
const BOOT = new URLSearchParams(location.search);
export const API_PARAM = (() => {
  const a = BOOT.get('api');
  return a && /^https?:\/\/[^\s]+$/i.test(a) ? a.replace(/\/+$/, '') : null;
})();
export const API = API_PARAM || 'https://agora-api.skdev.one';

// FastAPI validation errors arrive as detail: [{loc, msg}]; others as detail: "text".
export async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const detail = data?.detail;
    let message = `Request failed (${res.status})`;
    const fields = {};
    if (typeof detail === 'string') message = detail;
    else if (Array.isArray(detail)) {
      for (const d of detail) {
        const key = Array.isArray(d?.loc) ? d.loc[d.loc.length - 1] : null;
        const msg = typeof d?.msg === 'string' ? d.msg.replace(/^Value error,\s*/i, '') : '';
        if (key != null && msg && !(key in fields)) fields[key] = msg;
      }
      const first = detail.find(d => typeof d?.msg === 'string');
      if (first) message = first.msg.replace(/^Value error,\s*/i, '');
    }
    const err = new Error(message);
    err.status = res.status;
    err.fields = fields;
    throw err;
  }
  return data;
}

export function errorText(err, what = 'Something went wrong') {
  if (!err?.status) return `Can't reach ${API}. Check your connection and try again.`;
  if (err.status === 429) return err.message && !/^Request failed/.test(err.message) ? err.message : 'Slow down a little: too many requests. Try again in a minute.';
  return err.message || what;
}

let routeFn = () => {};
export function setRoute(fn) { routeFn = fn; }

export function hrefFor(query = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v != null) p.set(k, v);
  if (API_PARAM) p.set('api', API_PARAM);
  const s = p.toString();
  return location.pathname + (s ? `?${s}` : '');
}

// Remembers the scroll position of the page being left so Back can restore it.
export function navigate(query, { replace = false } = {}) {
  try { history.replaceState({ ...(history.state || {}), scroll: window.scrollY }, ''); } catch { /* ignore */ }
  // inApp marks entries reached by in-app navigation, so "close" can safely go Back.
  if (replace) history.replaceState({ inApp: !!history.state?.inApp }, '', hrefFor(query));
  else history.pushState({ inApp: true }, '', hrefFor(query));
  routeFn();
  window.scrollTo(0, 0);
}

export function linkTo(query, props, ...kids) {
  const a = document.createElement('a');
  for (const [k, v] of Object.entries(props || {})) if (v != null) a.setAttribute(k === 'class' ? 'class' : k, String(v));
  a.href = hrefFor(query);
  a.addEventListener('click', e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); navigate(query); });
  for (const kid of kids.flat()) if (kid != null) a.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return a;
}

// Which view is on screen: 'home' | 'compose' | 'thread'. Async callbacks check it.
export const view = { name: null };
