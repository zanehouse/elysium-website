/* =========================================
   ELYSIAN CAPITAL — SCRIPT.JS
   Mobile navigation toggle only.
   ========================================= */

(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    var toggle = document.querySelector('.nav-toggle');
    var nav    = document.querySelector('nav');

    if (!toggle || !nav) return;

    toggle.addEventListener('click', function () {
      var isOpen = nav.classList.toggle('open');
      toggle.classList.toggle('open', isOpen);
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    /* Close nav when a link is tapped on mobile */
    nav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        nav.classList.remove('open');
        toggle.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });

    /* Mark active link */
    var path = window.location.pathname;
    nav.querySelectorAll('a').forEach(function (link) {
      if (link.getAttribute('href') && path.startsWith(link.getAttribute('href'))) {
        link.classList.add('active');
      }
    });
  });
})();

/* =========================================
   RESEARCH LIST — client-side sort
   ========================================= */
(function () {
  'use strict';

  var sortBtns = document.querySelectorAll('.sort-btn');
  if (!sortBtns.length) return;

  var list         = document.querySelector('.research-list');
  var ratingOrder  = { BULLISH: 0, NEUTRAL: 1, BEARISH: 2 };

  function sortList(method) {
    var items = Array.prototype.slice.call(list.querySelectorAll('.research-item'));

    items.sort(function (a, b) {
      var da, db, ra, rb;
      switch (method) {
        case 'date-desc':
          da = a.dataset.date ? new Date(a.dataset.date) : new Date(0);
          db = b.dataset.date ? new Date(b.dataset.date) : new Date(0);
          return db - da;
        case 'date-asc':
          da = a.dataset.date ? new Date(a.dataset.date) : new Date(0);
          db = b.dataset.date ? new Date(b.dataset.date) : new Date(0);
          return da - db;
        case 'ticker':
          return (a.dataset.ticker || '').localeCompare(b.dataset.ticker || '');
        case 'rating':
          ra = ratingOrder[a.dataset.rating] !== undefined ? ratingOrder[a.dataset.rating] : 99;
          rb = ratingOrder[b.dataset.rating] !== undefined ? ratingOrder[b.dataset.rating] : 99;
          return ra - rb;
        default:
          return 0;
      }
    });

    items.forEach(function (item) { list.appendChild(item); });
  }

  sortBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      sortBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      sortList(btn.dataset.sort);
    });
  });
})();

/* =========================================
   RESEARCH LIST — client-side search filter
   ========================================= */
(function () {
  'use strict';

  var input = document.querySelector('.search-input');
  var list  = document.querySelector('.research-list');
  if (!input || !list) return;

  var count = document.querySelector('.sort-count');
  var items = Array.prototype.slice.call(list.querySelectorAll('.research-item'));
  var total = items.length;

  function label(n) {
    return n + ' report' + (n !== 1 ? 's' : '');
  }

  input.addEventListener('input', function () {
    var q = input.value.trim().toLowerCase();
    var visible = 0;

    items.forEach(function (item) {
      var match = !q || item.textContent.toLowerCase().indexOf(q) !== -1;
      item.style.display = match ? '' : 'none';
      if (match) visible++;
    });

    if (count) {
      count.textContent = q ? visible + ' of ' + label(total) : label(total);
    }
  });
})();
