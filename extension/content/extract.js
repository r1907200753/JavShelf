'use strict';
// 番号提取：只跟页面 DOM 打交道，不碰扩展 API，好处是 tools/test-extract.js 可以拿真实
// 页面夹具直接跑这一份代码 —— 选择器改了，测试立刻知道。
(() => {
  const ENT = /\b([A-Za-z][A-Za-z0-9]{1,9}-\d{2,6}(?:-\d{1,3})?)\b/;
  const ENT_HYPHENLESS = /\b([A-Za-z]{2,6}\d{3,5})\b/;

  // 番号 as the site shows it: uppercase, trimmed. Two patterns only — a more permissive one
  // would start matching ordinary words in titles.
  function codeFromText(s, allowPlain) {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    const m = t.match(ENT) || (allowPlain ? t.match(ENT_HYPHENLESS) : null);
    return m ? m[1].toUpperCase() : '';
  }

  const text = (node) => (node ? String(node.textContent || '').replace(/\s+/g, ' ').trim() : '');

  const JAVDB = {
    id: 'javdb',
    // 影片页：/v/<id>。番号在两处可达 —— 面板里那份带 data-clipboard-text 的复制按钮，
    // 以及「番號:」那一行的 .value；标题里第一个 strong 是最后的兜底。
    detail() {
      const panel = document.querySelector('.movie-panel-info');
      if (!panel && !/^\/v\//.test(location.pathname)) return null;
      const head = document.querySelector('h2.title') || panel;
      if (panel) {
        const clip = panel.querySelector('[data-clipboard-text]');
        const fromClip = clip ? codeFromText(clip.getAttribute('data-clipboard-text')) : '';
        if (fromClip) return { code: fromClip, anchor: head };
        for (const block of panel.querySelectorAll('.panel-block')) {
          const label = text(block.querySelector('strong'));
          if (!/番[號号]/.test(label)) continue;
          const c = codeFromText(text(block.querySelector('.value')) || text(block));
          if (c) return { code: c, anchor: head };
        }
      }
      const c = codeFromText(text(document.querySelector('h2.title strong')));
      return c ? { code: c, anchor: head } : null;
    },
    // 列表页（搜索、演员页、分类页）：.movie-list > .item > a.box，番号在 .video-title 的 strong 里
    list() {
      return [...document.querySelectorAll('.movie-list .item')]
        .map((item) => {
          const a = item.querySelector('a.box[href]') || item.querySelector('a[href]');
          const code =
            codeFromText(text(item.querySelector('.video-title strong'))) ||
            codeFromText(item.getAttribute('title') || '') ||
            codeFromText(text(item.querySelector('.video-title')));
          const mount = item.querySelector('.cover') || item;
          return a && code ? { card: item, anchor: a, code, mount } : null;
        })
        .filter(Boolean);
    }
  };

  const JAVBUS = {
    id: 'javbus',
    // 影片页：番号在 <h3> 开头与「識別碼:」那一行（部分页该行的值还包在 span 里），
    // 再退到 URL 末段 —— javbus 的影片页地址就是番号。
    detail() {
      const info = document.querySelector('.info');
      const h3 = document.querySelector('.container h3, #wrapper h3, h3');
      const fromPath = codeFromText((location.pathname.split('/').filter(Boolean).pop() || '').replace(/\.html?$/i, ''));
      if (!info && !h3 && !fromPath) return null;
      const anchor = h3 || info;
      if (info) {
        for (const p of info.querySelectorAll('p')) {
          const t = text(p);
          if (!/識別碼|识别码/.test(t)) continue;
          const at = t.indexOf(':');
          const c = codeFromText(at >= 0 ? t.slice(at + 1) : t) || codeFromText(t);
          if (c) return { code: c, anchor };
        }
      }
      const c = codeFromText(text(h3), true) || fromPath;
      return c ? { code: c, anchor } : null;
    },
    // 列表页：a.movie-box，番号在第一个 <date> 里（第二个 date 是发行日期，不匹配），
    // 退路是 href 末段 —— 卡片地址就是 /<番号>。
    list() {
      return [...document.querySelectorAll('a.movie-box[href]')]
        .map((a) => {
          let code = '';
          for (const d of a.querySelectorAll('date')) {
            code = codeFromText(text(d));
            if (code) break;
          }
          if (!code) code = codeFromText((a.getAttribute('href') || '').split('/').filter(Boolean).pop() || '');
          const mount = a.querySelector('.photo-frame') || a;
          return code ? { card: a, anchor: a, code, mount } : null;
        })
        .filter(Boolean);
    }
  };

  window.__JSE_EXTRACT = { codeFromText, SITES: [JAVDB, JAVBUS] };
})();
