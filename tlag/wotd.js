// wotd: stores one word per pacific date, so past days never change. fallback to locally cached copy, and
// failing that to a deterministic pick from the dictionary.
(function () {
  'use strict';

  var LS_DICT = 'tlag.dict.v1';
  var LS_STATE = 'tlag.wotd.v1';
  var LS_HIST = 'tlag.wotd.history.v1';
  var WOTD_TZ = 'America/Los_Angeles';
  var DEFAULT_API = '/api/wotd';

  function todayKeyPST(d) {
    d = d || new Date();
    try {
      // en-CA yields YYYY-MM-DD in the given time zone, so everyone shares the Pacific day
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: WOTD_TZ, year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(d);
    } catch (err) {
      // Fallback to fixed UTC-8 (PST) if the Intl time zone is unavailable
      return new Date(d.getTime() - 8 * 3600 * 1000).toISOString().slice(0, 10);
    }
  }

  function parseKey(key) {
    // Noon UTC anchors the calendar date so formatting in Pacific TZ never shifts the day
    return new Date(key + 'T12:00:00Z');
  }

  function prettyKey(key) {
    try {
      return parseKey(key).toLocaleDateString(undefined, {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: WOTD_TZ
      });
    } catch (err) {
      return key;
    }
  }

  // cyrb53 hash, only used by the offline dictionary fallback
  function hashStr(str, seed) {
    var h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }

  function pickForDate(entries, key) {
    var idx = hashStr('tlag-wotd:' + key, 0) % entries.length;
    return { index: idx, entry: entries[idx] };
  }

  function readLS(name) {
    try {
      var raw = localStorage.getItem(name);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function writeLS(name, value) {
    try {
      localStorage.setItem(name, JSON.stringify(value));
    } catch (err) {
      /* storage full or unavailable: feature still works, just not remembered */
    }
  }

  function loadState() {
    var s = readLS(LS_STATE) || {};
    if (!Array.isArray(s.favs)) s.favs = [];
    delete s.seen; // old client-side "recent" log; the server history replaces it
    return s;
  }

  // ---- data: { today, dates: [sorted YYYY-MM-DD], byDate: { date: entry } } ----

  function normalize(raw) {
    if (!raw || typeof raw.today !== 'string' || !Array.isArray(raw.history)) return null;
    var byDate = {};
    raw.history.forEach(function (h) {
      if (h && typeof h.date === 'string' && h.entry) byDate[h.date] = h.entry;
    });
    var dates = Object.keys(byDate).sort();
    if (!dates.length) return null;
    return { today: raw.today, dates: dates, byDate: byDate };
  }

  function loadDict(url) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      return res.json();
    }).then(function (dict) {
      writeLS(LS_DICT, { savedAt: Date.now(), dict: dict });
      return dict;
    }).catch(function (err) {
      var cached = readLS(LS_DICT);
      if (cached && cached.dict && cached.dict.entries && cached.dict.entries.length) return cached.dict;
      throw err;
    });
  }

  function loadData(apiUrl, dictUrl) {
    return fetch(apiUrl, { headers: { Accept: 'application/json' } }).then(function (res) {
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      return res.json();
    }).then(function (raw) {
      var data = normalize(raw);
      if (!data) throw new Error('unexpected wotd response');
      writeLS(LS_HIST, raw);
      return data;
    }).catch(function (err) {
      console.warn('[wotd] api unavailable, falling back:', err);
      var cached = normalize(readLS(LS_HIST));
      var today = todayKeyPST();
      if (cached && cached.byDate[today]) {
        cached.today = today;
        return cached;
      }
      return loadDict(dictUrl).then(function (dict) {
        var by = {};
        by[today] = pickForDate(dict.entries, today).entry;
        return { today: today, dates: [today], byDate: by };
      });
    });
  }

  // ---- rendering ----

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function plainEn(entry) {
    if (typeof entry.enHtml === 'string') {
      var tmp = document.createElement('span');
      tmp.innerHTML = entry.enHtml;
      return tmp.textContent || '';
    }
    return entry.en || '';
  }

  function displayEn(entry) {
    return esc(plainEn(entry));
  }

  function renderEntryHTML(entry) {
    var h = '<div class="wotd-word tl">' + esc(entry.t) + '</div>';
    var meta = [];
    if (entry.ipa) meta.push('<span class="ipa">' + esc(entry.ipa) + '</span>');
    if (entry.pos) meta.push('<span class="pos">' + esc(entry.pos) + '</span>');
    if (entry.cats && entry.cats.length) {
      meta.push('<span class="wotd-cats">' + entry.cats.map(esc).join(' · ') + '</span>');
    }
    if (meta.length) h += '<div class="wotd-meta">' + meta.join(' ') + '</div>';
    h += '<p class="wotd-en">' + displayEn(entry) + '</p>';
    if (entry.ety) h += '<p class="wotd-ety">' + esc(entry.ety) + '</p>';
    (entry.ex || []).forEach(function (x) {
      h += '<div class="wotd-ex"><p class="wotd-ex-t">' + esc(x.tlag || '') + '</p>';
      String(x.en || '').split('\n').forEach(function (line) {
        if (line) h += '<p class="wotd-ex-e">' + esc(line) + '</p>';
      });
      if (x.gloss) h += '<p class="wotd-ex-g">' + esc(x.gloss) + '</p>';
      h += '</div>';
    });
    return h;
  }

  function renderWidget(box, data, state, key) {
    var entry = data.byDate[key];
    var idx = data.dates.indexOf(key);
    var prevKey = idx > 0 ? data.dates[idx - 1] : null;
    var nextKey = idx > -1 && idx < data.dates.length - 1 ? data.dates[idx + 1] : null;
    var isToday = key === data.today;

    var glossHref = box.getAttribute('data-gloss') || 'gloss/';
    var fav = state.favs.indexOf(entry.t) > -1;

    var h = ''
      + '<div class="wotd-top"><span class="tag wotd-date">' + esc(isToday ? 'Today · ' + prettyKey(key) : prettyKey(key)) + '</span>'
      + '<span class="wotd-nav" role="group" aria-label="Browse other days">'
      + '<button type="button" class="wotd-btn" data-act="prev" aria-label="Previous day"' + (prevKey ? '' : ' disabled') + '>‹</button>'
      + (isToday ? '' : '<button type="button" class="wotd-btn wotd-btn--text" data-act="today">Today</button>')
      + '<button type="button" class="wotd-btn" data-act="next" aria-label="Next day"' + (nextKey ? '' : ' disabled') + '>›</button>'
      + '</span></div>'
      + renderEntryHTML(entry)
      + '<div class="wotd-actions">'
      + '<button type="button" class="wotd-btn wotd-btn--text" data-act="fav" aria-pressed="' + fav + '">' + (fav ? '★ favorited' : '☆ favorite') + '</button>'
      + '<button type="button" class="wotd-btn wotd-btn--text" data-act="copy">copy</button>'
      + '<a class="wotd-link" href="' + esc(glossHref) + '?w=' + encodeURIComponent(entry.t) + '">open in dictionary</a>'
      + '</div>';

    // the five most recent days before the latest one
    var recent = data.dates.slice(-6, -1).reverse();
    if (recent.length) {
      h += '<p class="wotd-recent"><span>recent:</span> ' + recent.map(function (k) {
        return '<button type="button" class="wotd-chip" data-act="goto" data-date="' + esc(k) + '" title="' + esc(k) + '">' + esc(data.byDate[k].t) + '</button>';
      }).join(' ') + '</p>';
    }
    box.innerHTML = h;

    box.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var act = btn.getAttribute('data-act');
        if (act === 'prev' && prevKey) renderWidget(box, data, state, prevKey);
        else if (act === 'next' && nextKey) renderWidget(box, data, state, nextKey);
        else if (act === 'today') renderWidget(box, data, state, data.today);
        else if (act === 'goto') renderWidget(box, data, state, btn.getAttribute('data-date'));
        else if (act === 'fav') {
          var i = state.favs.indexOf(entry.t);
          if (i > -1) state.favs.splice(i, 1);
          else state.favs.push(entry.t);
          writeLS(LS_STATE, state);
          renderWidget(box, data, state, key);
        } else if (act === 'copy') {
          copyText('tlag word of the day ' + key + ': ' + entry.t + ': ' + plainEn(entry), btn);
        }
      });
    });
  }

  function copyText(text, btn) {
    function done(ok) {
      var orig = btn.textContent;
      btn.textContent = ok ? 'copied!' : 'copy failed';
      setTimeout(function () { btn.textContent = orig; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        done(true);
      } catch (err) {
        done(false);
      }
    }
  }

  function renderStrip(el, data) {
    var entry = data.byDate[data.today] || data.byDate[data.dates[data.dates.length - 1]];
    var key = data.byDate[data.today] ? data.today : data.dates[data.dates.length - 1];
    el.innerHTML = 'Word of the day (' + esc(key) + '): '
      + '<a href="?w=' + encodeURIComponent(entry.t) + '"><strong class="tl">' + esc(entry.t) + '</strong>: ' + displayEn(entry) + '</a>';
  }

  function fail(box, err) {
    console.error('[wotd] Could not load the word of the day:', err);
    var gloss = box.getAttribute('data-gloss') || 'gloss/';
    box.innerHTML = '<p class="wotd-error">Could not load today\u2019s word. '
      + '<a href="' + esc(gloss) + '">Browse the full dictionary</a> instead.</p>';
  }

  function showToday(data) {
    return data.byDate[data.today] ? data.today : data.dates[data.dates.length - 1];
  }

  document.addEventListener('DOMContentLoaded', function () {
    var widgets = Array.prototype.slice.call(document.querySelectorAll('[data-wotd]'));
    var strips = Array.prototype.slice.call(document.querySelectorAll('[data-wotd-strip]'));
    if (!widgets.length && !strips.length) return;

    var first = widgets[0] || strips[0];
    var apiUrl = first.getAttribute('data-wotd-api') || DEFAULT_API;
    var dictUrl = first.getAttribute('data-dict')
      || (first.hasAttribute('data-wotd-strip') ? '../data/dictionary.json' : 'data/dictionary.json');

    loadData(apiUrl, dictUrl).then(function (data) {
      var state = loadState();
      widgets.forEach(function (el) { renderWidget(el, data, state, showToday(data)); });
      strips.forEach(function (el) { renderStrip(el, data); });
    }).catch(function (err) {
      widgets.forEach(function (el) { fail(el, err); });
      strips.forEach(function (el) {
        el.innerHTML = 'Word of the day is unavailable offline. <a href="gloss/">Browse the dictionary</a>.';
      });
    });
  });

  // exposed for testing / debugging in the console
  window.TlagWotd = {
    todayKeyPST: todayKeyPST,
    todayKeyUTC: todayKeyPST // legacy alias
  };
})();
