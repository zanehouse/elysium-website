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
