'use strict';
// Verifies the JavDB -> nfo mapping on a THROWAWAY COPY of one of his nfo files.
// The original is only ever read.
//   node tools/test-javdb-nfo.js [proxyUrl]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { JavDB } = require(path.join(ROOT, 'main', 'javdb.js'));
const { readNfo, writeNfo } = require(path.join(ROOT, 'main', 'nfo.js'));
const { resolveDir } = require(path.join(ROOT, 'main', 'scan.js'));

const LIB = 'G:\\JAV\\JAV_output';
const CODE = process.argv[3] || 'MIMK-015';
const proxy = process.argv[2] || 'http://127.0.0.1:7890';

// Same rule the app uses, kept here so a divergence shows up as a failing check.
function nfoPatchFrom(info) {
  const fields = {
    title: info.title,
    originaltitle: info.title,
    premiered: info.date,
    year: String(info.date || '').slice(0, 4),
    runtime: info.minutes,
    studio: info.studio,
    label: info.studio,
    publisher: info.publisher || info.studio,
    series: info.series,
    director: info.director,
    genre: info.genres,
    tag: info.genres,
    rating: info.score,
    website: info.url,
    javdbsearchid: info.javdb
  };
  for (const k of Object.keys(fields)) {
    const v = fields[k];
    if (v === '' || v == null || (Array.isArray(v) && !v.length)) delete fields[k];
  }
  const female = info.actors.filter((a) => a.female).map((a) => a.name);
  return { fields, actors: (female.length ? female : info.actors.map((a) => a.name)).map((n) => ({ name: n, role: '' })) };
}

(async () => {
  const j = new JavDB(proxy, { throttleMs: 200 });
  const info = await j.videoByCode(CODE);
  j.close();
  if (!info) throw new Error('JavDB 没有搜到 ' + CODE);
  console.log('抓到:', info.code, '|', info.studio, '|', info.series || '(无系列)', '|', info.date, '|', info.actors.map((a) => a.name + (a.female ? '(女)' : '(男)')).join(' '));

  // Find the real nfo, then copy it aside.
  const dir = fs.readdirSync(LIB).flatMap((g) => {
    const gp = path.join(LIB, g);
    if (!fs.statSync(gp).isDirectory()) return [];
    return fs.readdirSync(gp).filter((d) => d.toUpperCase().startsWith(CODE.toUpperCase())).map((d) => path.join(gp, d));
  });
  if (!dir.length) throw new Error('库里找不到 ' + CODE);
  // The nfo is what matters here; take it straight from the folder rather than going
  // through the app's file-stem helper, which lives in the main process.
  const nfo = dir.map((d) => path.join(d, path.basename(d) + '.nfo')).find((p) => fs.existsSync(p))
    || dir.map((d) => fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith('.nfo')).map((f) => path.join(d, f))[0]).find(Boolean);
  const original = nfo;
  if (!original || !fs.existsSync(original)) throw new Error('没有 nfo');

  const copy = path.join(os.tmpdir(), 'javdb-nfo-test.nfo');
  fs.copyFileSync(original, copy);
  const before = readNfo(copy);
  console.log('覆写前: title=' + String(before.fields.title || '').slice(0, 40) + ' studio=' + before.fields.studio + ' series=' + before.fields.series + ' actors=' + before.actors.length + ' tags=' + Object.keys(before.fields).length + ' 未知标签=' + before.unknownTags.join(','));

  const patch = nfoPatchFrom(info);
  const res = writeNfo(copy, patch);
  const after = readNfo(copy);
  console.log('覆写后: title=' + String(after.fields.title || '').slice(0, 40) + ' studio=' + after.fields.studio + ' series=' + after.fields.series + ' actors=' + after.actors.length + ' tags=' + Object.keys(after.fields).length + ' 未知标签=' + after.unknownTags.join(','));
  console.log('       website=' + after.fields.website + ' runtime=' + after.fields.runtime + ' premiered=' + after.fields.premiered + ' rating=' + after.fields.rating + ' genre数=' + (after.fields.genre || []).length);
  console.log('备份文件:', fs.existsSync(copy + '.bak') ? '已生成' : '缺失', '| changed=' + res.changed);

  const maleLeft = after.actors.filter((a) => info.actors.find((x) => x.name === a.name && !x.female)).map((a) => a.name);
  console.log('男优是否被写入:', maleLeft.length ? maleLeft.join(',') : '没有（正确）');
  const preserved = before.unknownTags.filter((t) => after.unknownTags.includes(t));
  console.log('原有未知标签保留:', preserved.join(',') || '(无)');
  console.log('临时文件:', copy, '（原始文件未被改动）');
})().catch((e) => console.log('FAIL', e.message));
