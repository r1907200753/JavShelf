'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Performer profiles: the measurements the old program never had, which is what makes
// the 身高/罩杯/… ordering possible. Everything lives in JavShelf's own database; the
// only external touch is a read-only import of an existing local install's idol table.
const FIELDS = ['name', 'japanese_name', 'roman_name', 'chinese_name', 'height_cm', 'birth_date', 'bust', 'waist', 'hips', 'cup', 'birth_place'];
// Added after the first release, so existing databases need them created in place.
const EXTRA = { javdb_id: '', javdb_url: '', cover: '', note: '', birth_place: '' };

const MEASURES = ['height_cm', 'bust', 'waist', 'hips'];
const CUP_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// 罩杯 has three spellings in the wild: the old program's enum (1.0 = A … 13.0 = M, which is what
// the import carries), a bare letter from JavDB or the wiki, and a letter with the band size glued
// on (F65). On disk it is always one capital letter — the sidebar prints it and the ordering reads
// it as a size, and '10.0' sorts nowhere near J.
function normCup(v) {
  const s = String(v || '').trim().toUpperCase();
  if (!s) return '';
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Math.round(Number(s));
    return n >= 1 && n <= CUP_ALPHA.length ? CUP_ALPHA[n - 1] : '';
  }
  const m = s.match(/[A-Z]+/);
  return m ? m[0][0] : '';
}

// Body measurements are numbers; pages write them as `160 cm` or `87.8`.
function normMeasure(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  return (s.match(/\d+(?:\.\d+)?/) || [''])[0];
}

function cleanField(f, v) {
  if (f === 'cup') return normCup(v);
  if (MEASURES.includes(f)) return normMeasure(v);
  return String(v || '').trim();
}

function open(dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.prepare(`CREATE TABLE IF NOT EXISTS idol (
    name TEXT PRIMARY KEY, japanese_name TEXT DEFAULT '', roman_name TEXT DEFAULT '', chinese_name TEXT DEFAULT '',
    height_cm TEXT DEFAULT '', birth_date TEXT DEFAULT '', bust TEXT DEFAULT '', waist TEXT DEFAULT '',
    hips TEXT DEFAULT '', cup TEXT DEFAULT '', aliases TEXT DEFAULT '[]', updated TEXT DEFAULT ''
  )`).run();
  const have = new Set(db.prepare('PRAGMA table_info(idol)').all().map((c) => c.name));
  for (const col of Object.keys(EXTRA)) if (!have.has(col)) db.prepare(`ALTER TABLE idol ADD COLUMN ${col} TEXT DEFAULT ''`).run();
  return db;
}

function list(dbFile) {
  const db = open(dbFile);
  try {
    return db.prepare('SELECT * FROM idol').all().map((r) => ({ ...r, aliases: parseAliases(r.aliases) }));
  } finally {
    db.close();
  }
}

function parseAliases(v) {
  try {
    const a = JSON.parse(v || '[]');
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function save(dbFile, idol) {
  const name = String(idol.name || '').trim();
  if (!name) throw new Error('名字不能为空');
  const db = open(dbFile);
  try {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    db.prepare(`INSERT INTO idol (${FIELDS.join(',')}, aliases, updated)
       VALUES (${FIELDS.map(() => '?').join(',')}, ?, ?)
       ON CONFLICT(name) DO UPDATE SET ${FIELDS.filter((f) => f !== 'name').map((f) => `${f}=excluded.${f}`).join(',')}, aliases=excluded.aliases, updated=excluded.updated`)
      .run(...FIELDS.map((f) => (f === 'name' ? name : cleanField(f, idol[f]))), JSON.stringify(idol.aliases || []), now);
    return { name, saved: true };
  } finally {
    db.close();
  }
}

// A name that is already carried as somebody's alias points at the profile that survived
// that earlier merge, so folding into it again lands on the living row instead of
// resurrecting a dead spelling as a fresh empty profile.
function resolveName(db, name) {
  if (db.prepare('SELECT 1 FROM idol WHERE name = ?').get(name)) return name;
  const hit = db.prepare('SELECT name, aliases FROM idol').all().find((r) => parseAliases(r.aliases).includes(name));
  return hit ? hit.name : name;
}

// Folding one profile into another: the source's name becomes an alias of the target so
// rows written under either spelling still find the measurements, and every blank the
// target never had gets filled from her rather than thrown away with the deleted row.
const CARRIED = [...new Set([...FIELDS.slice(1), ...Object.keys(EXTRA)])];

function merge(dbFile, from, into) {
  const a = String(from || '').trim();
  const b0 = String(into || '').trim();
  if (!a || !b0) throw new Error('需要源名字和目标名字');
  const db = open(dbFile);
  try {
    const b = resolveName(db, b0);
    // Either end can come back as the same person: the target may be a spelling the source
    // already absorbed, or the source may itself be one of the target's aliases — in which
    // case there is nothing to fold and saying so beats rewriting the row to what it was.
    if (b === a || resolveName(db, a) === b) throw new Error('不能合并到自身');
    const src = db.prepare('SELECT * FROM idol WHERE name = ?').get(a) || null;
    const dst = db.prepare('SELECT * FROM idol WHERE name = ?').get(b) || null;
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const row = { name: b };
    const filled = [];
    for (const f of CARRIED) {
      const mine = String((dst && dst[f]) || '').trim();
      const hers = String((src && src[f]) || '').trim();
      if (mine) row[f] = mine;
      else {
        row[f] = hers;
        if (hers) filled.push(f);
      }
    }
    const aliases = new Set([...parseAliases(dst && dst.aliases), ...parseAliases(src && src.aliases), a]);
    aliases.delete(b);
    const cols = [...new Set([...FIELDS, ...CARRIED])];
    db.prepare(`INSERT INTO idol (${cols.join(',')}, aliases, updated) VALUES (${cols.map(() => '?').join(',')}, ?, ?)
       ON CONFLICT(name) DO UPDATE SET ${cols.filter((f) => f !== 'name').map((f) => `${f}=excluded.${f}`).join(',')}, aliases=excluded.aliases, updated=excluded.updated`)
      .run(...cols.map((f) => (f === 'name' ? b : String(row[f] || ''))), JSON.stringify([...aliases]), now);
    db.prepare('DELETE FROM idol WHERE name = ?').run(a);
    return { from: a, into: b, aliases: [...aliases], filled };
  } finally {
    db.close();
  }
}

// Read-only pickup of an existing local install's data, when he has one.
function importFrom(dbFile, sourceFile) {
  if (!sourceFile || !fs.existsSync(sourceFile)) throw new Error('找不到来源数据库');
  const src = new DatabaseSync(sourceFile, { readOnly: true });
  let rows = [];
  try {
    const has = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jav_idol'").get();
    if (!has) throw new Error('来源里没有 jav_idol 表');
    rows = src.prepare('SELECT name, roman_name, japanese_name, chinese_name, height_cm, birth_date, bust, waist, hips, cup FROM jav_idol').all();
  } finally {
    src.close();
  }
  const db = open(dbFile);
  let added = 0;
  try {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const stmt = db.prepare(`INSERT INTO idol (name, japanese_name, roman_name, chinese_name, height_cm, birth_date, bust, waist, hips, cup, aliases, updated)
      VALUES (?,?,?,?,?,?,?,?,?,?, '[]', ?) ON CONFLICT(name) DO UPDATE SET
      japanese_name=excluded.japanese_name, roman_name=excluded.roman_name, chinese_name=excluded.chinese_name,
      height_cm=excluded.height_cm, birth_date=excluded.birth_date, bust=excluded.bust, waist=excluded.waist,
      hips=excluded.hips, cup=excluded.cup, updated=excluded.updated`);
    for (const r of rows) {
      if (!String(r.name || '').trim()) continue;
      stmt.run(r.name, r.japanese_name || '', r.roman_name || '', r.chinese_name || '', normMeasure(r.height_cm), r.birth_date || '', normMeasure(r.bust), normMeasure(r.waist), normMeasure(r.hips), normCup(r.cup), now);
      added++;
    }
  } finally {
    db.close();
  }
  return { added, total: rows.length };
}

// One pass over what the earlier builds put on disk, run at startup:
//   - 罩杯 as the old program's enum or as a letter glued to a band size -> a bare letter
//   - 出身地 that an earlier wiki pass wrote into 中文名 because there was no column for it
// Both steps are idempotent, and the second only fires for a name that is spelled like a
// Japanese prefecture — a real Chinese 中文名 never ends in 県.
function repairLegacy(dbFile) {
  const db = open(dbFile);
  try {
    let cups = 0;
    let places = 0;
    const updCup = db.prepare('UPDATE idol SET cup = ? WHERE name = ?');
    const updPlace = db.prepare('UPDATE idol SET birth_place = ?, chinese_name = ? WHERE name = ?');
    db.exec('BEGIN');
    try {
      for (const r of db.prepare("SELECT name, cup FROM idol WHERE cup <> '' AND cup GLOB '[0-9]*'").all()) {
        const c = normCup(r.cup);
        if (c && c !== r.cup) {
          updCup.run(c, r.name);
          cups++;
        }
      }
      for (const r of db.prepare("SELECT name, cup FROM idol WHERE cup GLOB '[A-Z][0-9]*'").all()) {
        const c = normCup(r.cup);
        if (c && c !== r.cup) {
          updCup.run(c, r.name);
          cups++;
        }
      }
      for (const r of db.prepare("SELECT name, chinese_name, birth_place FROM idol WHERE chinese_name <> '' AND (chinese_name LIKE '%都' OR chinese_name LIKE '%道' OR chinese_name LIKE '%府' OR chinese_name LIKE '%県')").all()) {
        if (String(r.birth_place || '').trim()) continue;
        updPlace.run(r.chinese_name, '', r.name);
        places++;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { cups, places };
  } finally {
    db.close();
  }
}

function get(dbFile, name) {
  const db = open(dbFile);
  try {
    const r = db.prepare('SELECT * FROM idol WHERE name = ?').get(String(name || ''));
    return r ? { ...r, aliases: parseAliases(r.aliases) } : null;
  } finally {
    db.close();
  }
}

// Only the crawl-owned columns, so saving measurements never clears a JavDB binding and
// vice versa.
function patch(dbFile, name, fields) {
  const n = String(name || '').trim();
  if (!n) throw new Error('名字不能为空');
  const keys = Object.keys(EXTRA).filter((k) => fields[k] !== undefined);
  if (!keys.length) return get(dbFile, n);
  const db = open(dbFile);
  try {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const exists = db.prepare('SELECT 1 FROM idol WHERE name = ?').get(n);
    if (!exists)
      db.prepare(`INSERT INTO idol (name, aliases, updated, ${keys.join(',')}) VALUES (?, '[]', ?, ${keys.map(() => '?').join(',')})`).run(n, now, ...keys.map((k) => String(fields[k])));
    else db.prepare(`UPDATE idol SET ${keys.map((k) => `${k}=?`).join(',')}, updated=? WHERE name = ?`).run(...keys.map((k) => String(fields[k])), now, n);
  } finally {
    db.close();
  }
  return get(dbFile, n);
}

// Bulk version of patch() for the one-click actions: hundreds of separate patch() calls would
// open and close the database once per performer, so this does the whole batch in one
// transaction on a single connection.
function patchMany(dbFile, rows) {
  const items = (rows || []).filter((r) => r && String(r.name || '').trim());
  if (!items.length) return 0;
  const db = open(dbFile);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let done = 0;
  try {
    db.exec('BEGIN');
    for (const r of items) {
      const n = String(r.name).trim();
      const keys = Object.keys(EXTRA).filter((k) => r[k] !== undefined);
      if (!keys.length) continue;
      const values = keys.map((k) => String(r[k]));
      const exists = db.prepare('SELECT 1 FROM idol WHERE name = ?').get(n);
      if (!exists)
        db.prepare(`INSERT INTO idol (name, aliases, updated, ${keys.join(',')}) VALUES (?, '[]', ?, ${keys.map(() => '?').join(',')})`).run(n, now, ...values);
      else db.prepare(`UPDATE idol SET ${keys.map((k) => `${k}=?`).join(',')}, updated=? WHERE name = ?`).run(...values, now, n);
      done++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.close();
  }
  return done;
}

// ---- JavDB actress directory, cached once instead of re-walked per name -----------------
// Looking a single name up would otherwise mean paging through the whole directory, which
// costs minutes per performer. The crawl fills this table once and every lookup after that
// is a local index hit.
function openIndex(dbFile) {
  const db = open(dbFile);
  db.prepare('CREATE TABLE IF NOT EXISTS actor_index (name TEXT PRIMARY KEY, javdb_id TEXT, url TEXT, avatar TEXT, updated TEXT)').run();
  return db;
}

function saveIndex(dbFile, rows) {
  const db = openIndex(dbFile);
  try {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const stmt = db.prepare(`INSERT INTO actor_index (name, javdb_id, url, avatar, updated) VALUES (?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET javdb_id=excluded.javdb_id, url=excluded.url, avatar=excluded.avatar, updated=excluded.updated`);
    db.exec('BEGIN');
    let n = 0;
    try {
      for (const r of rows || []) {
        for (const name of r.names || []) {
          stmt.run(String(name), r.id, r.url || '', r.avatar || '', now);
          n++;
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return n;
  } finally {
    db.close();
  }
}

function listIndex(dbFile) {
  const db = openIndex(dbFile);
  try {
    return db.prepare('SELECT * FROM actor_index').all();
  } finally {
    db.close();
  }
}

// Binds every profile that the cached directory can resolve.
function bindFromIndex(dbFile) {
  const db = openIndex(dbFile);
  try {
    const missing = db.prepare("SELECT name FROM idol WHERE javdb_id='' OR javdb_id IS NULL").all().map((r) => r.name);
    const idx = new Map(db.prepare('SELECT name, javdb_id, url FROM actor_index').all().map((r) => [r.name, r]));
    const upd = db.prepare("UPDATE idol SET javdb_id=?, javdb_url=?, updated=? WHERE name=?");
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    let bound = 0;
    const unmatched = [];
    db.exec('BEGIN');
    try {
      for (const name of missing) {
        const hit = idx.get(name) || [...idx.values()].find((r) => r.name.includes(name) || name.includes(r.name));
        if (!hit) {
          unmatched.push(name);
          continue;
        }
        upd.run(hit.javdb_id, hit.url, now, name);
        bound++;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { bound, unmatched: unmatched.length, totalMissing: missing.length };
  } finally {
    db.close();
  }
}

module.exports = { list, get, save, patch, patchMany, merge, importFrom, normCup, repairLegacy, open, saveIndex, bindFromIndex, listIndex };
