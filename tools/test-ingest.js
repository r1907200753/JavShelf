'use strict';
// Proves the folder -> library path on a real media root without touching any user data:
// a full ingest into a temp database, then append and delta passes over the same folders.
//   npx electron tools/test-ingest.js G:\JAV\JAV_output
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Ingestor, COLS } = require('../main/ingest');
const { ensureShelfTable } = require('../main/libs');

const dirs = process.argv.slice(2).filter((a) => !a.endsWith('.js'));
if (!dirs.length) {
  console.log('用法: npx electron tools/test-ingest.js <库文件夹> [更多文件夹…]');
  process.exit(1);
}

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'javshelf-ingest-'));
  const dbFile = path.join(tmp, 'JavShelf.db');
  const lib = { name: 'TEST', store: 'shelf' };
  ensureShelfTable(dbFile, lib);
  const runs = [];
  for (const mode of ['full', 'append', 'delta']) {
    let last = null;
    const t0 = Date.now();
    const res = await new Ingestor({
      dbFile,
      table: 'shelf_TEST',
      dirs,
      onProgress: (p) => {
        last = p;
      }
    }).run(mode);
    runs.push({ mode, ms: Date.now() - t0, added: res.added, updated: res.updated, deleted: res.deleted, skipped: res.skipped, total: res.total, lastPhase: last && last.phase });
    console.log(JSON.stringify(runs[runs.length - 1]));
  }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const rows = db.prepare('SELECT * FROM shelf_TEST LIMIT 3').all();
  const sample = rows.map((r) => ({
    编码: r.movie_编码,
    片名: String(r.movie_片名).slice(0, 26),
    日期: r.movie_日期,
    演员: String(r.movie_演员).slice(0, 30),
    制作: r.movie_制作,
    类别: String(r.movie_类别).slice(0, 40),
    简介: String(r.movie_源简).slice(0, 24),
    路径: String(r.file_路径).slice(0, 90)
  }));
  const withActor = db.prepare("SELECT COUNT(*) c FROM shelf_TEST WHERE movie_演员 <> ''").get().c;
  const withPlot = db.prepare("SELECT COUNT(*) c FROM shelf_TEST WHERE movie_源简 <> ''").get().c;
  const withDate = db.prepare("SELECT COUNT(*) c FROM shelf_TEST WHERE movie_日期 <> ''").get().c;
  db.close();
  console.log(JSON.stringify({ columns: COLS.length, withActor, withPlot, withDate, sample }, null, 1));
  fs.rmSync(tmp, { recursive: true, force: true });
  app.exit(0);
});
