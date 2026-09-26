'use strict';
// Reads the real 路径 column so the library/folder features can be built against what
// is actually on disk: which roots hold media, and what sidecar files sit next to a
// video (poster/fanart/thumb/nfo).
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

app.whenReady().then(() => {
  const db = new DatabaseSync(String.raw`G:\video\配置\ALEX.db`, { readOnly: true });
  const tables = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','index') ORDER BY type DESC").all();
  console.log('--- schema');
  for (const t of tables) {
    if (t.type !== 'table') continue;
    let n = '?';
    try {
      n = db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c;
    } catch {}
    console.log(`table ${t.name}: ${n} 行`);
  }
  for (const t of tables) {
    if (t.type !== 'table' || t.name === 'local_JAV') continue;
    try {
      const rows = db.prepare(`SELECT * FROM "${t.name}" LIMIT 12`).all();
      console.log(`--- ${t.name} 样例`);
      for (const r of rows) console.log(JSON.stringify(r).slice(0, 300));
    } catch (e) {
      console.log(`--- ${t.name} 读取失败 ${e.message}`);
    }
  }
  const rows = db.prepare('SELECT * FROM "local_JAV" LIMIT 2000').all();
  const cols = Object.keys(rows[0] || {});
  console.log('columns:', cols.join(' | '));
  const pathCols = cols.filter((c) => /路径|地址|目录|folder|path/i.test(c));
  console.log('path-ish columns:', pathCols.join(' | '));
  for (const c of pathCols) {
    const filled = rows.filter((r) => String(r[c] ?? '').trim()).length;
    console.log(`  ${c}: ${filled}/${rows.length} 非空, 样例 ${JSON.stringify(String(rows.find((r) => String(r[c] ?? '').trim())?.[c] ?? '').slice(0, 200))}`);
  }
  const roots = new Map();
  const sidecars = new Map();
  let parsed = 0;
  const PC = pathCols[0];
  for (const r of rows) {
    const raw = String(r[PC] ?? '').trim();
    if (!raw) continue;
    let list = [];
    try {
      const j = JSON.parse(raw);
      list = Array.isArray(j) ? j.map((x) => String(x.path || x.p || x)) : [String(j)];
    } catch {
      list = raw.split(/[;|]/).map((s) => s.trim()).filter(Boolean);
    }
    const first = list.find((s) => /[.\\/]/.test(s));
    if (!first) continue;
    parsed++;
    const file = /\.(mp4|mkv|avi|ts|wmv|iso)$/i.test(first) ? first : '';
    const dir = file ? path.dirname(file) : first.replace(/[\\/]+$/, '');
    const root = first.split(/[\\/]/).slice(0, 3).join('/');
    roots.set(root, (roots.get(root) || 0) + 1);
    if (sidecars.size < 3 && fs.existsSync(dir)) {
      const names = fs.readdirSync(dir);
      sidecars.set(dir, {
        total: names.length,
        nfo: names.filter((f) => f.toLowerCase().endsWith('.nfo')),
        img: names.filter((f) => /\.(jpg|png|webp)$/i.test(f)),
        video: names.filter((f) => /\.(mp4|mkv|avi|ts|wmv)$/i.test(f)).slice(0, 3),
        sample: names.slice(0, 8)
      });
    }
  }
  console.log('rows', rows.length, 'with parsed path', parsed);
  console.log('--- roots (top 10)');
  for (const [k, v] of [...roots].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(v, k);
  console.log('--- sidecar dirs');
  for (const [k, v] of sidecars) console.log(k, JSON.stringify(v));
  app.exit(0);
});
