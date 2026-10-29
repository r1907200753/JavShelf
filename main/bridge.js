'use strict';
const http = require('node:http');

// The browser extension talks to this process over loopback HTTP. Three rules shape it:
//   - bind 127.0.0.1 only, so nothing outside this machine can reach it;
//   - every request must carry X-JavShelf: 1 — a header a web page cannot add without a
//     CORS preflight, which is only answered for chrome-extension:// origins. A random
//     site can therefore neither read the replies nor launch the player through a form;
//   - CORS is answered only for chrome-extension://, and the answers never echo paths
//     back: lookup returns 番号/库名/已看, play returns which player was used.
const HEADER = 'x-javshelf';
const MAX_BODY = 64 * 1024;
const MAX_CODES = 300;

// Same rule as the renderer's dupKey (renderer/app.js): only leading zeros between the
// letter prefix and the digits are collapsed, so ABP-123 / abp123 / ABP-0123 are one key
// while ABP-123-2 and ABP-123A stay distinct. The two copies must stay in step — the
// lookup answer has to agree with what 查重 calls a match.
function normalizeKey(code) {
  const s = String(code || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
  return s.replace(/^([A-Z]+)0+(?=\d)/, '$1');
}

class Bridge {
  // lookup(codes) -> { "<requested>": {have, code, lib, seen} }; play(code) -> {ok, player, error}
  constructor({ lookup, play, info, log }) {
    this.lookup = lookup;
    this.play = play;
    this.info = info;
    this.log = log || (() => {});
    this.server = null;
    this.sockets = new Set();
    this.port = 0;
    this.error = '';
    this.startedAt = 0;
    this.stats = { requests: 0, lookups: 0, plays: 0, rejected: 0 };
  }

  status() {
    return {
      running: !!this.server,
      port: this.port,
      error: this.error,
      startedAt: this.startedAt,
      stats: { ...this.stats }
    };
  }

  // Returns null on success, or a human-readable reason for the settings panel.
  start(port) {
    this.stop();
    const want = Number(port) || 0;
    if (!want) {
      this.error = '端口号无效';
      return this.error;
    }
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.onRequest(req, res));
      server.on('connection', (sock) => {
        this.sockets.add(sock);
        sock.on('close', () => this.sockets.delete(sock));
      });
      const done = (err) => {
        if (err) {
          this.error = err.code === 'EADDRINUSE' ? `端口 ${want} 已被占用` : err.message;
          try {
            server.close();
          } catch {
            /* never listened */
          }
          this.server = null;
          resolve(this.error);
          return;
        }
        this.server = server;
        this.port = want;
        this.error = '';
        this.startedAt = Date.now();
        resolve(null);
      };
      server.once('error', done);
      server.listen(want, '127.0.0.1', () => {
        server.removeListener('error', done);
        server.on('error', (e) => this.log('warn', '浏览器桥接出错：' + ((e && e.message) || e)));
        done(null);
      });
    });
  }

  stop() {
    const server = this.server;
    this.server = null;
    if (!server) return;
    // close() only stops new connections; a kept-alive extension connection would hold the
    // port until it times out, and the next start() on the same port would fail EADDRINUSE.
    try {
      server.close();
    } catch {
      /* already closed */
    }
    for (const s of this.sockets) {
      try {
        s.destroy();
      } catch {
        /* already gone */
      }
    }
    this.sockets.clear();
  }

  cors(req, res) {
    const origin = String(req.headers.origin || '');
    if (!origin.startsWith('chrome-extension://')) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, ' + HEADER);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }

  send(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const parts = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        parts.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
      req.on('error', reject);
    });
  }

  async onRequest(req, res) {
    this.stats.requests++;
    const allowed = this.cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(allowed ? 204 : 403).end();
      return;
    }
    if (String(req.headers[HEADER] || '') !== '1') {
      this.stats.rejected++;
      this.send(res, 403, { ok: false, error: '缺少 ' + HEADER + ' 请求头' });
      return;
    }
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      this.send(res, 400, { ok: false, error: '地址读不出来' });
      return;
    }
    try {
      if (req.method === 'GET' && url.pathname === '/api/ping') {
        this.send(res, 200, { ok: true, ...this.info() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/lookup') {
        const codes = String(url.searchParams.get('codes') || '')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean)
          .slice(0, MAX_CODES);
        if (!codes.length) {
          this.send(res, 400, { ok: false, error: '没有要查的番号' });
          return;
        }
        this.stats.lookups++;
        this.send(res, 200, { ok: true, results: this.lookup(codes) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/play') {
        const raw = await this.readBody(req);
        let arg = {};
        try {
          arg = JSON.parse(raw || '{}');
        } catch {
          this.send(res, 400, { ok: false, error: '请求体不是 JSON' });
          return;
        }
        const code = String(arg.code || '').trim();
        if (!code) {
          this.send(res, 400, { ok: false, error: '没有番号' });
          return;
        }
        this.stats.plays++;
        const r = await this.play(code, String(arg.lib || ''));
        this.send(res, 200, r.ok ? { ok: true, player: r.player } : { ok: false, error: r.error });
        return;
      }
      this.send(res, 404, { ok: false, error: '没有这个接口' });
    } catch (e) {
      this.send(res, 500, { ok: false, error: (e && e.message) || String(e) });
    }
  }
}

module.exports = { Bridge, normalizeKey, HEADER, MAX_CODES };
