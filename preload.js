'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  boot: () => ipcRenderer.invoke('app:bootInfo'),
  metrics: () => ipcRenderer.invoke('app:metrics'),
  onMetrics: (cb) => ipcRenderer.on('app:metrics', (_e, m) => cb(m)),

  allRows: () => ipcRenderer.invoke('library:all'),
  row: (code, lib) => ipcRenderer.invoke('library:row', { code, lib }),
  setState: (code, field, value, lib) => ipcRenderer.invoke('state:set', { code, field, value, lib }),
  backup: (lib) => ipcRenderer.invoke('db:backup', lib),
  imgCacheInfo: () => ipcRenderer.invoke('imgcache:info'),
  imgCacheClear: () => ipcRenderer.invoke('imgcache:clear'),
  dbRemove: (code, lib) => ipcRenderer.invoke('db:remove', { code, lib }),

  settings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onAppearance: (cb) => ipcRenderer.on('app:appearance', (_e, a) => cb(a)),

  libUse: (name) => ipcRenderer.invoke('lib:use', name),
  libSave: (lib) => ipcRenderer.invoke('lib:save', lib),
  libRemove: (name) => ipcRenderer.invoke('lib:remove', name),
  libEnable: (name, on) => ipcRenderer.invoke('lib:enable', { name, on }),
  libImportLegacy: () => ipcRenderer.invoke('lib:importLegacy'),
  scanRescan: () => ipcRenderer.invoke('scan:rescan'),
  onScanProgress: (cb) => ipcRenderer.on('scan:progress', (_e, p) => cb(p)),
  onScanDone: (cb) => ipcRenderer.on('scan:done', (_e, p) => cb(p)),
  ingestRun: (library, mode) => ipcRenderer.invoke('ingest:run', { library, mode }),
  ingestStop: () => ipcRenderer.invoke('ingest:stop'),
  onIngestProgress: (cb) => ipcRenderer.on('ingest:progress', (_e, p) => cb(p)),
  onIngestDone: (cb) => ipcRenderer.on('ingest:done', (_e, p) => cb(p)),

  resolve: (codes, fast) => ipcRenderer.invoke('media:resolve', codes, !!fast),
  onMediaResolved: (cb) => ipcRenderer.on('media:resolved', (_e, m) => cb(m)),
  pickDir: () => ipcRenderer.invoke('media:pickDir'),
  nfoRead: (rel) => ipcRenderer.invoke('nfo:read', rel),
  nfoWrite: (rel, patch) => ipcRenderer.invoke('nfo:write', { rel, fields: patch.fields, actors: patch.actors, code: patch.code, lib: patch.lib, onlyCode: patch.onlyCode }),
  nfoPath: (code) => ipcRenderer.invoke('nfo:path', code),

  idolList: () => ipcRenderer.invoke('idol:list'),
  idolSave: (idol) => ipcRenderer.invoke('idol:save', idol),
  idolMerge: (from, into) => ipcRenderer.invoke('idol:merge', { from, into }),
  idolImport: (source) => ipcRenderer.invoke('idol:import', source),
  idolGuess: () => ipcRenderer.invoke('idol:guess'),
  idolPatch: (name, fields) => ipcRenderer.invoke('idol:patch', { name, fields }),
  idolCheckJavdb: (ref) => ipcRenderer.invoke('idol:checkJavdb', ref),
  idolBindJavdb: (arg) => ipcRenderer.invoke('idol:bindJavdb', arg),
  idolWiki: (name) => ipcRenderer.invoke('idol:wiki', name),
  entityList: (kind) => ipcRenderer.invoke('entity:list', kind),
  entitySave: (kind, row) => ipcRenderer.invoke('entity:save', { kind, row }),
  javdbVideo: (code) => ipcRenderer.invoke('javdb:video', code),
  javdbOpen: (url) => ipcRenderer.invoke('javdb:open', url),
  javdbOpenEntity: (kind, name) => ipcRenderer.invoke('javdb:openEntity', { kind, name }),
  javdbFetchAvatars: (opts) => ipcRenderer.invoke('javdb:fetchAvatars', opts || {}),
  javdbCookieFromChrome: () => ipcRenderer.invoke('javdb:cookieFromChrome'),
  actorImportLocal: (arg) => ipcRenderer.invoke('actor:importLocal', arg || {}),
  javdbFetchAvatarFor: (name) => ipcRenderer.invoke('javdb:fetchAvatars', { names: [name] }),
  logList: () => ipcRenderer.invoke('log:list'),
  logClear: () => ipcRenderer.invoke('log:clear'),
  onLogEntry: (cb) => ipcRenderer.on('log:entry', (_e, e) => cb(e)),
  javdbApplyNfo: (code) => ipcRenderer.invoke('javdb:applyNfo', code),
  javdbEnrich: (what, opts) => ipcRenderer.invoke('javdb:enrich', { what, opts }),
  javdbEnrichStop: () => ipcRenderer.invoke('javdb:enrichStop'),
  pickImageFile: () => ipcRenderer.invoke('media:pickImage'),
  pickZipFile: () => ipcRenderer.invoke('media:pickZip'),
  readImageAsData: (file) => ipcRenderer.invoke('media:readAsData', file),
  importCover: (kind, name, file, dataUrl) => ipcRenderer.invoke('cover:import', { kind, name, file, dataUrl }),
  videoCoverSet: (code, lib, dataUrl, alsoFolder) => ipcRenderer.invoke('cover:videoSet', { code, lib, dataUrl, alsoFolder }),
  videoCoverTarget: (code, lib) => ipcRenderer.invoke('cover:videoTarget', { code, lib }),
  videoCoverClear: (code, lib) => ipcRenderer.invoke('cover:videoClear', { code, lib }),
  videoCoverCount: () => ipcRenderer.invoke('cover:videoCount'),
  dupeDetail: (dirs) => ipcRenderer.invoke('dupes:detail', dirs),
  onEnrichProgress: (cb) => ipcRenderer.on('enrich:progress', (_e, p) => cb(p)),
  onEnrichDone: (cb) => ipcRenderer.on('enrich:done', (_e, p) => cb(p)),

  actorCoverage: () => ipcRenderer.invoke('actor:coverage'),
  actorUseAvatarsAsCovers: () => ipcRenderer.invoke('actor:useAvatarsAsCovers'),
  actorPaths: (names) => ipcRenderer.invoke('actor:paths', names),
  actorSetFromData: (name, dataUrl) => ipcRenderer.invoke('actor:setFromData', { name, dataUrl }),

  play: (code, lib) => ipcRenderer.invoke('player:open', { code, lib }),
  reveal: (p) => ipcRenderer.invoke('reveal:file', p),

  // 浏览器拓展的本地桥接：开关/端口走 saveSettings 的 bridge 组，这两个只管状态与打开拓展目录。
  bridgeStatus: () => ipcRenderer.invoke('bridge:status'),
  bridgeOpenExtension: () => ipcRenderer.invoke('bridge:openExtension'),

  // rel 直接来自磁盘路径，里面可能有 # ? %：不逐段编码的话 # 之后整段变成片段、
  // ? 变成查询串，协议层永远读不到真正的文件。头像的缓存版本号本来就带 ?v=，得留在末尾。
  imgUrl: (rel) => {
    const s = String(rel == null ? '' : rel);
    const at = s.indexOf('?');
    const path = at < 0 ? s : s.slice(0, at);
    const query = at < 0 ? '' : s.slice(at);
    return 'shelfimg://local/' + path.split('/').map(encodeURIComponent).join('/') + query;
  }
};

contextBridge.exposeInMainWorld('shelf', api);
