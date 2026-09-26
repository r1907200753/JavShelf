'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Studios and series are the same shape — a name, an optional JavDB binding, a cover and the
// earliest title that carries them — so one module serves both kinds. They live in JavShelf's
// own database, never in the shared one.
//
// The cover is deliberately *not* a copy: default_cover_code points at a row already on the
// wall, so the poster comes from his own folder through the normal media path and nothing is
// duplicated on disk. cover is only set when he picks one himself.
const KINDS = { studio: 'movie_制作', series: 'movie_系列' };
const COLUMNS = `name TEXT PRIMARY KEY, javdb_id TEXT DEFAULT '', javdb_url TEXT DEFAULT '',
  cover TEXT DEFAULT '', default_code TEXT DEFAULT '', default_date TEXT DEFAULT '',
  count INTEGER DEFAULT 0, note TEXT DEFAULT '', updated TEXT DEFAULT ''`;

function table(kind) {
  const t = String(kind || '');
  if (!KINDS[t]) throw new Error('未知实体类型: ' + t);
  return t;
}

function open(dbFile, kind) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.prepare(`CREATE TABLE IF NOT EXISTS ${table(kind)} (${COLUMNS})`).run();
  return db;
}

function list(dbFile, kind) {
  const db = open(dbFile, kind);
  try {
    return db.prepare(`SELECT * FROM ${table(kind)} ORDER BY count DESC, name ASC`).all();
  } finally {
    db.close();
  }
}

function get(dbFile, kind, name) {
  const db = open(dbFile, kind);
  try {
    return db.prepare(`SELECT * FROM ${table(kind)} WHERE name = ?`).get(String(name || '')) || null;
  } finally {
    db.close();
  }
}

function upsert(dbFile, kind, row) {
  const name = String(row.name || '').trim();
  if (!name) throw new Error('名字不能为空');
  const t = table(kind);
  const db = open(dbFile, kind);
  try {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const prev = db.prepare(`SELECT * FROM ${t} WHERE name = ?`).get(name) || {};
    const merged = {
      javdb_id: row.javdb_id !== undefined ? row.javdb_id : prev.javdb_id || '',
      javdb_url: row.javdb_url !== undefined ? row.javdb_url : prev.javdb_url || '',
      cover: row.cover !== undefined ? row.cover : prev.cover || '',
      default_code: row.default_code !== undefined ? row.default_code : prev.default_code || '',
      default_date: row.default_date !== undefined ? row.default_date : prev.default_date || '',
      count: row.count !== undefined ? Number(row.count) || 0 : Number(prev.count) || 0,
      note: row.note !== undefined ? row.note : prev.note || ''
    };
    db.prepare(
      `INSERT INTO ${t} (name, javdb_id, javdb_url, cover, default_code, default_date, count, note, updated)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET javdb_id=excluded.javdb_id, javdb_url=excluded.javdb_url,
         cover=excluded.cover, default_code=excluded.default_code, default_date=excluded.default_date,
         count=excluded.count, note=excluded.note, updated=excluded.updated`
    ).run(name, merged.javdb_id, merged.javdb_url, merged.cover, merged.default_code, merged.default_date, merged.count, merged.note, now);
    return get(dbFile, kind, name);
  } finally {
    db.close();
  }
}

// Rebuilt from the rows currently on the wall, so disabling a library shrinks the list and
// re-enabling it grows it back. Anything he edited (cover, note, javdb binding) is kept.
function rebuild(dbFile, kind, rows) {
  const field = KINDS[table(kind)];
  const grouped = new Map();
  for (const r of rows || []) {
    const raw = String(r[field] || '').trim();
    if (!raw) continue;
    for (const name of raw.split(/[,/、|]/).map((s) => s.trim()).filter(Boolean)) {
      const date = String(r.movie_日期 || '').trim();
      const cur = grouped.get(name) || { name, count: 0, default_date: '', default_code: '' };
      cur.count += 1;
      // Earliest release wins the cover; an empty date never beats a real one.
      if (date && (!cur.default_date || date < cur.default_date)) {
        cur.default_date = date;
        cur.default_code = String(r.movie_编码 || '');
      }
      grouped.set(name, cur);
    }
  }
  const db = open(dbFile, kind);
  try {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const keep = new Set(grouped.keys());
    const known = db.prepare(`SELECT name FROM ${table(kind)}`).all().map((r) => r.name);
    const stmt = db.prepare(
      `INSERT INTO ${table(kind)} (name, count, default_date, default_code, updated) VALUES (?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET count=excluded.count, default_date=excluded.default_date,
         default_code=excluded.default_code, updated=excluded.updated`
    );
    // One transaction: without it every entity is its own commit, and a few hundred of
    // these turned a library toggle from instant into a ten-second stall.
    db.exec('BEGIN');
    let kept = 0;
    try {
      for (const g of grouped.values()) stmt.run(g.name, g.count, g.default_date, g.default_code, now);
      const touched = db.prepare(`SELECT name FROM ${table(kind)} WHERE cover<>'' OR note<>'' OR javdb_id<>''`).all().map((r) => r.name);
      const del = db.prepare(`DELETE FROM ${table(kind)} WHERE name = ?`);
      const touchedSet = new Set(touched);
      kept = [...touchedSet].filter((n) => !keep.has(n)).length;
      for (const n of known) if (!keep.has(n) && !touchedSet.has(n)) del.run(n);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { total: grouped.size, kept };
  } finally {
    db.close();
  }
}

// `open` stays private: every caller here wants a whole operation, not a handle.
module.exports = { KINDS, list, get, upsert, rebuild };
