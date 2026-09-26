'use strict';
// Live check of main/javdb.js against real pages. Read-only, prints a report.
//   node tools/test-javdb.js [proxyUrl]
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { JavDB, wikiActress } = require(path.join(ROOT, 'main', 'javdb.js'));

const proxy = process.argv[2] || 'http://127.0.0.1:7890';
const j = new JavDB(proxy, { throttleMs: 250 });
const show = (label, o, keys) =>
  console.log(label.padEnd(22), keys.map((k) => `${k}=${Array.isArray(o[k]) ? JSON.stringify(o[k]) : String(o[k] == null ? '' : o[k]).slice(0, 46)}`).join('  ') || JSON.stringify(o).slice(0, 120));

(async () => {
  for (const code of ['MIMK-015', 'SSIS-980', 'IPZZ-293']) {
    try {
      const v = await j.videoByCode(code);
      show('video ' + code, v, ['code', 'date', 'minutes', 'studio', 'studioId', 'series', 'seriesId', 'director', 'score']);
      console.log('  女优=' + JSON.stringify(v.actressNames) + ' 全部=' + JSON.stringify(v.actors.map((a) => a.name + (a.female ? '(女)' : a.male ? '(男)' : '(?)'))));
      console.log('  actors=' + JSON.stringify(v.actors) + ' genres=' + JSON.stringify(v.genres).slice(0, 90));
      console.log('  url=' + v.url + ' cover=' + String(v.cover).slice(0, 60));
    } catch (e) {
      console.log('video ' + code + ' FAIL', e.message);
    }
  }

  try {
    const dir = await j.actressDirectoryPage(1);
    console.log('\ndirectory page1'.padEnd(22), 'rows=' + dir.length, JSON.stringify(dir[0]).slice(0, 160));
    const target = dir.find((r) => r.names.length > 2) || dir[0];
    const det = await j.actressDetail(target.id);
    show('actressDetail', det, ['names', 'aliases', 'videoCount', 'url']);
  } catch (e) {
    console.log('directory FAIL', e.message);
  }

  for (const [label, fn] of [['maker zKW', () => j.makerDetail('zKW')], ['series mpyn', () => j.seriesDetail('mpyn')]]) {
    try {
      const r = await fn();
      show(label, r, ['name', 'videoCount', 'cover', 'url']);
    } catch (e) {
      console.log(label + ' FAIL', e.message);
    }
  }

  for (const n of ['楓カレン', '深田えいみ', '田中檸檬']) {
    try {
      const w = await wikiActress(n, proxy);
      show('wiki ' + n, w || {}, ['birthDate', 'height', 'bust', 'waist', 'hips', 'cup', 'birthPlace', 'bloodType', 'page']);
    } catch (e) {
      console.log('wiki ' + n + ' FAIL', e.message);
    }
  }
  j.close();
})();
