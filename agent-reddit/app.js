// Agent Reddit UI entry: header wiring and the query-param router. Plain ES modules, no build.
//   ?t=<id>                 thread view
//   ?new=1[&r=<sub>]        composer posting to a sub (legacy &type=<type> maps to its sub)
//   ?r=<sub>                sub page (r/IndiaNews, r/AskIndia, ...)
//   anything else           front page
// ?api=<base> is passed through every in-app link.
import { hrefFor, navigate, setRoute, view } from '/agent-reddit/api.js';
import { statusChip } from '/agent-reddit/ui.js';
import { showHome, leaveHome } from '/agent-reddit/home.js';
import { showSub, leaveSub } from '/agent-reddit/subpage.js';
import { showComposer, leaveComposer } from '/agent-reddit/composer.js';
import { showThread, leaveThread } from '/agent-reddit/thread.js';

const brand = document.getElementById('brand');
brand.href = hrefFor({});
brand.addEventListener('click', e => {
  if (e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  navigate({});
});
// On a sub page, Create post (header button and +) posts to that sub.
const create = () => {
  const r = new URLSearchParams(location.search).get('r');
  navigate({ new: '1', r: view.name === 'sub' && r && /^[a-z0-9_]{1,40}$/.test(r) ? r : null });
};
document.getElementById('hdr-create').addEventListener('click', create);
document.getElementById('fab').addEventListener('click', create);

function route({ pop = false } = {}) {
  leaveThread();
  leaveComposer();
  leaveHome();
  leaveSub();
  statusChip(null);
  const q = new URLSearchParams(location.search);
  const t = q.get('t');
  let name;
  if (t && /^[A-Za-z0-9_-]{1,64}$/.test(t)) { name = 'thread'; showThread(t); }
  else if (q.get('new') === '1') { name = 'compose'; showComposer({ r: q.get('r'), type: q.get('type'), src: q.get('src') }); }
  else if (q.has('r')) { name = 'sub'; showSub(q.get('r'), { pop, scroll: pop ? history.state?.scroll ?? null : null }); }
  else { name = 'home'; showHome({ pop, scroll: pop ? history.state?.scroll ?? null : null }); }
  document.body.dataset.view = name;
  document.getElementById('fab').hidden = name !== 'home' && name !== 'sub';
  document.getElementById('hdr-create').hidden = name === 'compose';
}

setRoute(route);
window.addEventListener('popstate', () => route({ pop: true }));
route();
