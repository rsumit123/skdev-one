// Reddit-style "Create a post" composer: type tabs, who writes it, per-type forms,
// news source pick list (today's paper / live news / paste), crowd, length, handle.
import {
  h, svg, ICONS, TYPE_ICON, avatar, humanFlair, richText, plural, safeUrl, domainOf, extLink,
  skeletonCard, skeletonList, avatarLogo,
} from '/agent-reddit/ui.js';
import { api, errorText, hrefFor, navigate, view, API } from '/agent-reddit/api.js';
import {
  mergeItems, nextOffset, paperSource, paperDate, relTime, POST_TYPES, typeInfo,
  CROWDS, LENGTHS, LIMIT_RANGE, DEFAULT_LIMIT, validateCreate, buildCreateBody, validHandle,
} from '/agent-reddit/tree.js';
import { getHandle, setHandle } from '/agent-reddit/local.js';
import { rulesCard } from '/agent-reddit/home.js';

const TYPES = Object.keys(POST_TYPES);
const TYPE_TAB = { news: 'News', ask: 'Ask', opinion: 'Opinion', poll: 'Poll', ama: 'AMA' };
const TYPE_HINT = {
  news: 'Share a news story. The redditors read it and argue in the comments.',
  ask: 'Ask the crowd a question, like r/AskIndia. Expect advice, anecdotes and bad jokes.',
  opinion: 'Post an unpopular opinion and watch the redditors pile on (or agree).',
  poll: 'Ask a question with 2 to 6 options. Every redditor votes, then explains why.',
  ama: 'One redditor hosts an Ask Me Anything. The others ask questions, the host answers.',
};
// Must match the backend archetype occupations (app/reddit/archetypes.py).
export const AMA_HOSTS = [
  'software engineer', 'startup founder', 'plumber', 'electrician', 'kirana shop owner', 'tea stall owner',
  'auto-rickshaw driver', 'bus conductor', 'gig delivery rider', 'migrant construction worker',
  'government school teacher', 'bank PO', 'ER doctor', 'nurse', 'ASHA health worker', 'small farmer',
  'village sarpanch', 'college student', 'IAS aspirant', 'PhD researcher', 'chartered accountant', 'bar lawyer',
  'retired bank clerk', 'army veteran', 'homemaker', 'RWA secretary', 'journalist', 'film-industry crew',
  'textile factory owner', 'real-estate broker', 'shipping logistics manager', 'NRI in the US',
];
const AMA_SHORTLIST = 10;
let HOSTS = AMA_HOSTS; // replaced by GET /reddit/hosts when the server has it
let hostsTried = false;

async function loadHosts() {
  if (hostsTried) return;
  hostsTried = true;
  try {
    const d = await api('/reddit/hosts');
    const list = Array.isArray(d?.hosts) ? [...new Set(d.hosts.filter(x => typeof x === 'string').map(x => x.trim()).filter(x => x && x.length <= 60))] : [];
    if (list.length) HOSTS = list;
  } catch { /* older backend: keep the built-in list */ }
  if (view.name === 'compose' && C.type === 'ama') document.getElementById('ama-hosts')?._draw?.();
}
const FIELD_FROM_API = {
  title: 'title', body: 'body', idea: 'idea', poll_options: 'options', user_name: 'handle', article: 'story',
  headline: 'headline', link: 'link', ama_host: 'amaHost', thread_limit: 'limit', bots: 'crowd', max_comments: 'length',
};

// ---------------------------------------------------------------- state

const C = {
  type: 'news', author: 'bot', authorChosen: false,
  src: null, // null = automatic (paper when one exists, else live); 'paper' | 'news' | 'paste'
  picked: null, pickedId: null, pickedFeed: null, listOpen: true,
  paste: { headline: '', link: '', text: '' },
  title: '', body: '', idea: '', options: ['', ''], amaHost: null, amaAll: false,
  handle: '', crowd: 'medium', length: 'normal', limit: DEFAULT_LIMIT, advOpen: false,
  tried: false, errors: {}, serverErr: '', posting: false,
  papers: null, feeds: { paper: null, news: null }, gen: 0,
};
let IO = null;
let ELS = null;
let EXCERPT_SEQ = 0;
let FEED_TOKEN = 0;

const defaultAuthor = type => (type === 'news' || type === 'ama' ? 'bot' : 'user');

export function showComposer({ type, src } = {}) {
  view.name = 'compose';
  document.title = 'Create post : r/AgentReddit';
  document.body.classList.add('is-compose');
  C.type = TYPES.includes(type) ? type : (TYPES.includes(C.type) ? C.type : 'news');
  if (!C.authorChosen) C.author = defaultAuthor(C.type);
  C.src = src === 'paper' || src === 'news' || src === 'paste' ? src : null;
  C.handle = C.handle || getHandle();
  C.serverErr = '';
  C.posting = false;
  C.gen++;
  C.papers = null;
  C.feeds = { paper: newFeed(), news: newFeed() };
  disconnect();
  document.getElementById('hero').replaceChildren();
  const close = h('button', { class: 'icon-btn compose-close', type: 'button', id: 'compose-close', 'aria-label': 'Close composer', on: { click: leave } }, ICONS.close());
  document.getElementById('main').replaceChildren(
    h('div', { class: 'compose-top' },
      close,
      h('h1', { class: 'compose-h', text: 'Create post' }),
      h('span', { class: 'compose-to' }, avatarLogo('compose-sub-ic'), h('span', { text: 'r/AgentReddit' })),
    ),
    h('section', { class: 'card compose-card', 'aria-labelledby': 'ctype-label' },
      h('span', { class: 'sr-only', id: 'ctype-label', text: 'Post type' }),
      typeTabs(),
      h('p', { class: 'type-hint', id: 'type-hint' }),
      h('div', { class: 'compose-body', id: 'compose-body' }),
      composeFoot(),
    ),
  );
  document.getElementById('side').replaceChildren(tipsCard(), rulesCard());
  renderBody();
  loadPapers();
  loadHosts();
}

export function leaveComposer() {
  document.body.classList.remove('is-compose');
  disconnect();
}

function leave() {
  // Back if we came from inside the app, else to the front page.
  if (history.state?.inApp) history.back();
  else navigate({});
}

function typeTabs() {
  return h('div', { class: 'ctype-tabs', role: 'tablist', 'aria-labelledby': 'ctype-label' },
    TYPES.map(t => h('button', {
      class: 'ctype', type: 'button', role: 'tab', id: `ctype-${t}`, 'data-type': t, 'aria-selected': String(C.type === t),
      vars: { '--pc': typeInfo(t).color },
      on: { click: () => setType(t) },
    }, TYPE_ICON[t](), h('span', { text: TYPE_TAB[t] }))));
}

function setType(t) {
  if (C.type === t) return;
  C.type = t;
  if (!C.authorChosen) C.author = defaultAuthor(t);
  C.serverErr = '';
  document.querySelectorAll('.ctype').forEach(b => b.setAttribute('aria-selected', String(b.dataset.type === t)));
  try { history.replaceState(history.state, '', hrefFor({ new: '1', type: t })); } catch { /* ignore */ }
  renderBody();
}

function setAuthor(a) {
  if (C.author === a) return;
  C.author = a;
  C.authorChosen = true;
  C.serverErr = '';
  renderBody();
}

// ---------------------------------------------------------------- body

function renderBody() {
  const box = document.getElementById('compose-body');
  if (!box) return;
  disconnect();
  document.getElementById('type-hint').textContent = TYPE_HINT[C.type];
  const parts = [whoControl()];
  if (C.type === 'news') parts.push(newsFields());
  else if (C.type === 'poll') parts.push(pollFields());
  else if (C.type === 'ama') parts.push(amaFields());
  else parts.push(textFields());
  parts.push(crowdFields(), advancedFields());
  if (C.author === 'user') parts.push(handleField());
  box.replaceChildren(...parts);
  if (C.type === 'news') { renderSourcePanel(); const s = activeSource(); if (isFeed(s) && C.papers !== null) ensureFeed(s); } // papers decide the default first
  validate();
}

function whoControl() {
  const opt = (a, title, sub) => h('button', {
    class: 'who-opt', type: 'button', role: 'radio', id: `who-${a}`, 'aria-checked': String(C.author === a),
    on: { click: () => setAuthor(a) },
  }, h('span', { class: 'who-radio', 'aria-hidden': 'true' }), h('span', { class: 'who-text' }, h('strong', { text: title }), h('span', { text: sub })));
  const botSub = { news: 'A bot posts it and adds its take', ask: 'Give an idea, a bot asks it', opinion: 'Give an idea, a bot argues it', poll: 'Give an idea, a bot writes the poll', ama: 'The host bot writes its own intro' }[C.type];
  const me = `u/${C.handle || 'you'}`;
  const userSub = { news: `You post it as ${me}`, ask: `You ask, as ${me}`, opinion: `Your take, as ${me}`, poll: 'Your question and options', ama: 'You write the AMA intro' }[C.type];
  return h('div', { class: 'field' },
    h('span', { class: 'field-label', id: 'who-label', text: 'Who writes the post?' }),
    h('div', { class: 'who', role: 'radiogroup', 'aria-labelledby': 'who-label' },
      opt('user', "I'll write it", userSub), opt('bot', 'Let a bot OP write it', botSub)));
}

function errEl(key) {
  return h('span', { class: 'field-err', id: `err-${key}`, 'data-err': key, role: 'alert' });
}

function textInput(key, { label, placeholder, max, optional, multiline, rows = 4, value, onInput, hint }) {
  const id = `f-${key}`;
  const count = h('span', { class: 'counter', text: max ? `${String(value || '').length}/${max}` : '' });
  const props = {
    id, maxlength: max || null, placeholder, autocomplete: 'off', 'aria-describedby': `err-${key}`, 'data-field': key,
    on: { input: e => { onInput(e.target.value); if (max) count.textContent = `${e.target.value.length}/${max}`; C.serverErr = ''; validate(); } },
  };
  const ctl = multiline ? h('textarea', { ...props, rows }) : h('input', { ...props, type: key === 'link' ? 'url' : 'text', inputmode: key === 'link' ? 'url' : null, value: value || '' });
  if (multiline) ctl.value = value || '';
  return h('label', { class: 'field', for: id },
    h('span', { class: 'field-label' }, label, optional ? h('span', { class: 'opt', text: ' (optional)' }) : null, max && multiline ? count : null),
    ctl,
    hint ? h('span', { class: 'field-hint', text: hint }) : null,
    errEl(key));
}

const titleHolder = {
  ask: 'Ask something, e.g. Is ₹25 LPA in Bengaluru actually rich?',
  opinion: 'Unpopular opinion: ...',
  poll: 'Ask a question, e.g. Which Indian city has the best street food?',
  ama: "e.g. I'm a nurse on night shifts in Pune. Ask me anything!",
};
const ideaHolder = {
  news: 'e.g. focus on what it means for renters',
  ask: 'e.g. whether to move back to a hometown after 10 years in Mumbai',
  opinion: 'e.g. filter coffee is overrated',
  poll: 'e.g. the best Indian breakfast',
  ama: 'e.g. talk about the worst night shift ever',
};

function ideaField(optional) {
  return textInput('idea', {
    label: C.type === 'news' ? 'Angle for the bot OP' : 'Your one-line idea', optional, max: 300, placeholder: ideaHolder[C.type],
    value: C.idea, onInput: v => { C.idea = v; },
    hint: C.type === 'news' ? 'The bot posts the story with a short submission statement.' : 'A bot OP turns it into a Reddit-style post in its own voice.',
  });
}

function bodyField(label = 'Body') {
  return textInput('body', { label, optional: true, max: 6000, multiline: true, rows: 4, placeholder: 'Add some context (optional)', value: C.body, onInput: v => { C.body = v; } });
}

function textFields() {
  if (C.author === 'bot') return h('div', { class: 'fields' }, ideaField(false));
  return h('div', { class: 'fields' },
    textInput('title', { label: 'Title', max: 300, placeholder: titleHolder[C.type], value: C.title, onInput: v => { C.title = v; } }),
    bodyField());
}

function pollFields() {
  if (C.author === 'bot') return h('div', { class: 'fields' }, ideaField(false));
  const list = h('div', { class: 'poll-opts', id: 'poll-opts' });
  const add = h('button', { class: 'btn-link add-opt', type: 'button', id: 'add-opt', on: { click: () => {
    if (C.options.length >= 6) return;
    C.options.push('');
    draw();
    list.querySelectorAll('input')[C.options.length - 1]?.focus();
    validate();
  } } }, ICONS.plus(), 'Add option');
  const draw = () => {
    list.replaceChildren(...C.options.map((v, i) => h('div', { class: 'poll-opt' },
      h('span', { class: 'poll-opt-n', 'aria-hidden': 'true', text: String.fromCharCode(65 + i) }),
      h('input', { type: 'text', maxlength: 80, value: v, placeholder: `Option ${i + 1}`, 'aria-label': `Option ${i + 1}`, 'aria-describedby': 'err-options', 'data-field': 'options',
        on: { input: e => { C.options[i] = e.target.value; C.serverErr = ''; validate(); } } }),
      h('button', { class: 'icon-btn opt-remove', type: 'button', 'aria-label': `Remove option ${i + 1}`, disabled: C.options.length <= 2,
        on: { click: () => { if (C.options.length <= 2) return; C.options.splice(i, 1); draw(); validate(); } } }, ICONS.close()))));
    add.hidden = C.options.length >= 6;
  };
  draw();
  return h('div', { class: 'fields' },
    textInput('title', { label: 'Question', max: 300, placeholder: titleHolder.poll, value: C.title, onInput: v => { C.title = v; } }),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'Options', h('span', { class: 'opt', text: ' (2 to 6)' })),
      list, add, errEl('options')),
    bodyField('Context'));
}

function amaFields() {
  const chips = h('div', { class: 'host-chips', id: 'ama-hosts', role: 'radiogroup', 'aria-label': 'AMA host' });
  const drawChips = () => {
    const list = C.amaAll ? HOSTS : HOSTS.slice(0, AMA_SHORTLIST);
    const shown = C.amaHost && !list.includes(C.amaHost) ? [...list, C.amaHost] : list;
    const chip = (val, label, extra) => h('button', {
      class: `host-chip${extra ? ' ' + extra : ''}`, type: 'button', role: 'radio', 'data-host': val || '', 'aria-checked': String((C.amaHost || '') === (val || '')),
      on: { click: () => { C.amaHost = val; drawChips(); } },
    }, label);
    chips.replaceChildren(
      chip(null, h('span', {}, ICONS.sparkle(), 'Random'), 'host-random'),
      ...shown.map(o => chip(o, o[0].toUpperCase() + o.slice(1))),
      h('button', { class: 'host-more', type: 'button', id: 'ama-more', 'aria-expanded': String(C.amaAll),
        on: { click: () => { C.amaAll = !C.amaAll; drawChips(); } } }, C.amaAll ? 'Fewer' : `+${HOSTS.length - AMA_SHORTLIST} more`),
    );
    if (HOSTS.length <= AMA_SHORTLIST) chips.querySelector('.host-more')?.remove();
  };
  chips._draw = drawChips;
  drawChips();
  const pick = h('div', { class: 'field' },
    h('span', { class: 'field-label', text: 'Who is the host?' }),
    chips,
    h('span', { class: 'field-hint', text: 'One of the redditors gets this job and answers questions in first person.' }),
    errEl('amaHost'));
  if (C.author === 'bot') return h('div', { class: 'fields' }, pick, ideaField(true));
  return h('div', { class: 'fields' }, pick,
    textInput('title', { label: 'AMA title', max: 300, placeholder: titleHolder.ama, value: C.title, onInput: v => { C.title = v; } }),
    bodyField('Intro'));
}

function crowdFields() {
  const group = (key, label, opts, cur, set) => h('div', { class: 'field' },
    h('span', { class: 'field-label', id: `${key}-label`, text: label }),
    h('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': `${key}-label`, id: key },
      opts.map(([v, name, n]) => h('button', {
        class: 'seg-opt', type: 'button', role: 'radio', 'data-v': v, 'aria-checked': String(cur === v),
        on: { click: e => { set(v); e.currentTarget.parentNode.querySelectorAll('.seg-opt').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === v))); updateFoot(); } },
      }, h('strong', { text: name }), h('span', { text: n })))));
  return h('div', { class: 'fields fields-row' },
    group('crowd', 'Crowd', [['small', 'Small', `${CROWDS.small} bots`], ['medium', 'Medium', `${CROWDS.medium} bots`], ['large', 'Large', `${CROWDS.large} bots`]], C.crowd, v => { C.crowd = v; }),
    group('length', 'Length', [['quick', 'Quick', `${LENGTHS.quick} comments`], ['normal', 'Normal', `${LENGTHS.normal} comments`], ['long', 'Long', `${LENGTHS.long} comments`]], C.length, v => { C.length = v; }),
  );
}

function advancedFields() {
  const out = h('output', { class: 'opt-val', id: 'limit-out', text: String(C.limit) });
  const range = h('input', { type: 'range', id: 'f-limit', min: LIMIT_RANGE[0], max: LIMIT_RANGE[1], step: 1, value: C.limit,
    on: { input: e => { C.limit = +e.target.value; out.textContent = e.target.value; validate(); } } });
  const panel = h('div', { class: 'adv-panel', id: 'adv-panel', hidden: !C.advOpen },
    h('div', { class: 'opt-row' }, h('label', { class: 'opt-label', for: 'f-limit', text: 'Max comments per top-level thread' }), out, range),
    h('p', { class: 'field-hint', text: 'Once a top-level comment and its replies reach this many, that thread locks.' }),
    errEl('limit'));
  const toggle = h('button', { class: 'adv-toggle', type: 'button', id: 'adv-toggle', 'aria-expanded': String(C.advOpen), 'aria-controls': 'adv-panel',
    on: { click: () => { C.advOpen = !C.advOpen; panel.hidden = !C.advOpen; toggle.setAttribute('aria-expanded', String(C.advOpen)); } } },
  h('span', { text: 'Advanced' }), h('span', { class: 'chev', 'aria-hidden': 'true' }));
  return h('div', { class: 'adv' }, toggle, panel);
}

function handleField() {
  const input = h('input', { type: 'text', id: 'f-handle', value: C.handle, maxlength: 20, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    'aria-describedby': 'err-handle', 'data-field': 'handle',
    on: { input: e => { C.handle = e.target.value.trim(); if (validHandle(C.handle)) setHandle(C.handle); av.replaceWith(av = avatar(C.handle, 'handle-av')); C.serverErr = ''; validate(); } } });
  let av = avatar(C.handle, 'handle-av');
  return h('div', { class: 'field handle-field' },
    h('label', { class: 'field-label', for: 'f-handle', text: 'Post as' }),
    h('div', { class: 'handle-row' }, av, h('span', { class: 'handle-u', 'aria-hidden': 'true', text: 'u/' }), input, humanFlair()),
    h('span', { class: 'field-hint', text: 'Saved on this device. Letters, numbers and underscores, 3 to 20.' }),
    errEl('handle'));
}

// ---------------------------------------------------------------- news sources

const PAGE_SIZE = 12;
const FEED_API = { paper: 'paper', news: 'live' };
const SRC_LABELS = { paper: "Today's paper", news: 'Live news', paste: 'Paste headline or link' };
const SECTIONS = [[null, 'All', 'total'], ['politics', 'Politics', 'politics'], ['economy', 'Economy', 'economy']];
const SECTION_COLOR = { politics: '#0079d3', economy: '#0f9d58' };
const KIND_COLOR = { analysis: '#7e53c1', opinion: '#d4760a' };

function newFeed(section = null) {
  return { token: ++FEED_TOKEN, section, items: [], total: null, next: 0, loading: false, loaded: false, err: null, moreErr: null, age: null, paper: null };
}
function disconnect() { IO?.disconnect(); IO = null; ELS = null; }
function hasPapers() { return Array.isArray(C.papers) && C.papers.length > 0; }
function isFeed(k) { return k === 'paper' || k === 'news'; }
function activeSource() {
  if (C.src === 'paste' || C.src === 'news') return C.src;
  if (C.src === 'paper' && C.papers !== null && !hasPapers()) return 'news';
  if (C.papers === null || hasPapers()) return 'paper';
  return 'news';
}
function onNews() { return view.name === 'compose' && C.type === 'news'; }

async function loadPapers() {
  const gen = C.gen;
  let papers = [];
  let err = null;
  try {
    const d = await api('/reddit/papers');
    papers = Array.isArray(d?.papers) ? d.papers.filter(p => p && typeof p === 'object') : [];
  } catch (e) { err = e; }
  if (view.name !== 'compose' || gen !== C.gen) return;
  C.papers = papers;
  if (err && !err.status) {
    document.getElementById('compose-alert')?.remove();
    document.querySelector('.compose-card')?.before(h('div', { class: 'card notice notice-error', id: 'compose-alert', role: 'alert' },
      h('div', { class: 'notice-text' }, h('strong', { text: "Can't reach the Agent Reddit server." }), h('span', { text: ` Tried ${API}. You can still write a post; posting needs the server.` }))));
  }
  if (onNews()) { renderSourceTabs(); renderSourcePanel(); const s = activeSource(); if (isFeed(s)) ensureFeed(s); }
}

function newsFields() {
  const extra = C.author === 'user' ? bodyField('Your take') : ideaField(true);
  return h('div', { class: 'fields' },
    h('div', { class: 'field src-field' },
      h('span', { class: 'field-label', id: 'src-label', text: 'Story' }),
      h('div', { class: 'src-box' },
        h('div', { class: 'tabs src-tabs', id: 'tabs', role: 'tablist', 'aria-labelledby': 'src-label' }),
        h('div', { id: 'tab-panel', role: 'tabpanel' })),
      errEl('story')),
    extra);
}

function renderSourceTabs() {
  const bar = document.getElementById('tabs');
  if (!bar) return;
  const keys = [...(C.papers === null || hasPapers() ? ['paper'] : []), 'news', 'paste'];
  bar.replaceChildren(...keys.map(k => h('button', {
    class: 'tab', type: 'button', role: 'tab', id: `tab-${k}`, 'aria-selected': String(activeSource() === k),
    on: { click: () => {
      if (activeSource() === k) return;
      C.src = k;
      document.querySelectorAll('#tabs .tab').forEach(b => b.setAttribute('aria-selected', String(b.id === `tab-${k}`)));
      renderSourcePanel();
      if (isFeed(k)) ensureFeed(k);
      C.serverErr = '';
      validate();
    } },
  }, h('span', { class: 'tab-text', text: k === 'paste' ? 'Paste' : SRC_LABELS[k] }))));
}

function renderSourcePanel() {
  if (!document.getElementById('tabs')?.childElementCount) renderSourceTabs();
  const panel = document.getElementById('tab-panel');
  if (!panel) return;
  disconnect();
  const src = activeSource();
  panel.setAttribute('aria-labelledby', `tab-${src}`);
  if (src === 'paste') { panel.replaceChildren(pasteForm()); return; }
  if (C.picked && C.pickedFeed === src && !C.listOpen) { panel.replaceChildren(pickedSummary()); return; }
  const f = C.feeds[src];
  if (src === 'paper' && C.papers === null) { panel.replaceChildren(skeletonList(3)); return; }
  const head = feedHead(src);
  if (f.err) {
    panel.replaceChildren(head, h('div', { class: 'empty' },
      h('p', { text: f.err.status ? `Stories are unavailable right now (${f.err.message}).` : 'Stories could not be loaded.' }),
      h('div', { class: 'empty-actions' },
        h('button', { class: 'btn btn-outline', type: 'button', id: 'feed-retry', on: { click: () => reloadFeed(src) } }, ICONS.retry(), 'Retry'),
        h('button', { class: 'btn btn-text', type: 'button', text: 'Paste a headline instead', on: { click: () => document.getElementById('tab-paste')?.click() } }),
      )));
    return;
  }
  if (!f.loaded) { panel.replaceChildren(head, skeletonList(3)); return; }
  if (!f.items.length) {
    panel.replaceChildren(head, h('div', { class: 'empty' }, h('p', {
      text: src === 'paper' && f.section ? `No ${f.section} stories in today's paper.` : 'No stories right now. Paste a headline instead.',
    })));
    return;
  }
  const list = h('div', { class: 'news-list', id: 'feed-list', role: 'radiogroup', 'aria-label': SRC_LABELS[src] });
  for (const item of f.items) list.append(storyCard(src, item, false));
  const foot = h('div', { class: 'feed-foot', id: 'feed-foot', 'aria-live': 'polite' });
  const sentinel = h('div', { class: 'feed-sentinel', 'aria-hidden': 'true' });
  panel.replaceChildren(head, list, foot, sentinel);
  ELS = { key: src, head, list, foot, sentinel };
  if ('IntersectionObserver' in window) {
    IO = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting) && onNews() && activeSource() === src) loadPage(src);
    }, { rootMargin: '0px 0px 600px 0px' });
    IO.observe(sentinel);
  }
  renderFoot(src);
}

function ensureFeed(key) {
  const f = C.feeds[key];
  if (!f.loaded && !f.loading && !f.err) loadPage(key);
}

async function loadPage(key) {
  const f = C.feeds[key];
  if (f.loading || f.next == null || f.err || f.moreErr) return;
  const { token } = f;
  const offset = f.next;
  f.loading = true;
  if (f.loaded) renderFoot(key);
  const q = new URLSearchParams({ feed: FEED_API[key], offset: String(offset), limit: String(PAGE_SIZE) });
  if (key === 'paper' && f.section) q.set('section', f.section);
  let data;
  try {
    data = await api(`/reddit/news?${q}`);
  } catch (err) {
    if (C.feeds[key].token !== token) return;
    f.loading = false;
    if (f.loaded) { f.moreErr = err; renderFoot(key); }
    else { f.err = err; if (onNews() && activeSource() === key) renderSourcePanel(); }
    return;
  }
  if (C.feeds[key].token !== token) return; // stale: chip or source changed while in flight
  const first = !f.loaded;
  const { items, added } = mergeItems(f.items, data?.items);
  f.items = items;
  f.loaded = true;
  f.loading = false;
  f.next = nextOffset(data?.next_offset, offset);
  f.total = Number.isInteger(data?.total) ? data.total : (f.next == null ? items.length : null);
  if (data?.cached_age_s != null) f.age = data.cached_age_s;
  if (data?.paper && typeof data.paper === 'object') f.paper = data.paper;
  if (!onNews() || activeSource() !== key) return;
  const els = ELS;
  if (first || !els || els.key !== key || !els.list) { renderSourcePanel(); return; }
  for (const it of added) els.list.append(storyCard(key, it, true));
  els.head.replaceWith(els.head = feedHead(key));
  renderFoot(key);
  recheck();
}

function reloadFeed(key, section = C.feeds[key].section) {
  C.feeds[key] = newFeed(section);
  renderSourcePanel();
  loadPage(key);
}

function recheck() {
  if (!IO || !ELS?.sentinel) return;
  IO.unobserve(ELS.sentinel);
  IO.observe(ELS.sentinel);
}

function renderFoot(key) {
  const els = ELS;
  if (!els || els.key !== key) return;
  const f = C.feeds[key];
  const foot = els.foot;
  foot.removeAttribute('aria-busy');
  if (f.loading) {
    foot.setAttribute('aria-busy', 'true');
    foot.replaceChildren(h('div', { class: 'feed-row feed-loading' },
      h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { text: 'Loading more stories…' })), skeletonCard());
  } else if (f.moreErr) {
    foot.replaceChildren(h('div', { class: 'feed-row feed-err', role: 'alert' },
      h('span', { text: "Couldn't load more" }), h('span', { class: 'feed-sep', 'aria-hidden': 'true', text: '·' }),
      h('button', { class: 'btn-link feed-retry', type: 'button', on: { click: () => { f.moreErr = null; loadPage(key); } } }, ICONS.retry(), 'Retry')));
  } else if (f.next == null) {
    const n = f.items.length;
    foot.replaceChildren(h('div', { class: 'feed-row feed-end' },
      h('span', { class: 'feed-end-mark', 'aria-hidden': 'true' }),
      h('span', {},
        h('strong', { text: "You're all caught up" }),
        h('span', { class: 'feed-end-sub', text: key === 'paper' ? `${plural(n, 'story', 'stories')} from today's paper` : `${plural(n, 'headline')} from the live feed` }))));
  } else if (!IO) {
    foot.replaceChildren(h('div', { class: 'feed-row' },
      h('button', { class: 'btn btn-outline', type: 'button', text: 'Load more stories', on: { click: () => loadPage(key) } })));
  } else foot.replaceChildren();
}

function feedHead(key) {
  const f = C.feeds[key];
  const count = f.total != null ? plural(f.total, 'story', 'stories') : '';
  if (key === 'news') {
    const updated = f.age == null ? '' : f.age < 60 ? 'updated just now' : `updated ${relTime(new Date(Date.now() - f.age * 1000).toISOString())} ago`;
    return h('div', { class: 'feed-head' },
      h('p', { class: 'feed-meta', text: ['Google News, The Hindu, Indian Express and NDTV', updated, count].filter(Boolean).join(' · ') }));
  }
  const paper = C.papers?.[0] || {};
  const label = f.paper?.label || paper.label || "Today's paper";
  const counts = paper.counts && typeof paper.counts === 'object' ? paper.counts : {};
  const chips = h('div', { class: 'fchips', role: 'group', 'aria-label': 'Filter by section' },
    SECTIONS.map(([sec, name, ck]) => h('button', {
      class: 'fchip', type: 'button', 'data-section': sec || 'all', 'aria-pressed': String(f.section === sec),
      on: { click: () => { if (C.feeds.paper.section !== sec) reloadFeed('paper', sec); } },
    }, h('span', { text: name }), Number.isInteger(counts[ck]) ? h('span', { class: 'fchip-n', text: String(counts[ck]) }) : null)));
  return h('div', { class: 'feed-head' },
    h('div', { class: 'paper-id' },
      paperIcon(),
      h('div', { class: 'paper-id-text' },
        h('strong', { class: 'paper-label', text: label }),
        h('span', { class: 'feed-meta', text: ['Print edition', count].filter(Boolean).join(' · ') }),
      ),
    ),
    chips,
  );
}

function paperIcon() {
  return svg('0 0 20 20', [
    ['rect', { x: 2.5, y: 3.5, width: 15, height: 13, rx: 1.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }],
    ['path', { d: 'M5.5 7h9M5.5 10h4M5.5 13h4M11.5 10h3v3h-3z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
  ], 'paper-ic');
}

function articleFrom(key, it) {
  if (key === 'paper') {
    const text = typeof it.body === 'string' && it.body.trim() ? it.body : it.summary;
    return { headline: String(it.title || '').slice(0, 300), body: text ? String(text).slice(0, 6000) : null, link: null, source: paperSource(it) };
  }
  return { headline: String(it.title || '').slice(0, 300), body: it.summary ? String(it.summary).slice(0, 6000) : null, link: safeUrl(it.link), source: it.source || null };
}

function selectStory(key, item) {
  C.picked = articleFrom(key, item);
  C.pickedId = item.id;
  C.pickedFeed = key;
  C.pickedItem = item;
  C.listOpen = false;
  C.serverErr = '';
  renderSourcePanel();
  validate();
  const box = document.querySelector('.src-field');
  if (box && box.getBoundingClientRect().top < 0) box.scrollIntoView({ block: 'start' });
  document.getElementById('picked-change')?.focus({ preventScroll: true });
}

function pickedSummary() {
  const it = C.pickedItem || {};
  const meta = C.pickedFeed === 'paper'
    ? [C.picked.source, paperDate(it.published)].filter(Boolean).join(' · ')
    : [it.source, relTime(it.published) ? `${relTime(it.published)} ago` : ''].filter(Boolean).join(' · ');
  return h('div', { class: 'picked', id: 'picked', 'data-id': C.pickedId },
    h('span', { class: 'picked-check', 'aria-hidden': 'true' }),
    h('div', { class: 'picked-main' },
      h('span', { class: 'picked-k', text: 'Selected story' }),
      h('strong', { class: 'picked-title', text: C.picked.headline }),
      meta ? h('span', { class: 'feed-meta', text: meta }) : null),
    h('button', { class: 'btn btn-outline btn-sm', type: 'button', id: 'picked-change', text: 'Change',
      on: { click: () => { C.listOpen = true; renderSourcePanel(); document.querySelector(`.news-card[data-id="${CSS.escape(String(C.pickedId))}"]`)?.scrollIntoView({ block: 'center' }); } } }));
}

function isSelected(key, item) { return C.pickedFeed === key && C.pickedId === item.id; }

function storyCard(key, item, appended) {
  const card = key === 'paper' ? paperCard(item) : newsCard(item);
  if (appended) card.classList.add('is-appended');
  return card;
}

function pickRow(selected, ...extra) {
  return h('div', { class: 'news-foot' },
    h('span', { class: 'pick' }, h('span', { class: 'pick-box', 'aria-hidden': 'true' }), h('span', { class: 'pick-label', text: selected ? 'Selected' : 'Pick this story' })),
    ...extra);
}

function storyInput(key, item, selected) {
  const input = h('input', { type: 'radio', name: 'story', class: 'sr-only', value: String(item.id), checked: selected });
  input.addEventListener('click', () => selectStory(key, item)); // click also fires for the already-picked story
  return input;
}

function newsCard(item) {
  const selected = isSelected('news', item);
  const when = relTime(item.published);
  const link = extLink(item.link, domainOf(item.link) || 'article', 'news-link');
  if (link) link.addEventListener('click', e => e.stopPropagation());
  return h('label', { class: `post-card news-card${selected ? ' is-selected' : ''}`, 'data-id': item.id },
    storyInput('news', item, selected),
    h('div', { class: 'post-main' },
      h('div', { class: 'post-meta' },
        h('span', { class: 'meta-src', text: item.source || 'News' }),
        when ? h('span', { text: ` • ${when === 'just now' ? when : when + ' ago'}` }) : null),
      h('h3', { class: 'post-title', text: item.title || '' }),
      item.summary ? h('p', { class: 'news-summary', text: item.summary }) : null,
      pickRow(selected, link)));
}

function paperCard(item) {
  const selected = isSelected('paper', item);
  const section = typeof item.section === 'string' ? item.section.toLowerCase() : '';
  const kind = typeof item.kind === 'string' ? item.kind.toLowerCase() : '';
  const when = paperDate(item.published);
  const pill = (cls, text, color) => h('span', { class: `mpill ${cls}`, vars: { '--pc': color }, text });
  const sep = () => h('span', { class: 'meta-sep', 'aria-hidden': 'true', text: '·' });
  const meta = [h('span', { class: 'meta-src', text: item.source || 'The Indian Express' })];
  if (section) meta.push(sep(), pill('sec-pill', section[0].toUpperCase() + section.slice(1), SECTION_COLOR[section] || '#787c7e'));
  if (KIND_COLOR[kind]) meta.push(pill('kind-pill', kind[0].toUpperCase() + kind.slice(1), KIND_COLOR[kind]));
  if (Number.isInteger(item.page) && item.page > 0) meta.push(sep(), h('span', { class: 'meta-page', text: `p. ${item.page}` }));
  if (when) meta.push(sep(), h('span', { text: when }));
  const byline = [item.byline, item.dateline].filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());
  const body = typeof item.body === 'string' && item.body.trim() ? item.body : '';
  let excerpt = null;
  let toggle = null;
  if (body) {
    const id = `excerpt-${++EXCERPT_SEQ}`;
    excerpt = h('div', { class: 'excerpt', id, hidden: true },
      h('p', { class: 'excerpt-note', text: 'What the redditors will read' }),
      richText(body, 'excerpt-text'));
    toggle = h('button', { class: 'excerpt-toggle', type: 'button', 'aria-expanded': 'false', 'aria-controls': id,
      on: { click: e => {
        e.preventDefault(); // keep the click from also picking the card
        const open = excerpt.hidden;
        excerpt.hidden = !open;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.querySelector('.excerpt-label').textContent = open ? 'Hide excerpt' : 'Read excerpt';
      } } },
    h('span', { class: 'excerpt-label', text: 'Read excerpt' }), h('span', { class: 'chev', 'aria-hidden': 'true' }));
  }
  return h('label', { class: `post-card news-card paper-card${selected ? ' is-selected' : ''}`, 'data-id': item.id, 'data-section': section || null },
    storyInput('paper', item, selected),
    h('div', { class: 'post-main' },
      h('div', { class: 'post-meta' }, meta),
      h('h3', { class: 'post-title', text: item.title || '' }),
      item.summary ? h('p', { class: 'news-summary', text: item.summary }) : null,
      byline.length ? h('p', { class: 'byline', text: byline.join(' · ') }) : null,
      excerpt,
      pickRow(selected, toggle)));
}

function pasteForm() {
  const p = C.paste;
  return h('div', { class: 'own-form' },
    textInput('headline', { label: 'Headline', max: 300, placeholder: 'e.g. Bengaluru to charge a congestion tax on ORR', value: p.headline, onInput: v => { p.headline = v; } }),
    textInput('link', { label: 'Link', optional: true, placeholder: 'https://', value: p.link, onInput: v => { p.link = v; } }),
    textInput('text', { label: 'Article text', optional: true, max: 6000, multiline: true, rows: 4, placeholder: 'Paste the article so the bots have context.', value: p.text, onInput: v => { p.text = v; } }));
}

// ---------------------------------------------------------------- validate + post

function formState() {
  const src = activeSource();
  return {
    type: C.type, author: C.author, source: src === 'paste' ? 'paste' : src,
    picked: C.pickedFeed === src ? C.picked : null, paste: C.paste,
    title: C.title, body: C.body, idea: C.idea, options: C.options, amaHost: C.amaHost,
    handle: C.handle, crowd: C.crowd, length: C.length, limit: C.limit,
  };
}

function validate() {
  C.errors = validateCreate(formState());
  paintErrors();
  updateFoot();
  return C.errors;
}

function paintErrors() {
  document.querySelectorAll('[data-err]').forEach(el => {
    const msg = C.tried ? C.errors[el.dataset.err] || '' : '';
    el.textContent = msg;
  });
  document.querySelectorAll('[data-field]').forEach(el => {
    const bad = C.tried && !!C.errors[el.dataset.field];
    el.classList.toggle('is-invalid', bad);
    if (bad) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid');
  });
}

function composeFoot() {
  return h('div', { class: 'compose-foot' },
    h('div', { class: 'foot-text' },
      h('p', { class: 'foot-sum', id: 'foot-sum' }),
      h('p', { class: 'post-err', id: 'post-err', role: 'alert' })),
    h('button', { class: 'btn btn-text foot-cancel', type: 'button', text: 'Cancel', on: { click: leave } }),
    h('button', { class: 'btn btn-primary post-btn', type: 'button', id: 'post-btn', on: { click: post } }, 'Post'));
}

function updateFoot() {
  const sum = document.getElementById('foot-sum');
  if (!sum) return;
  const who = C.author === 'user' ? `u/${C.handle || '…'}` : 'a bot OP';
  sum.textContent = `${typeInfo(C.type).label} by ${who} · ${CROWDS[C.crowd]} redditors · up to ${LENGTHS[C.length]} comments`;
  const btn = document.getElementById('post-btn');
  btn.disabled = C.posting;
  btn.textContent = C.posting ? 'Posting…' : 'Post';
  const n = Object.keys(C.errors).length;
  document.getElementById('post-err').textContent = C.serverErr || (C.tried && n ? (n === 1 ? Object.values(C.errors)[0] : `Fix ${n} things above to post.`) : '');
}

async function post() {
  if (C.posting) return;
  C.tried = true;
  const errs = validate();
  if (Object.keys(errs).length) {
    const first = document.querySelector('.is-invalid, .field-err:not(:empty)');
    const target = first?.closest('.field') || first;
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const focusable = target?.querySelector?.('input, textarea, button');
    (first?.matches?.('input, textarea') ? first : focusable)?.focus({ preventScroll: true });
    return;
  }
  const body = buildCreateBody(formState());
  C.posting = true; C.serverErr = ''; updateFoot();
  try {
    const res = await api('/reddit/threads', { method: 'POST', body: JSON.stringify(body) });
    if (!res?.id) throw Object.assign(new Error('The server did not return a thread id.'), { status: 500 });
    C.posting = false;
    resetDraft();
    if (view.name === 'compose') navigate({ t: res.id }, { replace: true });
  } catch (err) {
    C.posting = false;
    const fields = err.fields || {};
    for (const [k, msg] of Object.entries(fields)) {
      const key = FIELD_FROM_API[k];
      if (key) C.errors[key] = msg;
    }
    C.serverErr = err.status === 422 ? `The server rejected this post: ${err.message}` : errorText(err, 'Could not create the post.');
    paintErrors();
    updateFoot();
  }
}

function resetDraft() {
  Object.assign(C, {
    picked: null, pickedId: null, pickedFeed: null, pickedItem: null, listOpen: true,
    paste: { headline: '', link: '', text: '' }, title: '', body: '', idea: '', options: ['', ''],
    tried: false, errors: {}, serverErr: '',
  });
}

function tipsCard() {
  const tips = [
    ['Pick a type', 'News for a story, Ask for a question, Opinion for a hot take, Poll to make them vote, AMA to interview one of them.'],
    ['You or a bot', 'Write it yourself (you get a HUMAN flair) or give a bot OP a one-line idea.'],
    ['Crowd and length', 'More bots means more arguments. Long threads take a few minutes to play out.'],
  ];
  return h('section', { class: 'card side-card tips-card' },
    h('h2', { class: 'side-head', text: 'Posting to r/AgentReddit' }),
    h('ol', { class: 'tips' }, tips.map(([k, v]) => h('li', {}, h('strong', { text: k }), h('span', { text: v })))));
}
