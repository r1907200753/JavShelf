'use strict';
const fs = require('node:fs');
const path = require('node:path');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { nativeImage } = require('electron');

// A single title's cover, replaced by hand. Two copies can exist and they mean different
// things, so this module keeps them apart:
//
//   · ours  — <dataDir>\video_cover\<桶>\<编号>-<内容哈希>.jpg, recorded in JavShelf.db.
//     This is what the wall shows, and it never touches his folders. The hash is part of the
//     name because the image protocol answers with `immutable`: a second import saved under
//     the same name would keep painting the first picture.
//   · his  — the `-poster.jpg` next to the video, written only when he ticks that box in the
//     crop dialog, so the tools that read the folder directly see the same picture. Whatever
//     was there first is copied to `<同名>.bak`, and restore() puts those bytes back —
//     overwriting a cover he downloaded is not something to do quietly.
//
// The same code can exist in two libraries, so a row is keyed by (库, 编号) like the entry cache.
const MAX_W = 640;

function keyOf(lib, code) {
  return JSON.stringify([String(lib || ''), safeCode(code)]);
}

function safeCode(code) {
  return String(code || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 64);
}

function bucket(code) {
  const s = safeCode(code).toUpperCase();
  if (!s) return 'OTHER';
  return /[0-9A-Z]/.test(s[0]) ? s[0] : '_';
}

function toJpeg(buf) {
  const img = nativeImage.createFromBuffer(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  if (img.isEmpty()) throw new Error('不是可解码的图片');
  const s = img.getSize();
  const out = s.width > MAX_W ? img.resize({ width: MAX_W, quality: 'best' }) : img;
  return out.toJPEG(90);
}

function writeAtomic(abs, buf) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, abs);
}

class CoverStore {
  constructor(dataDir, dbFile) {
    this.dir = path.join(dataDir, 'video_cover');
    this.dbFile = dbFile;
    fs.mkdirSync(this.dir, { recursive: true });
    this.map = new Map();
    this.reload();
  }

  open() {
    fs.mkdirSync(path.dirname(this.dbFile), { recursive: true });
    const db = new DatabaseSync(this.dbFile);
    db.prepare(
      `CREATE TABLE IF NOT EXISTS video_cover (
         lib TEXT NOT NULL, code TEXT NOT NULL, rel TEXT NOT NULL,
         folder TEXT DEFAULT '', updated TEXT DEFAULT '', PRIMARY KEY(lib, code))`
    ).run();
    return db;
  }

  // Every boot reads the table into a map (the wall asks per visible card, so it must not
  // touch the database). The connection belongs to this method and has to die here — leaking
  // one handle per 切库/入库 kept JavShelf.db open for the whole session.
  reload() {
    this.map = new Map();
    this.loadError = '';
    let db = null;
    try {
      db = this.open();
      for (const r of db.prepare('SELECT lib, code, rel, folder FROM video_cover').all()) this.map.set(keyOf(r.lib, r.code), r);
    } catch (e) {
      // Emptying the map is the safe answer: showing his own poster beats showing nothing,
      // and a later save() will surface the same failure with a real error message.
      this.loadError = String((e && e.message) || e);
    } finally {
      if (db) db.close();
    }
    return this;
  }

  // What the wall asks on every render, so this stays a map lookup — no database per code.
  get(lib, code) {
    return this.map.get(keyOf(lib, code)) || null;
  }

  has(lib, code) {
    return !!this.get(lib, code);
  }

  // The rel to paint, or '' when there is no override. Existence is checked because he can
  // delete our folder by hand, and a missing sidecar should fall back to his own poster
  // instead of a broken picture. This is a stat on our local data folder, not on his drive.
  relOf(lib, code) {
    const row = this.get(lib, code);
    if (!row) return '';
    if (fs.existsSync(this.absOf(row.rel))) return row.rel;
    this.map.delete(keyOf(lib, code));
    return '';
  }

  absOf(rel) {
    return path.join(this.dir, String(rel).slice('video_cover/'.length));
  }

  count() {
    return this.map.size;
  }

  // Save our copy, and mirror into his folder only when asked. `folderAbs` is the exact
  // sidecar path main.js resolved (existing poster, or `<视频名>-poster.jpg` beside it) —
  // it never comes from the renderer. The mirror is the only await here: on his cloud mount a
  // write is a multi-second round trip, and doing it synchronously would freeze the wall.
  async save(lib, code, buf, folderAbs) {
    const jpeg = toJpeg(buf);
    const stamp = crypto.createHash('sha1').update(jpeg).digest('hex').slice(0, 10);
    const rel = `video_cover/${bucket(code)}/${safeCode(code)}-${stamp}.jpg`;
    writeAtomic(this.absOf(rel), jpeg);

    const prev = this.get(lib, code);
    // Re-importing the same picture keeps the same name, so there is nothing to prune then.
    if (prev && prev.rel && prev.rel !== rel) {
      try {
        fs.rmSync(this.absOf(prev.rel));
      } catch {
        /* an orphan in our own folder is dead bytes, not his data */
      }
    }

    let mirrored = folderAbs;
    // A later import without the tick must not forget the .bak an earlier mirrored import left
    // behind, otherwise 恢复原本封面 would leave the replaced cover sitting in his folder. Only
    // the row keeps that pointer — `folder` below still means "written by this call".
    let keeps = folderAbs;
    if (!keeps && prev && prev.folder) {
      try {
        if (fs.existsSync(prev.folder + '.bak')) keeps = prev.folder;
      } catch {
        /* unreadable folder: keeping the pointer is a bonus, not a requirement */
      }
    }
    if (folderAbs) {
      const existed = fs.existsSync(folderAbs);
      if (existed && !fs.existsSync(folderAbs + '.bak')) await fsp.copyFile(folderAbs, folderAbs + '.bak');
      const tmp = folderAbs + '.' + process.pid + '.tmp';
      await fsp.writeFile(tmp, jpeg);
      await fsp.rename(tmp, folderAbs);
    }

    const db = this.open();
    try {
      db
        .prepare(
          `INSERT INTO video_cover (lib, code, rel, folder, updated) VALUES (?,?,?,?,?)
           ON CONFLICT(lib, code) DO UPDATE SET rel=excluded.rel, folder=excluded.folder, updated=excluded.updated`
        )
        .run(String(lib || ''), safeCode(code), rel, keeps, new Date().toISOString().slice(0, 19).replace('T', ' '));
    } finally {
      db.close();
    }
    const row = { lib: String(lib || ''), code: safeCode(code), rel, folder: keeps };
    this.map.set(keyOf(lib, code), row);
    return { rel, folder: mirrored };
  }

  // Drop our copy. If we mirrored, the original bytes come back from the .bak; a sidecar we
  // created ourselves is taken away again, because that folder had no poster before.
  async clear(lib, code) {
    const row = this.get(lib, code);
    if (!row) return { removed: false, restored: '', removedFolder: '' };
    try {
      fs.rmSync(this.absOf(row.rel));
    } catch {
      /* already gone */
    }
    let restored = '';
    let removedFolder = '';
    if (row.folder) {
      const bak = row.folder + '.bak';
      if (fs.existsSync(bak)) {
        await fsp.rename(bak, row.folder);
        restored = row.folder;
      } else if (fs.existsSync(row.folder)) {
        try {
          await fsp.rm(row.folder);
          removedFolder = row.folder;
        } catch {
          /* leave a file we cannot delete rather than claiming it is gone */
        }
      }
    }
    const db = this.open();
    try {
      db.prepare('DELETE FROM video_cover WHERE lib=? AND code=?').run(String(lib || ''), safeCode(code));
    } finally {
      db.close();
    }
    this.map.delete(keyOf(lib, code));
    return { removed: true, restored, removedFolder };
  }

  // The record is being deleted from the library, so our own copy has no owner left and comes
  // with it. Unlike clear() this never touches his folder: whatever was mirrored there stays,
  // because 删除记录 promises 「视频文件与 nfo 未改动」 and quietly restoring a .bak would be a
  // write to a folder he just told us to forget about.
  discard(lib, code) {
    const row = this.get(lib, code);
    if (!row) return false;
    try {
      fs.rmSync(this.absOf(row.rel));
    } catch {
      /* already gone */
    }
    const db = this.open();
    try {
      db.prepare('DELETE FROM video_cover WHERE lib=? AND code=?').run(String(lib || ''), safeCode(code));
    } finally {
      db.close();
    }
    this.map.delete(keyOf(lib, code));
    return !!row.folder;
  }
}

module.exports = { CoverStore };
