(function () {
  'use strict';

  var PHONE = '972532346979';
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  document.getElementById('year').textContent = new Date().getFullYear();

  // Header border + mobile action bar
  var header = document.querySelector('.header');
  var mbar = document.getElementById('mbar');
  function onScroll() {
    header.classList.toggle('is-scrolled', window.scrollY > 10);
    mbar.classList.toggle('is-visible', window.scrollY > 480);
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Mobile menu
  var burger = document.getElementById('burger');
  var nav = document.getElementById('nav');
  function setMenu(open) {
    nav.classList.toggle('is-open', open);
    burger.setAttribute('aria-expanded', open);
    document.body.style.overflow = open ? 'hidden' : '';
  }
  burger.addEventListener('click', function () { setMenu(!nav.classList.contains('is-open')); });
  nav.addEventListener('click', function (e) { if (e.target.tagName === 'A') setMenu(false); });

  // Reveal on scroll (text + image clips)
  // A clipped element has no visible area, so watch its parent and reveal the clip.
  var targets = document.querySelectorAll('.reveal, .clip');
  if ('IntersectionObserver' in window && !reduceMotion) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        (en.target._reveals || [en.target]).forEach(function (el) { el.classList.add('is-in'); });
        io.unobserve(en.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });
    targets.forEach(function (el) {
      if (el.classList.contains('clip')) {
        var parent = el.parentElement;
        (parent._reveals = parent._reveals || []).push(el);
        io.observe(parent);
      } else {
        io.observe(el);
      }
    });
  } else {
    targets.forEach(function (el) { el.classList.add('is-in'); });
  }

  // Active nav link
  var links = nav.querySelectorAll('a');
  if ('IntersectionObserver' in window) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (a) { a.classList.toggle('is-active', a.getAttribute('href') === '#' + en.target.id); });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    document.querySelectorAll('main section[id]').forEach(function (s) { spy.observe(s); });
  }

  // Parallax: hero images and motto background
  if (!reduceMotion) {
    var layers = Array.prototype.slice.call(document.querySelectorAll('[data-speed]'));
    var motto = document.querySelector('[data-parallax]');
    var ticking = false;
    var render = function () {
      var y = window.scrollY;
      layers.forEach(function (img) {
        if (!img.parentElement.classList.contains('is-in')) return;
        img.style.transform = 'translate3d(0,' + (y * parseFloat(img.dataset.speed)).toFixed(1) + 'px,0) scale(1.08)';
      });
      if (motto) {
        var r = motto.parentElement.getBoundingClientRect();
        var p = (r.top + r.height / 2 - window.innerHeight / 2) / window.innerHeight;
        motto.style.transform = 'translate3d(0,' + (p * -90).toFixed(1) + 'px,0)';
      }
      ticking = false;
    };
    window.addEventListener('scroll', function () {
      if (!ticking) { requestAnimationFrame(render); ticking = true; }
    }, { passive: true });
    // Hand over from the reveal transition to scroll-driven transforms once it ends
    layers.forEach(function (img) {
      img.parentElement.addEventListener('transitionend', render, { once: true });
    });
  }

  // Services: image preview that follows the cursor
  var peek = document.getElementById('peek');
  if (peek && finePointer && !reduceMotion) {
    var peekImg = peek.querySelector('img');
    var tx = 0, ty = 0, cx = 0, cy = 0, raf = null;
    var loop = function () {
      cx += (tx - cx) * 0.18;
      cy += (ty - cy) * 0.18;
      var tilt = Math.max(-6, Math.min(6, (tx - cx) * 0.08));
      peek.style.transform = 'translate3d(' + (cx - 120) + 'px,' + (cy - 200) + 'px,0) rotate(' + tilt + 'deg)';
      raf = Math.abs(tx - cx) + Math.abs(ty - cy) > 0.5 ? requestAnimationFrame(loop) : null;
    };
    var move = function (e) {
      tx = e.clientX; ty = e.clientY;
      if (!raf) raf = requestAnimationFrame(loop);
    };
    document.querySelectorAll('.menu__item').forEach(function (item) {
      item.addEventListener('mouseenter', function (e) {
        peekImg.src = item.dataset.img;
        if (!peek.classList.contains('is-on')) { cx = tx = e.clientX; cy = ty = e.clientY; }
        peek.classList.add('is-on');
        move(e);
      });
      item.addEventListener('mousemove', move);
      item.addEventListener('mouseleave', function () { peek.classList.remove('is-on'); });
    });
  }

  // Service link -> preselect in booking form
  var serviceSelect = document.getElementById('serviceSelect');
  document.querySelectorAll('[data-service]').forEach(function (a) {
    a.addEventListener('click', function () {
      var val = a.dataset.service;
      if (Array.prototype.some.call(serviceSelect.options, function (o) { return o.value === val; })) {
        serviceSelect.value = val;
      }
      if (val === 'תספורת חתול') document.querySelector('input[name=type][value="חתול"]').checked = true;
    });
  });

  // Booking form -> WhatsApp message
  var form = document.getElementById('bookForm');
  var err = document.getElementById('formError');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var d = new FormData(form);
    var nameInput = form.elements.name;
    var name = (d.get('name') || '').trim();
    if (!name) {
      err.hidden = false;
      nameInput.classList.add('is-invalid');
      nameInput.focus();
      return;
    }
    err.hidden = true;
    nameInput.classList.remove('is-invalid');

    var pet = (d.get('pet') || '').trim();
    var breed = (d.get('breed') || '').trim();
    var when = (d.get('when') || '').trim();
    var lines = ['היי רותם, אשמח לתאם תור במיס פונפון.', '', 'שם: ' + name];
    lines.push(d.get('type') + (pet ? ': ' + pet : ''));
    if (breed) lines.push('גזע / גודל: ' + breed);
    lines.push('שירות: ' + d.get('service'));
    if (when) lines.push('מועד מועדף: ' + when);

    track('form_submit');
    window.open('https://wa.me/' + PHONE + '?text=' + encodeURIComponent(lines.join('\n')), '_blank', 'noopener');
  });

  // Conversion events (active once gtag / GA4 is added)
  function track(name) {
    if (typeof window.gtag === 'function') window.gtag('event', name);
  }
  document.querySelectorAll('[data-track]').forEach(function (el) {
    el.addEventListener('click', function () { track(el.dataset.track); });
  });
})();
