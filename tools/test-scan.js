'use strict';
// Measures the scanner against the real library folders: how long a cold scan takes and
// what share of database rows actually resolve to a file on disk.
const { app } = require('electron');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { MediaIndex } = require('../main/scan');

const DB = String.raw`G:\video\配置\ALEX.db`;

function dbNames() {
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db.prepare('SELECT "movie_编码" AS code, "file_路径" AS p FROM "local_JAV"').all();
  db.close();
  return rows.map((r) => {
    let base = '';
    try {
      const j = JSON.parse(r.p);
      const grp = j['视频文件'] || Object.values(j)[0];
      const first = grp && (Array.isArray(grp) ? grp[0] : Object.values(grp)[0]);
      if (first && first['文件名']) base = first['文件名'] + String(first['扩展名'] || '');
    } catch {
      /* rows without a parseable path just never resolve */
    }
    return { code: r.code, base: base.replace(/\.[a-z0-9]+$/i, '') };
  });
}

app.whenReady().then(async () => {
  const dirs = process.argv.slice(2);
  const roots = dirs.length ? dirs : ['G:\\JAV\\JAV_output'];
  const names = dbNames();
  const t0 = Date.now();
  let last = 0;
  const idx = await MediaIndex.build(roots, {
    onProgress: (p) => {
      if (p.scanned - last >= 2000) {
        last = p.scanned;
        console.log(`  ...已扫 ${p.scanned} 目录，命中 ${p.found} 条，${p.ms}ms`);
      }
    }
  });
  const ms = Date.now() - t0;
  let hit = 0;
  let withPoster = 0;
  let withNfo = 0;
  const samples = [];
  for (const n of names) {
    const e = idx.lookup(n.base, n.code, path.basename(String(n.code)));
    if (e) {
      hit++;
      if (e.poster) withPoster++;
      if (e.nfo) withNfo++;
      if (samples.length < 3) samples.push({ want: n.base, ...e });
    }
  }
  console.log(JSON.stringify({
    roots,
    dirsScanned: idx.size,
    scanMs: ms,
    rows: names.length,
    resolved: hit,
    resolvedPct: +(hit / names.length * 100).toFixed(1),
    withPoster,
    withNfo,
    samples
  }, null, 1));
  app.exit(0);
});
