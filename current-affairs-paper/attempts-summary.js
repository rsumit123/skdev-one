/* Per-week scores on the current-affairs index.
 *
 * Reads the slugs already in the markup, asks /api/attempts for a summary of
 * each, and adds a line under the topics. Weeks nobody has attempted are left
 * exactly as they were, and if the request fails nothing changes at all - the
 * listing has to work whether or not anyone has played.
 */
(function () {
  'use strict';

  var items = Array.prototype.slice.call(document.querySelectorAll('.weeks li[data-slug]'));
  if (!items.length) return;

  var bySlug = {};
  var slugs = [];
  items.forEach(function (li) {
    var slug = li.getAttribute('data-slug');
    if (slug && !bySlug[slug]) {
      bySlug[slug] = li;
      slugs.push(slug);
    }
  });

  fetch('/api/attempts?weeks=' + encodeURIComponent(slugs.join(',')), {
    headers: { accept: 'application/json' }
  })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(r.status)); })
    .then(function (data) {
      (data.summary || []).forEach(function (s) {
        var li = bySlug[s.week];
        if (!li || !s.attempts) return;

        var line = li.querySelector('.scores');
        if (!line) return;

        var best = document.createElement('b');
        best.textContent = 'best ' + s.best + ' / ' + s.total;

        line.textContent = '';
        line.appendChild(best);
        line.appendChild(document.createTextNode(
          ' · ' + s.attempts + (s.attempts === 1 ? ' attempt' : ' attempts')
        ));
        line.hidden = false;
      });
    })
    .catch(function () { /* listing stands on its own */ });
}());
