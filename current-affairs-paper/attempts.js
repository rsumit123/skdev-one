/* Attempt history for the weekly current-affairs quizzes.
 *
 * Injected into every paper as one <script> tag at publish time, after the
 * paper's own inline script, so QUESTIONS is already defined. It recomputes
 * the score from QUESTIONS and the form rather than scraping the rendered
 * results, records it via /api/attempts, and lists what everyone has scored.
 *
 * Recording is explicit: one "Record this attempt" button, placed inside the
 * results box under the score so it is on screen the moment you are scored.
 * It stays disabled, with a reason, until there is something to record and a
 * name to record it under - an earlier version recorded silently on "Check
 * answers" and dropped the attempt when no name had been saved yet.
 *
 * Everything from the API is rendered with textContent, never innerHTML:
 * names are typed by whoever is playing and are not to be trusted as markup.
 *
 * If the API is unreachable or unconfigured nothing appears - a quiz that
 * works offline should not grow a broken box.
 */
(function () {
  'use strict';

  var API = '/api/attempts';
  var NAME_KEY = 'ca.name';
  var MAX_NAME = 24;

  var week = (function () {
    var m = location.pathname.match(/current-affairs-paper\/([a-z]{3}-\d{1,2}-\d{1,2})/);
    return m ? m[1] : null;
  }());

  var checkBtn = document.getElementById('check');
  var resetBtn = document.getElementById('reset');
  var result = document.getElementById('result');
  var verdict = document.getElementById('verdict');
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
    '.att-bar{margin:22px 0 4px;padding:16px 18px;border:1px solid #D8D5CC;background:#FFFFFF}',
    '.att-bar[hidden]{display:none}',
    '.att-bar h3{font-family:Georgia,"Times New Roman",serif;font-weight:400;font-size:17px;',
    '  margin:0 0 12px;color:#1C222C}',
    '.att-bar-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
    '.att-bar label{font-size:13px;color:#5A6472}',
    '.att-bar input{font:inherit;font-size:14px;padding:7px 9px;border:1px solid #D8D5CC;',
    '  background:#FFFFFF;color:#1C222C;border-radius:2px;min-width:0;width:11em}',
    '.att-bar button{font:inherit;font-size:13px;padding:8px 14px;border:1px solid #1C222C;',
    '  background:#1C222C;color:#F7F6F2;border-radius:2px;cursor:pointer}',
    '.att-bar button:disabled{opacity:.4;cursor:not-allowed}',
    '.att-hint{font-size:13px;color:#5A6472;margin:10px 0 0}',
    '.att{padding:32px 0 0;border-top:1px solid #D8D5CC;margin-top:8px}',
    '.att[hidden]{display:none}',
    '.att h2{font-family:Georgia,"Times New Roman",serif;font-weight:400;',
    '  font-size:24px;margin:0 0 6px;color:#1C222C}',
    '.att-sub{font-size:13px;color:#5A6472;margin:0 0 20px}',
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

  // --------------------------------------------------------- the record bar
  // Inside the results box, directly under the verdict, so it is the first
  // thing below the score rather than something to scroll past the review for.

  var bar = document.createElement('div');
  bar.className = 'att-bar';
  bar.hidden = true;

  var barHead = document.createElement('h3');
  barHead.textContent = 'Add this score to the attempts list';
  bar.appendChild(barHead);

  var barRow = document.createElement('div');
  barRow.className = 'att-bar-row';
  var nameLabel = document.createElement('label');
  nameLabel.setAttribute('for', 'att-name');
  nameLabel.textContent = 'Your name';
  var nameInput = document.createElement('input');
  nameInput.id = 'att-name';
  nameInput.type = 'text';
  nameInput.maxLength = MAX_NAME;
  nameInput.autocomplete = 'nickname';
  nameInput.placeholder = 'so the score has a name on it';
  nameInput.value = stored(NAME_KEY) || '';
  var recordBtn = document.createElement('button');
  recordBtn.type = 'button';
  recordBtn.textContent = 'Record this attempt';
  barRow.appendChild(nameLabel);
  barRow.appendChild(nameInput);
  barRow.appendChild(recordBtn);
  bar.appendChild(barRow);

  var hint = document.createElement('p');
  hint.className = 'att-hint';
  bar.appendChild(hint);

  if (verdict && verdict.parentNode === result) {
    result.insertBefore(bar, verdict.nextSibling);
  } else {
    result.appendChild(bar);
  }

  // -------------------------------------------------------- the history list

  var panel = document.createElement('section');
  panel.className = 'att';
  panel.hidden = true;

  var heading = document.createElement('h2');
  heading.textContent = 'Attempts';
  panel.appendChild(heading);

  var sub = document.createElement('p');
  sub.className = 'att-sub';
  panel.appendChild(sub);

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

  function typedName() {
    return nameInput.value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  }

  function myName() {
    return typedName() || stored(NAME_KEY) || '';
  }

  function scoredNow() {
    return result.classList.contains('show');
  }

  function tally() {
    var score = 0;
    var wrong = [];
    for (var i = 0; i < QUESTIONS.length; i++) {
      var picked = document.querySelector('input[name="q' + i + '"]:checked');
      var chosen = picked ? Number(picked.value) : null;
      if (chosen === QUESTIONS[i].a) score++;
      else wrong.push(i);
    }
    return { score: score, wrong: wrong, total: QUESTIONS.length };
  }

  function missedText(wrong) {
    var names = [];
    for (var i = 0; i < wrong.length; i++) {
      var q = QUESTIONS[wrong[i]];
      names.push(q ? (wrong[i] + 1) + '. ' + q.topic : String(wrong[i] + 1));
    }
    return names.join(' · ');
  }

  // --------------------------------------------------------- the record flow

  var apiUp = false;      // nothing is offered until a read has succeeded
  var state = 'idle';     // idle | sending | done | failed

  function sync() {
    if (!apiUp) { bar.hidden = true; return; }
    bar.hidden = false;

    if (state === 'sending') {
      recordBtn.disabled = true;
      recordBtn.textContent = 'Recording…';
      hint.textContent = '';
      return;
    }

    if (state === 'done') {
      recordBtn.disabled = true;
      recordBtn.textContent = 'Recorded';
      hint.textContent = 'Saved as ' + myName() + '. It is in the list below, and on the index page.';
      return;
    }

    recordBtn.textContent = 'Record this attempt';

    if (!scoredNow()) {
      recordBtn.disabled = true;
      hint.textContent = 'Check your answers first — then this button records the score.';
      return;
    }

    if (!typedName()) {
      recordBtn.disabled = true;
      hint.textContent = 'Type your name above, then press Record.';
      return;
    }

    var t = tally();
    recordBtn.disabled = false;
    hint.textContent = state === 'failed'
      ? 'That did not save. Press Record to try again.'
      : t.score + ' out of ' + t.total + ', ready to record. Nothing is shared until you press Record.';
  }

  recordBtn.addEventListener('click', function () {
    if (recordBtn.disabled) return;
    var name = typedName();
    if (!name || !scoredNow()) { sync(); return; }

    store(NAME_KEY, name);
    var t = tally();
    state = 'sending';
    sync();

    fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ week: week, name: name, score: t.score, total: t.total, wrong: t.wrong })
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(r.status)); })
      .then(function () {
        state = 'done';
        return load();
      })
      .catch(function () {
        state = 'failed';
        sync();
      });
  });

  nameInput.addEventListener('input', function () { if (state !== 'done') sync(); });

  // The paper shows the results box on check and hides it again on start over,
  // so both are just cues to re-read that state.
  checkBtn.addEventListener('click', function () { setTimeout(sync, 0); });
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      state = 'idle';
      setTimeout(sync, 0);
    });
  }

  // --------------------------------------------------------------- rendering

  function render(attempts) {
    attempts = attempts || [];
    rowsBox.textContent = '';
    var mine = stored(NAME_KEY) || '';

    if (!attempts.length) {
      var none = document.createElement('p');
      none.className = 'att-none';
      none.textContent = 'No attempts recorded yet. Answer the questions, check them, then press Record and your score lands here.';
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
        apiUp = true;
        render(data.attempts || []);
        panel.hidden = false;
        sync();
      })
      .catch(function () {
        apiUp = false;
        panel.hidden = true;
        sync();
      });
  }

  load();
}());
