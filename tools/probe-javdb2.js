'use strict';
// Dev-only feasibility probe for JavDB scraping (actress data / studio / series).
// Writes only to the OS temp dir; prints a short report.
//   node tools/probe-javdb2.js [proxyUrl]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { ProxyAgent, fetch } = require(ROOT + '/node_modules/undici');

const PROXY = process.argv[2] || 'http://127.0.0.1:7890';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const d = new ProxyAgent({ uri: PROXY, headersTimeout: 30000, bodyTimeout: 30000, connections: 1 });

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {
        dispatcher: d,
        redirect: 'manual',
        headers: { 'user-agent': UA, 'accept-language': 'zh-TW,zh;q=0.8,ja;q=0.7' }
      });
      return { s: r.status, b: await r.text() };
    } catch (e) {
      if (i === tries - 1) return { s: 0, b: '', err: String(e.message).slice(0, 90) };
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}
const txt = (h) => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '|').replace(/\|+/g, '|').replace(/[ \t\r\n]+/g, ' ');
const uniq = (a) => [...new Set(a)];

(async () => {
  const out = [];
  const say = (s) => { out.push(s); console.log(s); };

  // A. the actress directory: name -> id, and how deep the pagination goes
  for (const page of [1, 2, 30]) {
    const r = await get(`https://javdb.com/actors/censored?page=${page}`);
    const boxes = [...r.b.matchAll(/<div class="box actor-box">[\s\S]*?href="(\/actors\/[A-Za-z0-9]+)" title="([^"]+)"/g)]
      .map((m) => ({ id: m[1], name: m[2].trim() }));
    say(`A 演员目录 第${page}页: status=${r.s} 条数=${boxes.length} 例=${JSON.stringify(boxes.slice(0, 3))}`);
  }

  // B. does an actress page carry the body measurements he wants?
  const dir = await get('https://javdb.com/actors/censored?page=1');
  const ids = uniq([...dir.b.matchAll(/href="(\/actors\/[A-Za-z0-9]+)"/g)].map((m) => m[1])).slice(0, 4);
  for (const id of ids) {
    const a = await get('https://javdb.com' + id);
    const t = txt(a.b);
    const grab = (label) => {
      const i = t.indexOf(label);
      return i < 0 ? null : t.slice(i, i + 46).split('|').slice(1).join(' ').trim().slice(0, 30);
    };
    say(`B ${id} 身高=${grab('身高')} 生日=${grab('出生日期')} 三围=${grab('三圍')||grab('三围')} 罩杯=${grab('罩杯')} 血型=${grab('血型')} 出生地=${grab('出生地')} 作品数=${(t.match(/(\d+)\s*部作品/)||[])[1]||'?'}`);
    fs.writeFileSync(path.join(os.tmpdir(), 'javdb_actor_' + id.split('/')[2] + '.html'), a.b);
  }

  // C. series + studio links straight from a video page
  for (const code of ['MIMK-015', 'SSIS-980', 'IPZZ-293']) {
    const s = await get('https://javdb.com/search?q=' + code + '&f=all');
    const vid = uniq([...s.b.matchAll(/href="(\/v\/[A-Za-z0-9]+)"/g)].map((m) => m[1]))[0];
    if (!vid) { say(`C ${code}: 搜索无结果 status=${s.s}`); continue; }
    const v = await get('https://javdb.com' + vid);
    const panel = txt(v.b.slice(v.b.indexOf('movie-panel-info'), v.b.indexOf('movie-panel-info') + 2600));
    say(`C ${code} ${vid} 系列链接=${JSON.stringify(uniq([...v.b.matchAll(/href="(\/series\/[A-Za-z0-9]+)"/g)].map((m)=>m[1])))}`);
    say(`   片商链接=${JSON.stringify(uniq([...v.b.matchAll(/href="(\/makers\/[A-Za-z0-9]+)[^"]*"/g)].map((m)=>m[1])))} 面板=${panel.slice(0, 190)}`);
  }

  // D. what a maker page and a series page offer as a cover image
  const mk = await get('https://javdb.com/makers/N73g');
  say(`D 片商页 N73g status=${mk.s} 标题=${(mk.b.match(/<title>([^<]{0,60})/)||[])[1]} 首个封面=${(mk.b.match(/src="(https:\/\/c0\.jdbstatic\.com\/[^"]+)"/)||[])[1] || '无'}`);
  fs.writeFileSync(path.join(os.tmpdir(), 'javdb_maker.html'), mk.b);

  await d.close();
  fs.writeFileSync(path.join(os.tmpdir(), 'javdb_report.txt'), out.join('\n'));
})().catch((e) => { console.log('FATAL', e && e.message); process.exit(1); });
