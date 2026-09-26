'use strict';
// Grabs the JavDB login cookie from his own Chrome instead of an embedded browser: Chrome opens
// the real site (so the edge doesn't serve a blank challenge page), and we read the cookie jar
// back over Chrome's own debugging pipe. Reading it from Chrome is the only way to get the
// session cookie at all — it is HttpOnly, so no page script can see it.
//
// A private profile directory under our own data dir keeps the debugging port legal (Chrome
// refuses it on the default profile) and leaves his bookmarks and history untouched. The first
// run asks him to log in there once; later runs read the stored cookie back instantly.
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

const BASE = 'https://javdb.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const LOGIN_WAIT_MS = 240000;
const POLL_MS = 2000;

function chromeExecutable() {
  const env = process.env;
  const dirs = [env.PROGRAMFILES || 'C:\\Program Files', env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', env.LOCALAPPDATA || ''];
  // Chrome first; Edge speaks the same debugging protocol, so a machine with only Edge works too.
  const shapes = [
    ['Google', 'Chrome', 'Application', 'chrome.exe'],
    ['Microsoft', 'Edge', 'Application', 'msedge.exe']
  ];
  for (const shape of shapes) {
    for (const d of dirs) {
      const p = path.join(d, ...shape);
      if (d && fs.existsSync(p)) return p;
    }
  }
  return '';
}

function isJavdb(cookie) {
  return /javdb/i.test(String(cookie.domain || ''));
}

// The session cookie is what makes JavDB serve the logged-in actress page; the rest is
// decoration. If a jar turns up without one we still hand it over, flagged, so the button
// can never dead-end on an unknown cookie name.
function hasSession(cookies) {
  return cookies.some((c) => /session|remember|auth|token/i.test(String(c.name)));
}

// A fixed port (not --remote-debugging-port=0) so a Chrome we started earlier can be reused
// instead of spawning a second window, and so a stale DevToolsActivePort file can never make us
// talk to the wrong instance.
const DEBUG_PORT = 9333;

// Is there already a Chrome on our port, i.e. the window we opened last time?
async function liveDevtools(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    const info = await res.json();
    if (info && info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl;
  } catch {
    /* nothing listening */
  }
  return '';
}

// The session cookie is what makes JavDB serve the logged-in actress page; the rest is
// decoration. If a jar turns up without one we still hand it over, flagged, so the button
// can never dead-end on an unknown cookie name.
function hasSession(cookies) {
  return cookies.some((c) => /session|remember|auth|token/i.test(String(c.name)));
}

// One real request decides whether the harvested jar is worth saving: a rejected cookie makes
// JavDB answer 502 to everything, which is exactly the failure this feature used to hide.
async function cookieWorks(header, proxy) {
  const agent = proxy ? new ProxyAgent({ uri: proxy }) : null;
  try {
    const r = await undiciFetch(`${BASE}/actors/censored?page=1`, {
      dispatcher: agent || undefined,
      redirect: 'manual',
      headers: { 'user-agent': UA, cookie: header }
    });
    return { ok: r.status === 200, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  } finally {
    if (agent && agent.close) agent.close().catch(() => {});
  }
}

// Opens Chrome for JavDB and waits until the jar holds a logged-in session, then hands the
// header string back. onStatus(text) drives whatever the caller shows the user.
// The window is deliberately left open: closing it while he is still typing his password was
// the whole bug. He closes it himself when he is done.
async function collectFromChrome({ profileDir, url, proxy, onStatus, timeoutMs }) {
  const exe = chromeExecutable();
  if (!exe) return { ok: false, reason: '这台电脑上没有安装 Chrome（找不到 chrome.exe）' };
  if (typeof WebSocket !== 'function') return { ok: false, reason: '当前运行环境没有 WebSocket，无法与 Chrome 通信' };
  fs.mkdirSync(profileDir, { recursive: true });
  const notify = typeof onStatus === 'function' ? onStatus : () => {};
  const port = Number(process.env.JAVSHELF_CHROME_PORT) || DEBUG_PORT;
  const running = await liveDevtools(port);
  if (!running) {
    const args = [
      '--user-data-dir=' + profileDir,
      '--remote-debugging-port=' + port,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      url
    ];
    if (proxy) args.splice(args.length - 1, 0, '--proxy-server=' + proxy);
    try {
      const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (e) {
      return { ok: false, reason: '启动 Chrome 失败：' + e.message };
    }
    notify('正在打开 Chrome…');
    await new Promise((r) => setTimeout(r, 1200));
  } else {
    notify('复用上一次打开的 Chrome 窗口');
  }
  {
    const dev = { ws: running || '' };
    let ok = !!dev.ws;
    for (let i = 0; !ok && i < 25; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const url2 = await liveDevtools(port);
      if (url2) {
        dev.ws = url2;
        ok = true;
      }
    }
    if (!ok) {
      notify('Chrome 没有响应，可能已被禁用调试端口');
      return { ok: false, reason: 'Chrome 启动后没有开放调试端口（' + port + '）' };
    }
    const ws = cdp(dev.ws);
    await ws.ready;
    const deadline = Date.now() + (timeoutMs || LOGIN_WAIT_MS);
    let javdb = [];
    let said = '';
    const say = (t) => {
      if (t === said) return;
      said = t;
      notify(t);
    };
    for (;;) {
      try {
        javdb = (await allCookies(ws)).filter(isJavdb);
      } catch (e) {
        ws.close();
        return { ok: false, reason: '读取 Cookie 失败：' + e.message };
      }
      if (hasSession(javdb)) break;
      if (Date.now() > deadline) break;
      say(`Chrome 已就绪，请在它的窗口里登录 JavDB（窗口不会自动关闭，登录后会自动回填）`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    const loggedIn = hasSession(javdb);
    const seen = new Map(javdb.map((c) => [String(c.name), String(c.value)]));
    const header = [...seen].map(([n, v]) => `${n}=${v}`).join('; ');
    ws.close();
    if (!loggedIn || !header) {
      return { ok: false, reason: '还没读到登录后的 Cookie：请在打开的那个 Chrome 窗口里完成登录，然后回来再点一次', count: seen.size };
    }
    const check = await cookieWorks(header, proxy);
    if (!check.ok) {
      return {
        ok: false,
        reason: `读到 Cookie 但站点不接受（HTTP ${check.status}${check.status === 502 ? '，被边缘节点拒绝' : ''}）：请确认已经登录成功，或换个代理节点后重试`,
        count: seen.size
      };
    }
    say('Cookie 已取回，可以直接关闭那个 Chrome 窗口');
    return { ok: true, cookie: header, count: seen.size, names: [...seen.keys()], looksLoggedIn: true, verified: true };
  }
}

module.exports = { collectFromChrome };
