'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, protocol, screen, shell, globalShortcut, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { Db } = require('./db');
const { Media } = require('./media');
const { ActorStore } = require('./actors');
const { CoverStore } = require('./covers');
const { LibraryFiles, resolveDir, VIDEO_EXT } = require('./scan');
const libs = require('./libs');
const idols = require('./idols');
const entities = require('./entities');
const { JavDB, wikiActress, fetchImage, parseActorRef, avatarFor, BASE: BASE_JAVDB } = require('./javdb');
const { readNfo, writeNfo, createNfo } = require('./nfo');
const { ImgCache, SLOW_READ_MS } = require('./imgcache');
const { collectFromChrome } = require('./chromecookie');

const SCHEME = 'shelfimg';
const ROOT = path.resolve(__dirname, '..');

// Any distributed form — the folder you zip and hand to someone, or the single-file
// launcher — keeps its settings beside the exe, because that is where a person looks.
// The launcher also sets PORTABLE_EXECUTABLE_DIR; a distribution folder is detected by
// the resources/app next to its exe.
const EXE_DIR = path.dirname(app.getPath('exe'));
const PORTABLE_DIR =
  process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged && fs.existsSync(path.join(EXE_DIR, 'resources', 'app')) ? EXE_DIR : '');

// --user-data lets a second instance (or a test run) keep its own profile.
const SMOKE = process.env.SHELF_SMOKE || process.argv.includes('--smoke') || process.argv.includes('--smoke-reopen');
const SMOKE_REOPEN = process.argv.includes('--smoke-reopen');
// A short live crawl against the real site, so scraper fixes can be verified without the UI suite.
const SMOKE_CRAWL = process.argv.includes('--smoke-crawl');
// Restart round trip for the tray entry; it always gets its own profile dir below.
const SMOKE_RESTART = process.argv.includes('--smoke-restart');
const PROFILE_FLAG = process.argv.find((a) => a.startsWith('--user-data='));
let PROFILE_DIR = PROFILE_FLAG ? path.resolve(PROFILE_FLAG.slice('--user-data='.length)) : '';
// A smoke run must always start from an empty profile, otherwise the second invocation
// inherits the first one's libraries and never exercises the setup screen. The reopen
// check is the opposite: it deliberately reuses the profile the full run left behind.
if (!PROFILE_FLAG && SMOKE && !SMOKE_REOPEN) {
  PROFILE_DIR = path.join(ROOT, 'out', 'smoke-profile');
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
}
// The restart check normally runs against the profile the UI suite left behind, so it proves
// the libraries survive a relaunch. Without an explicit --user-data it gets a throwaway one,
// and any stale probe from an earlier attempt is cleared so it cannot fake a match.
if (SMOKE_RESTART && !PROFILE_FLAG) {
  PROFILE_DIR = path.join(ROOT, 'out', 'restart-profile');
  fs.rmSync(path.join(PROFILE_DIR, 'restart-probe.json'), { force: true });
}
if (PROFILE_DIR) app.setPath('userData', PROFILE_DIR);
else if (PORTABLE_DIR) app.setPath('userData', path.join(PORTABLE_DIR, 'JavShelf-data'));

const CONFIG_FILE = PROFILE_DIR
  ? path.join(PROFILE_DIR, 'config.json')
  : PORTABLE_DIR
    ? path.join(PORTABLE_DIR, 'config.json')
    : path.join(ROOT, 'config.json');

const DEFAULTS = {
  // Deliberately empty: a fresh install shows the setup screen rather than silently
  // adopting whatever the previous program had configured.
  dataDir: '',
  libraries: [],
  activeLibrary: '',
  playerPath: '',
  proxy: '',
  // 900ms: paging faster than this gets 502s from JavDB's edge rather than a block page.
  javdbThrottle: 900,
  // Pasting a browser cookie makes JavDB serve the logged-in actress page.
  javdbCookie: '',
  uiScale: 1,
  window: { width: 1400, height: 900 },
  sort: { key: 'movie_日期', dir: 'desc' },
  appearance: {
    theme: 'dark',
    radius: 8,
    badgeSubtitle: false,
    badgeResolution: true,
    badgeCount: true,
    listCategory: true,
    listSeries: true,
    staticLoad: true,
    minWidth: 1080
  },
  playback: { player: 'system', loop: true, statFile: false },
  shortcuts: { hotkey: 'F10', tray: true, startupTip: true, autostart: false },
  display: {
    items: { pageSize: 120, perRow: 0, waterfall: false, titleLines: 2, tagLines: 2, actorLines: 2, hideSeries: false, hideActors: false, hideTags: false, hideActions: false, fullHeart: false },
    actor: { pageSize: 90, perRow: 0, sort: 'count', sortDir: 'desc' },
    studio: { pageSize: 120, perRow: 0, sort: 'count', sortDir: 'desc' },
    series: { pageSize: 120, perRow: 0, sort: 'count', sortDir: 'desc' },
    tag: { pageSize: 120, perRow: 0, sort: 'count', sortDir: 'desc' }
  }
};

// Each display tab falls back to the shape above, so adding an option later cannot
// leave an old config file with undefined values.
function mergeDisplay(raw) {
  const out = {};
  for (const [view, base] of Object.entries(DEFAULTS.display)) {
    const stored = (raw && raw[view] && raw[view].sort) || {};
    const merged = { ...base, ...((raw && raw[view]) || {}) };
    // A view either sorts by one key (a string) or by a {key,dir} pair. Spreading a string
    // like 'count' would split it into {0:'c',1:'o',...}, so the two kinds never mix.
    merged.sort = typeof base.sort === 'string' ? (typeof stored === 'string' ? stored : base.sort) : { ...base.sort, ...stored };
    out[view] = merged;
  }
  return out;
}

let cfg = loadConfig();
let win = null;
let tray = null;
let dbs = new Map();      // library name -> Db, for every enabled library
let media = null;
let actors = null;
let covers = null;        // hand-picked per-title covers, ours until he mirrors them
let files = null;
let gridCache = null;
let libOf = new Map();    // 编码 -> library name, so a write lands in the right database
let ingestJob = null;

// A small ring buffer the 日志 button reads. Handlers used to swallow their failures into
// a status toast, which left no trail when something went wrong an hour later.
const appLog = [];
// Local wall clock, not toISOString(): the panel is there so he can line a message up with
// what he saw at the time, and a UTC stamp reads eight hours off on his machine.
const p2 = (n) => String(n).padStart(2, '0');
function stamp(d) {
  const t = d || new Date();
  return `${p2(t.getHours())}:${p2(t.getMinutes())}:${p2(t.getSeconds())}`;
}
function log(level, msg) {
  const e = { t: stamp(), level: String(level), msg: String(msg).slice(0, 500) };
  appLog.push(e);
  if (appLog.length > 500) appLog.shift();
  if (win && !win.isDestroyed()) win.webContents.send('log:entry', e);
  return e;
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return {
      ...DEFAULTS,
      ...raw,
      appearance: { ...DEFAULTS.appearance, ...(raw.appearance || {}) },
      playback: { ...DEFAULTS.playback, ...(raw.playback || {}) },
      display: mergeDisplay(raw.display),
      shortcuts: { ...DEFAULTS.shortcuts, ...(raw.shortcuts || {}) }
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

function saveConfig(next) {
  cfg = next;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, cache: true, corsEnabled: true }
  }
]);

// ---------------------------------------------------------------- libraries

function libraryList() {
  return libs.normalize(cfg.libraries || []);
}

function activeLibrary() {
  const list = libraryList();
  return list.find((l) => l.name === cfg.activeLibrary) || list[0] || null;
}

function shelfDbPath() {
  return path.join(app.getPath('userData'), 'JavShelf.db');
}

// Filename the predecessor program used for its own database. It is a fact about his disk,
// not a name this app carries: opened read-only to seed libraries and to read rows from.
const LEGACY_DB_FILE = 'ALEX.db';

function legacyDbPath() {
  return cfg.dataDir ? path.join(cfg.dataDir, LEGACY_DB_FILE) : '';
}

// A named library that isn't open is an error, not a cue to write into whichever database
// happens to be first: with two libraries enabled, falling back used to send 收藏/已看 toggles
// and deletions to the wrong one. Only a caller that genuinely has no name (single-library
// setup, an unresolvable code) gets the first handle.
function requireDb(libName) {
  const name = libName === undefined || libName === null ? '' : String(libName);
  if (name) {
    const hit = dbs.get(name);
    if (!hit) throw new Error('媒体库「' + name + '」没有打开，先在设置里启用它');
    return hit;
  }
  const only = dbs.values().next().value || null;
  if (!only) throw new Error('还没有可用的媒体库，先在左侧添加一个库');
  return only;
}

function requireActors() {
  if (!actors) throw new Error('程序还在启动中，稍等再试');
  return actors;
}

// Every enabled library contributes rows to one wall, so each row carries the library it
// came from and writes go back to the right database.
// Avatars are ours, not the old program's: they live under 数据目录 when he points us at one,
// and under our own data folder otherwise, so downloading a photo never needs setup first.
function boot() {
  const all = libraryList();
  const active = all.filter((l) => l.enabled !== false);
  dbs = new Map();
  media = new Media(cfg.dataDir || app.getPath('userData'));
  files = new LibraryFiles(path.join(app.getPath('userData'), 'scan'));
  actors = new ActorStore(cfg.dataDir || app.getPath('userData'), media);
  // Hand-picked covers hang off the same base as the avatars: with no 数据目录 they still
  // have somewhere to live, so the feature works on a fresh install.
  covers = new CoverStore(cfg.dataDir || app.getPath('userData'), shelfDbPath());
  if (covers.loadError) log('warn', '自定义封面索引未载入，海报墙暂时显示文件夹里的那张：' + covers.loadError);
  gridCache = null;
  forgetEntries();
  const rows = [];
  let cols = null;
  for (const lib of active) {
    const file = libs.dbFileFor(lib, legacyDbPath(), shelfDbPath());
    if (lib.store === 'shelf') libs.ensureShelfTable(file, lib);
    if (!file || !fs.existsSync(file)) {
      lib.error = file ? '找不到数据库文件：' + file : '这个库的数据文件还没准备好，先在设置里填好数据目录';
      continue;
    }
    const handle = new Db(file, libs.tableOf(lib));
    dbs.set(lib.name, handle);
    for (const dir of lib.dirs) media.addRoot(dir);
    const data = handle.loadGrid();
    cols = cols || data.cols;
    for (const r of data.rows) {
      r._lib = lib.name;
      rows.push(r);
    }
    startScan(lib);
  }
  cfg.activeLibrary = active.some((l) => l.name === cfg.activeLibrary) ? cfg.activeLibrary : (active[0] && active[0].name) || '';
  gridCache = { cols: cols || [], rows };
  libOf = new Map(rows.map((r) => [String(r.movie_编码), r._lib]));
  // 片商/系列 are derived from whatever is currently on the wall, so toggling a library
  // off removes its entities and turning it back on restores them.
  try {
    for (const kind of ['studio', 'series']) entities.rebuild(shelfDbPath(), kind, rows);
  } catch (e) {
    // A derived index must never block startup — but silently skipping it leaves the 片商/系列
    // walls showing yesterday's library, so at least say so once.
    log('warn', '片商/系列索引未重建：' + (e && e.message));
  }
  // The measurements came over from the old program, which stored 罩杯 as an enum index, and an
  // earlier build of this one had nowhere to put 出身地 so it wrote it into 中文名. Both are
  // settled here, once, before anything reads the wall.
  try {
    if (fs.existsSync(shelfDbPath())) {
      const fixed = idols.repairLegacy(shelfDbPath());
      if (fixed.cups || fixed.places)
        log('info', `女优资料修正：罩杯改成字母 ${fixed.cups} 条，出身地从中文名迁出 ${fixed.places} 条`);
    }
  } catch (e) {
    log('warn', `女优资料修正跳过: ${e.message}`);
  }
  return { all, active };
}

// Locating files is cheap once cached, but a cold walk of a cloud-mounted root is not, so
// it runs in the background and the wall keeps working with whatever is already indexed.
// Several libraries can be enabled at once and each one scans its own roots, so the prepare
// call is told which roots the whole setup still wants — otherwise the second library would
// drop the first one's index and nothing in it could be played any more.
function scanRootsWanted() {
  const dirs = [];
  for (const lib of libraryList()) if (lib.enabled !== false) dirs.push(...((lib && lib.dirs) || []));
  return dirs;
}

function startScan(lib) {
  const dirs = (lib && lib.dirs) || [];
  if (!dirs.length || !files) return;
  const started = Date.now();
  files
    .prepare(dirs, {
      keep: scanRootsWanted(),
      onProgress: (p) => {
        if (win && !win.isDestroyed()) win.webContents.send('scan:progress', { ...p, library: lib.name, ms: Date.now() - started });
      },
      onIndexed: (dir, index) => warmRoot(dir, index, lib.name),
      onWarn: (msg) => log('warn', msg)
    })
    .then(() => {
      // 缓存留着不动:预热已经按 size/mtime 补了新的、换了改的、删了没的。
      // 只有「哪个文件在哪个文件夹」这份会话备忘需要重猜。
      forgetEntries();
      if (win && !win.isDestroyed()) win.webContents.send('scan:done', { library: lib.name, entries: files.status() });
    })
    .catch((e) => {
      // Without this the wall just never gets pictures and nothing says why.
      log('warn', `扫描 ${lib.name} 失败：${(e && e.message) || e}`);
      if (win && !win.isDestroyed()) win.webContents.send('scan:done', { library: lib.name, error: String((e && e.message) || e), entries: files.status() });
    });
}

// Re-scan 之后把这个根的新条目灌进图片缓存;本地快盘由 warm 内部的探测自己放弃,
// 所以每个根都可以无脑调一次。进度借用 scan:progress 的 warm 阶段。
async function warmRoot(dir, index, libName) {
  const list = [];
  for (const e of index.entries()) {
    for (const k of ['poster', 'fanart', 'thumb', 'nfo']) if (e[k]) list.push(e[k]);
  }
  if (!list.length) return;
  let lastSend = 0;
  const res = await imgCache.warm(list, {
    ownerPrefix: path.resolve(dir) + path.sep,
    onProgress: (done, total) => {
      if (done !== total && done - lastSend < 25) return;
      lastSend = done;
      if (win && !win.isDestroyed()) {
        win.webContents.send('scan:progress', { phase: 'warm', mode: 'warm', library: libName, scanned: done, found: total, current: String(dir) });
      }
    }
  });
  if (!res.skippedLocal && (res.copied || res.dropped || res.pruned)) {
    log('info', `缓存预热 ${dir}：补 ${res.copied} · 未变 ${res.skipped} · 清除 ${res.dropped + res.pruned}（${(res.ms / 1000).toFixed(1)} s）`);
  }
  return res;
}

// ------------------------------------------------------------------ ingest

// mode: full 覆盖刷新 · append 新增刷新 · delta 删改刷新
function runIngest(libName, mode) {
  const lib = libraryList().find((l) => l.name === String(libName));
  if (!lib) return Promise.reject(new Error('没有这个库'));
  if (!lib.dirs.length) return Promise.reject(new Error('这个库还没有添加文件夹'));
  if (lib.store !== 'shelf') return Promise.reject(new Error('来自旧程序的库已有自己的数据，只做定位不重建'));
  const file = shelfDbPath();
  libs.ensureShelfTable(file, lib);
  // 两个入库同时跑会在同一张表上互相盖写,而且「停止」只能按住后一个。
  if (ingestJob) return Promise.reject(new Error('已经有一个入库在跑：等它结束，或先按停止'));
  const t0 = Date.now();
  const job = { lib: lib.name, mode, cancelled: false, started: t0 };
  ingestJob = job;
  const { Ingestor } = require('./ingest');
  return new Ingestor({
    dbFile: file,
    table: libs.tableOf(lib),
    dirs: lib.dirs,
    // 闭包认自己这份 job：全局 ingestJob 会被后一次运行换掉,拿它判断等于让前一个作业听别人的话。
    shouldStop: () => job.cancelled,
    onProgress: (p) => {
      if (win && !win.isDestroyed()) win.webContents.send('ingest:progress', { library: lib.name, mode, ms: Date.now() - t0, ...p });
    }
  }).run(mode).then((res) => {
    if (ingestJob === job) ingestJob = null;
    boot();
    if (res.stopped) log('warn', `入库已停止（${lib.name} · ${mode}）：${res.scanned} 个条目里写了 ${res.added + res.updated} 行，删改刷新没有执行`);
    else if (res.shielded) log('warn', `删改刷新（${lib.name}）跳过 ${res.shielded} 行：它们所在的目录这次没读到，不算消失`);
    if (win && !win.isDestroyed()) win.webContents.send('ingest:done', { library: lib.name, mode, ...res });
    return res;
  }).catch((e) => {
    if (ingestJob === job) ingestJob = null;
    throw e;
  });
}

// ---------------------------------------------------------------- images

// ---------------------------------------------------------------- 图片本地缓存
// 策略在 main/imgcache.js:慢盘(网盘挂载)的海报与 nfo 靠「扫描完成时预热 + size/mtime 校验」
// 维护本地副本,刷新不再整目录作废——v1.5.5 的清仓正是「每次刷新都卡」的根源(X: 实测
// 单张海报 ~2.4 s,而 stat ~0 ms)。协议层命中缓存直接出图,不做远端校验。
const imgCache = new ImgCache(path.join(app.getPath('userData'), 'imgcache'));

function imageResponse(buf, rel, mtime) {
  const ext = (path.extname(rel).slice(1) || 'jpeg').toLowerCase();
  // Avatars are overwritten in place (one stable name per performer), so an immutable
  // copy would keep painting the picture from before he replaced it — the browser and this
  // process both cache by URL. Posters and hand-picked covers get a new name whenever their
  // bytes change, so they keep the year of cache that makes scrolling cheap.
  const pinned = !VOLATILE.test(String(rel || ''));
  return new Response(buf, {
    headers: {
      'Content-Type': 'image/' + (ext === 'jpg' ? 'jpeg' : ext),
      'Content-Length': String(buf.length),
      'Cache-Control': pinned ? 'public, max-age=31536000, immutable' : 'no-cache',
      ETag: '"' + Number(mtime || 0).toString(36) + '-' + buf.length.toString(36) + '"'
    }
  });
}

// rels this app replaces in place. A warm copy of one of those outlives the write and paints
// the old bytes forever, and they sit on our own disk anyway — so they skip the cache entirely.
const VOLATILE = /^actor\//;

function registerImageProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      rel = url.pathname; // a literal % in a scanned filename is not valid percent-encoding
    }
    rel = rel.replace(/^\//, '');
    let abs;
    try {
      abs = media.resolve(rel);
    } catch {
      return new Response('forbidden', { status: 403 });
    }
    const volatile = VOLATILE.test(rel);
    const warm = volatile ? null : imgCache.hit(abs);
    if (warm) return imageResponse(warm.buf, rel, warm.mtime);
    // 缓存没命中就现场读原盘:这一步在网盘挂载上实测 ~2.4 s/张,必须走异步,
    // 否则协议层会把整个主进程(连同所有正在出图的请求)卡住。
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      return new Response('not found', { status: 404 });
    }
    if (!st.isFile()) return new Response('not found', { status: 404 });
    let buf;
    const t0 = Date.now();
    try {
      buf = await fsp.readFile(abs);
    } catch {
      return new Response('not found', { status: 404 });
    }
    const ms = Date.now() - t0;
    // 预热之外的兜底:只有真慢的读取才值得留一份本地副本,本地快盘复制了也没收益。
    if (!volatile && ms >= SLOW_READ_MS) {
      try {
        imgCache.write(abs, buf, st);
      } catch {
        /* a failed cache write must never break the picture */
      }
    }
    return imageResponse(buf, rel, st.mtimeMs);
  });
}

// Resolve a batch of codes against the scan index. Only the visible rows ask, so this
// stays cheap even with 7000 titles, and the answer is a `r<n>/` reference the image
// protocol can serve without ever learning an absolute path from the page.
function resolveEntries(codes) {
  const out = {};
  if (!files || !codes.length) return out;
  const byLib = new Map();
  for (const raw of codes) {
    const code = String(raw);
    const lib = libOf.get(code) || cfg.activeLibrary;
    if (!byLib.has(lib)) byLib.set(lib, []);
    byLib.get(lib).push(code);
  }
  for (const [lib, list] of byLib) {
    const handle = dbs.get(lib);
    if (!handle) continue;
    const meta = handle.fileMeta(list);
    for (const code of list) {
      const row = meta.get(code);
      if (row) row._lib = lib;
      out[code] = entryFor(row, code);
    }
  }
  return out;
}

// Some rows point at a parent folder (an actor directory, or an outer wrapper). Walk down
// until the folder that actually holds the video is found, so 打开目录 and nfo writes land on
// the leaf folder instead of a parent that has no nfo in it.
function deepestEntryDir(dir, code) {
  let cur = String(dir || '');
  const want = String(code || '').toUpperCase();
  for (let depth = 0; depth < 3; depth++) {
    let items;
    try {
      items = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return cur;
    }
    const holdsVideo = items.some((e) => !e.isDirectory() && VIDEO_EXT.has(path.extname(e.name).toLowerCase()));
    if (holdsVideo) return cur;
    const subs = items.filter((e) => e.isDirectory()).map((e) => path.join(cur, e.name));
    if (!subs.length) return cur;
    const byCode = want ? subs.find((d) => path.basename(d).toUpperCase().includes(want)) : null;
    cur = byCode || (subs.length === 1 ? subs[0] : cur);
    if (!byCode && subs.length > 1) return cur;
  }
  return cur;
}

// V8 parses /[\/]/ in a way that does not match a backslash, so a Windows path failed this
// test and the exact stored folder was never used. Test the two characters explicitly.
function isAbsPath(s) {
  const t = String(s || '');
  return t.includes(String.fromCharCode(92)) || t.includes('/');
}

// Resolving a card means touching its folder. On a cloud-mounted drive (his X:) every one of
// those calls is a network round trip, and the wall asks for a batch on every render and every
// scroll — so results are memoised for the session and the extra directory walk is skipped when
// the first attempt already found the files. Cleared whenever the library is re-scanned.
const entryCache = new Map();
function forgetEntries() {
  entryCache.clear();
}
// One title's cover just changed, so drop only that row's memo. Clearing the whole cache would
// send every visible card back through resolveDir, which on an unindexed root is a synchronous
// readdir per card (~200 ms on the cloud mount).
function forgetEntry(lib, code) {
  const c = String(code);
  for (const k of new Set([String(lib || ''), String(cfg.activeLibrary || ''), ''])) {
    entryCache.delete(k + '\u0000' + c);
  }
}

function entryFor(row, code) {
  const lib = (row && row._lib) || '';
  const ck = lib + '\u0000' + String(code);
  const memo = entryCache.get(ck);
  if (memo) return memo;
  const entry = entryForUncached(row, code);
  if (entry) entryCache.set(ck, entry);
  return entry;
}

function entryForUncached(row, code) {
  // 先查内存里的扫描索引:它一次扫盘就答完所有行,而逐行 resolveDir 会在网盘挂载上
  // 同步 readdir(实测 ~200 ms/次 × 每页 120 行 = 主进程冻结半分钟,正是「开墙卡」)。
  // 索引没有这条(新入库/根目录还没扫到)才回退到行里存的目录。
  let hit = files.lookup(videoBaseName(row && row.file_路径), code, folderHint(code, row));
  if (!hit) {
    const stored = String((row && row.only_code) || '');
    if (isAbsPath(stored)) hit = resolveDir(stored, videoBaseName(row.file_路径));
  }
  if (!hit) return null;
  // Only descend when this folder clearly is not the one holding the video: the walk costs up to
  // three more directory reads, and the stored folder is usually already the leaf.
  if (!hit.video && !hit.nfo) {
    const leaf = deepestEntryDir(hit.dir, code);
    if (leaf && leaf !== hit.dir) hit = resolveDir(leaf, videoBaseName(row && row.file_路径)) || hit;
  }
  const entry = {
    lib: (row && row._lib) || cfg.activeLibrary,
    dir: hit.dir,
    video: hit.video,
    name: hit.name,
    poster: media.relFor(hit.poster || ''),
    fanart: media.relFor(hit.fanart || ''),
    thumb: media.relFor(hit.thumb || ''),
    nfo: media.relFor(hit.nfo || '')
  };
  // A cover he picked by hand wins the picture. The folder's own sidecar is kept in the entry
  // as well, because importing again with 「同时写入影片文件夹」 has to know what it replaces.
  const custom = covers ? covers.relOf(entry.lib, code) : '';
  if (custom) {
    entry.folderPoster = entry.poster;
    entry.poster = custom;
    entry.custom = true;
  }
  return entry;
}

// entryFor speaks the renderer's language (r<n>/ references), but anything that touches the
// filesystem needs a real path — passing the reference straight to fs lands it relative to the
// app folder and fails with ENOENT. A reference that no longer resolves is not an error here;
// it just means "no nfo was seen", so callers fall through to their create path.
function nfoPathFor(entry) {
  if (!entry || !entry.nfo) return '';
  try {
    return media.resolve(entry.nfo);
  } catch {
    return '';
  }
}

function videoBaseName(json) {
  try {
    const parsed = JSON.parse(String(json || '{}'));
    const group = parsed['视频文件'] || {};
    const first = Object.values(group)[0];
    // The index is keyed by the file name without its extension, so drop 扩展名 here.
    if (first && first['文件名']) return String(first['文件名']).trim();
  } catch {
    /* older rows store plain text here */
  }
  return '';
}

function folderHint(code, row) {
  const title = String((row && row.movie_片名) || '');
  return title ? code + ' ' + title.slice(0, 24) : '';
}

// ---------------------------------------------------------------- window

function applyAppearance() {
  if (!win || win.isDestroyed()) return;
  win.setMinimumSize(cfg.appearance.minWidth || 900, 560);
  win.webContents.setZoomFactor(cfg.uiScale || 1);
  win.webContents.send('app:appearance', { ...cfg.appearance, uiScale: cfg.uiScale });
}

function appIcon() {
  const img = nativeImage.createFromPath(path.join(ROOT, 'build', 'icon.png'));
  return img.isEmpty() ? null : img;
}

function createWindow() {
  const primary = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: cfg.window.width,
    height: cfg.window.height,
    x: cfg.window.x,
    y: cfg.window.y,
    minWidth: cfg.appearance.minWidth || 900,
    minHeight: 560,
    // Without an explicit icon the taskbar falls back to whatever the host exe carries,
    // which for an unpacked app folder is the stock Electron one.
    icon: appIcon(),
    backgroundColor: cfg.appearance.theme === 'dark' ? '#14171c' : '#f7f8fa',
    show: false,
    autoHideMenuBar: true,
    title: 'JavShelf',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });
  win.webContents.on('dom-ready', () => applyAppearance());
  // 界面进程没了、或者卡住不动，都必须留下一行原因。以前这两件事只会让窗口跟着关掉、
  // 程序以 0 退出：回归跑到一半没有输出、日志停在上一步，看不出是崩了还是被谁关了。
  win.webContents.on('render-process-gone', (_e, d) => {
    log('error', '界面进程退出：' + ((d && d.reason) || '未知') + '（exitCode ' + (d && d.exitCode) + '）');
    if (SMOKE) {
      process.stdout.write('SMOKE_FAIL render-process-gone ' + JSON.stringify(d) + '\n');
      process.exitCode = 1;
      app.quit();
    }
  });
  win.webContents.on('unresponsive', () => log('warn', '界面无响应'));
  win.webContents.on('responsive', () => log('info', '界面恢复响应'));
  win.once('ready-to-show', () => {
    // A hidden/occluded window throttles rAF away, which hangs any smoke step that waits
    // on scrolling or animation. Keep painting in the background instead of stealing the
    // screen with an always-on-top test window.
    if (SMOKE) win.setBackgroundThrottling(false);
    win.show();
  });
  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));

  const persist = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    saveConfig({
      ...cfg,
      window: { width: b.width, height: b.height, x: b.x, y: b.y, display: primary.id, scale: primary.scaleFactor }
    });
  };
  win.on('close', (e) => {
    // Minimise-to-tray only intercepts the close button; quitting always gets through.
    if (cfg.shortcuts.tray && tray && !app.isQuitting) {
      e.preventDefault();
      win.hide();
      return;
    }
    persist();
  });
  win.on('resize', () => win.webContents.send('app:metrics', metrics()));
  win.on('restore', () => applyAppearance());
}

// A function rather than a literal inside setContextMenu: Tray has no getContextMenu()
// in this Electron, so this is the only way the regression can read back what the
// background icon actually offers.
function trayTemplate() {
  return [
    { label: '显示窗口', click: () => (win.show(), win.focus()) },
    // 冷启动才能把「本次会话里已经读进内存的东西」换掉：扫描索引、封面清单、抓取连接、
    // 界面本身。给它一个不用自己找进程名的入口，而不是让他去任务管理器结束任务。
    { label: '重启软件', click: () => restart() },
    { type: 'separator' },
    { label: '退出', click: () => quit() }
  ];
}

function makeTray() {
  if (tray || !cfg.shortcuts.tray) return;
  const base = appIcon();
  if (!base) return;
  tray = new Tray(base.resize({ width: 16, height: 16 }));
  tray.setToolTip('JavShelf 媒体库');
  tray.on('click', () => (win.isVisible() ? win.focus() : (win.show(), win.focus())));
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
}

// relaunch() spawns process.execPath plus these args *after* this process exits, so the
// source-run case keeps its --user-data (a restart that landed on a fresh empty profile
// would look like the library had been deleted).
function restart() {
  try {
    app.relaunch({ args: process.argv.slice(1) });
  } catch (e) {
    log('error', '重启失败：' + ((e && e.message) || e));
    return;
  }
  log('info', '按托盘「重启软件」，正在重启');
  quit();
}

// --smoke-restart: the round trip the tray entry promises. The first process hides a nonce
// in its own profile and restarts exactly the way the menu does; the second one reads the
// nonce back and reports its command line and boot state. Results go to a file, not stdout,
// because a relaunched process is detached and may not inherit the pipe. The env marker is
// inherited by relaunch, so a relaunch that loops can still only loop once.
async function restartRoundTrip() {
  const dir = app.getPath('userData');
  const probe = path.join(dir, 'restart-probe.json');
  const result = path.join(dir, 'restart-result.json');
  if (!process.env.SHELF_RESTART_CHILD) {
    fs.rmSync(result, { force: true });
    const nonce = 'r' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    fs.writeFileSync(probe, JSON.stringify({ nonce }));
    process.env.SHELF_RESTART_CHILD = nonce;
    restart();
    return;
  }
  const want = process.env.SHELF_RESTART_CHILD;
  let have = '';
  try {
    have = String(JSON.parse(fs.readFileSync(probe, 'utf8')).nonce || '');
  } catch {
    /* reported as a mismatch below */
  }
  let booted = false;
  for (let i = 0; i < 60 && !booted; i++) {
    booted = await win.webContents.executeJavaScript('!!window.__booted', true);
    if (!booted) await new Promise((r) => setTimeout(r, 250));
  }
  fs.writeFileSync(
    result,
    JSON.stringify({
      matched: !!have && have === want,
      booted,
      userData: dir,
      libraries: (cfg.libraries || []).length,
      argv: process.argv.slice(1)
    })
  );
  fs.rmSync(probe, { force: true });
  quit();
}

function quit() {
  app.isQuitting = true;
  app.quit();
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  if (!cfg.shortcuts.hotkey) return;
  try {
    globalShortcut.register(cfg.shortcuts.hotkey, () => {
      if (!win || win.isDestroyed()) return;
      if (win.isVisible() && win.isFocused()) win.hide();
      else {
        win.show();
        win.focus();
      }
    });
  } catch {
    /* an unregistered or occupied function key is not worth crashing over */
  }
}

function metrics() {
  const d = screen.getDisplayMatching(win ? win.getBounds() : screen.getPrimaryDisplay().bounds);
  return { scaleFactor: d.scaleFactor, bounds: d.bounds, workArea: d.workArea };
}

// ---------------------------------------------------------------- IPC

function publicConfig() {
  const active = activeLibrary();
  return {
    dataDir: cfg.dataDir,
    playerPath: cfg.playerPath,
    proxy: cfg.proxy,
    uiScale: cfg.uiScale,
    sort: cfg.sort,
    appearance: cfg.appearance,
    playback: cfg.playback,
    shortcuts: cfg.shortcuts,
    display: cfg.display,
    libraries: libraryList(),
    activeLibrary: active ? active.name : '',
    scan: files ? files.status() : [],
    config: { file: CONFIG_FILE, userData: app.getPath('userData') }
  };
}

ipcMain.handle('app:metrics', () => ({ ...metrics(), config: publicConfig() }));
ipcMain.handle('app:bootInfo', () => {
  const t0 = Date.now();
  boot();
  const first = activeLibrary();
  return {
    rows: gridCache.rows.length,
    cols: gridCache.cols,
    ms: Date.now() - t0,
    dbFile: first ? (dbs.get(first.name) || {}).file : null,
    table: first ? (dbs.get(first.name) || {}).table : null,
    library: first,
    libraries: publicConfig().libraries,
    needsSetup: dbs.size === 0,
    config: publicConfig()
  };
});

ipcMain.handle('settings:get', () => publicConfig());
ipcMain.handle('settings:set', (_e, patch) => {
  const next = {
    ...cfg,
    ...patch,
    appearance: { ...cfg.appearance, ...(patch.appearance || {}) },
    playback: { ...cfg.playback, ...(patch.playback || {}) },
    shortcuts: { ...cfg.shortcuts, ...(patch.shortcuts || {}) },
    display: patch.display ? mergeDisplay({ ...cfg.display, ...patch.display }) : cfg.display,
    window: { ...cfg.window, ...(patch.window || {}) }
  };
  const dataChanged = next.dataDir !== cfg.dataDir || next.activeLibrary !== cfg.activeLibrary;
  saveConfig(next);
  applyAppearance();
  makeTray();
  registerHotkey();
  app.setLoginItemSettings({ openAtLogin: !!next.shortcuts.autostart });
  if (dataChanged) {
    boot();
    if (win) win.webContents.reload();
  }
  return publicConfig();
});

// ------------------------------------------------------------- library CRUD

// Library changes rebuild the in-process handles and let the renderer refetch rows —
// reloading the whole window would throw away the scan progress it is showing.
ipcMain.handle('lib:use', (_e, name) => {
  const hit = libraryList().find((l) => l.name === String(name));
  if (!hit) throw new Error('没有这个库');
  saveConfig({ ...cfg, activeLibrary: hit.name });
  boot();
  return publicConfig();
});

ipcMain.handle('lib:enable', (_e, { name, on }) => {
  const list = libraryList();
  const hit = list.find((l) => l.name === String(name));
  if (!hit) throw new Error('没有这个库');
  hit.enabled = !!on;
  saveConfig({ ...cfg, libraries: list });
  boot();
  return publicConfig();
});

ipcMain.handle('lib:save', (_e, lib) => {
  const clean = libs.normalize([lib])[0];
  if (!clean) throw new Error('库名不合法');
  const rest = libraryList().filter((l) => l.name !== clean.name);
  const next = [...rest, clean];
  saveConfig({
    ...cfg,
    libraries: next,
    activeLibrary: cfg.activeLibrary === lib.name ? clean.name : cfg.activeLibrary || clean.name
  });
  boot();
  return publicConfig();
});

ipcMain.handle('lib:remove', (_e, name) => {
  const list = libraryList();
  if (list.length <= 1) throw new Error('至少要保留一个库');
  const next = list.filter((l) => l.name !== String(name));
  saveConfig({ ...cfg, libraries: next, activeLibrary: cfg.activeLibrary === name ? next[0].name : cfg.activeLibrary });
  boot();
  return publicConfig();
});

// Opt-in only: a fresh install starts empty, and this is how someone migrating from the
// old program pulls its library list over.
ipcMain.handle('lib:importLegacy', () => {
  if (!cfg.dataDir) throw new Error('先在设置里填好数据目录');
  const found = libs.seedFromLegacyDb(legacyDbPath());
  if (!found.length) throw new Error('没在这个数据目录里找到旧程序的库定义');
  const have = new Set(libraryList().map((l) => l.name));
  const next = [...libraryList(), ...found.filter((l) => !have.has(l.name))];
  saveConfig({ ...cfg, libraries: next, activeLibrary: cfg.activeLibrary || next[0].name });
  boot();
  return publicConfig();
});

ipcMain.handle('scan:rescan', () => {
  if (files) files.invalidate();
  for (const lib of libraryList()) if (lib.enabled !== false) startScan(lib);
  return true;
});

ipcMain.handle('ingest:run', (_e, { library, mode }) => runIngest(library, mode || 'append'));
// 没有在跑的时候按「停止」不该凭空造出一个作业来（那会让下一次入库一开始就是取消态）。
ipcMain.handle('ingest:stop', () => {
  if (!ingestJob) return false;
  ingestJob.cancelled = true;
  return true;
});

ipcMain.handle('media:resolve', (_e, codes) => resolveEntries(codes));

// Paths this window has been *handed* by a pick dialog. The page cannot read disk through
// media:readAsData until he has chosen the file himself in the native dialog, which turns a
// general "read any absolute path" channel into one that only echoes back his own choice.
const picked = new Set();
function rememberPick(p) {
  if (!p) return p;
  picked.add(path.resolve(p));
  if (picked.size > 200) picked.delete(picked.values().next().value);
  return p;
}

ipcMain.handle('media:pickDir', async () => {
  const r = await require('electron').dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : rememberPick(r.filePaths[0]);
});

// The crop dialog works on pixels, so the picked file is handed to the renderer as a data
// URL rather than a path it cannot read.
ipcMain.handle('media:readAsData', async (_e, file) => {
  const src = String(file || '');
  if (!src || !picked.has(path.resolve(src))) throw new Error('请先在「选择图片」里挑这张图');
  let st;
  try {
    st = await fsp.stat(src);
  } catch {
    throw new Error('找不到图片文件');
  }
  if (!st.isFile()) throw new Error('这不是一个图片文件');
  if (st.size > 24 * 1024 * 1024) throw new Error('图片太大（超过 24MB）');
  const ext = (path.extname(src).slice(1) || 'jpeg').toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  if (!['jpeg', 'png', 'webp', 'bmp'].includes(mime)) throw new Error('只支持 jpg / png / webp / bmp');
  return `data:image/${mime};base64,${(await fsp.readFile(src)).toString('base64')}`;
});

ipcMain.handle('media:pickZip', async () => {
  const r = await require('electron').dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: '压缩包', extensions: ['zip'] }]
  });
  return r.canceled ? null : rememberPick(r.filePaths[0]);
});

ipcMain.handle('media:pickImage', async () => {
  const r = await require('electron').dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }]
  });
  return r.canceled ? null : rememberPick(r.filePaths[0]);
});

// Copies a chosen picture next to the other library images so it is reachable through the
// same confined scheme, and returns the relative reference the renderer already understands.
ipcMain.handle('cover:import', (_e, { kind, name, file, dataUrl }) => {
  const base = cfg.dataDir || app.getPath('userData');
  const safeKind = ['actor', 'studio', 'series'].includes(String(kind)) ? String(kind) : 'actor';
  const safeName = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .slice(0, 40);
  // Either a disk path or the base64 produced by the crop dialog.
  const mime = /^data:image\/(png|jpe?g|webp);base64,/i.exec(String(dataUrl || ''));
  const src = String(file || '');
  const ext = mime ? (mime[1].toLowerCase() === 'jpeg' ? 'jpg' : mime[1].toLowerCase()) : (path.extname(src).slice(1) || 'jpg').toLowerCase();
  if (!['jpg', 'jpeg', 'png', 'webp', 'bmp'].includes(ext)) throw new Error('只支持 jpg / png / webp / bmp');
  const bytes = mime ? Buffer.from(dataUrl.split(',')[1], 'base64') : (fs.existsSync(src) ? fs.readFileSync(src) : null);
  if (!bytes) throw new Error('找不到要导入的图片');
  const dir = path.join(base, 'shelf_covers', safeKind);
  fs.mkdirSync(dir, { recursive: true });
  const tag = require('node:crypto').createHash('sha1').update(safeName + Date.now()).digest('hex').slice(0, 8);
  const rel = `shelf_covers/${safeKind}/${safeName || 'cover'}-${tag}.${ext}`;
  fs.writeFileSync(path.join(dir, path.basename(rel)), bytes);
  return rel;
});

// ------------------------------------------------- 单部影片的自定义封面 (v1.6.7)
// Right-click a card → 导入图片裁切为封面. The crop dialog's checkbox decides whether his
// folder also gets the picture; by default only JavShelf's own copy is written, because the
// `-poster.jpg` already in there may be a cover he downloaded and a second import cannot
// undo that.
function coverLibOf(code, lib) {
  return String(lib || libOf.get(String(code)) || cfg.activeLibrary || '');
}

// Where the folder copy would go: the sidecar this title already has, or a new
// `<视频名>-poster.jpg` next to the video. Both are derived here, never accepted from the page.
// `mustLocate` is false for a display-only import — then we are not allowed to need his folder.
function coverFolderTarget(code, lib, mustLocate) {
  const key = coverLibOf(code, lib);
  const row = requireDb(key).loadRow(String(code));
  if (!row) throw new Error('记录不存在');
  const entry = entryFor({ ...row, _lib: key }, String(code));
  if (!entry || !entry.dir || !fs.existsSync(entry.dir)) {
    if (mustLocate !== false) throw new Error('还没定位到这个影片的文件夹');
    return { lib: key, entry: entry || {}, target: '' };
  }
  const ownRel = entry.custom ? entry.folderPoster : entry.poster;
  let target = '';
  if (ownRel) {
    try {
      target = media.resolve(ownRel);
    } catch {
      target = '';
    }
  }
  if (!target) target = path.join(entry.dir, (entry.name || String(code)) + '-poster.jpg');
  // One folder, the title's own — a reference that escaped it is a bug, not a request.
  if (path.dirname(path.resolve(target)).toLowerCase() !== path.resolve(entry.dir).toLowerCase()) {
    throw new Error('封面要写入的位置不在这部影片的文件夹里');
  }
  return { lib: key, entry, target };
}

// What 「同时写入影片文件夹」 would touch, in full. The dialog names the file so the choice is
// informed, and the regression reads the same path to prove the bytes are and stay his.
ipcMain.handle('cover:videoTarget', (_e, { code, lib }) => {
  const { lib: key, entry, target } = coverFolderTarget(code, lib);
  return { lib: key, dir: entry.dir, target, replaces: fs.existsSync(target), custom: !!entry.custom };
});

ipcMain.handle('cover:videoSet', async (_e, { code, lib, dataUrl, alsoFolder }) => {
  if (!covers) throw new Error('程序还在启动中，稍等再试');
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) throw new Error('图片数据格式不对');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length) throw new Error('图片是空的');
  const want = !!alsoFolder;
  const { lib: key, target } = coverFolderTarget(code, lib, want);
  const r = await covers.save(key, code, buf, want ? target : '');
  forgetEntry(key, code);
  if (r.folder) await refreshWarmCopy(r.folder);
  log('info', `已换封面：${code}` + (r.folder ? '（同时写入影片文件夹，原图备份为 .bak）' : '（只改这里的显示，影片文件夹未动）'));
  return { ok: true, rel: r.rel, folder: r.folder };
});

ipcMain.handle('cover:videoClear', async (_e, { code, lib }) => {
  if (!covers) throw new Error('程序还在启动中，稍等再试');
  const key = coverLibOf(code, lib);
  const r = await covers.clear(key, code);
  forgetEntry(key, code);
  if (r.restored) await refreshWarmCopy(r.restored);
  if (r.removedFolder) imgCache.drop(r.removedFolder);
  if (!r.removed) return { ok: false, error: '这部影片没有自定义封面' };
  log(
    'info',
    `已恢复封面：${code}` + (r.restored ? '（文件夹里的原图已从 .bak 还原）' : r.removedFolder ? '（撤掉了写进文件夹的那张）' : '')
  );
  return { ok: true, restored: r.restored, removedFolder: r.removedFolder };
});

// How many titles carry a hand-picked cover — the number the wall's status line reports.
ipcMain.handle('cover:videoCount', () => (covers ? covers.count() : 0));

// ---------------------------------------------------------------- 查重 (v1.6.7)
// The grouping itself happens in the page over the rows already in memory. All this does is
// answer 「这些文件夹里到底有什么」, and only for folders under a root of an enabled library —
// a list of paths arriving from the page must not turn into a general-purpose disk reader.
ipcMain.handle('dupes:detail', async (_e, dirs) => {
  const roots = scanRootsWanted().map((d) => path.resolve(d).toLowerCase());
  const list = [...new Set((Array.isArray(dirs) ? dirs : []).map((d) => String(d || '')).filter(Boolean))].slice(0, 400);
  const out = {};
  let at = 0;
  const worker = async () => {
    while (at < list.length) {
      const dir = list[at++];
      const key = path.resolve(dir).toLowerCase();
      if (!roots.some((r) => key === r || key.startsWith(r + path.sep))) {
        out[dir] = { ok: false, error: '不在库目录里' };
        continue;
      }
      try {
        const items = await fsp.readdir(dir, { withFileTypes: true });
        const files = items.filter((i) => !i.isDirectory()).map((i) => i.name);
        const videos = [];
        let bytes = 0;
        for (const name of files) {
          if (!VIDEO_EXT.has(path.extname(name).toLowerCase())) continue;
          let size = 0;
          try {
            size = (await fsp.stat(path.join(dir, name))).size;
          } catch {
            size = 0;
          }
          videos.push({ name, bytes: size });
          bytes += size;
        }
        videos.sort((a, b) => b.bytes - a.bytes);
        const lower = files.map((n) => n.toLowerCase());
        out[dir] = {
          ok: true,
          bytes,
          videos,
          poster: lower.some((n) => n.endsWith('-poster.jpg')),
          nfo: lower.some((n) => n.endsWith('.nfo'))
        };
      } catch {
        out[dir] = { ok: false, error: '读不到这个文件夹' };
      }
    }
  };
  // Eight at a time: this is a report he opens on purpose, not the wall's paint path, and a
  // cloud mount answers each directory in seconds.
  await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
  return out;
});

ipcMain.handle('library:row', (_e, { code, lib }) => {
  const row = requireDb(lib).loadRow(String(code));
  if (row) row._media = resolveEntries([String(code)])[String(code)] || null;
  return row;
});
ipcMain.handle('library:all', () => gridCache || { cols: [], rows: [] });

// Keep the cached grid in step with writes, so a refetch never shows stale 收藏/已看.
function syncCache(code, field, value, lib) {
  if (!gridCache) return;
  for (const r of gridCache.rows) {
    if (String(r.movie_编码) === String(code) && (!lib || r._lib === lib)) r[field] = value;
  }
}

ipcMain.handle('state:set', (_e, { code, field, value, lib }) => {
  const changes = requireDb(lib).setState(String(code), String(field), value);
  syncCache(code, String(field), String(value), lib);
  return changes;
});
ipcMain.handle('db:backup', async (_e, lib) => {
  const handle = requireDb(lib || cfg.activeLibrary);
  return handle.backup(cfg.dataDir || path.dirname(handle.file));
});

ipcMain.handle('imgcache:info', () => imgCache.info());
ipcMain.handle('imgcache:clear', () => {
  const info = imgCache.info();
  imgCache.clear();
  forgetEntries();
  log('info', `已清空图片缓存（${info.files} 个文件）`);
  return imgCache.info();
});

// 从管理器里删除一条影片记录：只删 JavShelf 自己 shelf 表里的那一行。视频文件、目录里的
// nfo、以及旧程序那份共享数据库都不碰——所以旧库（store 不是 shelf）直接拒绝。
// 下次「新增刷新/覆盖刷新」会按目录重新扫回来，这是预期行为。
ipcMain.handle('db:remove', (_e, { code, lib }) => {
  const name = String(lib || libOf.get(String(code)) || '');
  const def = libraryList().find((l) => l.name === name);
  if (!def || def.store !== 'shelf') {
    throw new Error('这个库的记录存在旧程序的共享数据库里，删它等于改别人的数据；只有 JavShelf 自己的库可以删');
  }
  const c = String(code);
  const changes = requireDb(name).remove(c);
  if (changes && gridCache) {
    // Only this library's rows: the same 番号 can legitimately live in two libraries, and
    // dropping the other one from the cache made it vanish from the wall until the next reload.
    gridCache.rows = gridCache.rows.filter((r) => !(String(r.movie_编码) === c && r._lib === name));
    libOf.delete(c);
    forgetEntry(name, c);
    // Our own copy of a hand-picked cover goes with the record; his folder is left alone,
    // exactly as the promise on the button says (记录删掉，文件不动).
    if (covers) covers.discard(name, c);
    try {
      for (const kind of ['studio', 'series']) entities.rebuild(shelfDbPath(), kind, gridCache.rows);
    } catch (e) {
      log('warn', '片商/系列索引未重建：' + (e && e.message));
    }
  }
  log('info', changes ? `已从媒体库删除记录 ${c}（视频文件与 nfo 未改动）` : `库里没有 ${c} 这条记录`);
  return { removed: changes, code: c };
});

// X: 上的 nfo 读一次也要 ~250 ms。清单里有这个文件 = 它曾在慢盘上:先 stat 校验
// (网盘挂载的元数据实测 ~0 ms),size/mtime 都对得上就出本地副本;对不上或从没缓存过
// 就回原盘读,读得慢顺手存。编辑/覆写的目标永远是原盘,写成功后刷新这份副本。
async function readNfoCached(rel) {
  const abs = media.resolve(rel);
  const meta = imgCache.entry(abs);
  if (meta) {
    const st = await fsp.stat(abs).catch(() => null);
    if (st && imgCache.fresh(abs, st)) {
      const buf = imgCache.bytes(abs);
      if (buf) return readNfo(abs, buf.toString('utf8'));
    }
  }
  const t0 = Date.now();
  const text = await fsp.readFile(abs, 'utf8');
  if (Date.now() - t0 >= SLOW_READ_MS) {
    const st = await fsp.stat(abs).catch(() => null);
    if (st) imgCache.write(abs, Buffer.from(text, 'utf8'), st);
  }
  return readNfo(abs, text);
}

// 换过封面之后本地那份副本必须跟着变，否则下一次出图还在读旧字节。
// 全程异步：写进影片文件夹的那张图就在网盘上，同步 stat/read 会把主进程连同
// 正在出图的所有请求一起冻住几秒。
async function refreshWarmCopy(abs) {
  if (!imgCache.entry(abs)) return; // 本地盘的条目不新建缓存;慢盘的懒路径会兜住
  try {
    const st = await fsp.stat(abs);
    imgCache.write(abs, await fsp.readFile(abs), st);
  } catch {
    imgCache.drop(abs);
  }
}

ipcMain.handle('nfo:read', (_e, rel) => readNfoCached(rel));
// The 演员 box in the nfo editor is part of the document, not decoration: it used to be
// dropped on the way through this handler, so saving always left the old <actor> list behind.
ipcMain.handle('nfo:write', async (_e, { rel, fields, actors }) => {
  const abs = media.resolve(rel);
  const out = writeNfo(abs, { fields, actors: Array.isArray(actors) ? actors : undefined });
  await refreshWarmCopy(abs);
  return out;
});
// Where the overwrite would actually write, in real-path form. Exposed so the regression can
// assert the invariant that broke once: this must be an absolute path that exists, never an
// r<n>/ reference handed to fs.
ipcMain.handle('nfo:path', (_e, code) => {
  const row = (gridCache ? gridCache.rows : []).find((r) => String(r.movie_编码) === String(code));
  if (!row) return { ok: false, error: '记录不存在' };
  const abs = nfoPathFor(entryFor(row, String(code)) || {});
  return { ok: true, abs, exists: !!abs && fs.existsSync(abs) };
});

// ---------------------------------------------------------------- 女优资料

function guessLegacyIdolDb() {
  const roots = ['G:\\', 'D:\\', 'C:\\Program Files\\'];
  for (const root of roots) {
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/javboss/i.test(n)) continue;
      const p = path.join(root, n, 'data', 'javboss.db');
      if (fs.existsSync(p)) return p;
    }
  }
  return '';
}

ipcMain.handle('idol:list', () => stampAvatarCovers(idols.list(shelfDbPath())));
ipcMain.handle('idol:save', (_e, idol) => idols.save(shelfDbPath(), idol));
ipcMain.handle('idol:merge', (_e, { from, into }) => idols.merge(shelfDbPath(), from, into));
ipcMain.handle('idol:import', (_e, source) => idols.importFrom(shelfDbPath(), String(source || '') || guessLegacyIdolDb()));
ipcMain.handle('idol:guess', () => guessLegacyIdolDb());
ipcMain.handle('idol:patch', (_e, { name, fields }) => idols.patch(shelfDbPath(), name, fields || {}));

// ---- manual JavDB binding ------------------------------------------------------------
// The directory crawl can't reach everyone (renamed, unlisted, or just a spelling it never
// matched), so the last resort is pasting her page yourself. Two calls: 校验 reads the live page
// and shows who it is — including the case where she turns out to be somebody else — and 绑定
// writes what survived. 绑定 deliberately does not re-fetch: it works with no proxy and no
// network, which is also the only way a mis-remembered id can be corrected by hand.
ipcMain.handle('idol:checkJavdb', async (_e, ref) => {
  const parsed = parseActorRef(ref);
  if (parsed.error) throw new Error(parsed.error);
  const d = await javdbClient().actressDetail(parsed.id);
  if (!d.names.length && !d.videoCount) throw new Error('JavDB 这一页读不出名字，可能已经改版或她的页被下了');
  return {
    id: parsed.id,
    url: parsed.url,
    names: [...new Set([...d.names, ...d.aliases])].filter(Boolean),
    videoCount: d.videoCount,
    avatar: d.avatar,
    measurements: { height_cm: d.height, birth_date: d.birthDate, bust: d.bust, waist: d.waist, hips: d.hips, cup: d.cup }
  };
});

ipcMain.handle('idol:bindJavdb', async (_e, { name, ref, avatar }) => {
  const n = String(name || '').trim();
  if (!n) throw new Error('没有女优名字');
  const parsed = parseActorRef(ref);
  if (parsed.error) throw new Error(parsed.error);
  idols.patch(shelfDbPath(), n, { javdb_id: parsed.id, javdb_url: parsed.url });
  // Her row and the actor index have to move together: 下载官方头像 and the sidebar circle both
  // look the id up in the index, so a binding that skipped this step would half-work.
  const pic = avatarFor(parsed.id, avatar);
  idols.saveIndex(shelfDbPath(), [{ id: parsed.id, url: parsed.url, avatar: pic, names: [n] }]);
  let saved = false;
  let avatarError = '';
  if (pic && !String(cfg.proxy || '').trim()) {
    // Without a proxy this request can only hang out to its 30 s timeout, and the photo is the
    // one thing about binding that genuinely needs the network.
    avatarError = '没填代理，先只绑了编号；代理配好后点「下载官方头像」即可';
  } else if (pic) {
    try {
      const store = requireActors();
      if (store.has(n)) avatarError = '她已经有头像了，没有覆盖';
      else {
        store.save(n, await fetchImage(pic, cfg.proxy));
        saved = true;
      }
    } catch (e) {
      avatarError = e.message;
    }
  }
  log('info', `手动绑定女优 ${n} → JavDB ${parsed.id}${saved ? '（头像已取到）' : avatarError ? '（头像：' + avatarError + '）' : ''}`);
  return { name: n, id: parsed.id, url: parsed.url, avatarSaved: saved, avatarError };
});

// One performer, read from the Japanese Wikipedia infobox — the only place that still publishes
// 身長/スリーサイズ/ブラサイズ. The editor calls this; the directory crawl uses the same reader.
// Japanese is what the encyclopedia titles its articles in, so the names are tried in that order
// and the first page that answers wins.
ipcMain.handle('idol:wiki', async (_e, name) => {
  const n = String(name || '').trim();
  if (!n) throw new Error('没有女优名字');
  if (!String(cfg.proxy || '').trim()) throw new Error('没填代理，读不到日文维基');
  const row = idols.get(shelfDbPath(), n) || {};
  const seen = new Set();
  for (const q of [row.japanese_name, n, row.roman_name, row.chinese_name]) {
    const want = String(q || '').trim();
    if (!want || seen.has(want)) continue;
    seen.add(want);
    let w = null;
    try {
      w = await wikiActress(want, cfg.proxy);
    } catch {
      w = null;
    }
    if (!w) continue;
    const m = {
      height_cm: w.height,
      birth_date: w.birthDate,
      bust: w.bust,
      waist: w.waist,
      hips: w.hips,
      cup: w.cup,
      birth_place: w.birthPlace
    };
    const got = Object.values(m).filter(Boolean).length;
    log('info', `日文维基 ${n}：${w.page} 取到 ${got} 项${w.asOf ? `（${w.asOf}年时点）` : ''}`);
    return { page: w.page, asOf: w.asOf, queried: want, measurements: m };
  }
  throw new Error(`日文维基没有「${n}」这一页，或是没读到她的档案卡`);
});

ipcMain.handle('log:list', () => appLog.slice());
ipcMain.handle('log:clear', () => {
  appLog.length = 0;
  return true;
});

// Official photos come from the JavDB CDN and land in the same bucket layout the avatar
// pipeline already uses, so the sidebar and the cover wall pick them up for free.
function normalizeProxyForWindow(proxy) {
  const s = String(proxy || '').trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://' + s;
}

// The cookie comes out of his own Chrome, never an embedded view: the real browser gets past the
// edge's bot check, and the session cookie is HttpOnly so only Chrome itself can hand it over.
let cookieJob = null;
ipcMain.handle('javdb:cookieFromChrome', async () => {
  if (cookieJob) return { ok: false, busy: true, reason: '已经有一个取回任务在等登录，请看刚打开的 Chrome 窗口' };
  const profileDir = path.join(cfg.dataDir || app.getPath('userData'), 'javdb-chrome');
  const proxy = normalizeProxyForWindow(cfg.proxy);
  log('info', '正在打开 Chrome 读取 JavDB Cookie…');
  cookieJob = collectFromChrome({
    profileDir,
    url: 'https://javdb.com/login',
    proxy,
    onStatus: (t) => log('info', t)
  });
  let r;
  try {
    r = await cookieJob;
  } finally {
    cookieJob = null;
  }
  if (!r.ok) {
    log('warn', '未取得 JavDB Cookie：' + r.reason);
    return r;
  }
  cfg = { ...cfg, javdbCookie: r.cookie };
  saveConfig(cfg);
  log('info', `已从 Chrome 取回 JavDB Cookie ${r.count} 条${r.looksLoggedIn ? '（含登录会话）' : '（未见登录会话，可能还需要在网站里登录）'}`);
  return r;
});

// PowerShell single-quoted literal: the only character that needs doubling is the quote
// itself, so a filename carrying one cannot step out of the string it is embedded in.
function psQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// Local avatar import: a folder or a zip whose image filenames are performer names.
// Matching is exact name or any stored alias; anything unmatched is reported, not guessed.
ipcMain.handle('actor:importLocal', async (_e, { dir, zip }) => {
  const store = requireActors();
  const os = require('node:os');
  // Both paths come out of a pick dialog in this window; insist on that rather than
  // letting the channel become a reader for any folder or archive on disk.
  for (const p of [dir, zip]) {
    if (p && !picked.has(path.resolve(p))) throw new Error('请先用「选择文件夹」或「选择压缩包」挑出这个位置');
  }
  let root = String(dir || '');
  let tmp = '';
  try {
    if (zip) {
      tmp = path.join(os.tmpdir(), 'jshelf-avatars-' + Date.now());
      fs.mkdirSync(tmp, { recursive: true });
      const { execFileSync } = require('node:child_process');
      execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(tmp)} -Force`], { stdio: 'pipe' });
      root = tmp;
    }
    if (!root || !fs.existsSync(root)) throw new Error('找不到要导入的目录或压缩包');
    const known = new Map();
    for (const p of idols.list(shelfDbPath())) {
      known.set(p.name.toLowerCase(), p.name);
      for (const a of p.aliases || []) known.set(String(a).toLowerCase(), p.name);
      if (p.japanese_name) known.set(String(p.japanese_name).toLowerCase(), p.name);
    }
    for (const n of actorNames()) if (!known.has(n.toLowerCase())) known.set(n.toLowerCase(), n);
    const IMG = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
    const files = [];
    // Async walk and read: a few hundred portraits on a slow disk used to freeze the whole
    // process (and with it the poster wall) for the length of the import.
    const walk = async (d, depth) => {
      if (depth > 4) return;
      let items;
      try {
        items = await fsp.readdir(d, { withFileTypes: true });
      } catch (e) {
        log('warn', `头像导入读不到 ${path.basename(d)}：${e.message}`);
        return;
      }
      for (const e of items) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else if (IMG.has(path.extname(e.name).toLowerCase())) files.push(full);
      }
    };
    await walk(root, 0);
    let matched = 0;
    let unreadable = 0;
    const missed = [];
    for (const f of files) {
      const base = path.basename(f, path.extname(f)).trim();
      const hit = known.get(base.toLowerCase());
      if (!hit) {
        if (missed.length < 12) missed.push(base);
        continue;
      }
      try {
        store.save(hit, await fsp.readFile(f));
        matched++;
      } catch {
        unreadable++;
      }
    }
    log('info', `本地头像导入完成：匹配 ${matched} / ${files.length}` + (unreadable ? `，${unreadable} 张解码失败` : ''));
    return { matched, total: files.length, missed };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// A cancelled 抓取 leaves enrichJob behind with cancelled:true. Reusing that flag here meant
// the first person who ever pressed 停止 could permanently disable avatar downloads — the
// batch and the single-person route share this function, so they share its own abort flag.
let avatarJob = null;
ipcMain.handle('javdb:fetchAvatars', (_e, opts = {}) => fetchAvatars(opts));

// Shared by the bulk download and a single manual binding, so "绑定 her page" and
// "下载官方头像" can never disagree about where her photo comes from.
async function fetchAvatars(opts = {}) {
  if (avatarJob) throw new Error('头像已经在下载中，先等它结束或按停止');
  const store = requireActors();
  const byId = new Map(idols.listIndex(shelfDbPath()).map((r) => [r.javdb_id, r]));
  const names = idols.list(shelfDbPath()).filter((p) => p.javdb_id && byId.get(p.javdb_id) && byId.get(p.javdb_id).avatar && !store.has(p.name));
  const only = Array.isArray(opts.names) && opts.names.length ? new Set(opts.names.map(String)) : null;
  const pool = only ? names.filter((p) => only.has(p.name)) : names;
  const cap = Math.max(0, Number(opts.limit) || 0);
  const todo = cap ? pool.slice(0, cap) : pool;
  if (!todo.length) {
    // Nothing to grab is almost always a missing binding rather than a dead upstream, so say
    // which step is missing instead of reporting a quiet success.
    const bound = idols.list(shelfDbPath()).filter((p) => p.javdb_id).length;
    const indexed = byId.size;
    const reason = only ? oneAvatarGap([...only][0], byId, store) : !indexed
      ? '还没有 JavDB 演员索引：点左侧演员栏那一排的「资料管理」，在里面跑一次「抓取女优目录并绑定」'
      : !bound
        ? '库里的演员都还没绑定 JavDB 编号：同样在「资料管理」里跑一次「抓取女优目录并绑定」'
        : '已绑定的演员都已有头像';
    log('warn', '头像下载没有可做的条目：' + reason);
    return { done: 0, failed: 0, total: 0, reason };
  }
  log('info', `开始下载头像 ${todo.length} 张`);
  avatarJob = { cancelled: false, total: todo.length };
  let done = 0;
  let failed = 0;
  try {
    for (const p of todo) {
      if (avatarJob.cancelled) break;
      try {
        const buf = await fetchImage(byId.get(p.javdb_id).avatar, cfg.proxy);
        store.save(p.name, buf);
        done++;
      } catch (e) {
        failed++;
        log('warn', `头像下载失败 ${p.name}: ${e.message}`);
      }
      if (win && !win.isDestroyed()) win.webContents.send('enrich:progress', { what: 'avatars', done: done + failed, total: todo.length, current: p.name });
    }
  } finally {
    avatarJob = null;
  }
  log(done || failed ? 'info' : 'warn', `头像下载结束：成功 ${done}，失败 ${failed}`);
  if (win && !win.isDestroyed()) win.webContents.send('enrich:done', { what: 'avatars', done: done + failed, total: todo.length });
  return { done, failed, total: todo.length };
}

// Which step of 绑定编号 → 索引 → 头像地址 → 本地文件 is the one that's missing, for the
// single-person case where the batch advice above would just be noise.
function oneAvatarGap(name, byId, store) {
  const p = idols.get(shelfDbPath(), name);
  if (!p) return `资料库里还没有「${name}」这一位`;
  if (!p.javdb_id) return `她还没绑定 JavDB 编号：在二级界面点「绑定 JavDB」填一次她的链接`;
  const row = byId.get(p.javdb_id);
  if (!row) return `编号 ${p.javdb_id} 还不在演员索引里`;
  if (!row.avatar) return `索引里没有她的头像地址`;
  return `本地已经有她的头像，没有覆盖`;
}

// ---------------------------------------------------------------- 片商 / 系列

ipcMain.handle('entity:list', async (_e, kind) => stampAvatarCovers(entities.list(shelfDbPath(), kind)));
ipcMain.handle('entity:save', (_e, { kind, row }) => entities.upsert(shelfDbPath(), kind, row || {}));
// 片商/系列 are a derived index: boot() and 删除记录 rebuild them in-process, so there is no
// page-facing rebuild button to hang a channel on.

// ---------------------------------------------------------------- JavDB 抓取

// One client per proxy: rebuilding it on every call would throw away the keep-alive sockets,
// and the site responds far better to a warm connection.
let javdb = null;
let javdbProxy = '';
let cookieRejected = '';
let enrichJob = null;

function javdbClient() {
  const proxy = String(cfg.proxy || '').trim();
  if (!proxy) throw new Error('先在设置里填好代理，JavDB 直连不通');
  const cookie = String(cfg.javdbCookie || '');
  // Once the client has proven this cookie is what triggers the 502s, keep using the cookie-less
  // client — rebuilding it would re-attach the same bad value and stall for 30s on every page.
  const keepBroken = javdb && javdb.cookieBroken && cookie === cookieRejected;
  if (javdb && !keepBroken && (proxy !== javdbProxy || cookie !== (javdb.cookie || ''))) {
    javdb.close();
    javdb = null;
  }
  if (!javdb) {
    javdb = new JavDB(proxy, { throttleMs: Number(cfg.javdbThrottle) || 900, cookie });
    javdbProxy = proxy;
    javdb.onCookieFallback = (rejected) => {
      cookieRejected = rejected;
      log(
        'warn',
        '带 Cookie 的每个请求都被 JavDB 边缘节点回 502，去掉 Cookie 就正常——本次抓取已改用无 Cookie 请求。' +
          '请在 设置 → 数据 清空 JavDB Cookie，或点「从 Chrome 获取 Cookie」换一份新的。'
      );
    };
  }
  return javdb;
}

ipcMain.handle('javdb:video', async (_e, code) => javdbClient().videoByCode(String(code)));
// JavDB's studio search page returns nothing usable, but every title page carries its maker
// and series links. So an entity is resolved through one of its own titles — one request,
// and the answer is cached on the row.
async function resolveEntityUrl(kind, name) {
  const n = String(name || '').trim();
  if (!n) throw new Error('没有名字');
  const field = kind === 'studio' ? 'movie_制作' : kind === 'series' ? 'movie_系列' : 'movie_演员';
  const sample = (gridCache ? gridCache.rows : []).find((r) => String(r[field] || '').includes(n) && r.movie_编码);
  if (!sample) throw new Error('库里找不到可用于查询的作品');
  const info = await javdbClient().videoByCode(sample.movie_编码);
  let id = '';
  let url = '';
  if (kind === 'studio') {
    id = info.studioId;
    url = info.studioId ? `${BASE_JAVDB}/makers/${info.studioId}` : '';
  } else if (kind === 'series') {
    id = info.seriesId;
    url = info.seriesId ? `${BASE_JAVDB}/series/${info.seriesId}` : '';
  } else {
    const hit = info.actors.find((a) => a.name === n) || info.actors.find((a) => a.name.includes(n) || n.includes(a.name));
    id = hit ? hit.id : '';
    url = id ? `${BASE_JAVDB}/actors/${id}` : '';
  }
  if (!url) throw new Error('JavDB 上没有匹配到这一项');
  try {
    if (kind === 'actress') idols.patch(shelfDbPath(), n, { javdb_id: id, javdb_url: url });
    else entities.upsert(shelfDbPath(), kind, { name: n, javdb_id: id, javdb_url: url });
  } catch {
    /* the link still opens even if caching fails */
  }
  return { id, url };
}

ipcMain.handle('javdb:openEntity', async (_e, { kind, name }) => {
  const stored = kind === 'actress' ? idols.get(shelfDbPath(), name) : entities.get(shelfDbPath(), kind, name);
  const url = (stored && stored.javdb_url) || (await resolveEntityUrl(kind, name)).url;
  // The stored half of that can be anything a crawl once wrote there, so it goes through the
  // same host allow-list the free-form 打开链接 channel uses.
  if (!/^https:\/\/(www\.)?(javdb\.com|ja\.wikipedia\.org)\//.test(String(url || ''))) throw new Error('只能打开 JavDB 或维基百科的链接');
  await shell.openExternal(url);
  return url;
});

ipcMain.handle('javdb:open', async (_e, url) => {
  const u = String(url || '');
  // The renderer can ask to open anything it built from crawled data; keep it to the two
  // hosts this feature knows about rather than handing shell.openExternal a free-form URL.
  if (!/^https:\/\/(www\.)?(javdb\.com|ja\.wikipedia\.org)\//.test(u)) throw new Error('只能打开 JavDB 或维基百科的链接');
  await shell.openExternal(u);
  return true;
});

// Writes what JavDB knows into the folder's own nfo, leaving every tag it has no answer for
// untouched — an empty scraped field must not erase his data.
async function applyJavdbNfo(code) {
  const row = (gridCache ? gridCache.rows : []).find((r) => String(r.movie_编码) === String(code));
  if (!row) throw new Error('记录不存在');
  const entry = entryFor(row, String(code));
  if (!entry) throw new Error('还没定位到这个条目的文件夹，稍等扫描完成或点一次重新扫描');
  // The sidecar scan only reports an nfo it saw while walking; fall back to the Kodi
  // convention next to the video so an un-indexed folder still works.
  let nfo = nfoPathFor(entry);
  if (!nfo && entry.video) {
    const guess = entry.video.replace(/\.[A-Za-z0-9]+$/, '.nfo');
    if (fs.existsSync(guess)) nfo = guess;
  }
  // A folder with only a video is exactly the case 覆写 should fix, not refuse: create the
  // sidecar next to the video instead of erroring out.
  const creating = !nfo;
  if (creating) {
    if (!entry.dir || !fs.existsSync(entry.dir)) throw new Error('还没定位到这个条目的文件夹');
    if (!entry.video) throw new Error('找不到视频文件，无法确定 nfo 应该放在哪里');
    nfo = entry.video.replace(/\.[A-Za-z0-9]+$/, '.nfo');
  }
  const info = await javdbClient().videoByCode(code);
  if (!info) throw new Error('JavDB 上搜不到这个番号');
  const female = info.actors.filter((a) => a.female).map((a) => a.name);
  const fields = {
    title: info.title,
    originaltitle: info.title,
    premiered: info.date,
    year: String(info.date || '').slice(0, 4),
    runtime: info.minutes,
    studio: info.studio,
    label: info.studio,
    publisher: info.publisher || info.studio,
    series: info.series,
    director: info.director,
    genre: info.genres,
    tag: info.genres,
    rating: info.score,
    website: info.url,
    javdbsearchid: info.javdb
  };
  for (const k of Object.keys(fields)) {
    const v = fields[k];
    if (v === '' || v == null || (Array.isArray(v) && !v.length)) delete fields[k];
  }
  const payload = { fields, actors: (female.length ? female : info.actors.map((a) => a.name)).map((n) => ({ name: n, role: '' })) };
  const written = creating ? createNfo(nfo, payload) : writeNfo(nfo, payload);
  await refreshWarmCopy(nfo);
  let refreshed = null;
  try {
    refreshed = await runIngest(row._lib || cfg.activeLibrary, 'delta');
  } catch (e) {
    // The nfo is already correct, so a failed re-scan must not look like a failed write —
    // but it does have to be said, or the wall keeps showing the old 片名 with no trace.
    log('warn', `覆写后重扫未成功（${code}）：${(e && e.message) || e}`);
  }
  return { info, written, refreshed, actresses: female };
}

ipcMain.handle('javdb:applyNfo', (_e, code) => applyJavdbNfo(code));

// Batch route: bind each unbound 片商/系列 by reading one of its own titles off JavDB, since
// the video panel carries the maker/series ids directly.
//
// Which row to ask JavDB about for a given entity name, split the same way entities.rebuild
// splits them — an entity only exists because a row carried that exact segment.
function entitySampleRows(rows) {
  const out = { studio: new Map(), series: new Map() };
  for (const r of rows || []) {
    const code = String(r.movie_编码 || '');
    if (!code) continue;
    for (const kind of ['studio', 'series']) {
      const raw = String(r[entities.KINDS[kind]] || '').trim();
      if (!raw) continue;
      for (const n of raw.split(/[,/、|]/).map((s) => s.trim()).filter(Boolean)) {
        if (!out[kind].has(n)) out[kind].set(n, r);
      }
    }
  }
  return out;
}

async function runEnrich(what, opts = {}) {
  // 两批同时跑会共用同一条进度和同一个停止标记，谁也说不清按下去停了哪一批。
  if (enrichJob && enrichJob.running) throw new Error('已经有一批抓取在跑，先等它结束或按停止');
  const send = (channel, p) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, p);
  };
  enrichJob = { what, running: true, done: 0, total: 0, current: '', cancelled: false, startedAt: Date.now() };
  const client = javdbClient();
  const report = { bound: {}, created: {}, failed: 0 };
  try {
    if (what === 'entities') {
      // One pass over the wall instead of a linear scan per entity: a few hundred unbound
      // names x 14k rows was the slow part of this whole route.
      const samples = entitySampleRows(gridCache ? gridCache.rows : []);
      for (const kind of ['studio', 'series']) {
        const cap = Math.max(0, Number(opts.limit) || 0);
        const rows = entities.list(shelfDbPath(), kind).filter((e) => !e.javdb_id);
        if (cap) rows.length = Math.min(rows.length, cap);
        report.bound[kind] = 0;
        enrichJob.total += rows.length;
        for (const e of rows) {
          if (enrichJob.cancelled) break;
          enrichJob.current = e.name;
          send('enrich:progress', { ...enrichJob, ...report });
          const sample = samples[kind].get(e.name);
          if (!sample) {
            // 库里已经没有带这个名字的片子了：跳过也要记账，否则进度条永远差一截。
            enrichJob.done++;
            continue;
          }
          try {
            const info = await client.videoByCode(sample.movie_编码);
            const id = kind === 'studio' ? info.studioId : info.seriesId;
            if (id) {
              entities.upsert(shelfDbPath(), kind, { name: e.name, javdb_id: id, javdb_url: `${BASE_JAVDB}/${kind === 'studio' ? 'makers' : 'series'}/${id}` });
              report.bound[kind]++;
            }
          } catch (err) {
            report.failed++;
            log('warn', `实体绑定失败 ${e.name}: ${err.message}`);
          }
          enrichJob.done++;
        }
      }
    } else if (what === 'idols') {
      // Phase 1: page the JavDB actress directory into a local index (once), so a name
      // lookup never has to walk hundreds of pages again.
      // JavDB splits the directory into three branches and each is hundreds of pages long
      // (page 260 of any of them still holds unseen people), so a full run must walk all
      // three — with only the censored branch a whole class of performers can never bind.
      const BRANCHES = [
        ['/actors/censored', '有码'],
        ['/actors/uncensored', '无码'],
        ['/actors/western', '欧美']
      ];
      // 0 pages means "walk each branch to its end". Paging past the last page does *not* come
      // back empty — the site repeats the final page — so the end is detected by a repeat,
      // and the cap is only a stop-loss. A positive number is a per-branch budget, so asking
      // for a short run still samples all three branches instead of only the first.
      const wanted = Number(opts.pages) || 0;
      const full = wanted <= 0;
      const perBranch = full ? 800 : wanted;
      enrichJob.done = 0;
      enrichJob.total = perBranch * BRANCHES.length;
      for (const [path, label] of BRANCHES) {
        if (enrichJob.cancelled) break;
        log('info', `${label}目录开始（${full ? '翻到末尾' : '最多 ' + perBranch + ' 页'}）`);
        let lastIds = '';
        for (let page = 1; page <= perBranch && !enrichJob.cancelled; page++) {
          enrichJob.current = `${label}目录第 ${page} 页`;
          report.added = report.bound.idols || 0;
          report.found = report.indexed || 0;
          send('enrich:progress', { ...enrichJob, ...report });
          try {
            const rows = await client.actressDirectoryPage(page, path);
            const ids = rows.map((r) => r.id).join(',');
            if (ids && ids === lastIds) {
              log('info', `${label}目录到第 ${page - 1} 页为止，之后是重复页，这一支翻完`);
              break;
            }
            lastIds = ids;
            report.indexed = (report.indexed || 0) + idols.saveIndex(shelfDbPath(), rows);
          } catch (e) {
            report.failed++;
            log('warn', `${label}目录第 ${page} 页抓取失败: ${e.message}`);
          }
          enrichJob.done++;
        }
      }
      // Phase 2: bind the profiles that the index can resolve.
      const bound = idols.bindFromIndex(shelfDbPath());
      report.bound.idols = bound.bound;
      report.unmatched = bound.unmatched;
      log('info', `女优目录抓取结束：索引 ${report.indexed || 0} 条，绑定 ${bound.bound} 位，未匹配 ${bound.unmatched} 位`);
      // Phase 3: measurements come from the Japanese Wikipedia infobox, since JavDB no
      // longer publishes them. Bounded because each hit is a network round trip.
      const wantWiki = opts.wiki !== false;
      const limit = Math.max(0, Number(opts.limit) || 0);
      if (wantWiki) {
        const need = idols
          .list(shelfDbPath())
          .filter((p) => !p.height_cm || !p.birth_date || !p.bust)
          .slice(0, limit || undefined);
        enrichJob.done = 0;
        enrichJob.total = need.length;
        for (const p0 of need) {
          if (enrichJob.cancelled) break;
          enrichJob.current = p0.name;
          send('enrich:progress', { ...enrichJob, ...report });
          // Each source only fills what is still blank, and the row is carried forward between
          // the two writes — saving a stale snapshot would undo the first one.
          let p = p0;
          try {
            // With a login cookie JavDB itself serves the measurements; try it first so the
            // numbers match the site he is reading.
            if (cfg.javdbCookie && p.javdb_id && (!p.height_cm || !p.birth_date || !p.bust)) {
              const d = await client.actressDetail(p.javdb_id);
              if (d.height || d.bust || d.birthDate) {
                p = {
                  ...p,
                  height_cm: p.height_cm || d.height,
                  birth_date: p.birth_date || d.birthDate,
                  bust: p.bust || d.bust,
                  waist: p.waist || d.waist,
                  hips: p.hips || d.hips,
                  cup: p.cup || d.cup
                };
                idols.save(shelfDbPath(), p);
                report.javdb = (report.javdb || 0) + 1;
              }
            }
            const w = await wikiActress(p.japanese_name || p.name, cfg.proxy);
            if (w) {
              p = {
                ...p,
                height_cm: p.height_cm || w.height,
                birth_date: p.birth_date || w.birthDate,
                bust: p.bust || w.bust,
                waist: p.waist || w.waist,
                hips: p.hips || w.hips,
                cup: p.cup || w.cup,
                birth_place: p.birth_place || w.birthPlace
              };
              idols.save(shelfDbPath(), p);
              // note is a crawl column, so it goes through patch() rather than the profile write.
              if (!p.note && w.page) idols.patch(shelfDbPath(), p.name, { note: `ja.wikipedia:${w.page}${w.asOf ? `（${w.asOf}年時点）` : ''}` });
              report.wiki = (report.wiki || 0) + 1;
            }
            // The encyclopedia throttles a client that comes back too fast; without the pause a
            // long pass reports half the roster as missing.
            await new Promise((res) => setTimeout(res, 1200));
          } catch (err) {
            report.failed++;
            log('warn', `补全失败 ${p0.name}: ${err.message}`);
          }
          enrichJob.done++;
        }
      }
    }
  } finally {
    enrichJob.running = false;
    enrichJob.ms = Date.now() - enrichJob.startedAt;
    send('enrich:done', { ...enrichJob, ...report });
  }
  return { ...report, ms: enrichJob.ms };
}

ipcMain.handle('javdb:enrich', (_e, { what, opts }) => runEnrich(String(what || 'entities'), opts || {}));
// 停止 covers whichever job is live: the directory crawl and the avatar download report into
// the same progress bar, so one button has to reach both flags (and only a *running* one).
ipcMain.handle('javdb:enrichStop', () => {
  const hit = !!(enrichJob && enrichJob.running) || !!avatarJob;
  if (enrichJob && enrichJob.running) enrichJob.cancelled = true;
  if (avatarJob) avatarJob.cancelled = true;
  return hit;
});

// Opening the dialog also picks up anything he dropped into actor_inbox by hand, so there is
// no separate 导入收件箱 button to press.
ipcMain.handle('actor:coverage', () => {
  const store = requireActors();
  return { ...store.coverage(actorNames()), imported: store.importInbox(), dir: store.actorDir };
});

// One click: every actress who already has a local avatar gets it written as her cover-wall
// image; those without one keep the built-in default (earliest released title's poster).
ipcMain.handle('actor:useAvatarsAsCovers', () => {
  const store = requireActors();
  const rows = idols.list(shelfDbPath());
  const hits = [];
  for (const p of rows) if (store.has(p.name)) hits.push({ name: p.name, cover: store.relOf(p.name) });
  const applied = idols.patchMany(shelfDbPath(), hits);
  log('info', `头像设为封面：已应用 ${applied} 位，${rows.length - applied} 位没有头像保持默认`);
  return { applied, kept: rows.length - applied, total: rows.length };
});

// The crop dialog sends a data URL produced by a canvas, so the crop happens in the renderer
// and only the finished bytes land on disk.
ipcMain.handle('actor:setFromData', (_e, { name, dataUrl }) => {
  const store = requireActors();
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) throw new Error('图片数据格式不对');
  store.save(String(name || '').trim(), Buffer.from(m[2], 'base64'));
  log('info', `已保存裁切后的头像：${name}`);
  return { rel: store.relOf(String(name).trim()) };
});

// Answers "does this performer have an avatar, and under what path" from the one
// place that owns the bucket rule, so the renderer never guesses a filename.
// The answer carries the file's mtime: a wall or sidebar that asked for the same URL before
// and after an upload would otherwise keep the picture it already has.
ipcMain.handle('actor:paths', async (_e, names) => {
  const out = {};
  if (!actors) return out;
  for (const n of names || []) {
    const key = String(n);
    const ref = await actors.refOf(key);
    if (ref) out[key] = ref;
  }
  return out;
});

// 头像设为封面墙封面 stores the avatar's own rel in the entity row, so those refs need the
// same version on the way out. The database keeps the clean path — only the page's URL
// carries the stamp. The rel is what we stat (not a name run back through the bucket rule),
// so a name that needed sanitising cannot silently lose its stamp.
async function stampAvatarCovers(rows) {
  if (!media || !Array.isArray(rows)) return rows;
  for (const r of rows) {
    const rel = String(r.cover || '');
    if (!/^actor\//.test(rel) || rel.includes('?v=')) continue;
    let abs;
    try {
      abs = media.resolve(rel);
    } catch {
      continue;
    }
    const st = await fsp.stat(abs).catch(() => null);
    if (st && st.isFile()) r.cover = rel + '?v=' + Math.round(st.mtimeMs);
  }
  return rows;
}

function actorNames() {
  const data = gridCache || { rows: [] };
  const set = new Set();
  for (const r of data.rows) {
    for (const p of String(r.movie_演员 || '').split('/')) {
      const n = p.trim();
      if (n) set.add(n);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}

ipcMain.handle('player:open', async (_e, arg) => {
  const code = String(typeof arg === 'string' ? arg : (arg && arg.code) || '');
  const lib = (typeof arg === 'object' && arg && arg.lib) || libOf.get(code) || '';
  const handle = requireDb(lib || undefined);
  const row = handle.loadRow(code);
  if (!row) return { ok: false, error: '记录不存在' };
  // Same resolution the wall uses, stored-folder fallback included: asking only the scan index
  // made 播放 fail for any library whose root wasn't indexed, while 打开目录 kept working.
  const hit = entryFor({ ...row, _lib: lib || String(cfg.activeLibrary || '') }, code);
  const video = hit && hit.video;
  if (!video || !(await fsp.stat(video).catch(() => null))) {
    return { ok: false, error: '在库文件夹里找不到这个文件，可能还没扫描完或已被移动' };
  }
  // Two ways out: hand the file to whatever Windows considers its player (works on a machine
  // with no PotPlayer), or start a chosen exe ourselves, which is the only way to get its
  // command-line switches. A bad custom path degrades to the system player rather than failing.
  const wantCustom = cfg.playback.player === 'custom';
  const custom = wantCustom && cfg.playerPath && (await fsp.stat(cfg.playerPath).catch(() => null));
  let player = 'system';
  if (custom) {
    const args = [hit.video];
    if (cfg.playback.loop && /potplayer/i.test(cfg.playerPath)) args.unshift('/loop');
    const child = spawn(cfg.playerPath, args, { detached: true, stdio: 'ignore' });
    child.unref();
    player = 'custom';
  } else {
    const err = await shell.openPath(hit.video);
    if (err) return { ok: false, error: '系统没能打开这个文件：' + err };
    if (wantCustom) log('warn', '指定的播放器路径无效，已改用系统默认播放器');
  }
  // 观看次数/时长 are columns of our own table; a shared legacy database only ever gets 已看
  // (the same three fields every other write here is limited to). Either way a state write
  // must not be able to make 播放 report a failure — the player already has the file.
  try {
    const own = (libraryList().find((l) => l.name === lib) || {}).store === 'shelf';
    if (own) handle.bumpWatch(code, 0);
    else {
      handle.setState(code, 'state_已看', '真');
      syncCache(code, 'state_已看', '真', lib);
    }
  } catch (e) {
    log('warn', `已看状态没写上（${code}）：${(e && e.message) || e}`);
  }
  const info = cfg.playback.statFile ? await fsp.stat(hit.video) : null;
  return { ok: true, player, file: hit.video, dir: hit.dir, size: info ? info.size : 0 };
});

// 打开所在文件夹 / 打开文件: only for paths that are inside a library root, our own data
// directory, or the scan index's knowledge of a title. The page gets these paths from us in the
// first place; insisting keeps the one channel that can launch a shell action from being pointed
// at any folder on the machine.
function revealable(abs) {
  const roots = [cfg.dataDir || app.getPath('userData'), ...scanRootsWanted()]
    .filter(Boolean)
    .map((d) => path.resolve(d).toLowerCase());
  const key = path.resolve(abs).toLowerCase();
  return roots.some((r) => key === r || key.startsWith(r + path.sep));
}

ipcMain.handle('reveal:file', async (_e, p) => {
  const abs = /^r\d+\//.test(String(p)) ? media.resolve(p) : String(p);
  if (!abs) return { ok: false, error: '没有这个位置' };
  if (!revealable(abs)) return { ok: false, error: '这个位置不在媒体库或数据目录里' };
  if (await fsp.stat(abs).catch(() => null)) shell.showItemInFolder(abs);
  return { ok: true };
});

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.javshelf.library');
  registerImageProtocol();
  boot();
  createWindow();
  // Renderer errors land in the same trail as main-process ones, so the 日志 button shows
  // the whole picture instead of only half of it.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) log('renderer', `${sourceId}:${line} ${message}`);
  });
  makeTray();
  registerHotkey();
  if (SMOKE_RESTART) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        restartRoundTrip().catch((e) => {
          process.stdout.write('SMOKE_FAIL restart-roundtrip ' + (e && e.stack) + '\n');
          process.exitCode = 1;
          quit();
        });
      }, 2500);
    });
  }
  if (SMOKE || SMOKE_CRAWL) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      process.stdout.write(`RENDERER[${level}] ${sourceId}:${line} ${message}\n`);
    });
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        // Boot now awaits the avatar inbox, so give it room instead of a fixed guess.
        for (let i = 0; i < 60; i++) {
          const ready = await win.webContents.executeJavaScript('!!window.__booted', true);
          if (ready) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        const { runSmoke, runReopen, runCrawlCheck } = require('./smoke');
        try {
          const res = SMOKE_CRAWL
            ? await runCrawlCheck(win, path.join(ROOT, 'out'))
            : SMOKE_REOPEN
                ? await runReopen(win, path.join(ROOT, 'out'))
                : await runSmoke(win, path.join(ROOT, 'out'), { trayTemplate });
          process.stdout.write('SMOKE ' + JSON.stringify(res) + '\n');
        } catch (e) {
          // A failed run must not look like a clean exit to whoever scripted it.
          process.stdout.write('SMOKE_FAIL ' + (e && e.stack) + '\n');
          process.exitCode = 1;
        }
        quit();
      }, 2500);
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!cfg.shortcuts.tray || app.isQuitting) app.quit();
});
app.on('before-quit', () => {
  app.isQuitting = true;
});
app.on('will-quit', () => globalShortcut.unregisterAll());
