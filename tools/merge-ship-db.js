'use strict';
// Builds the database that ships inside the portable package: the shelf rows the app already
// ingested, plus the performer profiles and JavDB bindings scraped during testing. Nothing here
// rewrites a row that already carries data — the shipped file is the base, the test profile only
// fills holes.
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const arg = (name) => {
  const f = process.argv.find((a) => a.startsWith('--' + name + '='));
  return f ? path.resolve(f.slice(name.length + 3)) : '';
};
const BASE = arg('base');
const FROM = arg('from');
const OUT = arg('out');
if (!BASE || !FROM || !OUT) {
  console.error('用法: node tools/merge-ship-db.js --base=<交付库> --from=<测试库> --out=<输出>');
  process.exit(1);
}
fs.rmSync(OUT, { force: true });
fs.rmSync(OUT + '-journal', { force: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.copyFileSync(BASE, OUT);

const db = new DatabaseSync(OUT);
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
db.prepare('ATTACH DATABASE ? AS src').run(FROM);
const report = [];

function sameSchema(table) {
  const mine = cols(table);
  const theirs = db.prepare(`PRAGMA src.table_info(${table})`).all().map((r) => r.name);
  return { mine, theirs, ok: mine.length > 0 && mine.join() === theirs.join() };
}

// Only ever fills a column that is still empty in the base, so a value the user edited by hand
// in the shipped copy always wins over the scraped one.
function mergeTable(table, keyCol, fill) {
  const s = sameSchema(table);
  if (!s.mine.length) return report.push(`${table}: 目标库没有这张表，跳过`);
  if (!s.ok) return report.push(`${table}: 两侧列不一致，跳过（${s.mine.length} vs ${s.theirs.length}）`);
  const rows = db.prepare(`SELECT * FROM src.${table}`).all();
  if (!rows.length) return report.push(`${table}: 源库为空`);
  const have = new Map(db.prepare(`SELECT * FROM ${table}`).all().map((r) => [r[keyCol], r]));
  const ins = db.prepare(`INSERT INTO ${table} (${s.mine.join(',')}) VALUES (${s.mine.map(() => '?').join(',')})`);
  let added = 0;
  let touched = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const id = row[keyCol];
      if (!id) continue;
      const cur = have.get(id);
      if (!cur) {
        ins.run(...s.mine.map((c) => row[c] ?? ''));
        added++;
        continue;
      }
      const patch = fill(row, cur);
      if (!patch.length) continue;
      db.prepare(`UPDATE ${table} SET ${patch.map((p) => `${p}=?`).join(',')} WHERE ${keyCol}=?`).run(
        ...patch.map((p) => row[p] ?? ''),
        id
      );
      touched++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // Names are the user's own data, so the report counts rows and never quotes them.
  report.push(`${table}: 新增 ${added}，补空 ${touched}（源 ${rows.length}）`);
}

const empty = (v) => v === undefined || v === null || String(v).trim() === '';
const blanks = (fields) => (src, cur) => fields.filter((f) => empty(cur[f]) && !empty(src[f]));

mergeTable('idol', 'name', blanks(['japanese_name', 'roman_name', 'chinese_name', 'height_cm', 'birth_date', 'bust', 'waist', 'hips', 'cup', 'note']));
mergeTable('studio', 'name', blanks(['javdb_id', 'javdb_url', 'cover', 'note', 'default_code', 'default_date']));
mergeTable('series', 'name', blanks(['javdb_id', 'javdb_url', 'cover', 'note', 'default_code', 'default_date']));
try {
  db.prepare('SELECT 1 FROM src.actor_index LIMIT 1').get();
  mergeTable('actor_index', 'name', blanks(['javdb_id', 'javdb_url', 'avatar', 'slug']));
} catch {
  report.push('actor_index: 源库没有这张表');
}

db.exec('DETACH DATABASE src');
const summary = ['idol', 'studio', 'series'].map((t) => `${t}=${db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c}`);
const filled = db.prepare("SELECT COUNT(*) c FROM idol WHERE height_cm<>''").get().c;
console.log(report.join('\n'));
console.log('输出 ' + OUT + '  ' + summary.join(' ') + '，其中带身高 ' + filled);
db.close();
