// "Add a comment" / inline Reply box. Owns its text, handle and error line; the caller
// does the network call through onSubmit(text, handle) and resolves/rejects it.
import { h, avatar, humanFlair } from '/agent-reddit/ui.js';
import { validHandle } from '/agent-reddit/tree.js';
import { getHandle, setHandle } from '/agent-reddit/local.js';

const MAX = 2000;
let SEQ = 0;

export function commentBox({ reply = false, replyName = '', onSubmit, onCancel } = {}) {
  const n = ++SEQ;
  let handle = getHandle();
  let busy = false;
  const ta = h('textarea', {
    class: 'cbox-input', id: `cbox-${n}`, rows: reply ? 3 : 4, maxlength: MAX,
    placeholder: reply ? `Reply to ${replyName}` : 'What are your thoughts?',
    'aria-label': reply ? `Reply to ${replyName}` : 'Add a comment', 'aria-describedby': `cbox-err-${n}`,
  });
  const count = h('span', { class: 'cbox-count', 'aria-hidden': 'true', text: `0/${MAX}` });
  const err = h('p', { class: 'cbox-err', id: `cbox-err-${n}`, role: 'alert' });
  const send = h('button', { class: 'btn btn-primary btn-sm cbox-send', type: 'button', disabled: true, text: reply ? 'Reply' : 'Comment' });
  const cancel = h('button', { class: 'btn btn-text btn-sm cbox-cancel', type: 'button', text: 'Cancel' });
  let av = avatar(handle, 'cbox-av');
  const who = h('span', { class: 'cbox-who-name', text: `u/${handle}` });
  const handleIn = h('input', { class: 'cbox-handle', type: 'text', maxlength: 20, value: handle, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Your username', hidden: true });
  const change = h('button', { class: 'btn-link cbox-change', type: 'button', text: 'change' });
  const who_row = h('div', { class: 'cbox-who' }, av, h('span', { class: 'cbox-as', text: 'Commenting as' }), who, humanFlair(), handleIn, change);

  const box = h('div', { class: `cbox${reply ? ' cbox-reply' : ''}`, 'data-cbox': reply ? 'reply' : 'top' },
    who_row,
    h('div', { class: 'cbox-field' }, ta,
      h('div', { class: 'cbox-bar' }, count, h('span', { class: 'cbox-spacer' }), reply || onCancel ? cancel : null, send)),
    err);

  const sync = () => {
    const len = ta.value.length;
    count.textContent = `${len}/${MAX}`;
    send.disabled = busy || !ta.value.trim();
  };
  const setHandleFrom = v => {
    const val = v.trim();
    if (!validHandle(val)) return false;
    handle = val; setHandle(val);
    who.textContent = `u/${val}`;
    av.replaceWith(av = avatar(val, 'cbox-av'));
    return true;
  };
  change.addEventListener('click', () => {
    const editing = handleIn.hidden;
    handleIn.hidden = !editing; who.hidden = editing;
    change.textContent = editing ? 'done' : 'change';
    if (editing) { handleIn.value = handle; handleIn.focus(); }
    else if (!setHandleFrom(handleIn.value)) { handleIn.hidden = false; who.hidden = true; change.textContent = 'done'; err.textContent = 'Usernames are 3 to 20 letters, numbers or underscores.'; }
    else err.textContent = '';
  });
  handleIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); change.click(); } });
  ta.addEventListener('input', () => { err.textContent = ''; sync(); });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } if (e.key === 'Escape' && reply) onCancel?.(); });
  cancel.addEventListener('click', () => onCancel?.());
  send.addEventListener('click', submit);

  async function submit() {
    const text = ta.value.trim();
    if (busy || !text) return;
    if (!handleIn.hidden && !setHandleFrom(handleIn.value)) { err.textContent = 'Usernames are 3 to 20 letters, numbers or underscores.'; handleIn.focus(); return; }
    if (!validHandle(handle)) { err.textContent = 'Pick a username first.'; return; }
    busy = true; box.classList.add('is-busy'); send.textContent = 'Posting…'; err.textContent = ''; sync();
    try {
      await onSubmit(text, handle);
      ta.value = '';
    } catch (e) {
      err.textContent = e?.message || 'Could not post the comment.';
    } finally {
      busy = false; box.classList.remove('is-busy'); send.textContent = reply ? 'Reply' : 'Comment'; sync();
    }
  }
  box.focusInput = () => ta.focus({ preventScroll: false });
  box.input = ta;
  return box;
}
