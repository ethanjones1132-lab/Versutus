/* Versutus — progressive enhancement.
 * Everything here is additive. Without JavaScript the page is fully
 * complete and readable: nothing is hidden and nothing depends on this file.
 * When JavaScript is present we add the .js class to <html> first, which is
 * what enables the scroll-reveal styles in styles.css.
 */
(function () {
  'use strict';

  document.documentElement.classList.add('js');

  var reduceMotion = false;
  if (typeof window.matchMedia === 'function') {
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* ── Header: gain a border/shadow once the page scrolls ── */
  var header = document.querySelector('header.site-header');
  function onScrollHeader() {
    if (!header) return;
    header.classList.toggle('scrolled', window.scrollY > 8);
  }
  onScrollHeader();
  window.addEventListener('scroll', onScrollHeader, { passive: true });

  /* ── Scroll reveal for sections ── */
  var revealTargets = Array.prototype.slice.call(
    document.querySelectorAll('main > section')
  );

  if (reduceMotion || !('IntersectionObserver' in window)) {
    // No animation: just make every target visible immediately.
    revealTargets.forEach(function (el) { el.classList.add('revealed'); });
  } else {
    var revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('revealed');
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    );
    revealTargets.forEach(function (el) { revealObserver.observe(el); });
  }

  /* ── Active nav link: highlight the section being read ── */
  var navLinks = Array.prototype.slice.call(
    document.querySelectorAll('.nav-links a[href^="#"]')
  );
  var sections = navLinks
    .map(function (link) {
      var id = link.getAttribute('href').slice(1);
      return document.getElementById(id);
    })
    .filter(Boolean);

  function setActiveNav() {
    var current = null;
    sections.forEach(function (section) {
      if (section.getBoundingClientRect().top <= 140) {
        current = section.id;
      }
    });
    navLinks.forEach(function (link) {
      var id = link.getAttribute('href').slice(1);
      link.classList.toggle('active', id === current);
    });
  }

  setActiveNav();
  window.addEventListener('scroll', setActiveNav, { passive: true });
})();
