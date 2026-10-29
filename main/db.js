'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

// The three state columns this app is allowed to change in somebody else's database.
// Everything else in a shared table belongs to the program that wrote it.
const WRITABLE = new Set(['state_收藏', 'state_已看', 'state_字幕']);

const GRID_COLS = [
  'only_code', 'movie_编码', 'movie_片名', 'movie_日期', 'movie_演员', 'movie_评分',
  'movie_时长', 'movie_类别', 'movie_系列', 'movie_发行', 'movie_制作',
  'state_收藏', 'state_已看', 'state_字幕', 'state_观看', 'state_时长'
];

class Db {
  // file/table come from the library config: a legacy library reads local_<name> from
  // the old database, one created here lives in JavShelf.db as shelf_<name>.
  constructor(file, table) {
    this.file = file;
    this.table = table;
    if (!fs.existsSync(this.file)) throw new Error('找不到数据库: ' + this.file);
  }

  openRead() {
    return new DatabaseSync(this.file, { readOnly: true });
  }

  openWrite() {
    return new DatabaseSync(this.file);
  }

  // Column names are Chinese identifiers -> always quoted. Table name is derived
  // from a whitelist-checked library name, never from free-form input.
  static quoteIdent(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
  }

  // Called with a connection the caller already holds: loadGrid/fileMeta used to open a
  // second one just to ask which columns exist, doubling the work on a 14 MB library.
  static columnNames(db, table) {
    return db.prepare(`PRAGMA table_info(${Db.quoteIdent(table)})`).all().map((r) => r.name);
  }

  // The grid only needs a narrow slice; pulling movie_源简 / file_路径 for every
  // row is what makes a 14 MB library feel heavy to load.
  loadGrid() {
    const db = this.openRead();
    try {
      const have = new Set(Db.columnNames(db, this.table));
      const cols = GRID_COLS.filter((c) => have.has(c));
      const sql = `SELECT ${cols.map((c) => Db.quoteIdent(c)).join(', ')} FROM ${Db.quoteIdent(this.table)}`;
      const rows = db.prepare(sql).all();
      return { cols, rows };
    } finally {
      db.close();
    }
  }

  loadRow(code) {
    const db = this.openRead();
    try {
      const r = db.prepare(`SELECT * FROM ${Db.quoteIdent(this.table)} WHERE "movie_编码" = ?`).get(code);
      return r || null;
    } finally {
      db.close();
    }
  }

  // 番号 is not unique: the same title may be stored under two folders. A write that must
  // change one specific record addresses it by the shelf table's real primary key.
  loadRowByKey(onlyCode) {
    const db = this.openRead();
    try {
      const r = db.prepare(`SELECT * FROM ${Db.quoteIdent(this.table)} WHERE "only_code" = ?`).get(String(onlyCode));
      return r || null;
    } finally {
      db.close();
    }
  }

  // Rewrite one shelf row's metadata after its nfo was edited. Identity columns stay put:
  // moving them would orphan the row from the folder and from every other reader.
  refreshMeta(onlyCode, values, updatedAt) {
    const db = this.openWrite();
    try {
      const have = new Set(Db.columnNames(db, this.table));
      const cols = Object.keys(values || {}).filter(
        (c) => have.has(c) && c !== 'only_code' && c !== 'movie_编码' && c !== 'file_路径'
      );
      if (!cols.length) return 0;
      const sets = cols.map((c) => `${Db.quoteIdent(c)} = ?`);
      const args = cols.map((c) => values[c]);
      if (updatedAt !== undefined && have.has('state_更新')) {
        sets.push(`${Db.quoteIdent('state_更新')} = ?`);
        args.push(updatedAt);
      }
      return db
        .prepare(`UPDATE ${Db.quoteIdent(this.table)} SET ${sets.join(', ')} WHERE "only_code" = ?`)
        .run(...args, String(onlyCode)).changes;
    } finally {
      db.close();
    }
  }

  // file_路径 is deliberately left out of the grid query, so the handful of rows that
  // need a disk lookup ask for it in one batch instead.
  fileMeta(codes) {
    const list = [...new Set(codes.map(String))].filter(Boolean);
    if (!list.length) return new Map();
    const db = this.openRead();
    try {
      const have = new Set(Db.columnNames(db, this.table));
      const want = ['only_code', 'movie_编码', 'movie_片名', 'file_路径'].filter((c) => have.has(c));
      const sql = `SELECT ${want.map((c) => Db.quoteIdent(c)).join(', ')} FROM ${Db.quoteIdent(this.table)} WHERE "movie_编码" IN (${list.map(() => '?').join(',')})`;
      const rows = db.prepare(sql).all(...list);
      return new Map(rows.map((r) => [String(r.movie_编码), r]));
    } finally {
      db.close();
    }
  }

  // State writes stay inside the value domain the shared database already uses
  // (真/假, numeric text) so other readers of this table keep working unchanged.
  setState(code, field, value) {
    if (!WRITABLE.has(field)) throw new Error('不允许写入字段: ' + field);
    const db = this.openWrite();
    try {
      const info = db
        .prepare(`UPDATE ${Db.quoteIdent(this.table)} SET ${Db.quoteIdent(field)} = ? WHERE "movie_编码" = ?`)
        .run(String(value), code);
      return info.changes;
    } finally {
      db.close();
    }
  }

  // Drop one row from JavShelf's own shelf table. Video files and their nfo are never
  // touched, and the caller refuses this for libraries that still live in the shared
  // database — deleting someone else's rows is not ours to do.
  remove(code) {
    const db = this.openWrite();
    try {
      return db.prepare(`DELETE FROM ${Db.quoteIdent(this.table)} WHERE "movie_编码" = ?`).run(String(code)).changes;
    } finally {
      db.close();
    }
  }

  // Only ever called for a library this app owns (store === 'shelf'): 观看次数 and 时长 are
  // columns of our own table. A shared legacy database only gets 已看, through setState.
  bumpWatch(code, seconds) {
    const db = this.openWrite();
    try {
      const cur = db
        .prepare(`SELECT "state_观看" AS v, "state_时长" AS s FROM ${Db.quoteIdent(this.table)} WHERE "movie_编码" = ?`)
        .get(code);
      const watched = (Number(cur && cur.s) || 0) + (Number(seconds) || 0);
      const n = (Number(cur && cur.v) || 0) + 1;
      db.prepare(
        `UPDATE ${Db.quoteIdent(this.table)} SET "state_观看" = ?, "state_时长" = ?, "state_已看" = ? WHERE "movie_编码" = ?`
      ).run(String(n), String(watched), '真', code);
      return { watched, n };
    } finally {
      db.close();
    }
  }

  // A library is tens of megabytes and the target can be a cloud-mounted 数据目录: a
  // synchronous copy would freeze every image request in the process for seconds.
  async backup(dir) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const stem = path.basename(this.file, '.db');
    const target = path.join(dir || path.dirname(this.file), `${stem}.backup-${stamp}.db`);
    await fsp.copyFile(this.file, target);
    return target;
  }
}

module.exports = { Db };
