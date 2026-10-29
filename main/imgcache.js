'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// ------------------------------------------------------------------ 图片本地缓存 (v1.6)
// 慢盘读取图片的成本可能远高于读取文件元数据，因此使用 size/mtime 决定是否更新缓存。
// v1.5.5 的做法是「读得慢(≥250 ms)才留一份」+「扫描结束整目录作废」——后者正是卡的原因:
// 每次库刷新都把网盘海报全部打回原形,海报墙每页 24 张重新逐张走网络。
// v1.6 改为:
//   · 刷新不再删缓存;扫描完成后做一次「预热」——对索引里的海报/fanart/thumb/nfo 逐个 stat,
//     只有 size/mtime 变了或本地没有的才真读;从索引里消失的文件,缓存条目跟着删。
//   · 缓存文件按 sha1(绝对路径) 命名(与 v1.5.5 同布局),另有一张清单 index.json 记
//     每个条目的 size+mtime;协议层命中直接出图,不做任何远端校验(新鲜度由预热负责)。
//   · 本地快盘不复制(探测:一次快读即整根跳过;预热的判定线比懒缓存高一档,因为
//     判错的代价是「整根目录被复制成双份」)。
//   · 界面编辑/覆写 nfo、播放依然直接落原盘;写成功后顺手刷新缓存副本。
// 清单只包含慢盘的条目。v1.5.5 的缓存键是 r<n>/ 引用且没有清单,升级后第一次构造时
// 整目录丢弃(反正预热会重建)。
const SLOW_READ_MS = 250;
const WARM_PROBE_MS = 600;
const IMG_EXT_FOR_PROBE = /\.(jpe?g|png|webp)$/i;

class ImgCache {
  constructor(dir) {
    this.dir = dir;
    this.manifestFile = path.join(dir, 'index.json');
    this.meta = new Map();
    this.hits = 0;
    this.stored = 0;
    this._saveTimer = 0;
    let loaded = false;
    try {
      const j = JSON.parse(fs.readFileSync(this.manifestFile, 'utf8'));
      for (const [abs, e] of Object.entries(j.entries || {})) {
        if (e && typeof e.s === 'number') this.meta.set(abs, e);
      }
      loaded = true;
    } catch {
      /* no manifest yet */
    }
    if (!loaded) {
      try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* stale pre-1.6 cache that resists deletion is still just dead bytes */
      }
    }
  }

  pathFor(abs) {
    const h = crypto.createHash('sha1').update(path.resolve(abs)).digest('hex');
    return path.join(this.dir, h.slice(0, 2), h.slice(2));
  }

  entry(abs) {
    return this.meta.get(path.resolve(abs)) || null;
  }

  fresh(abs, st) {
    const m = this.entry(abs);
    return !!m && !!st && m.s === st.size && Math.abs(m.m - Math.round(st.mtimeMs)) < 2;
  }

  bytes(abs) {
    try {
      return fs.readFileSync(this.pathFor(abs));
    } catch {
      return null;
    }
  }

  // Protocol-level lookup: existence of the file alone is the hit test (no remote stat).
  // Must stay async: the wall asks for a screenful of images at once, and a synchronous
  // readFileSync per picture froze the main process for ~1.1 s per 120 cards.
  async hit(abs) {
    const key = path.resolve(abs);
    let buf;
    try {
      buf = await fsp.readFile(this.pathFor(key));
    } catch {
      return null;
    }
    this.hits++;
    const meta = this.meta.get(key);
    return { buf, mtime: (meta && meta.m) || 0 };
  }

  write(abs, buf, st) {
    const key = path.resolve(abs);
    const f = this.pathFor(key);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, f);
    this.meta.set(key, { s: buf.length, m: Math.round(st ? st.mtimeMs : Date.now()) });
    this.stored++;
    this.scheduleSave();
  }

  // 批量预热专用：上千张图逐个 writeFileSync 同样会卡住主进程，写入也让出事件循环。
  async writeAsync(abs, buf, st) {
    const key = path.resolve(abs);
    const f = this.pathFor(key);
    await fsp.mkdir(path.dirname(f), { recursive: true });
    const tmp = f + '.' + process.pid + '.tmp';
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, f);
    this.meta.set(key, { s: buf.length, m: Math.round(st ? st.mtimeMs : Date.now()) });
    this.stored++;
    this.scheduleSave();
  }

  drop(abs) {
    const key = path.resolve(abs);
    try {
      fs.rmSync(this.pathFor(key), { force: true });
    } catch {
      /* file already gone */
    }
    if (this.meta.delete(key)) this.scheduleSave();
  }

  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = 0;
      this.save();
    }, 2000);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.manifestFile + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: Object.fromEntries(this.meta) }));
      fs.renameSync(tmp, this.manifestFile);
    } catch {
      /* the cache is best-effort; losing the manifest only means re-warming later */
    }
  }

  clear() {
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* nothing to remove */
    }
    this.meta.clear();
    this.hits = 0;
    this.stored = 0;
  }

  info() {
    let files = 0;
    let bytes = 0;
    const walk = (dir) => {
      let list;
      try {
        list = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of list) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name !== 'index.json' && !e.name.includes('.tmp')) {
          files++;
          bytes += fs.statSync(p, { throwIfNoEntry: false })?.size || 0;
        }
      }
    };
    walk(this.dir);
    return { dir: this.dir, files, bytes, entries: this.meta.size, hits: this.hits, stored: this.stored };
  }

  // Re-warm one scanned root. `paths` are the sidecar files the fresh index found;
  // anything under ownerPrefix that disappeared from them loses its cache entry.
  // probeMs: 0 永远算慢(强制预热) · 负数永远算本地(回归用,不依赖机器负载) · 默认 WARM_PROBE_MS
  async warm(paths, opts = {}) {
    const t0 = Date.now();
    const ownerPrefix = opts.ownerPrefix || '';
    const probeMs = opts.probeMs == null ? WARM_PROBE_MS : opts.probeMs;
    const concurrency = opts.concurrency || 6;
    const onProgress = opts.onProgress || (() => {});
    const list = [...new Set(paths.map((p) => path.resolve(p)))].sort();
    const res = { total: list.length, copied: 0, skipped: 0, dropped: 0, pruned: 0, skippedLocal: false, probeMs: 0, ms: 0 };
    const prune = () => {
      if (!ownerPrefix) return;
      const keep = new Set(list);
      for (const key of [...this.meta.keys()]) {
        if (key.startsWith(ownerPrefix) && !keep.has(key)) {
          this.drop(key);
          res.pruned++;
        }
      }
    };
    // 探测:一次快读就足以说明这是本地盘(取均值会被冷启动的慢样本污染,把整个本地库
    // 复制成双份)。没变的探测文件只记跳过,不再重复落盘。
    // 仅抽样少量异步 stat，避免慢盘上的大量同步元数据访问阻塞主进程。
    const probes = [];
    if (probeMs > 0) {
      const candidates = list.filter((p) => IMG_EXT_FOR_PROBE.test(p));
      const picks = [];
      const step = Math.max(1, Math.floor(candidates.length / 6));
      for (let i = 0; i < candidates.length && picks.length < 6; i += step) picks.push(candidates[i]);
      const sized = [];
      for (const p of picks) {
        try {
          const st = await fsp.stat(p);
          if (st.isFile()) sized.push({ p, size: st.size });
        } catch {
          /* candidate vanished between scan and warm */
        }
      }
      sized.sort((a, b) => b.size - a.size);
      probes.push(...sized.slice(0, 2));
    }
    const probed = new Set();
    let decidedLocal = probeMs < 0;
    for (const { p } of probes) {
      if (decidedLocal) break;
      const a = process.hrtime.bigint();
      let buf;
      try {
        buf = await fsp.readFile(p);
      } catch {
        continue;
      }
      const ms = Number(process.hrtime.bigint() - a) / 1e6;
      probed.add(p);
      if (ms < probeMs) {
        decidedLocal = true;
        break;
      }
      res.probeMs = Math.max(res.probeMs, Math.round(ms));
      const st = await fsp.stat(p).catch(() => null);
      if (this.fresh(p, st)) res.skipped++;
      else if (buf) {
        await this.writeAsync(p, buf, st);
        res.copied++;
      }
    }
    if (decidedLocal) {
      res.skippedLocal = true;
      res.ms = Date.now() - t0;
      return res;
    }
    let done = 0;
    for (let i = 0; i < list.length; i += concurrency) {
      const batch = list.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (abs) => {
          if (probed.has(abs)) return;
          let st;
          try {
            st = await fsp.stat(abs);
            if (!st.isFile()) st = null;
          } catch {
            st = null;
          }
          if (!st) {
            if (this.entry(abs)) {
              this.drop(abs);
              res.dropped++;
            }
            return;
          }
          if (this.fresh(abs, st)) {
            let cached = false;
            try {
              cached = (await fsp.stat(this.pathFor(abs))).isFile();
            } catch {
              /* manifest says fresh but the copy is gone; re-read it */
            }
            if (cached) {
              res.skipped++;
              return;
            }
          }
          try {
            const buf = await fsp.readFile(abs);
            await this.writeAsync(abs, buf, st);
            res.copied++;
          } catch {
            /* drive hiccup: the lazy protocol path still covers this file */
          }
        })
      );
      done += batch.length;
      onProgress(Math.min(done, list.length), list.length);
    }
    prune();
    this.save();
    res.ms = Date.now() - t0;
    return res;
  }
}

module.exports = { ImgCache, SLOW_READ_MS };
