'use strict';
// Options page. One rule: the port and the toggles are stored as they are, but custom
// domains additionally need a permission grant and a dynamic content-script registration —
// both happen on 保存, so the user sees the consent prompt attached to the action.

const DEFAULTS = { port: 45789, detailMark: true, listMark: true, badgePlay: true, domains: [] };
const $ = (id) => document.getElementById(id);

const msg = (m) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(m, (r) => {
      void chrome.runtime.lastError;
      resolve(r || { ok: false, error: '扩展后台没有回应' });
    });
  });

function parseDomains(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const host = line.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^\*\./, '');
    if (!host) continue;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
      throw new Error('不像域名：' + line.trim());
    }
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

function setStatus(text, cls) {
  const s = $('status');
  s.textContent = text;
  s.className = cls || 'hint';
}

async function ping() {
  setStatus('连接中…', 'hint');
  const cfg = { port: Number($('port').value) || DEFAULTS.port };
  const r = await msg({ type: 'jse:ping' });
  if (r && r.ok) {
    setStatus(`已连接：JavShelf ${r.version} · 库里 ${r.rows} 条 · 库 ${(r.libraries || []).length} 个`, 'ok');
    return true;
  }
  if (r && r.offline) {
    setStatus(`连不上 127.0.0.1:${cfg.port}——确认 JavShelf 开着、设置里「打开本地桥接」已保存`, 'warn');
    return false;
  }
  setStatus('桥接回了错：' + ((r && r.error) || '未知原因'), 'bad');
  return false;
}

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  $('port').value = Number(s.port) || DEFAULTS.port;
  $('detailMark').checked = s.detailMark !== false;
  $('listMark').checked = s.listMark !== false;
  $('badgePlay').checked = s.badgePlay !== false;
  $('domains').value = (Array.isArray(s.domains) ? s.domains : []).join('\n');
  ping();
}

async function save() {
  const saved = $('saved');
  saved.textContent = '';
  saved.className = 'hint';
  let domains;
  try {
    domains = parseDomains($('domains').value);
  } catch (e) {
    saved.textContent = e.message;
    saved.className = 'bad';
    return;
  }
  // 授权请求必须在点击手势里，所以它前面不能有 await：这是本函数第一件事。
  const origins = [];
  for (const d of domains) origins.push(`*://${d}/*`, `*://*.${d}/*`);
  const granted = !origins.length || (await chrome.permissions.request({ origins }).catch(() => false));
  await chrome.storage.local.set({
    port: Number($('port').value) || DEFAULTS.port,
    detailMark: $('detailMark').checked,
    listMark: $('listMark').checked,
    badgePlay: $('badgePlay').checked,
    domains
  });
  const r = await msg({ type: 'jse:domains', domains });
  if (!saved.textContent) {
    if (!granted) {
      saved.textContent = '端口与开关已保存；附加域名没拿到授权，这些站点不会被标记';
      saved.className = 'warn';
    } else {
      saved.textContent = r && r.ok ? `已保存（附加域名生效 ${(r.matches || []).length} 条规则）` : '端口与开关已保存，附加域名注册失败';
      saved.className = r && r.ok ? 'ok' : 'warn';
    }
  }
  setTimeout(() => {
    saved.textContent = '';
  }, 6000);
  ping();
}

$('save').onclick = save;
$('test').onclick = ping;
$('port').addEventListener('change', ping);
load();
