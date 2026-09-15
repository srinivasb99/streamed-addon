'use strict';

/* Landing page logic: manifest install box + live preview with sport filter. */
(function () {
  var manifestUrl = window.location.origin + '/manifest.json';

  var urlBox = document.getElementById('manifest-url');
  var installLink = document.getElementById('install-link');
  var copyBtn = document.getElementById('copy-btn');
  var installNotice = document.getElementById('install-notice');
  var chipsEl = document.getElementById('chips');
  var gridEl = document.getElementById('live-grid');

  urlBox.textContent = manifestUrl;
  installLink.href = 'stremio://' + window.location.host + '/manifest.json';
  var localHost = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(window.location.hostname);
  installNotice.textContent = localHost
    ? 'Keep the :port number and use http for local development. This address only works on the computer running the addon.'
    : 'Use the HTTPS manifest URL exactly as shown. This hosted addon works across devices.';

  copyBtn.addEventListener('click', function () {
    function done() {
      copyBtn.textContent = 'Copied!';
      copyBtn.classList.add('copied');
      setTimeout(function () {
        copyBtn.textContent = 'Copy';
        copyBtn.classList.remove('copied');
      }, 1600);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(manifestUrl).then(done, done);
    } else {
      var ta = document.createElement('textarea');
      ta.value = manifestUrl;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* no-op */ }
      document.body.removeChild(ta);
      done();
    }
  });

  var allMetas = [];
  var activeSport = '';

  function kickoffLabel(description) {
    var lines = String(description || '').split('\n');
    for (var i = lines.length - 1; i >= 0; i--) {
      if (/kickoff/i.test(lines[i])) return lines[i].replace(/^kickoff:\s*/i, '');
    }
    return '';
  }

  function startDateLabel(startTime) {
    var date = new Date(Number(startTime));
    if (!Number.isFinite(date.getTime())) return 'Date TBA';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function render() {
    var metas = activeSport
      ? allMetas.filter(function (m) {
          return (m.genres || []).some(function (g) {
            return g.toLowerCase() === activeSport.toLowerCase();
          });
        })
      : allMetas;
    if (!metas.length) {
      gridEl.innerHTML = '<div class="live-empty">No matches available right now — check back at kickoff time.</div>';
      return;
    }
    gridEl.innerHTML = '';
    metas.slice(0, 12).forEach(function (m) {
      var card = document.createElement('div');
      card.className = 'match-card';
      var poster = document.createElement('div');
      poster.className = 'poster';
      if (m.background || m.poster) {
        poster.style.backgroundImage = "url('" + (m.background || m.poster) + "')";
      } else {
        poster.classList.add('poster-fallback');
        var fallback = document.createElement('div');
        fallback.className = 'poster-fallback-content';
        var fallbackIcon = document.createElement('img');
        fallbackIcon.src = '/assets/icon.svg';
        fallbackIcon.alt = '';
        var fallbackName = document.createElement('span');
        fallbackName.textContent = 'Streamed';
        fallback.appendChild(fallbackIcon);
        fallback.appendChild(fallbackName);
        poster.appendChild(fallback);
      }
      var shade = document.createElement('div');
      shade.className = 'shade';
      var body = document.createElement('div');
      body.className = 'body';
      var league = (m.genres && m.genres[0]) || 'Live';
      body.innerHTML =
        '<div class="league"></div><div class="name"></div><div class="kickoff"></div>';
      body.querySelector('.league').textContent = league;
      body.querySelector('.name').textContent = m.name;
      body.querySelector('.kickoff').textContent = m.isLive ? kickoffLabel(m.description) : '';
      card.appendChild(poster);
      card.appendChild(shade);
      var status = document.createElement('span');
      status.className = m.isLive ? 'live-badge' : 'date-badge';
      status.textContent = m.isLive ? 'LIVE' : startDateLabel(m.startTime);
      card.appendChild(status);
      card.appendChild(body);
      gridEl.appendChild(card);
    });
  }

  function selectSport(sport, btn) {
    activeSport = sport;
    var btns = chipsEl.querySelectorAll('.chip');
    for (var i = 0; i < btns.length; i++) btns[i].classList.remove('selected');
    if (btn) btn.classList.add('selected');
    render();
  }

  fetch('/api/sports')
    .then(function (r) { return r.json(); })
    .then(function (sports) {
      (sports || []).forEach(function (s) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.dataset.sport = s.name;
        b.textContent = s.name;
        b.addEventListener('click', function () { selectSport(s.name, b); });
        chipsEl.appendChild(b);
      });
    })
    .catch(function () { /* chips stay at "All sports" */ });

  chipsEl.querySelector('[data-sport=""]').addEventListener('click', function () {
    selectSport('', this);
  });

  fetch('/api/preview/live')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      allMetas = (data && data.metas) || [];
      render();
    })
    .catch(function () {
      gridEl.innerHTML = '<div class="live-empty">Could not load live matches — check your connection and refresh.</div>';
    });
})();
