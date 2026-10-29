'use strict';
// Service worker: the only place that talks to JavShelf. Content scripts never fetch the
// loopback bridge themselves — a request from an extension context carries the host
// permission and the required X-JavShelf header, while a page-context request would be a
// cross-origin fetch without it (and would show up as a CORS mess in the console).

const DEFAULTS = { port: 45789, detailMark: true, listMark: true, badgePlay: true, domains: [] };

async function readCfg() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  const port = Number(stored.port) || DEFAULTS.port;
  const domains = Array.isArray(stored.domains) ? stored.domains : [];
  return { ...DEFAULTS, ...stored, port, domains };
}

function base(port) {
  return 'http://127.0.0.1:' + port;
}

async function call(path, init, port) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(base(port) + path, {
      ...init,
      signal: ctrl.signal,
      headers: { 'X-JavShelf': '1', ...((init && init.headers) || {}) },
      cache: 'no-store'
    });
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') return { ok: false, error: '桥接回了看不懂的内容', offline: false };
    return body;
  } catch (e) {
    // A closed JavShelf or a closed bridge looks the same from here — network error.
    return { ok: false, offline: true, error: (e && e.name === 'AbortError') ? 'JavShelf 没在时限内回答' : '连不上 JavShelf' };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    const cfg = await readCfg();
    if (msg && msg.type === 'jse:ping') {
      const r = await call('/api/ping', { method: 'GET' }, cfg.port);
      reply({ ...r, port: cfg.port });
      return;
    }
    if (msg && msg.type === 'jse:lookup') {
      const codes = (Array.isArray(msg.codes) ? msg.codes : []).map((c) => String(c || '').trim()).filter(Boolean).slice(0, 300);
      if (!codes.length) {
        reply({ ok: true, results: {} });
        return;
      }
      const r = await call('/api/lookup?codes=' + encodeURIComponent(codes.join(',')), { method: 'GET' }, cfg.port);
      reply(r);
      return;
    }
    if (msg && msg.type === 'jse:play') {
      const code = String(msg.code || '').trim();
      if (!code) {
        reply({ ok: false, error: '没有番号' });
        return;
      }
      const r = await call(
        '/api/play',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) },
        cfg.port
      );
      reply(r);
      return;
    }
    if (msg && msg.type === 'jse:domains') {
      const matches = await syncDomains(Array.isArray(msg.domains) ? msg.domains : []);
      reply({ ok: true, matches });
      return;
    }
    reply({ ok: false, error: '不认识的请求' });
  })();
  return true; // keep the message channel open for the async reply
});

// Custom domains are registered as one persistent dynamic content script. Kept in a
// single call so a settings change is atomic: unregister, then register the new list.
// Only domains that actually have a host permission are registered — registerContentScripts
// throws for the rest, and one un-granted line would otherwise sink the whole list.
async function syncDomains(domains) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ['jse-custom'] });
  } catch {
    /* was not registered */
  }
  const matches = [];
  for (const d of domains) {
    const host = String(d || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) continue;
    const origins = [`*://${host}/*`, `*://*.${host}/*`];
    const ok = await chrome.permissions.contains({ origins }).catch(() => false);
    if (!ok) continue;
    matches.push(...origins);
  }
  if (!matches.length) return [];
  try {
    await chrome.scripting.registerContentScripts([
      {
        id: 'jse-custom',
        matches,
        js: ['content/extract.js', 'content/content.js'],
        css: ['content/content.css'],
        runAt: 'document_idle',
        persistAcrossSessions: true
      }
    ]);
  } catch {
    return [];
  }
  return matches;
}

chrome.runtime.onInstalled.addListener(() => {
  readCfg()
    .then((cfg) => syncDomains(cfg.domains))
    .catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  readCfg()
    .then((cfg) => syncDomains(cfg.domains))
    .catch(() => {});
});
