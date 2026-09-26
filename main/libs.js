'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// The predecessor program keeps its library list in a data_list table: one row per
// library, folders joined by ||. We read that once to seed our own config, then never
// write to it, so adding a library here cannot damage the original database.
const NAME_RE = /^[0-9A-Za-z_\u4e00-\u9fff-]{1,24}$/;

function validName(name) {
  const s = String(name || '').trim();
  if (!NAME_RE.test(s)) throw new Error('库名只能用中英文、数字、下划线或短横线，1-24 个字符');
  return s;
}

function seedFromLegacyDb(legacyDbPath) {
  const out = [];
  if (!fs.existsSync(legacyDbPath)) return out;
  let db;
  try {
    db = new DatabaseSync(legacyDbPath, { readOnly: true });
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='data_list'").get();
    if (!has) return out;
    for (const r of db.prepare('SELECT * FROM "data_list"').all()) {
      const name = String(r.only_code || '').trim();
      if (!name || !NAME_RE.test(name)) continue;
      const dirs = String(r.movie_目录 || '').split('||').map((s) => s.trim()).filter(Boolean);
      out.push({
        name,
        dirs,
        store: 'legacy',
        view: Number(r.movie_视图) === 1 ? 'thumb' : 'poster',
        titleField: Number(r.movie_片名) === 1 ? 'movie_编码' : 'movie_片名',
        subtitleField: Number(r.movie_副片名) === 1 ? 'movie_演员' : 'movie_日期'
      });
    }
  } catch {
    /* an unreadable database just means no seed */
  } finally {
    if (db) db.close();
  }
  return out;
}

function normalize(list) {
  const seen = new Set();
  const out = [];
  for (const lib of list || []) {
    let name;
    try {
      name = validName(lib.name);
    } catch {
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      dirs: [...new Set((lib.dirs || []).map((d) => String(d).trim()).filter(Boolean))],
      store: lib.store === 'shelf' ? 'shelf' : 'legacy',
      enabled: lib.enabled !== false,
      view: lib.view === 'thumb' ? 'thumb' : 'poster',
      titleField: lib.titleField === 'movie_编码' ? 'movie_编码' : 'movie_片名',
      subtitleField: ['movie_日期', 'movie_演员', 'movie_类别', 'movie_年份'].includes(lib.subtitleField) ? lib.subtitleField : 'movie_日期'
    });
  }
  return out;
}

// A legacy library's rows live in the old database under local_<name>; anything created
// here gets its own database so the original file keeps its shape.
function tableOf(lib) {
  return (lib.store === 'shelf' ? 'shelf_' : 'local_') + lib.name;
}

function dbFileFor(lib, legacyDbPath, shelfDbPath) {
  return lib.store === 'shelf' ? shelfDbPath : legacyDbPath;
}

function ensureShelfTable(shelfDbPath, lib) {
  const fs2 = require('node:fs');
  fs2.mkdirSync(path.dirname(shelfDbPath), { recursive: true });
  const db = new DatabaseSync(shelfDbPath);
  const table = tableOf(lib);
  if (!NAME_RE.test(lib.name)) throw new Error('非法库名');
  const exists = db.prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?').get('table', table);
  if (!exists) {
    const cols = [
      'only_code TEXT PRIMARY KEY', 'movie_编码 TEXT', 'movie_片名 TEXT', 'movie_日期 TEXT', 'movie_时长 TEXT',
      'movie_大小 TEXT', 'movie_导演 TEXT', 'movie_发行 TEXT', 'movie_制作 TEXT', 'movie_系列 TEXT',
      'movie_类别 TEXT', 'movie_演员 TEXT', 'movie_国家 TEXT', 'movie_语言 TEXT', 'movie_年份 TEXT',
      'movie_类型 TEXT', 'movie_编剧 TEXT', 'movie_评分 TEXT', 'movie_点赞 TEXT', 'movie_评论 TEXT',
      'movie_源简 TEXT', 'movie_中简 TEXT', 'movie_封面 TEXT', 'movie_预览 TEXT', 'movie_网址 TEXT',
      'file_路径 TEXT', 'state_收藏 TEXT DEFAULT "假"', 'state_已看 TEXT DEFAULT "假"',
      'state_字幕 TEXT DEFAULT "假"', 'state_高清 TEXT', 'state_观看 TEXT', 'state_时长 TEXT',
      'state_更新 TEXT', 'state_创建 TEXT'
    ].join(', ');
    db.prepare(`CREATE TABLE "${table}" (${cols})`).run();
  }
  db.close();
}

module.exports = { seedFromLegacyDb, normalize, tableOf, dbFileFor, ensureShelfTable };
