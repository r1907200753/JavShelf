'use strict';
// Dev-only probe #3: maker/series pages (need a cover) + where body measurements can come from.
//   node tools/probe-javdb3.js [proxyUrl]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { ProxyAgent, fetch } = require(ROOT + '/node_modules/undici');
const PROXY = process.argv[2] || 'http://127.0.0.1:7890';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const d = new ProxyAgent({ uri: PROXY, headersTimeout: 30000, bodyTimeout: 30000, connections: 1 });

async function get(url, follow = false) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      dispatcher: d,
      redirect: follow ? 'follow' : 'manual',
      headers: { 'user-agent': UA, 'accept-language': 'zh-TW,zh;q=0.8,ja;q=0.7' }
    });
    return { s: r.status, b: await r.text(), loc: r.headers.get('location') || '', url: r.url, ms: Date.now() - t0 };
  } catch (e) {
    return { s: 0, b: '', loc: '', err: String(e.message).slice(0, 90), ms: Date.now() - t0 };
  }
}
const uniq = (a) => [...new Set(a)];

(async () => {
  const lines = [];
  const say = (s) => { lines.push(s); console.log(s); };

  for (const [kind, url] of [['片商', 'https://javdb.com/makers/zKW'], ['系列', 'https://javdb.com/series/mpyn']]) {
    const r = await get(url);
    say(`${kind} ${url} -> ${r.s} loc=${r.loc.slice(0, 60)} ${r.b.length}B`);
    if (r.s >= 300 && r.s < 400) {
      const f = await get(new URL(r.loc, url).href, true);
      say(`   跟随重定向 -> ${f.s} ${(f.b.match(/<title>([^<]{0,60})/) || [])[1]}`);
      say(`   封面候选=${JSON.stringify(uniq((f.b.match(/src="(https:\/\/c0\.jdbstatic\.com\/[^"]+)"/g) || []).map((x) => x.slice(5, -1))).slice(0, 3))}`);
      say(`   影片链接数=${(f.b.match(/href="\/v\//g) || []).length}`);
      fs.writeFileSync(path.join(os.tmpdir(), 'javdb_' + kind + '.html'), f.b);
    }
  }

  // measurements: does FANZA still answer, and does it carry 身長/スリーサイズ?
  const fz = await get('https://video.dmm.com/digital/actress/', true);
  say(`FANZA 女优页 -> ${fz.s} ${fz.b.length}B err=${fz.err || ''}`);
  const fzSearch = await get('https://video.dmm.com/search/?content=all&word=' + encodeURIComponent('田中檸檬') + '&flow=video', true);
  say(`FANZA 搜索 -> ${fzSearch.s} ${fzSearch.b.length}B 身高字段=${/身長/.test(fzSearch.b)} 女優链接=${JSON.stringify(uniq((fzSearch.b.match(/https:\/\/video\.dmm\.com\/digital\/actress\/[^"/]+\//g) || [])).slice(0, 3))}`);

  const wiki = await get('https://ja.wikipedia.org/wiki/' + encodeURIComponent('田中柠檬'), true);
  say(`维基 -> ${wiki.s} ${wiki.b.length}B 身長=${/身長/.test(wiki.b)} 三サイズ=${/スリーサイズ|B\d{2,3}/.test(wiki.b)}`);

  await d.close();
  fs.writeFileSync(path.join(os.tmpdir(), 'javdb_report3.txt'), lines.join('\n'));
})().catch((e) => console.log('FATAL', e && e.message));
