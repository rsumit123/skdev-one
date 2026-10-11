/* Attempt history for the weekly current-affairs quizzes.
 *
 * Injected into every paper as one <script> tag at publish time, after the
 * paper's own inline script, so QUESTIONS is already defined. It recomputes
 * the score from QUESTIONS and the form rather than scraping the rendered
 * results, records it via /api/attempts, and lists what everyone has scored.
 *
 * Everything from the API is rendered with textContent, never innerHTML:
 * names are typed by whoever is playing and are not to be trusted as markup.
 *
 * If the API is unreachable or unconfigured the section simply never appears -
 * a quiz that works offline should not grow a broken box.
 */
(function () {
  'use strict';

  var API = '/api/attempts';
  var NAME_KEY = 'ca.name';

  var week = (function () {
    var m = location.pathname.match(/current-affairs-paper\/([a-z]{3}-\d{1,2}-\d{1,2})/);
    return m ? m[1] : null;
  }());

  var checkBtn = document.getElementById('check');
  var result = document.getElementById('result');
  if (!week || !checkBtn || !result || typeof QUESTIONS === 'undefined') return;

  function stored(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }

  // ------------------------------------------------------------------ styling

  var css = document.createElement('style');
  css.textContent = [
    '.att{padding:32px 0 0;border-top:1px solid #D8D5CC;margin-top:8px}',
    '.att[hidden]{display:none}',
    '.att h2{font-family:Georgia,"Times New Roman",serif;font-weight:400;',
    '  font-size:24px;margin:0 0 6px;color:#1C222C}',
    '.att-sub{font-size:13px;color:#5A6472;margin:0 0 20px}',
    '.att-who{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 22px}',
    '.att-who label{font-size:13px;color:#5A6472}',
    '.att-who input{font:inherit;font-size:14px;padding:7px 9px;border:1px solid #D8D5CC;',
    '  background:#FFFFFF;color:#1C222C;border-radius:2px;min-width:0;width:11em}',
    '.att-who button{font:inherit;font-size:13px;padding:7px 12px;border:1px solid #1C222C;',
    '  background:#1C222C;color:#F7F6F2;border-radius:2px;cursor:pointer}',
    '.att-who button:disabled{opacity:.5;cursor:default}',
    '.att-row{padding:14px 0;border-bottom:1px solid #D8D5CC;font-size:14px}',
    '.att-row:first-of-type{border-top:1px solid #D8D5CC}',
    '.att-line{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}',
    '.att-name{color:#1C222C}',
    '.att-me{font-size:11px;color:#FFFFFF;background:#5A6472;padding:2px 7px;border-radius:2px}',
    '.att-score{font-family:Georgia,serif;color:#1C222C}',
    '.att-when{font-size:12px;color:#5A6472;margin-left:auto}',
    '.att-missed{font-size:13px;color:#5A6472;margin:8px 0 0;padding-left:12px;',
    '  border-left:2px solid #D8D5CC}',
    '.att-none{font-size:14px;color:#5A6472;margin:0}',
    '@media (max-width:420px){.att-when{margin-left:0;width:100%}}'
  ].join('');
  document.head.appendChild(css);

  // ---------------------------------------------------------------- the panel

  var panel = document.createElement('section');
  panel.className = 'att';
  panel.hidden = true;

  var heading = document.createElement('h2');
  heading.textContent = 'Attempts';
  panel.appendChild(heading);

  var sub = document.createElement('p');
  sub.className = 'att-sub';
  panel.appendChild(sub);

  var who = document.createElement('div');
  who.className = 'att-who';
  var whoLabel = document.createElement('label');
  whoLabel.setAttribute('for', 'att-name');
  whoLabel.textContent = 'Your name';
  var whoInput = document.createElement('input');
  whoInput.id = 'att-name';
  whoInput.type = 'text';
  whoInput.maxLength = 24;
  whoInput.autocomplete = 'nickname';
  whoInput.placeholder = 'so scores have a name on them';
  var whoSave = document.createElement('button');
  whoSave.type = 'button';
  whoSave.textContent = 'Save';
  who.appendChild(whoLabel);
  who.appendChild(whoInput);
  who.appendChild(whoSave);
  panel.appendChild(who);

  var rowsBox = document.createElement('div');
  panel.appendChild(rowsBox);

  result.parentNode.insertBefore(panel, result.nextSibling);

  // ----------------------------------------------------------------- helpers

  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
    var h = Math.round(m / 60);
    if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
    var d = Math.round(h / 24);
    return d + (d === 1 ? ' day ago' : ' days ago');
  }

  function myName() {
    return stored(NAME_KEY) || '';
  }

  function missedText(wrong) {
    var names = [];
    for (var i = 0; i < wrong.length; i++) {
      var q = QUESTIONS[wrong[i]];
      names.push(q ? (wrong[i] + 1) + '. ' + q.topic : String(wrong[i] + 1));
    }
    return names.join(' · ');
  }

  var lastAttempts = [];

  function render(attempts) {
    lastAttempts = attempts || [];
    attempts = lastAttempts;
    rowsBox.textContent = '';
    var mine = myName();

    if (!attempts.length) {
      var none = document.createElement('p');
      none.className = 'att-none';
      none.textContent = 'No attempts recorded yet. Answer the questions and check them, and your score lands here.';
      rowsBox.appendChild(none);
      sub.textContent = 'Scores are shared with anyone who has this link.';
      return;
    }

    var best = attempts.reduce(function (a, b) { return b.score > a.score ? b : a; });
    sub.textContent = attempts.length + (attempts.length === 1 ? ' attempt' : ' attempts')
      + ', best ' + best.score + ' of ' + best.total + ' by ' + best.name
      + '. Shared with anyone who has this link.';

    attempts.forEach(function (a) {
      var row = document.createElement('div');
      row.className = 'att-row';

      var line = document.createElement('div');
      line.className = 'att-line';

      var name = document.createElement('span');
      name.className = 'att-name';
      name.textContent = a.name;             // never innerHTML
      line.appendChild(name);

      var isMine = mine && a.name === mine;
      if (isMine) {
        var tag = document.createElement('span');
        tag.className = 'att-me';
        tag.textContent = 'you';
        line.appendChild(tag);
      }

      var score = document.createElement('span');
      score.className = 'att-score';
      score.textContent = a.score + ' / ' + a.total;
      line.appendChild(score);

      var when = document.createElement('span');
      when.className = 'att-when';
      when.textContent = ago(a.at);
      line.appendChild(when);

      row.appendChild(line);

      // Only your own misses are spelled out - everyone else's would be noise,
      // and would hand out answers to someone mid-quiz.
      if (isMine && a.wrong && a.wrong.length) {
        var missed = document.createElement('p');
        missed.className = 'att-missed';
        missed.textContent = 'Missed: ' + missedText(a.wrong);
        row.appendChild(missed);
      }

      rowsBox.appendChild(row);
    });
  }

  function load() {
    return fetch(API + '?week=' + encodeURIComponent(week), { headers: { accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(r.status)); })
      .then(function (data) {
        whoInput.value = myName();
        render(data.attempts || []);
        panel.hidden = false;
      })
      .catch(function () { panel.hidden = true; });
  }

  // ------------------------------------------------------------- interaction

  whoSave.addEventListener('click', function () {
    var value = whoInput.value.replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!value) return;
    store(NAME_KEY, value);
    whoSave.textContent = 'Saved';
    setTimeout(function () { whoSave.textContent = 'Save'; }, 1500);
    render(lastAttempts);
  });

  function submit() {
    var name = myName();
    if (!name) return;                       // nothing to attribute it to

    var score = 0;
    var wrong = [];
    for (var i = 0; i < QUESTIONS.length; i++) {
      var picked = document.querySelector('input[name="q' + i + '"]:checked');
      var chosen = picked ? Number(picked.value) : null;
      if (chosen === QUESTIONS[i].a) score++;
      else wrong.push(i);
    }

    return fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ week: week, name: name, score: score, total: QUESTIONS.length, wrong: wrong })
    })
      .then(function () { return load(); })
      .catch(function () { /* leave the panel as it was */ });
  }

  // Capture phase, so the inputs are read before the paper's own handler
  // disables them. The paper disables the button once scored, which keeps this
  // from firing twice; the server de-duplicates a rapid resubmit anyway.
  checkBtn.addEventListener('click', function () {
    if (checkBtn.disabled) return;
    setTimeout(submit, 0);
  }, true);

  load();
}());
