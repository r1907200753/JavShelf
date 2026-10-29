'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { MediaIndex } = require('./scan');
const { readNfo } = require('./nfo');

// Turning folders into a library. The old program's own library was already scraped, so
// it is only ever *located* here; anything added in JavShelf has to be built from what is
// on disk, which means reading each item's nfo into the same column shape the rest of the
// app already speaks.
//
// mode:
//   full    覆盖刷新 — drop every row and re-read all of them
//   append  新增刷新 — only folders never seen before
//   delta   删改刷新 — re-read whose nfo changed, drop whose file vanished
const CODE_RE = /^([a-z]{2,10}[-_ ]?\d{2,6})/i;

function codeFrom(name) {
  const m = CODE_RE.exec(String(name).trim());
  return m ? m[1].toUpperCase().replace(/[ ]/, '-') : String(name).trim();
}

function listJoin(arr) {
  return [...new Set((arr || []).map((s) => String(s).trim()).filter(Boolean))].join('/');
}

const NOISE_RE = /^(\d{3,4}[pi]|4k|2160p?|1080p?|720p?|hevc|avc1|h\.?26[45]|x26[45]|蓝光|高画質|無碼破解|uc\d+)$/i;

// Scraped nfo genres are a mixed bag: codec, resolution, the code itself and the actress
// name all show up in there. Keep only what reads like a real category.
function cleanGenres(list, code, actors) {
  const lower = new Set([].concat(code || []).map((s) => String(s).toLowerCase()));
  for (const a of actors || []) lower.add(String(a).toLowerCase());
  return (list || []).filter((g) => {
    const s = String(g).trim();
    if (!s || s.length > 24) return false;
    if (NOISE_RE.test(s)) return false;
    if (/^(制作|發行|发行|片商|廠牌|系列|導演|导演)[:：]/.test(s)) return false;
    if (lower.has(s.toLowerCase())) return false;
    return true;
  });
}

function rowFromEntry(entry, nfo) {
  const f = nfo.fields || {};
  const actors = (nfo.actors || []).map((a) => a.name).filter(Boolean);
  const code = f.num || codeFrom(entry.name);
  const genres = cleanGenres([].concat(f.genre || []).concat(f.tag || []), [code, codeFrom(entry.name)], actors);
  const date = f.premiered || f.releasedate || (f.year ? f.year + '-01-01' : '');
  return {
    only_code: entry.dir,
    movie_编码: code,
    movie_片名: f.title || f.originaltitle || entry.name,
    movie_日期: date,
    movie_年份: String(f.year || (date || '').slice(0, 4)),
    movie_时长: String(f.runtime || ''),
    movie_评分: String(f.rating || f.criticrating || ''),
    movie_制作: f.maker || f.studio || '',
    movie_发行: f.label || f.publisher || '',
    movie_导演: listJoin([].concat(f.director || [])),
    movie_演员: listJoin(actors),
    movie_类别: listJoin(genres),
    movie_系列: f.series || (typeof f.set === 'string' ? f.set : ''),
    movie_国家: f.countrycode || '',
    movie_语言: '',
    movie_类型: f.type || '',
    movie_编剧: '',
    movie_源简: f.plot || f.outline || '',
    movie_中简: '',
    movie_网址: f.website || '',
    file_路径: JSON.stringify({
      视频文件: {
        0: {
          文件名: path.basename(entry.video, path.extname(entry.video)),
          扩展名: path.extname(entry.video),
          文件大小: String(entry.size || ''),
          创建日期: '',
          分辨率: ''
        }
      }
    })
  };
}

const COLS = Object.keys(rowFromEntry({ dir: '', name: '', video: 'a.mp4' }, { fields: {}, actors: [] }));

class Ingestor {
  constructor({ dbFile, table, dirs, onProgress, shouldStop }) {
    this.dbFile = dbFile;
    this.table = table;
    this.dirs = dirs.filter(Boolean);
    this.onProgress = onProgress || (() => {});
    // The 停止 button sets a flag in main.js; without this hook it is a control that does
    // nothing on the longest job in the app.
    this.shouldStop = shouldStop || (() => false);
  }

  emit(patch) {
    this.onProgress({ ...this.stats, t: Date.now() - this.t0, ...patch });
  }

  ensureMeta() {
    const db = new DatabaseSync(this.dbFile);
    try {
      db.prepare('CREATE TABLE IF NOT EXISTS shelf_scan (dir TEXT PRIMARY KEY, nfo_mtime INTEGER, code TEXT)').run();
    } finally {
      db.close();
    }
  }

  async run(mode = 'append') {
    this.t0 = Date.now();
    this.stats = { mode, roots: this.dirs.length, scanned: 0, found: 0, added: 0, updated: 0, deleted: 0, skipped: 0, shielded: 0, current: '' };
    this.ensureMeta();
    this.emit({ phase: 'start' });

    const entries = [];
    // 读不到的子目录记下来：删改刷新只看「这次没出现」,如果那一整段是因为网盘掉线才没出现,
    // 按消失处理会把好端端的库删掉一块。
    const unreadable = [];
    for (const root of this.dirs) {
      const idx = await MediaIndex.build([root], {
        onProgress: (p) => this.emit({ phase: 'walk', root, scanned: p.scanned, found: p.found, current: '' })
      });
      for (const e of idx.errors || []) unreadable.push(e.dir);
      const list = idx.entries();
      for (const e of list) entries.push(e);
      this.emit({ phase: 'walked', root, scanned: 0, found: entries.length });
    }

    const db = new DatabaseSync(this.dbFile);
    try {
      const known = new Map();
      for (const r of db.prepare('SELECT dir, nfo_mtime, code FROM shelf_scan').all()) known.set(r.dir, r);

      if (mode === 'full') {
        db.prepare(`DELETE FROM "${this.table}"`).run();
        db.prepare('DELETE FROM shelf_scan').run();
        known.clear();
      }

      const quoted = COLS.map((c) => `"${c}"`);
      const upsert = db.prepare(
        `INSERT INTO "${this.table}" (${quoted.join(',')}, "state_收藏", "state_已看", "state_字幕", "state_更新", "state_创建")
         VALUES (${COLS.map(() => '?').join(',')}, '假', '假', '假', ?, ?)
         ON CONFLICT(only_code) DO UPDATE SET ${quoted.map((c) => `${c}=excluded.${c}`).join(',')}, "state_更新"=excluded."state_更新"`
      );
      const remember = db.prepare('INSERT OR REPLACE INTO shelf_scan (dir, nfo_mtime, code) VALUES (?, ?, ?)');
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

      db.exec('BEGIN');
      let i = 0;
      let stopped = false;
      for (const e of entries) {
        i++;
        this.stats.scanned = i;
        this.stats.found = entries.length;
        this.stats.current = e.dir;
        if (i % 25 === 0) {
          db.exec('COMMIT');
          db.exec('BEGIN');
          this.emit({ phase: 'read' });
          if (this.shouldStop()) {
            stopped = true;
            break;
          }
          // 入库跑的是网盘上的整棵树;每 25 条让出一次事件循环,窗口才不会被判无响应。
          await new Promise((r) => setImmediate(r));
        }
        const prev = known.get(e.dir);
        if (mode === 'append' && prev) continue;
        let mtime = 0;
        try {
          const st = await fsp.stat(e.nfo || e.video);
          mtime = Math.round(st.mtimeMs);
          e.size = (await fsp.stat(e.video)).size;
        } catch {
          this.stats.skipped++;
          continue;
        }
        if (mode === 'delta' && prev && prev.nfo_mtime === mtime) continue;
        let nfo;
        if (e.nfo) {
          try {
            nfo = readNfo(e.nfo, await fsp.readFile(e.nfo, 'utf8'));
          } catch {
            // 读不动的 nfo 不等于「这部片没信息」。写一行只有文件夹名的空行会把
            // 之前抓好的片名/类别盖掉,所以跳过并计数,让下一轮再试。
            this.stats.skipped++;
            continue;
          }
        } else {
          nfo = { fields: {}, actors: [] };
        }
        if (!e.nfo && !nfo.fields.title) {
          // A folder with a video but no nfo still deserves a row; its name is the title.
          nfo.fields = { title: e.name };
        }
        const row = rowFromEntry(e, nfo);
        upsert.run(...COLS.map((c) => row[c]), now, now);
        remember.run(e.dir, mtime, row.movie_编码);
        this.stats[prev ? 'updated' : 'added']++;
      }
      db.exec('COMMIT');

      if (mode === 'delta' && !stopped) {
        const alive = new Set(entries.map((e) => e.dir));
        const blocked = (d) => unreadable.some((u) => d === u || d.startsWith(u + path.sep));
        const gone = [];
        let shielded = 0;
        for (const d of known.keys()) {
          if (alive.has(d)) continue;
          if (blocked(d)) shielded++;
          else gone.push(d);
        }
        if (shielded) this.stats.shielded = shielded;
        const del = db.prepare(`DELETE FROM "${this.table}" WHERE only_code = ?`);
        const delMeta = db.prepare('DELETE FROM shelf_scan WHERE dir = ?');
        for (const d of gone) {
          del.run(d);
          delMeta.run(d);
          this.stats.deleted++;
        }
      }
      const total = db.prepare(`SELECT COUNT(*) c FROM "${this.table}"`).get().c;
      this.emit({ phase: stopped ? 'stopped' : 'done', total });
      return { ...this.stats, total, ms: Date.now() - this.t0, stopped };
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already committed */
      }
      this.emit({ phase: 'error', error: String(e.message) });
      throw e;
    } finally {
      db.close();
    }
  }
}

module.exports = { Ingestor, COLS, rowFromEntry };
