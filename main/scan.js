'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// The database stores 文件名 + 扩展名 in file_路径 but no directory, so where a title
// actually lives has to come from the library folders themselves:
//   <root>\<演员或分类>\<条目>\<文件名>.mp4  +  <文件名>-poster.jpg / -fanart.jpg / -thumb.jpg / .nfo
// This walks the roots once, indexes by basename, and caches the result so the next
// start is instant.
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.avi', '.ts', '.m2ts', '.wmv', '.flv', '.mov', '.webm', '.mpg', '.mpeg', '.iso']);
const IMG_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const MAX_DEPTH = 4;
const PARALLEL = 24;

// poster/fanart/thumb are prefixed with the video name here, but Emby/Jellyfin tools
// write them bare, so accept both spellings.
function stems(base, kind) {
  if (kind === 'poster') return [`${base}-poster`, 'poster'];
  if (kind === 'fanart') return [`${base}-fanart`, 'fanart'];
  return [`${base}-thumb`, 'thumb', `${base}-fanart`, `${base}-poster`];
}

function sidecar(names, dir, base, kind) {
  for (const stem of stems(base, kind)) {
    for (const ext of IMG_EXT) {
      const hit = names.get((stem + ext).toLowerCase());
      if (hit) return path.join(dir, hit);
    }
  }
  // Renamed sidecars: accept the folder's only <kind> image, or one sharing the code prefix.
  const prefix = String(base || '').split('-').slice(0, 2).join('-').toLowerCase();
  for (const ext of IMG_EXT) {
    const suf = '-' + kind + ext;
    const cands = [...names.values()].filter((n) => n.toLowerCase().endsWith(suf));
    const hit = cands.find((n) => prefix && n.toLowerCase().startsWith(prefix)) || (cands.length === 1 ? cands[0] : null);
    if (hit) return path.join(dir, hit);
  }
  return null;
}

class MediaIndex {
  constructor(entries) {
    this.errors = [];
    // How many folders this build could not read. Persisted so the next launch can
    // paint from this index immediately and still know it has to walk again.
    this.unreadable = 0;
    this.byName = new Map();
    this.byDir = new Map();
    for (const e of entries || []) {
      this.byName.set(e.name.toLowerCase(), e);
      for (const p of e.parts || []) {
        if (p && !this.byName.has(p.toLowerCase())) this.byName.set(p.toLowerCase(), e);
      }
      if (!this.byDir.has(e.dir.toLowerCase())) this.byDir.set(e.dir.toLowerCase(), e);
    }
  }

  get size() {
    return this.byDir.size;
  }

  // Try the exact 文件名 from the database, then the folder name, then the code.
  lookup(...keys) {
    for (const k of keys) {
      if (!k) continue;
      const key = String(k).trim().toLowerCase();
      const hit = this.byName.get(key) || this.byDir.get(key);
      if (hit) return hit;
    }
    return null;
  }

  static signature(dirs) {
    const h = crypto.createHash('sha1');
    for (const d of [...new Set(dirs.filter(Boolean))].sort()) {
      let stamp = 'missing';
      try {
        stamp = String(Math.round(fs.statSync(d).mtimeMs));
      } catch {
        /* a drive that is offline still needs a stable signature */
      }
      h.update(`${d}|${stamp}\n`);
    }
    return h.digest('hex').slice(0, 16);
  }

  // A folder we could not read is reported, never silently dropped: an index that is missing a
  // subtree has to stay `stale` (see LibraryFiles.prepare), or the truncated result becomes the
  // cached truth and 海报墙 quietly loses whole sections with nothing in the log.
  static async build(dirs, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const t0 = Date.now();
    let level = [...new Set(dirs.filter(Boolean))].map((dir) => ({ dir, depth: 0 }));
    const entries = [];
    const errors = [];
    let scanned = 0;
    for (let depth = 0; level.length && depth <= MAX_DEPTH; depth++) {
      const next = [];
      for (let i = 0; i < level.length; i += PARALLEL) {
        const batch = level.slice(i, i + PARALLEL);
        const results = await Promise.all(
          batch.map(async (job) => {
            try {
              return { job, items: await fsp.readdir(job.dir, { withFileTypes: true }) };
            } catch (e) {
              return { job, error: String((e && (e.code || e.message)) || e) };
            }
          })
        );
        for (const r of results) {
          if (!r) continue;
          if (r.error) {
            // 一个根整个读不到（网盘没挂上）和某个子目录 拒绝访问 是同一类事实：
            // 少了一段，就不能说这份索引是完整的。
            if (errors.length < 40) errors.push({ dir: r.job.dir, error: r.error });
            continue;
          }
          scanned++;
          const names = new Map();
          for (const it of r.items) {
            if (it.isDirectory()) {
              if (r.job.depth < MAX_DEPTH) next.push({ dir: path.join(r.job.dir, it.name), depth: r.job.depth + 1 });
            } else {
              names.set(it.name.toLowerCase(), it.name);
            }
          }
          const videos = [...names.values()].filter((n) => VIDEO_EXT.has(path.extname(n).toLowerCase())).sort((a, b) => a.localeCompare(b, 'en'));
          if (videos.length) entries.push(MediaIndex.entryFrom(r.job.dir, names, videos));
        }
        onProgress({ scanned, found: entries.length, unreadable: errors.length, ms: Date.now() - t0 });
      }
      level = next;
    }
    const index = new MediaIndex(entries);
    index.errors = errors;
    index.scanned = scanned;
    return index;
  }

  static entryFrom(dir, names, videos) {
    const base = path.basename(videos[0], path.extname(videos[0]));
    return {
      dir,
      name: base,
      video: path.join(dir, videos[0]),
      parts: videos.map((v) => path.basename(v, path.extname(v))),
      poster: sidecar(names, dir, base, 'poster'),
      fanart: sidecar(names, dir, base, 'fanart'),
      thumb: sidecar(names, dir, base, 'thumb'),
      nfo: names.get((base + '.nfo').toLowerCase()) ? path.join(dir, names.get((base + '.nfo').toLowerCase())) : null
    };
  }

  entries() {
    return [...this.byDir.values()];
  }

  save(file, sig, unreadable) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sig, built: Date.now(), unreadable: Number(unreadable) || 0, entries: this.entries() }));
  }

  static load(file, sig) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j.sig !== sig || !Array.isArray(j.entries)) return null;
      const index = new MediaIndex(j.entries);
      index.unreadable = Number(j.unreadable) || 0;
      return index;
    } catch {
      return null;
    }
  }

  // 签名过期 ≠ 索引无用:旧条目仍然能立刻回答「这个番号的海报在哪」,
  // 新来/改名的条目由后台重扫补上。冷启动从空索引开始 = 海报墙整面「未索引」。
  static loadStale(file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(j.entries)) return null;
      const index = new MediaIndex(j.entries);
      index.unreadable = Number(j.unreadable) || 0;
      return index;
    } catch {
      return null;
    }
  }
}

// Cache indexes per root and refresh stale roots sequentially in the background so slow scans do not delay the first paint.
class LibraryFiles {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    this.parts = new Map();
    // Roots the user explicitly asked to re-walk, so a cached index whose signature still
    // matches cannot short-circuit a 重新扫描.
    this.forced = new Set();
  }

  cacheFile(dir) {
    const h = crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 16);
    return path.join(this.cacheDir, `scan-${h}.json`);
  }

  static rootSig(dir) {
    return MediaIndex.signature([dir]);
  }

  // 索引文件本来就在本地，启动时先同步装进内存：首屏解析要立刻知道海报在哪。
  // 目录遍历仍交给下面的延迟扫描；读这几个 JSON 只要几十毫秒，比首屏逐条问云盘快得多。
  // 网盘根目录可能比窗口晚几秒才可访问，所以这里不等 existsSync：签名读不到时用旧索引
  // 顶上并标记 stale，等后台 prepare 到了再重扫。扫描中的 part 不能被旧缓存顶掉。
  preload(dirs) {
    for (const dir of [...new Set(dirs.filter(Boolean))]) {
      const prev = this.parts.get(dir);
      if (prev && prev.scanning) continue;
      const sig = LibraryFiles.rootSig(dir);
      const fresh = MediaIndex.load(this.cacheFile(dir), sig);
      const index = fresh || MediaIndex.loadStale(this.cacheFile(dir));
      if (!index) continue;
      if (prev && prev.sig === sig && prev.index.size >= index.size) continue;
      this.parts.set(dir, {
        dir,
        sig,
        index,
        // 签名过期只代表后台还要重扫；旧索引仍先把墙画出来。缺口同理不自动重扫。
        stale: this.forced.has(path.resolve(dir)) || !fresh,
        scanning: false,
        unreadable: index.unreadable || 0
      });
    }
  }

  status() {
    return [...this.parts.values()].map((p) => ({
      dir: p.dir,
      entries: p.index.size,
      stale: p.stale,
      scanning: p.scanning,
      unreadable: p.unreadable || 0
    }));
  }

  lookup(...keys) {
    for (const p of this.parts.values()) {
      const hit = p.index.lookup(...keys);
      if (hit) return hit;
    }
    return null;
  }

  // Load whatever is cached right away, then refresh the stale/missing roots one by one.
  async prepare(dirs, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    const warn = opts.onWarn || (() => {});
    const wanted = [...new Set(dirs.filter(Boolean))];
    for (const dir of wanted) {
      if (!fs.existsSync(dir)) continue;
      const sig = LibraryFiles.rootSig(dir);
      const cached = MediaIndex.load(this.cacheFile(dir), sig);
      // 重新扫描 forces a re-walk even when the root's own mtime is unchanged: a folder
      // added three levels down does not touch the root's timestamp, so a signature test
      // alone can never notice it. The cached index still paints the wall meanwhile.
      const forced = this.forced.has(path.resolve(dir));
      if (cached) {
        this.parts.set(dir, {
          dir, sig, index: cached,
          // 缺口仅作状态提示，避免不可读目录拖慢每次启动；重扫由根签名变化或用户手动触发。
          stale: forced,
          scanning: false,
          unreadable: cached.unreadable || 0
        });
      } else {
        // 签名变了(往根目录里加了新片就会变)。旧索引先顶上,后台重扫完再换,
        // 海报墙不必等整棵网盘树走完才有图。
        const staleIdx = MediaIndex.loadStale(this.cacheFile(dir));
        this.parts.set(dir, { dir, sig, index: staleIdx || new MediaIndex([]), stale: true, scanning: false, unreadable: (staleIdx && staleIdx.unreadable) || 0 });
      }
    }
    // Only drop roots the caller says are no longer wanted. Each library prepares its own dirs,
    // and wiping everything else would leave the library that was prepared first with no index at
    // all — which is how 播放 started failing on a wall that was visibly scanned.
    if (opts.keep) {
      const keep = new Set(opts.keep.filter(Boolean).map((d) => path.resolve(d)));
      for (const dir of [...this.parts.keys()]) {
        if (!keep.has(path.resolve(dir))) this.parts.delete(dir);
      }
    }
    for (const dir of wanted) {
      const part = this.parts.get(dir);
      if (!part) continue;
      this.forced.delete(path.resolve(dir));
      if (!part.stale) continue;
      const wasForced = part.index.size;
      part.scanning = true;
      onProgress({ dir, phase: 'start', scanned: 0, found: 0 });
      try {
        const built = await MediaIndex.build([dir], {
          onProgress: (p) => onProgress({ dir, phase: 'scan', scanned: p.scanned, found: p.found, unreadable: p.unreadable, ms: p.ms })
        });
        part.sig = LibraryFiles.rootSig(dir);
        if (built.errors.length) {
          // 有一段没读到：留在内存里(取条目多的那一份)继续出图。这份索引同样要落盘——
          // 一次云盘抖动不该让整轮遍历作废，否则索引永远停在旧版本，每次启动都从旧索引
          // 开始、再走同步回退。缺口会落盘，但下次启动不会因此自动重扫，只有根签名变化
          // 或用户点「重新扫描」才重走。
          if (built.size > part.index.size) part.index = built;
          part.stale = true;
          part.unreadable = built.errors.length;
          warn(`${dir} 有 ${built.errors.length} 个目录没读到（${built.errors[0].error}），索引已落盘并保持待重扫`);
          try {
            part.sig = LibraryFiles.rootSig(dir);
            part.index.save(this.cacheFile(dir), part.sig, built.errors.length);
          } catch (e) {
            warn(`${dir} 索引落盘失败：${(e && e.message) || e}`);
          }
          // 读到的这一段也要预热：网盘上个别目录读不到是常态，若因此整棵根都不预热，
          // 新海报就永远没有本地副本，每次出图都要现场读网盘。
          if (opts.onIndexed) {
            try {
              await opts.onIndexed(dir, part.index);
            } catch (e) {
              warn(`${dir} 预热失败：${(e && e.message) || e}`);
            }
          }
          onProgress({ dir, phase: 'incomplete', scanned: part.index.size, found: part.index.size, unreadable: built.errors.length });
        } else {
          part.index = built;
          part.stale = false;
          part.unreadable = 0;
          part.index.save(this.cacheFile(dir), part.sig);
          if (opts.onIndexed) {
            try {
              await opts.onIndexed(dir, part.index);
            } catch (e) {
              // 预热失败不影响出图（懒路径会兜住），但它是缓存不热的唯一线索。
              warn(`${dir} 预热失败：${(e && e.message) || e}`);
            }
          }
        }
      } catch (e) {
        onProgress({ dir, phase: 'error', error: String(e && e.message) });
        warn(`${dir} 扫描中断：${(e && e.message) || e}`);
        // 整棵树上一次都是残缺的,中断之后不可能变完整,所以至少保持「有东西没读到」。
        part.stale = true;
        part.unreadable = Math.max(1, part.unreadable || 0);
      }
      part.scanning = false;
      onProgress({ dir, phase: 'done', scanned: part.index.size, found: part.index.size, stale: part.stale, before: wasForced });
    }
    return this;
  }

  invalidate() {
    for (const p of this.parts.values()) {
      p.stale = true;
      this.forced.add(path.resolve(p.dir));
    }
  }
}

// When a library already knows the exact folder of an item (ingested rows store it),
// resolve straight from there instead of waiting on the background walk.
// Exact `<stem>.nfo` first; otherwise the folder's own nfo, preferring one whose stem shares
// the code prefix. His folders rename the sidecars freely, and a strict match silently
// reported "no nfo" for entries that plainly have one.
function pickNfo(names, dir, key) {
  const exact = names.get((key + '.nfo').toLowerCase());
  if (exact) return path.join(dir, exact);
  const nfos = [...names.values()].filter((n) => n.toLowerCase().endsWith('.nfo'));
  if (!nfos.length) return null;
  const prefix = String(key || '').split('-').slice(0, 2).join('-').toLowerCase();
  const lower = String(key || '').toLowerCase();
  const hit =
    nfos.find((n) => prefix && n.toLowerCase().startsWith(prefix)) ||
    // Different scraper renames: take the nfo that shares the most characters with the video.
    (nfos.length
      ? nfos
          .map((n) => {
            const stem = n.toLowerCase().replace(/\.nfo$/, '');
            let shared = 0;
            while (shared < stem.length && shared < lower.length && stem[shared] === lower[shared]) shared++;
            return { n, shared };
          })
          .sort((a, b) => b.shared - a.shared)[0].n
      : null);
  return hit ? path.join(dir, hit) : null;
}

function entryFromNames(dir, names, base) {
  const stem = String(base || '').replace(/\.[a-z0-9]+$/i, '');
  const videos = [...names.values()].filter((n) => VIDEO_EXT.has(path.extname(n).toLowerCase())).sort((a, b) => a.localeCompare(b, 'en'));
  const key = stem || path.basename(videos[0] || '');
  const video = videos.length ? path.join(dir, (videos.find((v) => path.basename(v, path.extname(v)) === key) || videos[0])) : null;
  return {
    dir,
    name: key,
    video,
    parts: videos.map((v) => path.basename(v, path.extname(v))),
    poster: sidecar(names, dir, key, 'poster'),
    fanart: sidecar(names, dir, key, 'fanart'),
    thumb: sidecar(names, dir, key, 'thumb'),
    nfo: pickNfo(names, dir, key)
  };
}

function resolveDir(dir, base) {
  if (!dir || !fs.existsSync(dir)) return null;
  let names;
  try {
    names = new Map(fs.readdirSync(dir).map((n) => [n.toLowerCase(), n]));
  } catch {
    return null;
  }
  return entryFromNames(dir, names, base);
}

// 索引外条目在云盘上解析时走这条：同样的目录内容，异步读，主进程不会被
// 一次 200ms~1.4s 的 readdir 冻住（首屏 32 条就是约 6 秒的事件循环阻塞）。
async function resolveDirAsync(dir, base) {
  if (!dir) return null;
  let items;
  try {
    items = await fsp.readdir(dir);
  } catch {
    return null;
  }
  return entryFromNames(dir, new Map(items.map((n) => [n.toLowerCase(), n])), base);
}

module.exports = { MediaIndex, LibraryFiles, resolveDir, resolveDirAsync, VIDEO_EXT };
