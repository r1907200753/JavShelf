'use strict';
// Runs on javdb / javbus (and any extra domains registered from the options page).
// It only ever reads 番号s off the page and injects two things: a status pill on a movie's
// own page, and a small 「本地」 badge on cards in a list. Everything else — talking to
// JavShelf — is the service worker's job, because a fetch from this context would not carry
// the bridge's required header.
(() => {
  const DEFAULTS = { port: 45789, detailMark: true, listMark: true, badgePlay: true };
  let cfg = { ...DEFAULTS };
  chrome.storage.local.get(DEFAULTS).then((s) => {
    cfg = { ...DEFAULTS, ...s };
  });
  chrome.storage.onChanged.addListener((_c, area) => {
    if (area !== 'local') return;
    chrome.storage.local.get(DEFAULTS).then((s) => {
      cfg = { ...DEFAULTS, ...s };
    });
  });

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          void chrome.runtime.lastError;
          resolve(r || { ok: false, offline: true, error: '扩展后台没有回应' });
        });
      } catch (e) {
        resolve({ ok: false, offline: true, error: String((e && e.message) || e) });
      }
    });

  // 番号怎么读页面由 extract.js 提供（manifest 里排在前面注入），测试跑的就是同一份。
  const { SITES } = window.__JSE_EXTRACT || {};
  if (!SITES) return;

  // ---------------------------------------------------------------- rendering

  const esc = (s) => String(s == null ? '' : s);

  function styleMount(mount) {
    if (!mount) return;
    if (getComputedStyle(mount).position === 'static') mount.classList.add('jse-host');
  }

  function makePill(state, mainText, subText) {
    const pill = document.createElement('div');
    pill.className = 'jse-pill jse-' + state;
    const dot = document.createElement('span');
    dot.className = 'jse-dot';
    const main = document.createElement('span');
    main.className = 'jse-main';
    main.textContent = mainText;
    pill.append(dot, main);
    if (subText) {
      const sub = document.createElement('span');
      sub.className = 'jse-sub';
      sub.textContent = subText;
      pill.append(sub);
    }
    return pill;
  }

  async function playCode(code, onState) {
    onState('working', '正在调用播放器…');
    const r = await send({ type: 'jse:play', code });
    if (r && r.ok) {
      onState('ok', r.player === 'custom' ? '已用指定播放器打开' : '已用系统播放器打开');
      return;
    }
    if (r && r.offline) return onState('offline', 'JavShelf 未连接');
    onState('fail', (r && r.error) || '播放失败');
  }

  function detailPill(entry) {
    const { code, anchor } = entry;
    if (!anchor || anchor.dataset.jsePill) return;
    anchor.dataset.jsePill = '1';
    let pill = makePill('checking', '查本地库…');
    anchor.insertAdjacentElement('afterend', pill);
    const swap = (next) => {
      next.dataset.jsePill = '1';
      pill.replaceWith(next);
      pill = next;
      return next;
    };
    send({ type: 'jse:lookup', codes: [code] }).then((r) => {
      if (!r || r.offline) {
        const p = swap(makePill('offline', 'JavShelf 未连接'));
        p.title = '打开 JavShelf →「设置 → 浏览器拓展」勾「打开本地桥接」并保存；端口要和本扩展选项页里的一致';
        return;
      }
      if (!r.ok) return void swap(makePill('fail', '查询失败：' + esc(r.error)));
      const hit = (r.results || {})[code] || {};
      if (!hit.have) return void swap(makePill('missing', '本地没有', code));
      // 失败之后仍然可点：可能是播放器没配好或文件在网盘上还没就绪，重试一次是合理的动作。
      const attach = (p) => {
        if (hit.copies > 1) p.title = `本地有 ${hit.copies} 份拷贝`;
        p.onclick = () => {
          if (p.dataset.busy) return;
          p.dataset.busy = '1';
          playCode(code, (state, main) => {
            attach(swap(state === 'ok' ? makePill('ok', main) : makePill(state, main, '本地已有 · 点击播放')));
          });
        };
        return p;
      };
      attach(swap(makePill('have', '本地已有 · 点击播放', [hit.lib, hit.seen ? '已看' : ''].filter(Boolean).join(' · '))));
    });
  }

  const done = new WeakSet();

  async function listBadges(site) {
    const items = site.list().filter((it) => it.mount && !done.has(it.mount));
    if (!items.length) return;
    const byBadge = new Map();
    for (const it of items) {
      done.add(it.mount);
      if (!byBadge.has(it.code)) byBadge.set(it.code, []);
      byBadge.get(it.code).push(it);
    }
    const codes = [...byBadge.keys()];
    const r = await send({ type: 'jse:lookup', codes });
    if (!r || !r.ok) {
      // 连不上或出错时列表保持干净，不铺一页「失败」；把这些格子放回去，等下一次扫描重试。
      for (const it of items) done.delete(it.mount);
      return;
    }
    for (const [code, list] of byBadge) {
      const hit = (r.results || {})[code] || {};
      if (!hit.have) continue;
      for (const it of list) {
        styleMount(it.mount);
        const badge = document.createElement('span');
        badge.className = 'jse-badge';
        badge.textContent = '本地';
        badge.title = `本地已有${hit.lib ? '（' + hit.lib + '）' : ''}${hit.copies > 1 ? ' · ' + hit.copies + ' 份' : ''}${cfg.badgePlay ? ' · 点击播放' : ''}`;
        if (cfg.badgePlay) {
          badge.classList.add('jse-clickable');
          badge.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (badge.dataset.busy) return;
            badge.dataset.busy = '1';
            badge.textContent = '…';
            playCode(code, (state, main) => {
              badge.textContent = state === 'ok' ? '播放中' : state === 'fail' ? '失败' : state === 'offline' ? '离线' : '…';
              badge.title = main;
              if (state === 'ok') setTimeout(() => { badge.textContent = '本地'; badge.title = ''; }, 2500);
              else badge.dataset.busy = '';
            });
          };
        }
        it.mount.append(badge);
      }
    }
  }

  // ---------------------------------------------------------------- driving

  function site() {
    for (const s of SITES) {
      if (s.list().length) return s;
    }
    for (const s of SITES) {
      try {
        if (s.detail()) return s;
      } catch {
        /* try the next adapter */
      }
    }
    return null;
  }

  function pass() {
    const s = site();
    if (!s) return;
    if (cfg.detailMark) {
      try {
        const d = s.detail();
        if (d) detailPill(d);
      } catch {
        /* a page shape we did not foresee must not break the site */
      }
    }
    if (cfg.listMark) {
      listBadges(s).catch(() => {});
    }
  }

  let timer = 0;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(pass, 350);
  };

  pass();
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
})();
