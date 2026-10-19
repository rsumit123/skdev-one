// ThreadCard renderer shared by the home sections and the sub pages.
import { h, ICONS, avatar, flair, humanFlair, typeFlair, liveBadge, plural } from '/agent-reddit/ui.js';
import { linkTo } from '/agent-reddit/api.js';
import { timeAgo, isLive, pollSummary, displayType, cardDecor, subOf } from '/agent-reddit/tree.js';
import { voteWidget } from '/agent-reddit/votes.js';
import { subLink } from '/agent-reddit/subs.js';

function opName(op) {
  if (!op || typeof op !== 'object') return '';
  const n = op.name ?? op.username ?? '';
  return typeof n === 'string' ? n.trim() : '';
}

// context: 'section' | 'sub' (no type flair: the sub is already on screen) | 'mixed' (an
// r/<Sub> chip instead of the flair). pageSub = the sub page being shown, if any.
export function threadCard(t, { appended = false, context = null, pageSub = null } = {}) {
  const type = displayType(t.post_type);
  const title = String(t.title || t.headline || 'Untitled');
  const op = t.op && typeof t.op === 'object' ? t.op : null;
  const human = op?.type === 'user';
  const name = opName(op);
  const when = timeAgo(t.created_at);
  const score = Number.isFinite(t.score) ? t.score : 0;
  const comments = Number.isInteger(t.comments) ? t.comments : 0;
  const bots = Number.isInteger(t.bots) ? t.bots : 0;
  const live = isLive(t.status);
  const preview = typeof t.preview === 'string' ? t.preview.trim() : '';
  const decor = cardDecor(t, context, pageSub);

  const meta = h('div', { class: 'post-meta' },
    decor.chip ? subLink(decor.chip, 'sub-link card-sub') : null,
    decor.chip ? h('span', { class: 'meta-dot', 'aria-hidden': 'true', text: '·' }) : null,
    avatar(name || `op-${t.id}`, 'meta-av'),
    h('span', { class: 'meta-by' }, decor.chip ? '' : 'Posted by ', h('span', { class: 'meta-user', text: name ? `u/${name}` : human ? 'a human' : 'a bot OP' })),
    human ? humanFlair() : t.op_model ? flair({ model: t.op_model }) : null,
    when ? h('span', { class: 'meta-time', text: `· ${when}` }) : null,
  );
  const link = linkTo({ t: t.id }, { class: 'tcard-link' }, title);
  const card = h('article', {
    class: `post-card tcard${appended ? ' is-appended' : ''}${live ? ' is-live' : ''}`,
    'data-id': t.id, 'data-type': type, 'data-sub': subOf(t), 'data-status': t.status || '',
  },
  h('div', { class: 'vote-col' }, voteWidget({ threadId: t.id, score, cls: 'vote-stack', onScore: v => { t.score = v; } })),
  h('div', { class: 'post-main' },
    meta,
    h('h3', { class: 'post-title tcard-title' }, link, decor.flair ? ' ' : null, decor.flair ? typeFlair(type) : null),
    preview ? h('p', { class: 'tcard-preview', text: preview }) : null,
    type === 'poll' && t.poll ? pollMini(t.poll) : null,
    h('div', { class: 'tcard-foot' },
      voteWidget({ threadId: t.id, score, cls: 'vote-pill', onScore: v => { t.score = v; } }),
      h('span', { class: 'act' }, ICONS.comment(), h('span', { class: 'tcard-comments', text: plural(comments, 'comment') })),
      h('span', { class: 'act act-bots' }, ICONS.users(), h('span', { class: 'tcard-bots', text: plural(bots, 'redditor') })),
      live ? liveBadge(t.status) : null,
    ),
  ));
  // The whole card opens the thread (like Reddit), except clicks on buttons and links.
  card.addEventListener('click', e => {
    if (e.target.closest('button, a') || e.defaultPrevented) return;
    if (getSelection()?.toString()) return;
    link.click();
  });
  return card;
}

export function pollMini(poll, cls = 'poll-mini') {
  const s = pollSummary(poll);
  if (!s.options.length) return null;
  const palette = ['#7e53c1', '#0079d3', '#0f9d58', '#d93a00', '#c27c00', '#e0218a'];
  const bar = h('div', { class: 'poll-bar', 'aria-hidden': 'true' },
    s.options.map((o, i) => (s.total && o.votes ? h('span', { class: 'poll-seg', vars: { '--w': `${(o.votes / s.total) * 100}%`, '--pc': palette[i % palette.length] } }) : null)));
  const label = s.leader
    ? [h('strong', { text: s.leader.text }), ` leads with ${s.leader.pct}%`]
    : [h('span', { text: `${plural(s.options.length, 'option')}, no votes yet` })];
  return h('div', { class: cls, 'aria-label': `Poll: ${s.options.map(o => `${o.text} ${o.pct}%`).join(', ')}, ${plural(s.total, 'vote')}` },
    bar,
    h('p', { class: 'poll-legend' }, ...label, h('span', { class: 'poll-total', text: ` · ${plural(s.total, 'vote')}` })),
  );
}
