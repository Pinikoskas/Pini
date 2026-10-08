(function () {
  'use strict';

  var PHONE = '972532346979';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.getElementById('year').textContent = new Date().getFullYear();

  // Header shrink + mobile bottom bar
  var header = document.querySelector('.header');
  var mbar = document.getElementById('mbar');
  function onScroll() {
    var y = window.scrollY;
    header.classList.toggle('is-scrolled', y > 20);
    mbar.classList.toggle('is-visible', y > 500);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Mobile menu
  var burger = document.getElementById('burger');
  var nav = document.getElementById('nav');
  burger.addEventListener('click', function () {
    var open = nav.classList.toggle('is-open');
    burger.setAttribute('aria-expanded', open);
  });
  nav.addEventListener('click', function (e) {
    if (e.target.tagName === 'A') {
      nav.classList.remove('is-open');
      burger.setAttribute('aria-expanded', 'false');
    }
  });

  // Scroll reveal
  var reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('is-visible');
          io.unobserve(en.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('is-visible'); });
  }

  // Active nav link
  var links = nav.querySelectorAll('a');
  if ('IntersectionObserver' in window) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          links.forEach(function (a) {
            a.classList.toggle('is-active', a.getAttribute('href') === '#' + en.target.id);
          });
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    document.querySelectorAll('main section[id]').forEach(function (s) { spy.observe(s); });
  }

  // Hero crossfade slideshow
  var slides = document.querySelectorAll('.blob .slide');
  if (slides.length > 1 && !reduceMotion) {
    var i = 0;
    setInterval(function () {
      slides[i].classList.remove('is-active');
      i = (i + 1) % slides.length;
      slides[i].classList.add('is-active');
    }, 5000);
  }

  // Parallax band
  var pbg = document.querySelector('[data-parallax]');
  if (pbg && !reduceMotion) {
    var ticking = false;
    var update = function () {
      var r = pbg.parentElement.getBoundingClientRect();
      var progress = (r.top + r.height / 2 - window.innerHeight / 2) / window.innerHeight;
      pbg.style.transform = 'translate3d(0,' + (progress * -80).toFixed(1) + 'px,0)';
      ticking = false;
    };
    window.addEventListener('scroll', function () {
      if (!ticking) { requestAnimationFrame(update); ticking = true; }
    }, { passive: true });
    update();
  }

  // Service card -> preselect service in booking form
  var serviceSelect = document.getElementById('serviceSelect');
  document.querySelectorAll('[data-service]').forEach(function (a) {
    a.addEventListener('click', function () {
      var val = a.getAttribute('data-service');
      Array.prototype.forEach.call(serviceSelect.options, function (o) {
        if (o.value === val) serviceSelect.value = val;
      });
      if (val === 'תספורת חתול') {
        document.querySelector('input[name=type][value="חתול"]').checked = true;
      }
    });
  });

  // Booking form -> WhatsApp
  var form = document.getElementById('bookForm');
  var err = document.getElementById('formError');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var d = new FormData(form);
    var name = (d.get('name') || '').trim();
    var nameInput = form.elements.name;
    if (!name) {
      err.hidden = false;
      nameInput.classList.remove('is-invalid');
      void nameInput.offsetWidth; // restart shake animation
      nameInput.classList.add('is-invalid');
      nameInput.focus();
      return;
    }
    err.hidden = true;
    nameInput.classList.remove('is-invalid');

    var lines = ['היי רותם, אשמח לקבוע תור במיס פונפון 🐾', '', 'שם: ' + name];
    var pet = (d.get('pet') || '').trim();
    var breed = (d.get('breed') || '').trim();
    var when = (d.get('when') || '').trim();
    lines.push('חיית מחמד: ' + d.get('type') + (pet ? ' – ' + pet : ''));
    if (breed) lines.push('גזע / גודל: ' + breed);
    lines.push('שירות: ' + d.get('service'));
    if (when) lines.push('מועד מועדף: ' + when);

    track('form_submit');
    window.open('https://wa.me/' + PHONE + '?text=' + encodeURIComponent(lines.join('\n')), '_blank', 'noopener');
  });

  // Tease the floating WhatsApp tooltip once
  var fab = document.querySelector('.fab');
  if (fab) {
    setTimeout(function () {
      fab.classList.add('is-teasing');
      setTimeout(function () { fab.classList.remove('is-teasing'); }, 4000);
    }, 6000);
  }

  // Conversion tracking hook (works if gtag is added later)
  function track(name) {
    if (typeof window.gtag === 'function') window.gtag('event', name);
  }
  document.querySelectorAll('[data-track]').forEach(function (el) {
    el.addEventListener('click', function () { track(el.getAttribute('data-track')); });
  });
})();
