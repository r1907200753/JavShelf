'use strict';
// Dev-only probe: what can we actually read from JavDB through his proxy, and does the
// actor/studio/series data he wants exist there? Nothing is written except stdout.
//   node tools/probe-javdb.js [proxyUrl]
const ROOT = require('node:path').resolve(__dirname, '..');
const { ProxyAgent, fetch } = require(ROOT + '/node_modules/undici');

const PROXY = process.argv[2] || 'http://127.0.0.1:7890';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const d = new ProxyAgent({ uri: PROXY, headersTimeout: 25000, bodyTimeout: 25000, connections: 2 });

async function get(url, accept = 'text/html') {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      dispatcher: d,
      redirect: 'manual',
      headers: { 'user-agent': UA, accept, 'accept-language': 'zh-TW,zh;q=0.8,ja;q=0.7,en;q=0.6' }
    });
    const body = await r.text();
    return { url, status: r.status, loc: r.headers.get('location') || '', len: body.length, ms: Date.now() - t0, body };
  } catch (e) {
    return { url, status: 0, loc: '', len: 0, ms: Date.now() - t0, err: String(e.name + ': ' + e.message).slice(0, 120) };
  }
}

const show = (r, note) =>
  console.log(`${String(r.status).padEnd(3)} ${String(r.ms).padStart(5)}ms ${String(r.len).padStart(7)}B  ${r.url}\n      ${note || r.err || r.loc || ''}`);

const GEO = /根据|所在地|不可用|restricted|not available in your|Access Denied|Just a moment|cf-challenge/i;

(async () => {
  console.log('proxy =', PROXY);

  const home = await get('https://javdb.com/');
  show(home, '首页；geo 提示=' + GEO.test(home.body) + ' · 含条目链接=' + /\/v\/\d+/.test(home.body));

  const video = await get('https://javdb.com/search?q=SSIS-980&f=all');
  show(video, '搜索 SSIS-980：结果卡=' + (video.body.match(/\/v\/\d+/g) || []).length + ' · geo=' + GEO.test(video.body));

  const first = (video.body.match(/href="(\/v\/\d+)"/) || [])[1];
  console.log('  -> 第一条影片:', first || '无');

  if (first) {
    const page = await get('https://javdb.com' + first);
    show(page, '影片详情页');
    const info = [...page.body.matchAll(/<div class="value">([\s\S]*?)<\/div>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
    console.log('  详情字段数:', info.length);
    console.log('  片商链接:', [...page.body.matchAll(/href="(\/search\?[^"]*f=studio[^"]*|\/vendors[^"]*)"/g)].map((m) => m[1]).slice(0, 3));
    console.log('  系列链接:', [...page.body.matchAll(/href="(\/series\/[^"]+)"/g)].map((m) => m[1]).slice(0, 3));
    console.log('  演员链接:', [...page.body.matchAll(/href="(\/actors\/[^"]+)"/g)].map((m) => m[1]).slice(0, 4));
    console.log('  封面:', (page.body.match(/content="(https:\/\/img[^"]*javdb[^"]*)"/) || [])[1] || '无');
    const labels = [...page.body.matchAll(/<span[^>]*class="icon"[^>]*><\/span>\s*([^<]{1,12})/g)].map((m) => m[1].trim());
    console.log('  侧栏标签:', JSON.stringify(labels.slice(0, 14)));
  }

  for (const [name, url] of [
    ['女优列表(分页)', 'https://javdb.com/actors?f=f'],
    ['优优列表(全部)', 'https://javdb.com/actors'],
    ['片商列表', 'https://javdb.com/search?q=%E3%83%A2%E3%83%89%E3%82%AB%E3%83%BC%E3%83%88&f=studios'],
    ['系列列表', 'https://javdb.com/search?q=%E5%AE%B6%E5%BA%AD%E6%95%99%E5%B8%AB&f=series']
  ]) {
    const r = await get(url);
    show(r, name + '：actor=' + (r.body.match(/\/actors\/\d+/g) || []).length +
      ' studio=' + (r.body.match(/\/search\?[^"]*f=studio[^"]*/g) || []).length +
      ' series=' + (r.body.match(/\/series\/\d+/g) || []).length + ' geo=' + GEO.test(r.body));
  }

  const actorSearch = await get('https://javdb.com/search?q=' + encodeURIComponent('深田えいみ') + '&f=actors');
  show(actorSearch, '演员搜索');
  const aid = (actorSearch.body.match(/href="(\/actors\/\d+)"/) || [])[1];
  console.log('  -> 演员页:', aid || '无');
  if (aid) {
    const a = await get('https://javdb.com' + aid);
    show(a, '演员资料页');
    const rows = [...a.body.matchAll(/<div class="column is-6[^"]*">\s*<span[^>]*>([^<]+)<\/span>\s*([^<]+)/g)]
      .map((m) => m[1].trim() + '=' + m[2].trim());
    console.log('  资料:', JSON.stringify(rows.slice(0, 12)));
    console.log('  头像:', (a.body.match(/<img[^>]+src="(https:\/\/[^"]+\.jpg[^"]*)"/) || [])[1] || '无');
    console.log('  作品数:', (a.body.match(/(\d+)\s*(?:部作品|作品)/) || [])[1] || '?');
  }
  await d.close();
})();
