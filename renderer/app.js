'use strict';
const A = window.shelf;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  rows: [],
  byCode: new Map(),
  view: [],
  page: 1,
  pageSize: 120,
  waterfall: false,
  filters: { q: '', actor: new Set(), category: new Set(), studio: new Set(), series: new Set(), code: new Set(), year: new Set(), quick: 'all' },
  sort: { key: 'movie_日期', dir: 'desc' },
  titleField: 'movie_编码',
  cardW: 190,
  detailCode: null,
  cfg: {},
  app: {},
  disp: {},
  libraries: [],
  activeLib: '',
  counts: new Map(),       // library name -> rows, for the sidebar
  idols: [],
  idolMap: new Map(),
  actorAlias: new Map(),    // 别名 -> 档案名；只有显式别名参与折叠
  actorFold: new Map(),     // 档案名 -> 它吸收掉的写法，头像按这个回退
  nav: [],
  entities: { studio: [], series: [] },
  actorSort: 'count',
  actorDir: 'desc',
  needsSetup: true
};

/* ------------------------------------------------------------------ helpers */

const SPLIT = (s) => String(s || '').split('/').map((x) => x.trim()).filter(Boolean);
const clean = (s) => String(s || '').replace(/<!\[CDATA\[|\]\>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const truthy = (v) => v === '真';
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const bucket = (code) => {
  const c = String(code || '')[0];
  const u = c ? c.toUpperCase() : '';
  return /[0-9A-Z_]/.test(u) ? u : 'OTHER';
};
const posterRel = (code) => `poster/${bucket(code)}/${code}.jpg`;
const fanartRel = (code) => `fanart/${bucket(code)}/${code}.jpg`;
const hint = (t) => el('div', 'hint', t);
const input = (value, title, type) => {
  const n = el('input');
  n.type = type || 'text';
  n.value = value == null ? '' : value;
  if (title) n.title = title;
  return n;
};
const select = (options, value) => {
  const n = el('select');
  for (const [v, text] of options) {
    const o = el('option', null, text);
    o.value = v;
    if (String(v) === String(value)) o.selected = true;
    n.append(o);
  }
  return n;
};
const field = (label, node, tip) => {
  const r = el('div', 'row');
  r.append(el('label', null, label), node);
  if (tip) r.append(typeof tip === 'string' ? hint(tip) : tip);
  return r;
};
const check = (label, on, onChange, tip) => {
  const i = el('input');
  i.type = 'checkbox';
  i.checked = !!on;
  i.onchange = () => onChange(i.checked);
  return field(label, i, tip);
};

function derive(r) {
  const cats = SPLIT(r.movie_类别);
  const acts = SPLIT(r.movie_演员);
  const blob = `${r.movie_编码} ${r.movie_片名} ${acts.join(' ')} ${cats.join(' ')} ${r.movie_系列} ${r.movie_发行} ${r.movie_制作}`;
  const res = (blob.match(/(2160|[4]K)/i) || blob.match(/(1080|1920)/) || blob.match(/(720)/) || [''])[0];
  r._acts = acts;
  r._cats = cats;
  r._year = String(r.movie_日期 || '').slice(0, 4);
  r._fav = truthy(r.state_收藏);
  r._seen = truthy(r.state_已看);
  r._sub = truthy(r.state_字幕);
  r._res = /^[4]/i.test(res) ? '4K' : res ? res + 'P' : '';
  r._rate = Number(r.movie_评分) || 0;
  r._prefix = (String(r.movie_编码).match(/^[A-Za-z]+/) || [''])[0].toUpperCase();
  r._series = SPLIT(clean(r.movie_系列)).filter((x) => x.length > 1);
  r._makers = [r.movie_制作, r.movie_发行].map((x) => String(x || '').trim()).filter(Boolean);
  r._hay = blob.toLowerCase();
  r._title = String(r[state.titleField] || r.movie_编码 || '');
  return r;
}

/* --------------------------------------------------------------------- boot */

async function boot() {
  const info = await A.boot();
  state.cfg = info.config;
  state.libraries = info.config.libraries || [];
  state.activeLib = info.config.activeLibrary || '';
  state.app = { theme: 'dark', radius: 8, badgeSubtitle: false, badgeResolution: true, badgeCount: true, listCategory: true, listSeries: true, staticLoad: true, minWidth: 1080, ...(info.config.appearance || {}) };
  state.disp = info.config.display || {};
  syncActorSort();
  state.sort = info.config.sort || state.sort;
  applyDisplay();
  applyAppearance();
  const data = await A.allRows();
  state.rows = data.rows.map(derive);
  state.byCode = new Map(state.rows.map((r) => [r.movie_编码, r]));
  state.needsSetup = info.needsSetup || !state.rows.length;
  // 先把墙画出来。演员资料和片商/系列只补侧栏与副页，不该挡首屏；两者并行去取，
  // 回来后再刷新演员榜的别名合并计数，墙本身不用整面重渲染。
  buildFacets();
  wireUi();
  wireJobs();
  wireEnrichProgress();
  applyFilters();
  renderLibPanel();
  updateScanStat();
  setStatus(`载入 ${state.rows.length} 条 · ${info.ms} ms`);
  if (state.cfg.shortcuts && state.cfg.shortcuts.startupTip) {
    setStatus(`${state.libraries.length} 个库 · ${state.rows.length} 条`, 5000);
  }
  autoIngest();
  await Promise.all([loadIdols(), loadEntities()]);
  buildFacets();
  renderFacets();
  refreshAvatarStat().catch(() => {});
  window.__booted = true;
  window.__bootInfo = info;
  window.__state = state;
  window.__openDetail = openDetail;
  window.__reloadRows = reloadRows;
  window.__loadIdols = loadIdols;
  window.__mediaCache = mediaCache;
  window.__refreshAvatars = refreshAvatars;
  window.__nav = { push: pushFrame, pop: popFrame, top: navTop, entries: entityEntries };
  window.__openSecondary = (type) => pushFrame({ kind: 'covers', type, page: 1 });
  window.__cropDialog = cropDialog;
  window.__idolModal = idolModal;
  window.__resolveNow = resolveMedia;
  window.__dupes = { key: dupKey, groups: dupGroups };
}

async function loadIdols() {
  try {
    state.idols = await A.idolList();
  } catch {
    state.idols = [];
  }
  state.idolMap = new Map();
  state.actorAlias = new Map();
  state.actorFold = new Map();
  for (const p of state.idols) state.idolMap.set(p.name, p);
  const own = new Set(state.idolMap.keys());
  for (const p of state.idols) {
    for (const a of p.aliases || []) {
      if (!a || a === p.name) continue;
      if (!state.idolMap.has(a)) state.idolMap.set(a, p);
      // A spelling that has a profile of its own is not an alias: folding it away would
      // hide a real person's works behind somebody else's tile.
      if (!own.has(a) && !state.actorAlias.has(a)) {
        state.actorAlias.set(a, p.name);
        if (!state.actorFold.has(p.name)) state.actorFold.set(p.name, []);
        state.actorFold.get(p.name).push(a);
      }
    }
    if (p.japanese_name && !state.idolMap.has(p.japanese_name)) state.idolMap.set(p.japanese_name, p);
    if (p.chinese_name && !state.idolMap.has(p.chinese_name)) state.idolMap.set(p.chinese_name, p);
  }
}

// One tile per person. The wall, the sidebar list, the filters and the film list all count
// by this, because a merge only ever records the dead spelling as an alias — the nfo files
// on disk keep saying whatever they said, and rewriting those is not this program's call.
const canonActor = (n) => state.actorAlias.get(n) || n;
const spellingsOf = (name) => [name, ...(state.actorFold.get(name) || [])];

const systemDark = matchMedia('(prefers-color-scheme: dark)');

function applyAppearance() {
  const a = state.app;
  const root = document.documentElement.style;
  root.setProperty('--poster-radius', Math.max(0, Math.min(24, a.radius ?? 8)) + 'px');
  const auto = a.theme === 'auto';
  const light = auto ? !systemDark.matches : a.theme === 'light';
  document.body.classList.toggle('light', light);
}

systemDark.addEventListener('change', () => {
  if (state.app.theme === 'auto') applyAppearance();
});

// The 显示设置 tab for the current surface decides grid columns, clamps and page size.
function applyDisplay() {
  const d = state.disp.items || {};
  const root = document.documentElement.style;
  root.setProperty('--title-lines', d.titleLines || 2);
  $('#gridItems').classList.toggle('waterfall', !!d.waterfall);
  if (state.waterfall !== !!d.waterfall) state.page = 1;
  state.waterfall = !!d.waterfall;
  state.pageSize = d.pageSize || 120;
  const w = $('#waterfall');
  if (w) w.checked = state.waterfall;
  // In waterfall mode that number is how much one scroll-to-bottom appends, not a page.
  const pl = $('#pageSizeLabel');
  if (pl) pl.textContent = state.waterfall ? '每次加载' : '每页';
  paintPageSize();
  gridCols(d.perRow);
  paintDensity();
}

function paintDensity() {
  const slider = $('#density');
  if (!slider) return;
  const n = Number((state.disp.items || {}).perRow) || 0;
  slider.value = n;
  const label = $('#densityNum');
  if (label) label.textContent = n ? n + ' 列' : '自动';
}

// 显示设置 accepts any 30-960, so the fixed topbar list may not contain the current value;
// a select with no matching option renders blank and looks like the setting was lost.
const BASE_PAGE_SIZES = new Set(['60', '120', '240', '480']);

function paintPageSize() {
  const ps = $('#pageSize');
  if (!ps) return;
  const v = String(state.pageSize);
  for (const o of [...ps.options]) if (!BASE_PAGE_SIZES.has(o.value) && o.value !== v) o.remove();
  if (![...ps.options].some((o) => o.value === v)) ps.append(new Option(v, v));
  ps.value = v;
}

function gridCols(perRow) {
  const items = $('#gridItems');
  if (perRow && perRow > 0) items.style.gridTemplateColumns = `repeat(${perRow}, minmax(0, 1fr))`;
  else items.style.gridTemplateColumns = '';
}

/* ----------------------------------------------------------------- filtering */

function matchQuick(r) {
  switch (state.filters.quick) {
    case 'fav': return r._fav;
    case 'seen': return r._seen;
    case 'unseen': return !r._seen;
    case 'sub': return r._sub;
    default: return true;
  }
}

// The one comparator the top-bar 排序 controls. It has to be shared: the home wall sorts
// state.view, while an entity's own film list reads state.rows — sorting only the first
// left that second list in database order no matter what the toolbar said.
function sortRows(rows) {
  const { key, dir } = state.sort;
  const mul = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const x = a[key] ?? '';
    const y = b[key] ?? '';
    if (key === 'movie_评分') return ((Number(x) || 0) - (Number(y) || 0)) * mul;
    return String(x).localeCompare(String(y), 'zh') * mul;
  });
  return rows;
}

function applyFilters() {
  const f = state.filters;
  const terms = f.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const setFor = { actor: f.actor, category: f.category, studio: f.studio, series: f.series, code: f.code, year: f.year };
  const has = (k) => setFor[k].size > 0;
  const anyIn = (k, list) => {
    const s = setFor[k];
    for (const v of list) if (s.has(v)) return true;
    return false;
  };

  state.view = state.rows.filter((r) => {
    if (!matchQuick(r)) return false;
    if (has('actor') && !r._acts.some((n) => f.actor.has(canonActor(n)))) return false;
    if (has('category') && !anyIn('category', r._cats)) return false;
    if (has('studio') && !anyIn('studio', r._makers)) return false;
    if (has('series') && !anyIn('series', r._series)) return false;
    if (has('year') && !setFor.year.has(r._year)) return false;
    if (has('code') && !setFor.code.has(r._prefix)) return false;
    if (terms.length) for (const t of terms) if (!r._hay.includes(t)) return false;
    return true;
  });

  sortRows(state.view);

  const pages = Math.max(1, Math.ceil(state.view.length / state.pageSize));
  if (state.page > pages) state.page = pages;
  renderChips();
  renderFacets();
  render();
  updateBar();
}

function renderChips() {
  const host = $('#activeFilters');
  host.textContent = '';
  const f = state.filters;
  const LABEL = { actor: '演员', category: '类别', studio: '制作', series: '系列', year: '年份', code: '番号' };
  const add = (label, onRemove) => {
    const c = el('span', 'chip');
    c.append(el('b', null, label));
    const x = el('button', null, '×');
    x.onclick = onRemove;
    c.append(x);
    host.append(c);
  };
  if (f.q) add(`搜索：${f.q}`, () => { f.q = ''; $('#search').value = ''; applyFilters(); });
  if (f.quick !== 'all') add({ fav: '收藏', seen: '已看', unseen: '未看', sub: '有字幕' }[f.quick], () => setQuick('all'));
  for (const kind of ['actor', 'category', 'studio', 'series', 'year', 'code']) {
    for (const v of f[kind]) add(`${LABEL[kind]}：${v}`, () => { f[kind].delete(v); applyFilters(); });
  }
  if (host.children.length > 1) {
    const c = el('span', 'chip');
    const b = el('b', null, '清空全部');
    b.style.cursor = 'pointer';
    b.onclick = () => {
      f.q = ''; $('#search').value = '';
      for (const k of ['actor', 'category', 'studio', 'series', 'year', 'code']) f[k].clear();
      setQuick('all');
    };
    c.append(b);
    host.append(c);
  }
}

function setQuick(q) {
  closeDrawer({ focus: false });
  state.filters.quick = q;
  $$('#quickFilters button').forEach((b) => b.classList.toggle('active', b.dataset.quick === q));
  applyFilters();
}

/* ------------------------------------------------------------------- facets */

let facetData = {};
let facetTab = 'actor';

// Which sidebar tab owns a secondary cover wall.
const SEC_OF_TAB = { actor: 'actress', studio: 'studio', series: 'series' };

const FACET = {
  actor: { label: '演员', pick: (r) => r._acts, sortable: true },
  category: { label: '类别', pick: (r) => r._cats },
  studio: { label: '制作', pick: (r) => r._makers },
  series: { label: '系列', pick: (r) => r._series },
  code: { label: '番号', pick: (r) => (r._prefix ? [r._prefix] : []) },
  year: { label: '年代', pick: (r) => (r._year ? [r._year] : []) }
};

function buildFacets() {
  const tally = (key, arr) => {
    const m = new Map();
    for (const r of state.rows) for (const v of arr(r)) m.set(v, (m.get(v) || 0) + 1);
    return [...m];
  };
  facetData = {
    actor: tally('actor', (r) => [...new Set(r._acts.map(canonActor))]),
    category: tally('category', (r) => r._cats),
    studio: tally('studio', (r) => r._makers),
    series: tally('series', (r) => r._series),
    code: tally('code', (r) => (r._prefix ? [r._prefix] : [])),
    year: tally('year', (r) => (r._year ? [r._year] : []))
  };
  facetData.year.sort((a, b) => b[0].localeCompare(a[0]));
}

// Search is a live film filter; a name typed exactly is also a door into that actress's
// directory, which is where her filmography and profile actually live.
function actorJumpName(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return '';
  const hit = (facetData.actor || []).find(([name]) => String(name).toLowerCase() === q);
  return hit ? hit[0] : '';
}

function jumpToActor(name) {
  if (!name) return false;
  $('#searchActor').classList.add('hidden');
  setFiltersOpen(false);
  pushFrame({ kind: 'entity', type: 'actress', name, page: 1 });
  return true;
}

const ACTOR_SORTS = [
  ['count', '作品数'], ['name', '名字'], ['height_cm', '身高'], ['birth_date', '年龄'],
  ['cup', '罩杯'], ['bust', '胸围'], ['waist', '腰围'], ['hips', '臀围']
];

// 罩杯 is a letter. The import that came over from the old program kept it as that program's enum
// (1 = A … 13 = M); startup rewrites those rows, but a value read before the rewrite — or typed by
// hand — must still display and order as a cup rather than as the digit it looks like.
function cupLetter(v) {
  const s = String(v || '').trim().toUpperCase();
  if (!s) return '';
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Math.round(Number(s));
    return n >= 1 && n <= 26 ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[n - 1] : '';
  }
  const m = s.match(/[A-Z]+/);
  return m ? m[0][0] : '';
}

function idolSortValue(name, key) {
  const p = state.idolMap.get(name);
  if (!p) return -Infinity;
  if (key === 'birth_date') {
    const t = Date.parse(p.birth_date);
    return Number.isNaN(t) ? -Infinity : -t;
  }
  if (key === 'cup') {
    const c = cupLetter(p.cup);
    return c ? c.charCodeAt(0) : -Infinity;
  }
  const n = Number(p[key]);
  return Number.isFinite(n) && n > 0 ? n : -Infinity;
}

function renderFacets() {
  const list = $('#facetList');
  const spec = FACET[facetTab];
  const entries = (facetData[facetTab] || []).slice();
  if (facetTab === 'actor') {
    const sign = actorSortSign();
    const byName = (a, b) => a[0].localeCompare(b[0], 'ja');
    if (state.actorSort === 'count') entries.sort((a, b) => sign * (b[1] - a[1]) || byName(a, b));
    else if (state.actorSort === 'name') entries.sort((a, b) => sign * byName(a, b));
    else {
      // Performers without a measurement must land at the bottom deterministically;
      // subtracting -Infinity yields NaN and silently shuffles the whole list.
      entries.sort((a, b) => {
        const va = idolSortValue(a[0], state.actorSort);
        const vb = idolSortValue(b[0], state.actorSort);
        const na = !Number.isFinite(va);
        const nb = !Number.isFinite(vb);
        if (na && nb) return byName(a, b);
        if (na) return 1;
        if (nb) return -1;
        return sign * (vb - va);
      });
    }
  } else if (facetTab !== 'year') {
    entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'));
  }
  const q = $('#facetSearch').value.trim().toLowerCase();
  const shown = (q ? entries.filter(([v]) => v.toLowerCase().includes(q)) : entries).slice(0, 500);
  const sel = state.filters[facetTab];
  list.textContent = '';
  const pending = [];
  for (const [name, n] of shown) {
    const row = el('div', 'facet' + (sel.has(name) ? ' on' : ''));
    if (facetTab === 'actor') {
      if (avatarPaths[name]) row.append(avatarImg(avatarPaths[name], name));
      else {
        if (avatarPaths[name] !== null) pending.push(name);
        row.append(el('div', 'avatar ph', name.slice(0, 1)));
      }
    }
    const main = el('div', 'fmain');
    main.append(el('span', 'name', name));
    const p = facetTab === 'actor' ? state.idolMap.get(name) : null;
    if (p) {
      const bits = [p.height_cm ? p.height_cm + 'cm' : '', cupLetter(p.cup), p.birth_date ? String(p.birth_date).slice(0, 4) + '年生' : ''].filter(Boolean);
      if (bits.length) main.append(el('span', 'extra', bits.join(' · ')));
    }
    row.append(main);
    row.append(el('span', 'n', String(n)));
    row.onclick = () => {
      sel.has(name) ? sel.delete(name) : sel.add(name);
      applyFilters();
    };
    if (facetTab === 'actor') {
      row.oncontextmenu = (e) => {
        e.preventDefault();
        actorMenu(e.clientX, e.clientY, name, n);
      };
    }
    const secTab = SEC_OF_TAB[facetTab];
    if (secTab) {
      const open = el('button', 'facetopen', '▸');
      open.title = '在二级界面查看这一项';
      open.onclick = (ev) => {
        ev.stopPropagation();
        pushFrame({ kind: 'entity', type: secTab, name, page: 1 });
      };
      row.append(open);
    }
    list.append(row);
  }
  if (pending.length) resolveAvatars(pending, () => renderFacets());
  if (!shown.length) list.append(el('div', 'hint', '无匹配项'));
  renderActorSort();
}

// The sidebar chips and 显示设置 → 默认排序 are one setting, not two: whichever changes, both
// read back through here so the chips, the dialog and the cover walls cannot disagree.
function syncActorSort() {
  const v = (state.disp && state.disp.actor) || {};
  state.actorSort = ACTOR_SORTS.some(([k]) => k === v.sort) ? v.sort : 'count';
  state.actorDir = v.sortDir === 'asc' ? 'asc' : 'desc';
}

function actorSortSign() {
  return state.actorDir === 'asc' ? -1 : 1;
}

// The chips write the very setting 显示设置 → 默认排序 uses, so the order survives a restart
// and the two places can no longer disagree.
async function rememberActorSort() {
  const actor = { ...(state.disp.actor || {}), sort: state.actorSort, sortDir: state.actorDir };
  state.disp = { ...state.disp, actor };
  const cfg = await A.saveSettings({ display: { actor } });
  if (cfg && cfg.display) {
    state.cfg = cfg;
    state.disp = cfg.display;
    syncActorSort();
  }
}

function renderActorSort() {
  const box = $('#actorSort');
  box.textContent = '';
  box.classList.toggle('hidden', facetTab !== 'actor');
  if (facetTab !== 'actor') return;
  for (const [key, label] of ACTOR_SORTS) {
    const b = el('button', state.actorSort === key ? 'on' : '', label);
    b.onclick = () => {
      state.actorSort = key;
      rememberActorSort();
      renderFacets();
    };
    box.append(b);
  }
  const asc = state.actorDir === 'asc';
  const dir = el('button', asc ? 'on' : '', asc ? '升序 ↑' : '降序 ↓');
  dir.title = '排列方式：点一下在当前依据的两个方向之间切换（没有资料的始终排在最后）';
  dir.onclick = () => {
    state.actorDir = asc ? 'desc' : 'asc';
    rememberActorSort();
    renderFacets();
  };
  box.append(dir);
  const manage = el('button', '', '资料管理');
  manage.onclick = () => idolListModal();
  box.append(manage);
}

/* ---------------------------------------------------------------- the wall */

const gridItems = () => $('#gridItems');

function render() {
  syncWorkspace();
  if (inSecondary()) {
    renderSecondary().catch((e) => setStatus('二级界面渲染失败：' + e.message, 6000));
    return;
  }
  $('#secondary').classList.add('hidden');
  $('#subbar').classList.remove('hidden');
  $$('#wallEntries button').forEach((b) => b.classList.remove('on'));
  const items = gridItems();
  const host = $('#gridHost');
  const empty = $('#emptyState');
  items.textContent = '';
  empty.textContent = '';
  empty.classList.add('hidden');
  host.classList.remove('hidden');

  if (state.needsSetup) {
    paintSetup();
    $('#pager').textContent = '';
    updateBar();
    return;
  }
  const d = state.disp.items || {};
  gridCols(d.perRow);
  const pages = Math.max(1, Math.ceil(state.view.length / state.pageSize));
  if (state.page > pages) state.page = pages;
  // In waterfall mode the wall keeps everything from the top down to the loaded page, so
  // scrolling to the bottom appends the next chunk instead of swapping the visible one.
  const from = state.waterfall ? 0 : (state.page - 1) * state.pageSize;
  const slice = state.view.slice(from, state.page * state.pageSize);
  if (!slice.length) {
    host.classList.add('hidden');
    empty.classList.remove('hidden');
    empty.append(el('h2', null, '没有匹配的条目'), el('p', null, '换个关键词，或清空左侧筛选。'));
    paintPager(pages);
    updateBar();
    return;
  }
  appendRows(slice);
  paintPager(pages);
  updateBar();
  wfFill();
}

function appendRows(rows) {
  const items = gridItems();
  const fresh = [];
  for (const r of rows) {
    items.append(makeCard(r));
    if (mediaCache[r.movie_编码] === undefined) fresh.push(r.movie_编码);
  }
  if (fresh.length) resolveMedia(fresh);
}

// One chunk of the wall appended onto the existing ones. Returns false once exhausted.
function loadMore() {
  if (!state.waterfall) return false;
  const pages = Math.max(1, Math.ceil(state.view.length / state.pageSize));
  if (state.page >= pages) return false;
  const from = state.page * state.pageSize;
  state.page++;
  appendRows(state.view.slice(from, state.page * state.pageSize));
  paintPager(pages);
  updateBar();
  return true;
}

// Start the next chunk while the bottom is still WF_EDGE away, and keep going if a chunk
// was too short to make the wall scrollable again (otherwise it strands at the bottom).
const WF_EDGE = 600;
function wfFill() {
  if (!state.waterfall || inSecondary()) return;
  const host = $('#gridHost');
  for (let guard = 0; guard < 12; guard++) {
    if (host.scrollHeight - host.scrollTop - host.clientHeight > WF_EDGE) return;
    if (!loadMore()) return;
  }
}

function paintSetup() {
  const box = $('#emptyState');
  box.textContent = '';
  box.classList.remove('hidden');
  $('#gridHost').classList.add('hidden');
  box.append(el('h2', null, '先把影片文件夹加进来'));
  box.append(el('p', null, '添加一个媒体库并指向存放影片的目录即可。JavShelf 会读取每个条目里的 nfo 建立海报墙，之后每次打开都直接进界面；也可以填写数据目录，沿用旧程序已经整理好的元数据与封面。'));
  const row = el('div', 'row');
  const b1 = el('button', 'ghost primary', '添加媒体库');
  b1.onclick = () => libsModal();
  const b2 = el('button', 'ghost', '填写数据目录');
  b2.onclick = () => settingsModal();
  const b3 = el('button', 'ghost', '导入旧程序的库配置');
  b3.onclick = async () => {
    try {
      const cfg = await A.libImportLegacy();
      state.libraries = cfg.libraries;
      await reloadRows();
      renderLibPanel();
      setStatus('已导入库配置');
    } catch (e) {
      setStatus('导入失败：' + e.message, 6000);
    }
  };
  row.append(b1, b2, b3);
  box.append(row);
  const errs = state.libraries.filter((l) => l.error);
  for (const l of errs) box.append(hint(l.name + '：' + l.error));
}

function makeCard(r) {
  const code = r.movie_编码;
  const d = state.disp.items || {};
  const card = el('div', 'card' + (state.detailCode === code ? ' sel' : ''));
  card.dataset.code = code;
  const poster = el('div', 'poster');
  const img = el('img');
  img.loading = state.app.staticLoad === false ? 'eager' : 'lazy';
  img.decoding = 'async';
  img.alt = '';
  img.onload = () => img.classList.add('on');
  img.onerror = () => {
    if (!poster.querySelector('.placeholder')) poster.append(el('div', 'placeholder', '无封面'));
  };
  poster.append(img);
  const [top, bottom] = cardLines(r, d);
  card.append(poster, el('div', 'title', top), el('div', 'sub', bottom));
  card.onclick = () => inspectCode(code);
  card.ondblclick = (e) => {
    if (!e.target.closest('button')) openDetail(code);
  };
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', code);
  card.title = '单击快速检查 · 双击或 Enter 打开完整详情';
  card.onkeydown = (e) => {
    if (e.key === 'Enter' && e.target === card) {
      e.preventDefault();
      openDetail(code);
    }
  };
  card.oncontextmenu = (e) => {
    e.preventDefault();
    quickMenu(code);
  };
  if (!d.hideActions) {
    const acts = el('div', 'actions');
    const fav = el('button', null, r._fav ? '★' : '☆');
    fav.title = '收藏';
    fav.onclick = (e) => {
      e.stopPropagation();
      toggleState(code, 'state_收藏');
    };
    const seen = el('button', null, '✓');
    seen.title = '标记已看';
    seen.onclick = (e) => {
      e.stopPropagation();
      toggleState(code, 'state_已看');
    };
    const play = el('button', null, '▶');
    play.title = '播放';
    play.onclick = (e) => {
      e.stopPropagation();
      playCode(code);
    };
    acts.append(fav, seen, play);
    card.append(acts);
  }
  paintCardMedia(card, r);
  return card;
}

// He wants the film name as the headline and the code as the small line under it.
function cardLines(r, d) {
  const code = String(r.movie_编码 || '');
  const name = clean(r.movie_片名 || '');
  const bare = name && name.toUpperCase().startsWith(code.toUpperCase())
    ? name.slice(code.length).replace(/^[\s\-－_]+/, '')
    : name;
  if (state.titleField === 'movie_编码') return [bare || code, code];
  return [name || code, cardSub(r, d)];
}

function cardSub(r, d) {
  // With 番号 as the title the second line used to be date·actors, so a wall of codes had no
  // film name anywhere on it. The name takes priority; the old line is the fallback.
  const name = clean(r.movie_片名 || '');
  if (state.titleField === 'movie_编码' && name && name !== r.movie_编码) {
    // His titles repeat the code at the front; the card already shows it on line one.
    const code = String(r.movie_编码 || '');
    const bare = code && name.toUpperCase().startsWith(code.toUpperCase()) ? name.slice(code.length).replace(/^[\s\-－_]+/, '') : name;
    return bare || name;
  }
  const bits = [r.movie_日期];
  if (!d.hideActors && r._acts.length) bits.push(r._acts.slice(0, 3).join('、'));
  if (!d.hideSeries && r._series.length) bits.push(r._series[0]);
  return bits.filter(Boolean).join(' · ');
}

function paintCardMedia(card, r) {
  const code = r.movie_编码;
  const m = mediaCache[code];
  const d = state.disp.items || {};
  const img = card.querySelector('.poster img');
  const thumbFirst = false;
  // 还没解析出媒体时先留空位：旧版 poster 路径在多数库上并不存在，提前请求只会让每张
  // 卡片去云盘 stat 一次再 404，还抢走解析和缓存读取的线程。解析完 paintResolved 会再进来。
  if (m !== undefined) {
    const rel = (m && (thumbFirst ? m.thumb || m.poster : m.poster || m.thumb)) || posterRel(code);
    if (img.dataset.src !== A.imgUrl(rel)) {
      img.dataset.src = A.imgUrl(rel);
      img.src = A.imgUrl(rel);
    }
  }
  for (const t of card.querySelectorAll('.tag')) t.remove();
  const tag = (pos, text, cls) => {
    const s = el('span', 'tag ' + pos + (cls ? ' ' + cls : ''), text);
    card.querySelector('.poster').append(s);
  };
  if (r._res && state.app.badgeResolution) tag('tr', r._res);
  if (r._sub && state.app.badgeSubtitle) tag('tl', '字');
  if (r._rate >= 4 && state.app.badgeCount) tag('br', (state.app.fullHeart || (state.disp.items || {}).fullHeart) ? '♥ ' + r._rate.toFixed(1) : '★ ' + r._rate.toFixed(1));
  if (r._seen && state.app.badgeCount) tag('bl', '已看', 'seen');
  if (r._fav) tag('tl', '收藏', 'fav');
  if (!d.hideTags && state.app.listCategory !== false) {
    const cats = r._cats.filter((c) => c !== r._res).slice(0, (d.tagLines || 2) * 2);
    if (cats.length) {
      const s = el('span', 'tag bl', cats.slice(0, 3).join(' '));
      s.style.maxWidth = 'calc(100% - 10px)';
      s.style.overflow = 'hidden';
      s.style.textOverflow = 'ellipsis';
      s.style.whiteSpace = 'nowrap';
      card.querySelector('.poster').append(s);
    }
  }
  // 列表显示系列 used to be a setting nothing read. A series name is worth a chip of its own:
  // it is not part of the 类别 field, so it cannot show up twice.
  if (!d.hideSeries && state.app.listSeries !== false) {
    const series = (r._series || [])[0];
    if (series) {
      const s = el('span', 'tag bl series', series);
      s.style.maxWidth = 'calc(100% - 10px)';
      s.style.overflow = 'hidden';
      s.style.textOverflow = 'ellipsis';
      s.style.whiteSpace = 'nowrap';
      s.title = '系列：' + series;
      card.querySelector('.poster').append(s);
    }
  }
}

async function playCode(code) {
  const row = state.byCode.get(code);
  const res = await A.play(code, row && row._lib);
  setStatus(res.ok ? '已启动播放器：' + String(res.file || '').split(/[\/\x5c]/).pop() : '播放失败：' + res.error, 6000);
}

/* -------------------------------------------------------- media + avatars */

const mediaCache = {};
// 解析在途的编码：同一张卡片被多次渲染时不要重复发请求。
const pendingMedia = new Set();

async function resolveMedia(codes) {
  const ask = codes.filter((c) => mediaCache[c] === undefined && !pendingMedia.has(c));
  if (!ask.length) return;
  for (const c of ask) pendingMedia.add(c);
  let found = {};
  try {
    // 快路径：索引命中立刻返回，索引外的慢行由主进程解析完通过 media:resolved 补发。
    found = await A.resolve(ask, true);
  } catch {
    for (const c of ask) pendingMedia.delete(c);
    return;
  }
  const hits = [];
  for (const c of ask) {
    if (!found[c]) continue;
    mediaCache[c] = found[c];
    pendingMedia.delete(c);
    hits.push(c);
  }
  paintResolved(hits);
}

function paintResolved(codes) {
  for (const c of codes) {
    const card = $('#gridItems .card[data-code="' + cssEscape(c) + '"]') || $('#secondary .card[data-code="' + cssEscape(c) + '"]');
    const r = state.byCode.get(c);
    if (card && r) paintCardMedia(card, r);
  }
  if (state.detailCode && codes.includes(state.detailCode)) refreshDrawer();
}

const cssEscape = (s) => String(s).replace(/["\\]/g, '\\$&');

const avatarPaths = {};
let avatarGen = 0;

function forgetAvatarLookups() {
  avatarGen++;
  for (const k of Object.keys(avatarPaths)) delete avatarPaths[k];
}

function avatarImg(rel, name) {
  const img = el('img', 'avatar');
  img.src = A.imgUrl(rel);
  img.loading = 'lazy';
  img.decoding = 'async';
  // A file that exists but won't decode must not leave an empty circle — the initial belongs
  // there again, which is the same rule the placeholder follows.
  img.onerror = () => {
    if (name) img.replaceWith(el('div', 'avatar ph', String(name).slice(0, 1)));
    else img.remove();
  };
  return img;
}

async function resolveAvatars(names, done) {
  const ask = names.filter((n) => avatarPaths[n] === undefined);
  if (!ask.length) return;
  const gen = avatarGen;
  let found = {};
  try {
    found = await A.actorPaths(ask);
  } catch {
    return;
  }
  if (gen !== avatarGen) {
    if (done) done();
    else renderFacets();
    return;
  }
  for (const n of ask) {
    let ref = found[n] || null;
    if (!ref) {
      // After a merge the wall asks under the surviving name while the picture may still
      // sit under the spelling that was folded away — or the other way round on a card.
      for (const alt of spellingsOf(canonActor(n))) {
        if (found[alt]) {
          ref = found[alt];
          break;
        }
      }
    }
    avatarPaths[n] = ref;
  }
  if (done) done();
  else renderFacets();
}

async function refreshAvatarStat() {
  let cov = { have: 0, total: 0, imported: [] };
  try {
    cov = await A.actorCoverage();
  } catch {
    $('#stAvatars').textContent = '头像 未配置目录';
    return cov;
  }
  $('#stAvatars').textContent = `头像 ${cov.have} / ${cov.total}`;
  if (cov.imported && cov.imported.length) setStatus(`从收件箱导入 ${cov.imported.length} 张头像`);
  forgetAvatarLookups();
  return cov;
}

async function refreshAvatars() {
  const cov = await refreshAvatarStat();
  renderFacets();
  render();
  if (state.detailCode && !$('#detail').classList.contains('hidden')) await openDetail(state.detailCode);
  return cov;
}

// Right-click on a performer in the sidebar.
function actorMenu(x, y, name, count) {
  const prof = state.idolMap.get(name);
  ctxMenu(x, y, [
    { label: '编辑资料', fn: () => idolModal(name, count) },
    {
      label: '上传头像（可裁切）…',
      hint: '选一张图，裁成 3:4 后作为她的头像',
      fn: async () => {
        try {
          const got = await pickAndCrop();
          if (!got) return;
          await A.actorSetFromData(name, got.data);
          // refreshAvatars, not just renderFacets: the wall and an open detail panel show the
          // same picture, and "it updated after I restarted the app" was the old symptom.
          await refreshAvatars();
          setStatus('已设置头像：' + name);
        } catch (e) {
          setStatus('头像设置失败：' + e.message, 7000);
        }
      }
    },
    {
      label: '下载官方头像',
      disabled: !prof || !prof.javdb_id,
      hint: prof && prof.javdb_id ? '从 JavDB 取她的官方照片' : '需先在资料管理里抓取并绑定 JavDB 编号',
      fn: async () => {
        try {
          const r = await A.javdbFetchAvatarFor(name);
          if (!r.done) return setStatus('没有可下载的头像（未绑定编号或本地已有）', 6000);
          await refreshAvatars();
          setStatus('已下载头像：' + name);
        } catch (e) {
          setStatus('下载失败：' + e.message, 7000);
        }
      }
    },
    { label: '在 JavDB 中打开', fn: () => A.javdbOpenEntity('actress', name).catch((e) => setStatus('打开失败：' + e.message, 6000)) },
    { label: '在二级界面查看', fn: () => pushFrame({ kind: 'entity', type: 'actress', name, page: 1 }) }
  ]);
}

/* ------------------------------------------------------------ 右键菜单 */

let ctxEl = null;
function closeCtx() {
  if (!ctxEl) return;
  ctxEl.remove();
  ctxEl = null;
  removeEventListener('pointerdown', ctxOff, true);
}
function ctxOff(e) {
  if (ctxEl && !ctxEl.contains(e.target)) closeCtx();
}

function ctxMenu(x, y, items) {
  closeCtx();
  const m = el('div', 'ctxmenu');
  for (const it of items.filter(Boolean)) {
    const b = el('button', null, it.label);
    if (it.disabled) b.disabled = true;
    if (it.hint) b.title = it.hint;
    b.onclick = (e) => {
      e.stopPropagation();
      closeCtx();
      it.fn && it.fn();
    };
    m.append(b);
  }
  m.style.left = x + 2 + 'px';
  m.style.top = y + 2 + 'px';
  document.body.append(m);
  const r = m.getBoundingClientRect();
  if (r.right > innerWidth) m.style.left = Math.max(4, innerWidth - r.width - 6) + 'px';
  if (r.bottom > innerHeight) m.style.top = Math.max(4, innerHeight - r.height - 6) + 'px';
  ctxEl = m;
  addEventListener('pointerdown', ctxOff, true);
  return m;
}

/* ------------------------------------------------------------- 裁切对话框 */

// The crop is 3:4 to match a poster/avatar tile. Panning and zooming are plain transforms on
// the preview; the export recomputes the same mapping onto a canvas so what he sees is what
// gets written, and only the finished bytes reach disk.
//
// One mapping() feeds the preview, the pan clamp and the export: three readers, one geometry.
// A very wide (or very tall) source under 3:4 used to be unreadable here — the box fills by
// height, so a banner ends up showing a slice a few percent of its width with no way back.
// Hence the slider floor is the "whole image visible" scale and the wheel works too.
function cropDialog(dataUrl, onOk, title, opts) {
  modal(title || '裁切图片', (m, shut) => {
    const view = el('div', 'cropview');
    const img = el('img');
    img.src = dataUrl;
    img.draggable = false;
    view.append(img);
    // In the DOM before anything measures it: the cover size comes from clientWidth/Height,
    // and a detached node would measure 0 and fall back to a hard-coded box.
    m.append(view);
    let scale = 1;
    let ox = 0;
    let oy = 0;
    let drag = null;
    let failed = false;

    const fitOf = () => {
      const vw = view.clientWidth || 260;
      const vh = view.clientHeight || 347;
      const iw = img.naturalWidth || vw;
      const ih = img.naturalHeight || vh;
      const cover = Math.max(vw / iw, vh / ih);
      return { vw, vh, iw, ih, cover, whole: Math.min(vw / iw, vh / ih) / cover };
    };
    // What the frame currently holds, in preview pixels.
    const mapping = () => {
      const g = fitOf();
      const s = g.cover * scale;
      const dw = g.iw * s;
      const dh = g.ih * s;
      return { ...g, s, dw, dh, dx: (g.vw - dw) / 2 + ox, dy: (g.vh - dh) / 2 + oy };
    };
    // A picture smaller than the frame on one axis is locked to center on that axis: otherwise
    // a drag can slide it clean out of the box and the save exports a black tile.
    const clampPan = () => {
      const g = fitOf();
      const lx = Math.max(0, (g.iw * g.cover * scale - g.vw) / 2);
      const ly = Math.max(0, (g.ih * g.cover * scale - g.vh) / 2);
      ox = Math.min(lx, Math.max(-lx, ox));
      oy = Math.min(ly, Math.max(-ly, oy));
    };

    const zoom = el('input');
    zoom.type = 'range';
    zoom.min = '1';
    zoom.max = '4';
    zoom.step = '0.02';
    zoom.value = '1';
    // One geometry: the element is laid out at its cover size and the frame clips it, so a
    // transform of `scale` draws exactly iw·cover·scale px — the same number mapping() gives the
    // canvas. `object-fit: cover` on the element could not do this: it crops inside the element
    // first, so zooming out only shrank an already-cropped strip (横图 never fit on screen).
    const layout = () => {
      const g = fitOf();
      const w = g.iw * g.cover;
      const h = g.ih * g.cover;
      img.style.width = w + 'px';
      img.style.height = h + 'px';
      img.style.left = (g.vw - w) / 2 + 'px';
      img.style.top = (g.vh - h) / 2 + 'px';
      return g;
    };
    const readout = el('span', 'num', '1.00');
    const apply = () => {
      clampPan();
      img.style.transform = `translate(${ox}px, ${oy}px) scale(${scale})`;
      zoom.value = String(Math.min(4, Math.max(Number(zoom.min), scale)));
      readout.textContent = scale.toFixed(2);
    };
    const setScale = (next, px, py) => {
      const g = fitOf();
      const lim = Math.min(4, Math.max(g.whole, next));
      if (px !== undefined) {
        // keep the pixel under the pointer pinned while the scale changes
        const k = lim / scale;
        ox = px - (px - ox) * k;
        oy = py - (py - oy) * k;
      }
      scale = lim;
      apply();
    };
    // The natural size is only known once the bytes decode; that is when the floor appears.
    const ready = () => {
      // build() runs before the dialog is in the DOM, so an already-decoded source would measure
      // a detached box. One frame later it is attached and the numbers are real.
      if (!view.clientWidth) {
        requestAnimationFrame(ready);
        return;
      }
      const g = layout();
      if (g.whole < 1) {
        zoom.min = String(g.whole);
        zoom.title = `可以缩到 ${Math.round(g.whole * 100)}% 看到整张图`;
      }
      apply();
    };
    // A bitmap Chromium refuses to decode (too large, unsupported) used to leave a black frame
    // with no reason and a 保存 button that exported pure black.
    img.onerror = () => {
      failed = true;
      zoom.disabled = true;
      view.append(el('div', 'failed', '这张图没能解码：可能过大或格式不支持。换一张原图再试。'));
    };
    img.onload = ready;
    if (img.complete) ready();
    zoom.oninput = () => setScale(Number(zoom.value));
    // The wheel has to be handled here or the modal just scrolls under it.
    view.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = view.getBoundingClientRect();
        const cx = e.clientX - r.left - r.width / 2;
        const cy = e.clientY - r.top - r.height / 2;
        setScale(scale * Math.pow(1.0015, -e.deltaY), cx, cy);
      },
      { passive: false }
    );
    view.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX - ox, y: e.clientY - oy };
      try {
        view.setPointerCapture(e.pointerId);
      } catch {
        /* 合成事件与已经放开的指针都会走到这里，拖动本身照常 */
      }
    });
    view.addEventListener('pointermove', (e) => {
      if (!drag) return;
      ox = e.clientX - drag.x;
      oy = e.clientY - drag.y;
      apply();
    });
    const stop = () => {
      drag = null;
    };
    view.addEventListener('pointerup', stop);
    view.addEventListener('pointercancel', stop);

    const zrow = el('div', 'row');
    zrow.append(el('span', 'hint', '缩放'), zoom, readout);
    m.append(zrow);
    const trow = el('div', 'row');
    const fillBtn = el('button', 'ghost', '填满框');
    fillBtn.title = '放大到刚好盖住这一框（保存出去没有黑边）';
    fillBtn.onclick = () => setScale(1);
    const wholeBtn = el('button', 'ghost', '看全图');
    wholeBtn.title = '缩小到整张图都在框里（横图 / 长条图先用这个找到位置）';
    wholeBtn.onclick = () => setScale(fitOf().whole);
    trow.append(fillBtn, wholeBtn, el('span', 'hint', '滚轮缩放，拖动调整位置'));
    m.append(trow);

    // Only the cover picker offers this, and it is unchecked: writing into his folder means
    // replacing the cover he downloaded, so it has to be a thing he asked for.
    let folderBox = null;
    if (opts && opts.folderLabel) {
      const line = el('div', 'row');
      folderBox = el('input');
      folderBox.type = 'checkbox';
      const lab = el('label', 'hint');
      lab.append(folderBox, el('span', null, opts.folderLabel));
      lab.title = opts.folderHint || '';
      line.append(lab);
      m.append(line);
    }

    const row = el('div', 'row');
    const ok = el('button', 'ghost primary', '保存');
    ok.onclick = () => {
      if (failed) {
        setStatus('这张图没能解码，先换一张', 6000);
        return;
      }
      const [W, H] = (opts && opts.size) || [300, 400];
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#000';
      g.fillRect(0, 0, W, H);
      const p = mapping();
      const k = W / p.vw;
      g.drawImage(img, p.dx * k, p.dy * k, p.dw * k, p.dh * k);
      onOk(c.toDataURL('image/png'), { folder: !!(folderBox && folderBox.checked) });
      shut();
    };
    const cancel = el('button', 'ghost', '取消');
    cancel.onclick = shut;
    row.append(ok, cancel);
    m.append(row);
  });
}

// Pick a file, then crop it before anything is written. Returns { data, folder } — the
// second field is the tick-box state, so only this one call site decides whether his folder
// gets overwritten.
async function pickAndCrop(opts) {
  const file = await A.pickImageFile();
  if (!file) return null;
  const data = await A.readImageAsData(file);
  return new Promise((resolve) => {
    cropDialog(
      data,
      (out, flags) => resolve({ data: out, folder: !!(flags && flags.folder) }),
      opts && opts.title,
      opts
    );
  });
}

/* ------------------------------------------------------------- 二级界面 */

// A stack of frames over the home wall. Home stays exactly as it was — the sidebar still
// filters the poster wall — and these pages are an additional route on top of it.
const SECONDARY = {
  actress: { label: '女优', field: 'movie_演员', entityKind: null },
  studio: { label: '片商', field: 'movie_制作', entityKind: 'studio' },
  series: { label: '系列', field: 'movie_系列', entityKind: 'series' }
};

// Whose films these are. For 女优 a credit written under a merged-away spelling counts
// for the surviving name too, so the tile's number and the list behind it always agree.
function entityRows(type, name) {
  const field = SECONDARY[type].field;
  return state.rows.filter((r) => {
    const names = SPLIT(clean(r[field])).map((s) => s.trim()).filter(Boolean);
    return type === 'actress' ? names.some((n) => canonActor(n) === name) : names.includes(name);
  });
}

function navTop() {
  return state.nav[state.nav.length - 1] || { kind: 'home' };
}
function inSecondary() {
  return navTop().kind !== 'home';
}
function pushFrame(f) {
  if (!$('#detail').classList.contains('hidden')) closeDetail();
  closeDrawer({ focus: false });
  state.nav.push(f);
  render();
}
function popFrame() {
  if (!state.nav.length) return;
  closeDrawer({ focus: false });
  state.nav.pop();
  render();
}

async function loadEntities() {
  try {
    state.entities.studio = await A.entityList('studio');
    state.entities.series = await A.entityList('series');
  } catch {
    state.entities = { studio: [], series: [] };
  }
}

// Names grouped out of the wall itself, so a library toggle changes these lists immediately.
function entityEntries(type) {
  const spec = SECONDARY[type];
  if (!spec) return [];
  const byName = new Map();
  for (const r of state.rows) {
    const names = SPLIT(clean(r[spec.field])).map((s) => s.trim()).filter(Boolean);
    // One person, one tile: the merged-away spellings fold into the surviving name here,
    // the same way the sidebar list already counts them.
    const keys = type === 'actress' ? [...new Set(names.map(canonActor))] : names;
    for (const name of keys) {
      const date = String(r.movie_日期 || '').trim();
      const code = String(r.movie_编码 || '');
      const cur = byName.get(name) || { name, count: 0, code: '', date: '', cands: [] };
      cur.count++;
      if (code) cur.cands.push({ date, code });
      if (date && (!cur.date || date < cur.date)) {
        cur.date = date;
        cur.code = code;
      }
      byName.set(name, cur);
    }
  }
  const stored = spec.entityKind ? state.entities[spec.entityKind] || [] : [];
  const storedByName = new Map(stored.map((e) => [e.name, e]));
  const out = [...byName.values()];
  for (const e of out) {
    const s = storedByName.get(e.name);
    if (s) {
      e.cover = s.cover;
      e.javdbId = s.javdb_id;
      e.javdbUrl = s.javdb_url;
      if (s.default_code) {
        e.code = s.default_code;
        e.date = s.default_date;
      }
    }
    if (type === 'actress') {
      const p = state.idolMap.get(e.name);
      if (p) {
        if (p.cover) {
          e.cover = p.cover;
          e.coverIsAvatar = /^actor\//.test(p.cover);
        } else {
          e.cover = e.cover || '';
        }
        e.javdbId = e.javdbId || p.javdb_id;
        e.javdbUrl = e.javdbUrl || p.javdb_url;
        e.profile = p;
      }
    }
  }
  // The cover walls follow the same rule the sidebar uses: the actress wall tracks the chips
  // (key and direction), the other two track their own 显示设置 entry.
  const byNameCmp = (a, b) => a.name.localeCompare(b.name, 'ja');
  if (type === 'actress' && state.actorSort !== 'count') {
    const sign = actorSortSign();
    const key = state.actorSort;
    out.sort((a, b) => {
      const va = idolSortValue(a.name, key);
      const vb = idolSortValue(b.name, key);
      const na = !Number.isFinite(va);
      const nb = !Number.isFinite(vb);
      if (na && nb) return byNameCmp(a, b);
      if (na) return 1;
      if (nb) return -1;
      return key === 'name' ? sign * byNameCmp(a, b) : sign * (vb - va);
    });
  } else {
    const view = state.disp[type === 'actress' ? 'actor' : type] || {};
    const sign = view.sortDir === 'asc' ? -1 : 1;
    out.sort((a, b) => (view.sort === 'name' ? sign * byNameCmp(a, b) : sign * (b.count - a.count)) || byNameCmp(a, b));
  }
  return out;
}

// Covers are never copied into a separate folder: the default is the poster of the entity's
// earliest title, resolved through the same media path the wall uses.
async function coverSources(entries) {
  const codes = entries.map((e) => (!e.cover && e.code ? e.code : '')).filter(Boolean);
  const found = codes.length ? await A.resolve(codes) : {};
  // The earliest title often has no poster on disk while its later ones do; without this
  // fallback the tile stays an empty black box even though the wall's own cover editor
  // finds candidates for the same entity.
  const missing = entries.filter((e) => {
    if (e.cover) return false;
    const m = e.code ? found[e.code] : null;
    return !(m && m.poster);
  });
  if (missing.length) {
    const extra = new Set();
    for (const e of missing) {
      e.cands.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      for (const c of e.cands.slice(0, 12)) if (!found[c.code]) extra.add(c.code);
    }
    if (extra.size) Object.assign(found, await A.resolve([...extra]));
  }
  for (const e of entries) {
    if (e.cover) continue;
    let m = e.code ? found[e.code] : null;
    if (!(m && m.poster)) {
      m = null;
      for (const c of e.cands) {
        const mm = found[c.code];
        if (mm && mm.poster) { m = mm; break; }
      }
    }
    e.source = m && m.poster ? 'poster' : m && m.dir ? 'dir' : '';
    if (m && m.poster) e.posterRel = m.poster;
    e.fallback = m;
  }
  return entries;
}

function coverTile(type, e) {
  const tile = el('div', 'covtile');
  tile.dataset.name = e.name;
  const box = el('div', 'covimg');
  // 头像文件会被原地替换，同一路径必须有办法换 URL；mtime 标记由 actor:paths 按需给出，
  // 还没拿到时用本次会话的 avatarGen 代打，别为了它去逐个 stat。
  const rel = (e.coverIsAvatar ? avatarPaths[e.name] : '') || e.cover || avatarPaths[e.name] || e.posterRel || '';
  if (rel) {
    const img = el('img');
    img.loading = 'lazy';
    const fresh = /^actor\//.test(rel) && !rel.includes('?v=') ? rel + '?g=' + avatarGen : rel;
    img.src = A.imgUrl(fresh);
    // A dead sidecar used to leave the browser's broken-image glyph in the grid.
    img.onerror = () => {
      img.remove();
      if (!box.querySelector('.covph')) box.append(el('span', 'covph', e.name.slice(0, 2)));
    };
    box.append(img);
  } else {
    box.append(el('span', 'covph', e.name.slice(0, 2)));
  }
  tile.append(box);
  const meta = el('div', 'covmeta');
  meta.append(el('div', 'covname', e.name));
  meta.append(el('div', 'covcount', `${e.count} 部${e.date ? ' · ' + e.date : ''}`));
  tile.append(meta);

  const acts = el('div', 'covacts');
  const edit = el('button', 'ghost', '封面');
  edit.title = `编辑这个${SECONDARY[type].label}的封面`;
  edit.onclick = (ev) => {
    ev.stopPropagation();
    coverModal(type, e);
  };
  acts.append(edit);
  if (type === 'actress') {
    const info = el('button', 'ghost', '信息');
    info.title = '编辑资料（身高 / 生日 / 三围 / 罩杯）';
    info.onclick = (ev) => {
      ev.stopPropagation();
      idolModal(e.name, e.count);
    };
    acts.append(info);
  }
  // Always offered: an unbound entity resolves itself through one of its own titles on click.
  const open = el('button', 'ghost', 'JavDB');
  open.title = '在 JavDB 中打开';
  open.onclick = (ev) => {
    ev.stopPropagation();
    setStatus('正在 JavDB 查找…');
    A.javdbOpenEntity(SECONDARY[type].entityKind || 'actress', e.name)
      .then(() => setStatus('已在浏览器打开', 2500))
      .catch((err) => setStatus('打开失败：' + err.message, 6000));
  };
  acts.append(open);
  if (acts.children.length) tile.append(acts);

  const enter = () => pushFrame({ kind: 'entity', type, name: e.name, page: 1 });
  tile.onclick = enter;
  tile.tabIndex = 0;
  tile.setAttribute('role', 'button');
  tile.setAttribute('aria-label', `${SECONDARY[type].label}：${e.name}`);
  tile.onkeydown = (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      enter();
    }
  };
  return tile;
}

async function paintCovers(host, type) {
  const all = entityEntries(type);
  // Resolving a cover means a folder lookup per entity, so the wall is capped; the sidebar
  // filter stays the way to work through a long tail.
  const entries = await coverSources(all.slice(0, 400));
  const grid = el('div', 'covergrid');
  grid.dataset.kind = type;
  if (!entries.length) grid.append(el('p', 'hint', '这个视图还没有数据：库里的条目要先在 nfo 里写上' + SECONDARY[type].label + '。'));
  for (const e of entries) grid.append(coverTile(type, e));
  host.append(grid);
  if (all.length > entries.length) host.append(el('p', 'hint', `只显示前 ${entries.length} 个，共 ${all.length} 个。用左侧列表继续缩小范围。`));
  if (type === 'actress') resolveAvatars(entries.filter((e) => !e.cover || e.coverIsAvatar).map((e) => e.name).slice(0, 400), () => render());
}

async function paintEntityFilms(host, frame) {
  // filter() gives us a fresh array, so sorting it in place cannot reorder state.rows.
  const rows = sortRows(entityRows(frame.type, frame.name));
  const pages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  if (frame.page > pages) frame.page = pages;
  const slice = rows.slice((frame.page - 1) * state.pageSize, frame.page * state.pageSize);
  const grid = el('div', 'cardgrid');
  for (const r of slice) grid.append(makeCard(r));
  host.append(grid);
  const fresh = slice.map((r) => r.movie_编码).filter((c) => mediaCache[c] === undefined);
  if (fresh.length) resolveMedia(fresh);
  host.append(pagerFor(pages, frame.page, (p) => {
    frame.page = p;
    render();
  }));
}

function pagerFor(pages, page, go) {
  const bar = el('div', 'pager');
  const mk = (label, target, disabled, active) => {
    const b = el('button', null, label);
    if (disabled) b.disabled = true;
    if (active) b.classList.add('on');
    else b.onclick = () => go(target);
    return b;
  };
  bar.append(mk('首页', 1, page === 1), mk('‹', page - 1, page <= 1));
  const from = Math.max(1, Math.min(pages - 4, page - 2));
  for (let p = from; p <= Math.min(pages, from + 4); p++) bar.append(mk(String(p), p, false, p === page));
  bar.append(mk('›', page + 1, page >= pages), mk('末页', pages, page === pages));
  const info = el('span', 'pagerinfo', `第 ${page} / ${pages} 页`);
  bar.append(info);
  return bar;
}

function navBar(type, frame) {
  const bar = el('div', 'navbar2');
  const back = el('button', 'ghost back', '← 返回');
  back.onclick = () => popFrame();
  bar.append(back);
  bar.append(el('h2', 'navtitle', frame.kind === 'entity' ? `${SECONDARY[type].label}：${frame.name}` : `${SECONDARY[type].label}封面墙`));
  const count = el('span', 'navcount', frame.kind === 'entity' ? '' : `${entityEntries(type).length} 个`);
  bar.append(count);
  const spacer = el('span', 'navspacer');
  bar.append(spacer);
  if (frame.kind === 'covers') {
    const crawl = el('button', 'ghost', '绑定 JavDB 编号');
    crawl.title = '逐个片商/系列读取一次 JavDB，绑定后这里的 JavDB 按钮可直接打开';
    crawl.onclick = () => enrichJob(SECONDARY[type].entityKind ? 'entities' : 'idols');
    bar.append(crawl);
  }
  if (frame.kind === 'entity' && type === 'actress') {
    const prof = state.idolMap.get(frame.name);
    const films = entityRows('actress', frame.name).length;
    count.textContent = `${films} 部 · ` + (prof && prof.javdb_id ? `JavDB ${prof.javdb_id}` : '未绑定 JavDB');
    const bind = el('button', 'ghost', prof && prof.javdb_id ? '改绑 JavDB' : '绑定 JavDB');
    bind.title =
      prof && prof.javdb_url
        ? `当前：${prof.javdb_url}\n自动抓取认不出她时，把她的 JavDB 页地址贴进来就行`
        : '把她的 JavDB 女优页地址贴进来绑定；抓取认不出的（改名、没进目录、写法不同）就靠这一步';
    bind.onclick = () => idolModal(frame.name, films);
    bar.append(bind);
  }
  return bar;
}

async function renderSecondary() {
  const host = $('#secondary');
  const frame = navTop();
  const type = frame.type;
  $('#gridHost').classList.add('hidden');
  $('#subbar').classList.add('hidden');
  $('#emptyState').classList.add('hidden');
  host.classList.remove('hidden');
  $$('#wallEntries button').forEach((b) => b.classList.toggle('on', b.dataset.wall === type));
  host.textContent = '';
  host.append(navBar(type, frame));
  if (frame.kind === 'covers') await paintCovers(host, type);
  else await paintEntityFilms(host, frame);
}

/* ------------------------------------------------------------------ 抓取动作 */

function enrichJob(what) {
  const label = what === 'idols' ? '女优资料' : '片商/系列编号';
  setStatus(`开始抓取${label}…`);
  A.javdbEnrich(what)
    .then((r) => {
      setStatus(`抓取完成：${JSON.stringify(r.bound || {})}，失败 ${r.failed || 0}`);
      return loadEntities().then(loadIdols);
    })
    .then(() => render())
    .catch((e) => setStatus('抓取失败：' + e.message, 8000));
}

async function runLocalAvatarImport(arg) {
  try {
    const r = await A.actorImportLocal(arg);
    await refreshAvatars();
    setStatus(`头像导入：匹配 ${r.matched} / ${r.total}${r.missed.length ? '，未匹配示例见日志' : ''}`, 8000);
    if (r.missed.length) logNote(`未匹配的头像文件名：${r.missed.join('、')}`);
  } catch (e) {
    setStatus('导入失败：' + e.message, 8000);
  }
}

function logNote(msg) {
  const box = $('#logBox');
  if (box) box.append(el('div', 'logrow warn', msg));
}

/* ------------------------------------------------------------------- 日志 */

// One buffer, filled once at boot; the modal is just a view over it.
const logBuf = [];
let logSubscribed = false;

function paintLog(box) {
  box.textContent = '';
  if (!logBuf.length) box.append(el('p', 'hint', '暂时没有日志。抓取、入库和报错都会记在这里。'));
  for (const e of logBuf.slice().reverse()) {
    const row = el('div', 'logrow ' + e.level);
    row.append(el('span', 'logt', e.t), el('span', 'logl', e.level), el('span', 'logm', e.msg));
    box.append(row);
  }
}

function logModal() {
  if (!logSubscribed) {
    logSubscribed = true;
    A.onLogEntry((e) => {
      logBuf.push(e);
      const box = $('#logBox');
      if (box) paintLog(box);
    });
    A.logList().then((l) => {
      logBuf.push(...l);
      const box = $('#logBox');
      if (box) paintLog(box);
    });
  }
  modal('运行日志', (m) => {
    const box = el('div', 'logbox scroll-y');
    box.id = 'logBox';
    paintLog(box);
    m.append(box);
    const row = el('div', 'row');
    const refresh = el('button', 'ghost', '刷新');
    refresh.onclick = () => A.logList().then((l) => {
      logBuf.length = 0;
      logBuf.push(...l);
      paintLog(box);
    }).catch((e) => setStatus('读日志失败：' + ((e && e.message) || e), 6000));
    const clear = el('button', 'ghost', '清空');
    clear.onclick = async () => {
      if (!confirm('清空这份运行日志？\n\n它只是本次会话的备忘，不动库、不动文件，也不影响正在跑的作业。')) return;
      try {
        await A.logClear();
        logBuf.length = 0;
        paintLog(box);
        setStatus('日志已清空');
      } catch (e) {
        setStatus('清空失败：' + ((e && e.message) || e), 6000);
      }
    };
    row.append(refresh, clear);
    m.append(row);
  });
}

function wireEnrichProgress() {
  A.onEnrichProgress((p) => {
    jobKind = p.what || 'idols';
    showJob({ phase: 'progress', library: '抓取', mode: p.what === 'avatars' ? '头像' : p.what === 'idols' ? '女优资料' : '片商/系列', scanned: p.done, found: p.total, current: p.current });
  });
  A.onEnrichDone((p) => {
    showJob({ phase: 'done', library: '抓取', mode: p.what === 'avatars' ? '头像' : p.what === 'idols' ? '女优资料' : '片商/系列', scanned: p.done, found: p.total, ms: p.ms });
    setTimeout(() => hideJob(1500), 1400);
  });
}

async function coverModal(type, e) {
  const who = type === 'actress' ? '她' : '它';
  modal(`编辑封面 · ${e.name}`, async (body, shut) => {
    body.append(el('p', 'hint', `默认使用${who}发行最早那部作品的封面；也可以直接选一张本库其他影片的封面，或从磁盘导入一张图片。`));
    const grid = el('div', 'coverpick');
    const candidates = await coverCandidates(type, e);
    for (const c of candidates) {
      const t = el('div', 'cpick');
      const img = el('img');
      img.loading = 'lazy';
      img.src = A.imgUrl(c.rel);
      t.append(img);
      t.append(el('span', 'cpicklabel', c.label));
      t.onclick = async () => {
        try {
          await saveCover(type, e, c.rel);
          setStatus(`已设置 ${e.name} 的封面`);
          shut();
          render();
        } catch (err) {
          setStatus('封面设置失败：' + ((err && err.message) || err), 7000);
        }
      };
      grid.append(t);
    }
    body.append(grid);
    const row = el('div', 'row');
    const pick = el('button', 'ghost', '从文件导入并裁切…');
    pick.onclick = async () => {
      pick.disabled = true;
      try {
        // 和影片封面同一套裁切：同一个窗口里出现两种比例的封面没道理。
        const got = await pickAndCrop({ title: `裁切封面：${e.name}`, size: [600, 800] });
        if (!got) return;
        const rel = await A.importCover(type === 'actress' ? 'actor' : type, e.name, '', got.data);
        await saveCover(type, e, rel);
        setStatus('已导入封面');
        shut();
        render();
      } catch (err) {
        setStatus('封面导入失败：' + ((err && err.message) || err), 7000);
      } finally {
        pick.disabled = false;
      }
    };
    const clear = el('button', 'ghost', '恢复默认');
    clear.onclick = async () => {
      try {
        await saveCover(type, e, '');
        setStatus('已恢复为最早作品的封面');
        shut();
        render();
      } catch (err) {
        setStatus('恢复失败：' + ((err && err.message) || err), 7000);
      }
    };
    row.append(pick, clear);
    body.append(row);
  });
}

async function coverCandidates(type, e) {
  const spec = SECONDARY[type];
  const rows = state.rows
    .filter((r) => SPLIT(clean(r[spec.field])).map((s) => s.trim()).includes(e.name))
    .sort((a, b) => String(a.movie_日期 || '').localeCompare(String(b.movie_日期 || '')));
  const found = await A.resolve(rows.slice(0, 24).map((r) => r.movie_编码));
  const out = [];
  for (const r of rows.slice(0, 24)) {
    const m = found[r.movie_编码];
    if (m && m.poster) out.push({ rel: m.poster, label: `${r.movie_编码} · ${r.movie_日期 || ''}` });
  }
  return out;
}

async function saveCover(type, e, rel) {
  if (type === 'actress') await A.idolPatch(e.name, { cover: rel });
  else await A.entitySave(SECONDARY[type].entityKind, { name: e.name, cover: rel });
  await loadEntities();
  await loadIdols();
}

/* ------------------------------------------------------------- scan / ingest */

let jobKind = 'ingest';

function wireJobs() {
  A.onScanProgress((p) => {
    if (p.phase === 'warm') {
      // 预热是扫描的尾巴：借用任务条显示进度，停止按钮没有意义所以由 showJob 禁用。
      jobKind = 'warm';
      showJob(p);
      return;
    }
    jobKind = 'ingest';
    // repaintScan() re-reads the main-process status; painting from the cached
    // state.cfg would keep showing the boot-time count of 0.
    if (p.phase === 'scan' && p.scanned % 200 < 24) repaintScan();
  });
  A.onMediaResolved((map) => {
    const codes = [];
    for (const [c, entry] of Object.entries(map || {})) {
      mediaCache[c] = entry || null;
      pendingMedia.delete(c);
      codes.push(c);
    }
    paintResolved(codes);
  });
  A.onScanDone((p) => {
    if (jobKind === 'warm') hideJob(400);
    // 只有墙上这个库的扫描会改变卡片指向。别的库扫完就清空整墙重解析，
    // 三个本地库等于把首屏的慢目录重读三遍——它们和海报墙无关。
    if (!p || !p.library || p.library === state.activeLib) {
      for (const k of Object.keys(mediaCache)) delete mediaCache[k];
      pendingMedia.clear();
      render();
    }
    repaintScan();
  });
  A.onIngestProgress((p) => {
    jobKind = 'ingest';
    showJob(p);
  });
  A.onIngestDone((p) => {
    showJob({ ...p, phase: p.stopped ? 'stopped' : 'done' });
    setTimeout(() => hideJob(1500), 1200);
    reloadRows();
    repaintScan();
  });
}

async function repaintScan() {
  state.cfg = await A.settings();
  paintScan();
}

function paintScan() {
  const roots = state.cfg.scan || [];
  const total = roots.reduce((s, r) => s + r.entries, 0);
  const busy = roots.some((r) => r.scanning);
  // 一段网盘没读到不等于「库就这么大」；不说出来的话残缺索引就是新的真相。
  const holes = roots.reduce((s, r) => s + (r.unreadable || 0), 0);
  $('#stScan').textContent = `已索引文件 ${total}${busy ? ' · 定位中' : holes ? ` · ${holes} 处未读到` : ''}`;
}

async function updateScanStat() {
  const cfg = await A.settings();
  state.cfg = cfg;
  state.libraries = cfg.libraries;
  state.activeLib = cfg.activeLibrary;
  paintScan();
  renderLibPanel();
}

async function reloadRows() {
  const data = await A.allRows();
  state.rows = data.rows.map(derive);
  state.byCode = new Map(state.rows.map((r) => [r.movie_编码, r]));
  state.needsSetup = !state.rows.length;
  buildFacets();
  applyFilters();
  renderLibPanel();
}

let jobTimer = 0;
function showJob(p) {
  const box = $('#jobPanel');
  box.classList.remove('hidden');
  const pct = p.found ? Math.min(100, Math.round(((p.phase === 'read' ? p.scanned : p.scanned) / Math.max(1, p.found)) * 100)) : 0;
  box.textContent = '';
  const t = el('div', 't');
  t.append(el('b', null, `${p.library || ''} ${MODE_LABEL[p.mode] || '扫描'}`));
  const stop = el('button', 'ghost', '停止');
  // The panel serves both kinds of job; routing the button by what is actually running is
  // the difference between 停止 working and doing nothing.
  stop.onclick = async () => {
    const hit = jobKind === 'ingest' ? await A.ingestStop() : await A.javdbEnrichStop();
    if (!hit) setStatus('这一条已经跑完了，没什么可停的');
  };
  if (p.phase === 'done' || p.phase === 'warm' || p.phase === 'stopped') stop.disabled = true;
  t.append(stop);
  box.append(t);
  const bar = el('div', 'bar');
  const fill = el('i');
  fill.style.width = pct + '%';
  bar.append(fill);
  box.append(bar);
  const g = el('div', 'grid');
  const cell = (k, v) => {
    const c = el('div');
    c.append(el('b', null, String(v ?? 0)), ' ' + k);
    g.append(c);
  };
  if (p.phase === 'warm') {
    cell('已缓存', p.scanned);
    cell('共', p.found);
  } else {
    cell('已扫', p.scanned);
    cell('发现', p.found);
    cell('新增', p.added);
    cell('更新', p.updated);
    cell('删除', p.deleted);
    cell('跳过', p.skipped);
    // 那段网盘没读到,所以这些行不是「删了」而是「没敢删」。
    if (p.shielded) cell('待确认', p.shielded);
  }
  box.append(g);
  if (p.current) box.append(el('div', 'cur', p.current));
  else if (p.root) box.append(el('div', 'cur', p.root));
  else if (p.phase === 'walked') box.append(el('div', 'cur', `定位完成，共 ${p.found} 个条目`));
  else if (p.phase === 'stopped') box.append(el('div', 'cur', '已停止：这次按「消失即删」的部分没有执行，库里没删任何东西'));
  if (p.shielded) box.append(el('div', 'cur', `${p.shielded} 行所在目录这次没读到，按原样保留`));
  if (p.error) box.append(el('div', 'cur', '出错：' + p.error));
  clearTimeout(jobTimer);
  jobTimer = setTimeout(hideJob, 60000);
}

function hideJob(ms = 0) {
  setTimeout(() => $('#jobPanel').classList.add('hidden'), ms);
}

const MODE_LABEL = { full: '覆盖刷新', append: '新增刷新', delta: '删改刷新', warm: '缓存预热' };

// A library that was just pointed at folders should fill itself without a second click.
async function autoIngest() {
  for (const lib of state.libraries) {
    if (lib.enabled === false || lib.store !== 'shelf' || !lib.dirs.length) continue;
    const mine = state.rows.filter((r) => r._lib === lib.name).length;
    if (mine) continue;
    setStatus(`${lib.name} 还没有条目，正在读取 nfo…`, 6000);
    try {
      await A.ingestRun(lib.name, 'append');
    } catch (e) {
      setStatus('扫描失败：' + e.message, 8000);
    }
    return;
  }
}

async function runIngest(name, mode) {
  try {
    await A.ingestRun(name, mode);
  } catch (e) {
    setStatus('刷新失败：' + e.message, 8000);
  }
}

/* ------------------------------------------------------------------- pager */

function paintPager(pages) {
  const host = $('#pager');
  host.textContent = '';
  if (state.waterfall) {
    // A page number would be a lie here: the wall grows downward as you scroll.
    const loaded = Math.min(state.view.length, state.page * state.pageSize);
    const tail = state.page < pages ? '下滑继续加载' : '已全部加载';
    host.append(el('span', 'pagerinfo', `已加载 ${loaded} / ${state.view.length} 部 · ${tail}`));
    return;
  }
  const at = state.page;
  const go = (p) => {
    state.page = Math.max(1, Math.min(pages, p));
    render();
    $('#gridHost').scrollTop = 0;
  };
  const btn = (label, target, opts = {}) => {
    const b = el('button', opts.on ? 'on' : '', label);
    if (opts.disabled) b.disabled = true;
    else b.onclick = () => go(target);
    host.append(b);
  };
  btn('首页', 1, { disabled: at === 1 });
  btn('«', at - 10, { disabled: at <= 10 });
  btn('‹', at - 1, { disabled: at === 1 });
  const lo = Math.max(1, at - 2);
  const hi = Math.min(pages, lo + 4);
  for (let p = lo; p <= hi; p++) btn(String(p), p, { on: p === at });
  btn('›', at + 1, { disabled: at === pages });
  btn('»', at + 10, { disabled: at + 10 > pages });
  btn('末页', pages, { disabled: at === pages });
  const jump = el('input');
  jump.type = 'number';
  jump.min = '1';
  jump.max = String(pages);
  jump.value = String(at);
  jump.onchange = () => go(Number(jump.value) || 1);
  host.append(jump);
}

function updateBar() {
  const pages = Math.max(1, Math.ceil(state.view.length / state.pageSize));
  const text = state.waterfall
    ? `${state.view.length} / ${state.rows.length} 部 · 已加载 ${Math.min(state.view.length, state.page * state.pageSize)}`
    : `${state.view.length} / ${state.rows.length} 部 · 第 ${state.page}/${pages} 页`;
  $('#stCount').textContent = text;
  $('#stCount2').textContent = text;
}

/* ------------------------------------------------------------------ detail */

function syncWorkspace() {
  const secondary = inSecondary();
  const frame = navTop();
  const favorites = state.rows.filter(r => r._fav).length;
  $('#libraryIntro').classList.toggle('hidden', secondary);
  $('#quickFilters').classList.toggle('hidden', secondary);
  $('#workspaceCrumb').textContent = secondary ? (frame.name || SECONDARY[frame.type].label + '目录') : state.filters.quick === 'fav' ? '我的收藏' : '全部影片';
  $('#workspaceTitle').textContent = state.filters.quick === 'fav' ? '我的收藏' : '我的媒体库';
  $('#metricTotal').textContent = state.rows.length.toLocaleString();
  $('#metricFavorites').textContent = favorites.toLocaleString();
  $('#metricUnseen').textContent = state.rows.filter(r => !r._seen).length.toLocaleString();
  for (const [id, on] of [
    ['metricTotal', !secondary && state.filters.quick === 'all'],
    ['metricFavorites', !secondary && state.filters.quick === 'fav'],
    ['metricUnseen', !secondary && state.filters.quick === 'unseen']
  ]) {
    const b = $('#' + id);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  }
  $('#navTotal').textContent = state.rows.length.toLocaleString();
  $('#navFavCount').textContent = favorites.toLocaleString();
  for (const [id, on] of [['navHome', !secondary && state.filters.quick !== 'fav'], ['navFavorites', !secondary && state.filters.quick === 'fav']]) {
    const b = $('#' + id);
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  $$('#wallEntries button').forEach(b => {
    b.classList.toggle('on', secondary && b.dataset.wall === frame.type);
    if (secondary && b.dataset.wall === frame.type) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const count = ['actor', 'category', 'studio', 'series', 'year', 'code'].reduce((n, key) => n + state.filters[key].size, 0);
  $('#btnFilters').textContent = count ? `筛选 · ${count}` : '筛选';
  if (state.detailCode && !state.byCode.has(state.detailCode)) closeAllDetails();
}

function setFiltersOpen(open) {
  if (open) closeDrawer({ focus: false });
  $('#filterPanel').classList.toggle('hidden', !open);
  $('#btnFilters').classList.toggle('on', open);
  $('#btnFilters').setAttribute('aria-expanded', String(open));
  if (!open && $('#filterPanel').contains(document.activeElement)) $('#btnFilters').focus();
}

function paintSelection() {
  for (const c of $$('#gridItems .card, #secondary .card')) c.classList.toggle('sel', c.dataset.code === state.detailCode);
}

/* The right drawer is an overlay, not a column: the wall keeps its full width and the
   drawer floats above it. It only exists after a poster is clicked. */
const DRAWER_MIN = 360;
const DRAWER_MAX = 560;
const DRAWER_DEFAULT = 420;
let drawerRequest = 0;

function storedDrawerWidth() {
  const n = Math.round(Number(localStorage.getItem('javshelf.drawerWidth')));
  return Number.isFinite(n) && n > 0 ? Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, n)) : DRAWER_DEFAULT;
}

function syncDrawerInset(width) {
  const host = $('#inspector');
  const open = host && !host.classList.contains('hidden');
  document.documentElement.style.setProperty('--drawer-w', open ? (width || storedDrawerWidth()) + 'px' : '0px');
}

function setDrawerWidth(width, persist) {
  const w = Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, Math.round(width)));
  const host = $('#inspector');
  if (host) host.style.width = w + 'px';
  syncDrawerInset(w);
  if (persist) localStorage.setItem('javshelf.drawerWidth', String(w));
  return w;
}

const drawerBody = () => $('#inspector .drawer-body');
const drawerHero = () => $('#inspector .drawer-hero');
const drawerToolbar = () => $('#inspector .drawer-toolbar');

// What 上一部/下一部 walks: the whole filtered wall on the home page, and the cards
// currently drawn on a secondary page (that page owns its own paging).
function drawerSequence() {
  if (inSecondary()) return $$('#secondary .card').map((c) => c.dataset.code).filter(Boolean);
  return state.view.map((r) => String(r.movie_编码));
}

function inspectCode(code) {
  if (!matchMedia('(min-width: 901px)').matches) return openDetail(code);
  openDrawer(code);
}

async function openDrawer(code, opts = {}) {
  if (!matchMedia('(min-width: 901px)').matches) return;
  // 筛选 and the drawer compete for the same narrow strip; opening one closes the other.
  if (!$('#filterPanel').classList.contains('hidden')) setFiltersOpen(false);
  state.detailCode = code;
  paintSelection();
  const host = $('#inspector');
  const body = drawerBody();
  const request = ++drawerRequest;
  const held = host.contains(document.activeElement) ? document.activeElement.dataset.inspect : null;
  const focusKey = opts.focusKey || held || null;
  host.classList.remove('hidden');
  setDrawerWidth(storedDrawerWidth(), false);
  drawerHero().textContent = '';
  drawerToolbar().textContent = '';
  body.textContent = '';
  body.append(el('div', 'drawer-loading hint', '读取中…'));;
  let r;
  try {
    r = await A.row(code, state.byCode.get(code) && state.byCode.get(code)._lib);
  } catch (error) {
    if (request === drawerRequest) body.textContent = '读取失败：' + error.message;
    return;
  }
  if (request !== drawerRequest || state.detailCode !== code || host.classList.contains('hidden')) return;
  if (!r) {
    body.textContent = '未找到记录';
    return;
  }
  paintDrawer(r, code, focusKey);
  if (!focusKey && !opts.background) {
    (host.querySelector('[data-inspect="full"]') || host.querySelector('.drawer-close') || host).focus();
  }
}

function refreshDrawer() {
  const code = state.detailCode;
  if (!code || $('#inspector').classList.contains('hidden')) return;
  openDrawer(code, { background: true });
}

function closeDrawer(opts = {}) {
  const host = $('#inspector');
  const code = state.detailCode;
  if (host.classList.contains('hidden') && !code) return;
  drawerRequest++;
  host.classList.add('hidden');
  syncDrawerInset(0);
  const body = drawerBody();
  if (body) body.textContent = '';
  const hero = drawerHero();
  if (hero) hero.textContent = '';
  const toolbar = drawerToolbar();
  if (toolbar) toolbar.textContent = '';
  state.detailCode = null;
  paintSelection();
  if (opts.focus !== false) {
    const card = $$('#secondary .card, #gridItems .card').find(c => c.dataset.code === code && c.offsetParent !== null);
    (card || $('#navHome')).focus();
  }
}

// ≤900px 下抽屉被 CSS 收起。如果只是视觉上藏着，把它放大回来会冒出一份过期的详情，
// 所以跨过断点时就连同状态一起清掉；全屏详情打开时 detailCode 归它继续用。
function retireDrawer() {
  const host = $('#inspector');
  if (host.classList.contains('hidden')) return;
  const code = state.detailCode;
  const hadFocus = host.contains(document.activeElement);
  drawerRequest++;
  host.classList.add('hidden');
  syncDrawerInset(0);
  drawerBody().textContent = '';
  drawerHero().textContent = '';
  drawerToolbar().textContent = '';
  if ($('#detail').classList.contains('hidden')) {
    state.detailCode = null;
    paintSelection();
    if (hadFocus) {
      const card = $$('#secondary .card, #gridItems .card').find(c => c.dataset.code === code && c.offsetParent !== null);
      (card || $('#navHome')).focus();
    }
  }
}

const wideViewport = matchMedia('(min-width: 901px)');
wideViewport.addEventListener('change', (event) => {
  if (!event.matches) retireDrawer();
});

function paintDrawer(r, code, focusKey) {
  const host = $('#inspector');
  const hero = drawerHero();
  const body = drawerBody();
  hero.textContent = '';
  const toolbar = drawerToolbar();
  toolbar.textContent = '';
  body.textContent = '';

  const m = r._media || mediaCache[code] || null;
  if (m) mediaCache[code] = m;
  const cover = el('div', 'drawer-cover');
  const ambient = el('div', 'drawer-cover-ambient');
  const image = el('img');
  image.alt = code + ' 封面';
  // The folder's wide fanart heads the drawer, as it did in 1.8.1; the poster is the
  // fallback because a portrait crop would hide most of a landscape shot. The old
  // per-code fanart cache is the last resort for rows the scanner could not resolve.
  const picks = [];
  if (m) {
    if (m.fanart) picks.push({ rel: m.fanart, fanart: true });
    if (m.poster) picks.push({ rel: m.poster });
    if (m.thumb) picks.push({ rel: m.thumb });
  } else {
    picks.push({ rel: fanartRel(code), fanart: true }, { rel: posterRel(code) });
  }
  if (!picks.length) picks.push({ rel: posterRel(code) });
  let at = 0;
  const showCover = (pick) => {
    cover.classList.toggle('is-fanart', !!pick.fanart);
    hero.classList.toggle('is-fanart', !!pick.fanart);
    const url = A.imgUrl(pick.rel);
    image.src = url;
    ambient.style.backgroundImage = 'url("' + url.replace(/"/g, '%22') + '")';
  };
  showCover(picks[at++]);
  image.onerror = () => {
    if (at < picks.length) return void showCover(picks[at++]);
    cover.classList.remove('is-fanart');
    hero.classList.remove('is-fanart');
    image.remove();
    ambient.remove();
    cover.textContent = '暂无封面';
  };
  cover.append(ambient, image);
  hero.append(cover);

  const close = el('button', 'drawer-close', '×');
  close.setAttribute('aria-label', '关闭影片详情');
  close.title = '关闭影片详情';
  close.onclick = () => closeDrawer();
  hero.append(close);

  // Controls live below the art, not on it: a bare close cross is all the fanart carries.
  const seq = drawerSequence();
  const slotAt = seq.indexOf(String(code));
  if (slotAt >= 0 && seq.length > 1) {
    const step = (key, target, glyph, label) => {
      const b = el('button', 'ghost drawer-step ' + key, glyph);
      b.dataset.inspect = key;
      b.setAttribute('aria-label', label);
      b.disabled = !target;
      b.title = target
        ? (key === 'prev' ? '上一部：' : '下一部：') + target
        : key === 'prev' ? '已经是第一部' : '已经是最后一部';
      if (target) b.onclick = () => openDrawer(target, { focusKey: key });
      return b;
    };
    toolbar.append(
      step('prev', seq[slotAt - 1], '‹', '上一部'),
      el('span', 'drawer-pos', `${slotAt + 1} / ${seq.length}`),
      step('next', seq[slotAt + 1], '›', '下一部')
    );
  }
  const full = el('button', 'ghost primary drawer-full', '放大查看 ↗');
  full.dataset.inspect = 'full';
  full.title = '打开完整详情';
  full.onclick = () => openDetail(code);
  toolbar.append(el('span', 'drawer-spacer'), full);

  const { node, needAvatar } = detailContent(r, code);
  body.append(node);
  if (needAvatar.length) {
    resolveAvatars(needAvatar, () => {
      if (state.detailCode === code && !$('#inspector').classList.contains('hidden')) refreshDrawer();
    });
  }
  if (focusKey) {
    let target = host.querySelector(`[data-inspect="${focusKey}"]`);
    // Stepping onto the first/last film disables the button just used; move to its
    // neighbour instead of dropping focus into a removed node.
    if (!target || target.disabled) {
      target =
        host.querySelector(`[data-inspect="${focusKey === 'prev' ? 'next' : 'prev'}"]`) ||
        host.querySelector('[data-inspect="full"]');
    }
    target?.focus();
  }
}

let detailRequest = 0;
let detailReturnFocus = null;

function closeAllDetails() {
  closeDetail();
  closeDrawer({ focus: false });
}

// One builder for the overlay and the drawer: the two must never drift apart, and every
// action that exists in one has to exist in the other.
function detailContent(r, code) {
  const acts = SPLIT(r.movie_演员);
  const cats = SPLIT(r.movie_类别);
  const m = r._media || mediaCache[code] || null;
  if (m) mediaCache[code] = m;
  const stills = m ? [m.fanart, m.poster, m.thumb].filter(Boolean) : [];
  const body = el('div', 'body');
  body.append(el('div', 'code-line', code));
  const filmName = clean(r.movie_片名 || '');
  if (filmName && filmName !== code) body.append(el('h2', null, filmName));
  const rate = Number(r.movie_评分) || 0;
  body.append(el('div', 'stars', [
    rate ? '★'.repeat(Math.round(rate / 2)) + ' ' + rate.toFixed(1) : '',
    r.movie_日期 || '',
    r.movie_时长 ? r.movie_时长 + ' 分钟' : ''
  ].filter(Boolean).join('   ')));

  const needAvatar = [];
  const pillRow = el('div', 'pillrow');
  for (const a of acts) {
    const one = el('span', 'pill actorline');
    if (avatarPaths[a]) one.append(avatarImg(avatarPaths[a], a));
    else {
      if (avatarPaths[a] !== null) needAvatar.push(a);
      one.append(el('span', 'ph'));
    }
    one.append(el('span', null, a));
    // The label keeps the nfo's own spelling; where it leads is the person she is now.
    const who = canonActor(a);
    one.onclick = () => {
      closeAllDetails();
      state.nav = [];
      state.filters.actor = new Set([who]);
      applyFilters();
    };
    one.oncontextmenu = (e) => {
      e.preventDefault();
      idolModal(who);
    };
    one.title = '点击：在首页筛选她 · 右键：编辑女优资料';
    const go = el('b', 'pillgo', '▸');
    go.title = '在二级界面查看她';
    go.onclick = (ev) => {
      ev.stopPropagation();
      pushFrame({ kind: 'entity', type: 'actress', name: who, page: 1 });
    };
    one.append(go);
    pillRow.append(one);
  }
  body.append(pillRow);

  const kv = el('div', 'kv');
  const put = (k, v) => {
    if (!v) return;
    kv.append(el('i', null, k), el('span', null, v));
  };
  // 制作/系列 jump into the secondary page; the home filter stays where it was.
  const putLink = (k, v, type) => {
    if (!v) return;
    kv.append(el('i', null, k));
    const s = el('span', 'linkval', v);
    s.title = `在二级界面查看${SECONDARY[type].label}封面墙`;
    s.onclick = () => pushFrame({ kind: 'entity', type, name: v, page: 1 });
    kv.append(s);
  };
  putLink('制作', r.movie_制作, 'studio');
  put('发行', r.movie_发行);
  put('导演', r.movie_导演);
  putLink('系列', clean(r.movie_系列), 'series');
  put('片长', r.movie_时长 && r.movie_时长 + ' 分钟');
  put('库', r.only_code && r._lib);
  put('状态', [truthy(r.state_已看) ? '已看' : '未看', truthy(r.state_收藏) ? '收藏' : '', truthy(r.state_字幕) ? '字幕' : ''].filter(Boolean).join(' / '));
  put('更新', r.state_更新);
  body.append(kv);

  const catRow = el('div', 'pillrow');
  for (const c of cats.slice(0, 40)) {
    const p = el('span', 'pill', c);
    p.onclick = () => {
      closeAllDetails();
      state.nav = [];
      state.filters.category = new Set([c]);
      applyFilters();
    };
    catRow.append(p);
  }
  body.append(catRow);

  const actions = el('div', 'actions');
  const btn = (label, fn, primary, key) => {
    const b = el('button', 'ghost' + (primary ? ' primary' : ''), label);
    if (key) b.dataset.inspect = key;
    b.onclick = fn;
    actions.append(b);
    return b;
  };
  btn('▶ 播放', () => playCode(code), true, 'play');
  btn(truthy(r.state_收藏) ? '★ 取消收藏' : '☆ 收藏', () => toggleState(code, 'state_收藏'), false, 'fav').setAttribute('aria-pressed', String(truthy(r.state_收藏)));
  btn(truthy(r.state_已看) ? '标记未看' : '标记已看', () => toggleState(code, 'state_已看'), false, 'seen').setAttribute('aria-pressed', String(truthy(r.state_已看)));
  btn('更多操作', () => quickMenu(code), false, 'more');
  btn('打开目录', () => revealDir((m && m.dir) || '', '还没定位到这个条目所在的文件夹'));
  btn('复制路径', async () => {
    if (!m) return setStatus('还没定位到文件', 4000);
    navigator.clipboard.writeText(m.video || m.dir);
    setStatus('已复制文件路径', 2000);
  });
  if (m && m.nfo) btn('编辑信息(nfo)', () => nfoModal(code, m.nfo, { lib: r._lib, onlyCode: r.only_code }));
  // Crawling stays opt-in per title: these two never run on their own.
  btn('在浏览器中打开', async () => {
    setStatus('正在 JavDB 查找 ' + code + '…');
    try {
      const info = await A.javdbVideo(code);
      if (!info) return setStatus('JavDB 上没有搜到这个番号', 5000);
      await A.javdbOpen(info.url);
      setStatus('已在浏览器打开 ' + code, 3000);
    } catch (e) {
      setStatus('打开失败：' + e.message, 6000);
    }
  });
  if (m && m.nfo)
    btn('从 JavDB 覆写 nfo', async () => {
      setStatus('正在抓取 ' + code + ' 并覆写 nfo…');
      try {
        const res = await A.javdbApplyNfo(code);
        const i = res.info;
        setStatus(
          res.written.changed
            ? `已覆写：${i.studio || '—'} / ${i.series || '—'} / ${i.date || '—'} / 女优 ${res.actresses.length} 人`
            : 'JavDB 的内容与本地 nfo 一致，未改动',
          8000
        );
        await reloadRows();
        await loadEntities();
        applyFilters();
        refreshDrawer();
      } catch (e) {
        setStatus('覆写失败：' + e.message, 8000);
      }
    });
  body.append(actions);

  const where = el('div', 'kv pathline');
  where.append(el('i', null, '位置'), el('span', null, m ? m.dir : '未在库文件夹中找到（可能仍在扫描）'));
  body.append(where);

  if (stills.length) {
    body.append(el('p', 'hint', `剧照 ${stills.length} 张（点击看大图）`));
    const strip = el('div', 'stills');
    stills.forEach((rel, n) => {
      const im = el('img');
      im.src = A.imgUrl(rel);
      im.loading = 'lazy';
      im.decoding = 'async';
      im.alt = '剧照 ' + (n + 1);
      im.onclick = () => lightbox(stills, n);
      strip.append(im);
    });
    body.append(strip);
  }

  body.append(el('div', 'desc', clean(r.movie_源简)));
  return { node: body, m, stills, needAvatar };
}

async function openDetail(code, opts = {}) {
  const request = ++detailRequest;
  const row = state.byCode.get(code);
  const drawerWasHidden = $('#inspector').classList.contains('hidden');
  const priorCode = state.detailCode;
  state.detailCode = code;
  const host = $('#detail');
  const opening = host.classList.contains('hidden');
  const focusLabel = host.contains(document.activeElement) ? document.activeElement.textContent : '';
  if (opening) detailReturnFocus = document.activeElement;
  host.classList.remove('hidden');
  $('#detailBackdrop').classList.remove('hidden');
  $('#appShell').inert = true;
  host.textContent = '';
  const hero = el('div', 'hero');
  const close = el('button', 'ghost close', '×');
  close.setAttribute('aria-label', '关闭完整详情');
  close.onclick = closeDetail;
  hero.append(close);
  const loading = el('div', 'body hint', '读取中…');
  host.append(hero, loading);
  if (opening) close.focus();
  paintSelection();
  // Double-click/Enter opens the overlay, but the record behind it stays inspectable:
  // closing the overlay returns to the same drawer.
  if (drawerWasHidden || priorCode !== code || opts.refreshDrawer) openDrawer(code, { background: true });
  let r;
  try {
    r = await A.row(code, row && row._lib);
  } catch (error) {
    if (request === detailRequest) loading.textContent = '读取失败：' + error.message;
    return;
  }
  if (request !== detailRequest || state.detailCode !== code || host.classList.contains('hidden')) return;
  if (!r) {
    loading.textContent = '未找到记录';
    return;
  }
  loading.remove();
  const m = r._media || mediaCache[code] || null;
  if (m) mediaCache[code] = m;
  const bg = el('img');
  bg.alt = code + ' 封面';
  bg.src = A.imgUrl((m && (m.fanart || m.poster)) || fanartRel(code));
  bg.onerror = () => bg.remove();
  hero.prepend(bg);

  const { node: body, needAvatar } = detailContent(r, code);
  host.append(body);
  if (needAvatar.length) {
    resolveAvatars(needAvatar, () => {
      if (state.detailCode === code && !$('#detail').classList.contains('hidden')) openDetail(code, { refreshDrawer: true });
    });
  }
  if (!topModal() && $('#lightbox').classList.contains('hidden')) {
    const focused = [...host.querySelectorAll('button')].find(b => focusLabel && b.textContent === focusLabel);
    (focused || close).focus();
  }
}

function closeDetail() {
  detailRequest++;
  const wasOpen = !$('#detail').classList.contains('hidden');
  const back = detailReturnFocus;
  $('#detail').classList.add('hidden');
  $('#detail').textContent = '';
  $('#detailBackdrop').classList.add('hidden');
  $('#appShell').inert = false;
  if (wasOpen) {
    const usable = back && back.isConnected && back.offsetParent !== null;
    const drawerOpen = !$('#inspector').classList.contains('hidden');
    const full = drawerOpen && $('#inspector [data-inspect="full"]');
    const card = $$('#secondary .card, #gridItems .card')
      .find(c => c.dataset.code === state.detailCode && c.offsetParent !== null);
    (usable ? back : full || card || $('#navHome')).focus();
  }
  detailReturnFocus = null;
}

async function toggleState(code, field) {
  const row = state.byCode.get(code);
  if (!row) return;
  const nv = row[field] === '真' ? '假' : '真';
  try {
    await A.setState(code, field, nv, row._lib);
  } catch (e) {
    return setStatus('写入失败：' + e.message, 5000);
  }
  row[field] = nv;
  derive(row);
  applyFilters();
  if (state.detailCode === code && !$('#inspector').classList.contains('hidden')) refreshDrawer();
  if (state.detailCode === code && !$('#detail').classList.contains('hidden')) openDetail(code);
}

function quickMenu(code) {
  const row = state.byCode.get(code);
  if (!row) return;
  const shut = modal('' + code, (m) => {
    const item = (label, fn) => {
      const b = el('button', 'ghost', label);
      b.style.width = '100%';
      b.style.justifyContent = 'flex-start';
      b.onclick = async () => {
        shut();
        await fn();
      };
      m.append(b);
    };
    item(row._fav ? '取消收藏' : '加入收藏', () => toggleState(code, 'state_收藏'));
    item(row._seen ? '标记为未看' : '标记为已看', () => toggleState(code, 'state_已看'));
    item('播放', () => playCode(code));
    // A hand-picked cover lives in JavShelf's own folder first. Writing the same picture into
    // his video folder is the tick-box inside the crop dialog, because that one replaces a file
    // he downloaded and cannot be undone by this program alone.
    item('导入图片裁切为封面…', async () => {
      // Ask first, so the tick-box can name the exact file it would replace rather than
      // describing it as 「影片文件夹里的封面」 and letting him guess. When the folder is not
      // known yet the offer is simply absent — 只改显示 still works.
      let where = null;
      try {
        where = await A.videoCoverTarget(code, row._lib);
      } catch {
        where = null;
      }
      const leaf = where ? String(where.target).split(/[\/\x5c]/).pop() : '';
      const got = await pickAndCrop(
        where
          ? {
              title: '裁切封面：' + code,
              size: [600, 800],
              folderLabel: `同时写入影片文件夹（${where.replaces ? '覆盖 ' : '新建 '}${leaf}，原图先存成 .bak）`,
              folderHint: where.dir + String.fromCharCode(10) + '不勾就只改这里看到的封面，影片文件夹一个字节都不动。'
            }
          : { title: '裁切封面：' + code, size: [600, 800] }
      );
      if (!got) return;
      try {
        const r = await A.videoCoverSet(code, row._lib, got.data, got.folder);
        delete mediaCache[code];
        await resolveMedia([code]);
        setStatus(
          r.folder ? `已换封面：${code}（已写入影片文件夹，原图备份为 .bak）` : `已换封面：${code}（只改这里的显示）`,
          7000
        );
      } catch (e) {
        setStatus('封面导入失败：' + e.message, 9000);
      }
    });
    if (mediaCache[code] && mediaCache[code].custom) {
      item('恢复原本封面', async () => {
        try {
          const r = await A.videoCoverClear(code, row._lib);
          delete mediaCache[code];
          await resolveMedia([code]);
          setStatus(
            r.restored ? `已恢复：${code}（文件夹里的原图已从 .bak 还原）` : `已去掉自定义封面：${code}`,
            7000
          );
        } catch (e) {
          setStatus('恢复失败：' + e.message, 9000);
        }
      });
    }
    item('打开所在文件夹', () => {
      const m2 = mediaCache[code];
      return revealDir(m2 && m2.dir, '还没定位到这个文件');
    });
    item('从库中删除（不删文件）', async () => {
      const ok = confirm(
        `把 ${code} 从媒体库里删掉？\n\n只删除管理器里的这条记录，视频文件、封面和 nfo 一个都不动。\n` +
          '注意：下次做「新增刷新」或「覆盖刷新」时，它会按目录重新扫回来。'
      );
      if (!ok) return;
      try {
        const r = await A.dbRemove(code, row._lib);
        if (state.detailCode === code) closeAllDetails();
        await reloadRows();
        render();
        setStatus(r.removed ? `已从库中删除 ${code}（文件未改动）` : '库里没有这条记录', 6000);
      } catch (e) {
        setStatus('删除失败：' + e.message, 9000);
      }
    });
  });
}

/* ----------------------------------------------------------------- lightbox */

function lightbox(rels, start) {
  const host = $('#lightbox');
  host.textContent = '';
  host.classList.remove('hidden');
  let at = start || 0;
  const img = el('img');
  const cap = el('div', 'cap');
  const close = () => {
    host.classList.add('hidden');
    host.textContent = '';
    removeEventListener('keydown', onKey);
  };
  const step = (d) => {
    at = (at + d + rels.length) % rels.length;
    img.src = A.imgUrl(rels[at]);
    cap.textContent = `${at + 1} / ${rels.length} · ←/→ 切换 · Esc 关闭`;
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
  };
  addEventListener('keydown', onKey);
  host.onclick = (e) => { if (e.target === host) close(); };
  host.append(img, cap);
  step(0);
}

/* ------------------------------------------------------------------- modal */

// Every open modal, innermost last. Esc and 关闭 have to run the same shut(): hiding the
// host without clearing it leaves the previous dialog's buttons focusable by keyboard.
// 一个宿主只装一层模态：新开一个会把上一个的 DOM 抹掉,所以那个已经不算开着了
// (裁切对话框就是这么套在封面窗口里的)——node.isConnected 就是这件事的判据。
const modalStack = [];

function topModal() {
  while (modalStack.length && !modalStack[modalStack.length - 1].node.isConnected) modalStack.pop();
  return modalStack.length ? modalStack[modalStack.length - 1] : null;
}

function modal(title, build, onClose) {
  const host = $('#modalHost');
  // 关掉以后焦点回到打开它的那个按钮,而不是掉回页面顶部。
  const back = document.activeElement;
  host.textContent = '';
  host.classList.remove('hidden');
  const m = el('div', 'modal');
  m.tabIndex = -1;
  m.setAttribute('role', 'dialog');
  m.setAttribute('aria-label', title);
  const h = el('h3', null, title);
  const slot = { node: m, shut: null };
  const shut = () => {
    const at = modalStack.indexOf(slot);
    if (at >= 0) modalStack.length = at;
    host.classList.add('hidden');
    host.textContent = '';
    if (onClose) {
      try {
        onClose();
      } catch {
        /* a failed cleanup must not strand the modal host */
      }
    }
    if (back && back.focus) {
      try {
        back.focus();
      } catch {
        /* 那个按钮可能已经随界面重建掉了 */
      }
    }
  };
  slot.shut = shut;
  modalStack.push(slot);
  const close = el('button', 'ghost x', '关闭');
  close.onclick = shut;
  h.append(close);
  m.append(h);
  build(m, shut);
  host.append(m);
  host.onclick = (e) => { if (e.target === host) shut(); };
  return shut;
}

/* -------------------------------------------------------------- library UI */

function renderLibPanel() {
  const box = $('#libPanel');
  box.textContent = '';
  const head = el('div', 'head');
  head.append(el('b', null, '媒体库'));
  const manage = el('button', 'ghost', '管理');
  manage.onclick = () => libsModal();
  head.append(manage);
  box.append(head);
  for (const lib of state.libraries) {
    const row = el('div', 'librow' + (lib.name === state.activeLib ? ' on' : '') + (lib.enabled === false ? ' off' : ''));
    const tg = el('div', 'toggle' + (lib.enabled === false ? '' : ' on'));
    tg.title = lib.enabled === false ? '点击启用（显示在海报墙）' : '点击停用（从海报墙隐藏）';
    tg.onclick = async (e) => {
      e.stopPropagation();
      try {
        const cfg = await A.libEnable(lib.name, lib.enabled === false);
        state.libraries = cfg.libraries;
        await reloadRows();
      } catch (err) {
        setStatus('切换失败：' + err.message, 5000);
      }
    };
    const cnt = state.rows.filter((r) => r._lib === lib.name).length;
    row.append(tg, el('span', 'nm', lib.name), el('span', 'cnt', String(lib.enabled === false ? 'off' : cnt)));
    row.title = (lib.dirs || []).join('\n') || '还没有文件夹';
    row.onclick = () => libsModal(lib);
    box.append(row);
  }
  if (!state.libraries.length) box.append(el('button', 'ghost', '添加媒体库'));
  $('#stLib') && ($('#stLib').textContent = '');
}

function libsModal(preset) {
  modal('媒体库管理', (m, close) => {
    m.append(hint('库 = 名字 + 若干影片文件夹。开关关闭时该库不出现在海报墙。新建库会读取文件夹里的 nfo 建立自己的数据，不会改动旧程序的文件。'));
    const wrap = el('div', 'libcards');
    m.append(wrap);
    const paint = () => {
      wrap.textContent = '';
      for (const lib of state.libraries) wrap.append(libCard(lib, paint, close));
      if (!state.libraries.length) wrap.append(hint('还没有任何库。'));
    };
    const foot = el('div', 'row');
    const nb = el('button', 'ghost primary', '新建库');
    nb.onclick = () => editLib({ name: '', dirs: [], store: 'shelf', enabled: true, view: 'poster', titleField: 'movie_编码', subtitleField: 'movie_日期' }, paint);
    const ib = el('button', 'ghost', '导入旧程序库配置');
    ib.onclick = async () => {
      try {
        const cfg = await A.libImportLegacy();
        state.libraries = cfg.libraries;
        await reloadRows();
        paint();
        setStatus('已导入');
      } catch (e) {
        setStatus('导入失败：' + e.message, 6000);
      }
    };
    const sb = el('button', 'ghost', '重新定位文件');
    sb.onclick = async () => {
      await A.scanRescan();
      setStatus('开始重新定位文件夹');
    };
    foot.append(nb, ib, sb);
    m.append(foot);
    paint();
    if (preset) setTimeout(() => editLib(preset, paint), 0);
    void close;
  });
}

function libCard(lib, repaint, closeAll) {
  const c = el('div', 'libcard' + (lib.name === state.activeLib ? ' on' : ''));
  const head = el('header');
  head.append(el('b', null, lib.name), el('span', 'tagline', lib.store === 'shelf' ? '本地库' : '沿用旧数据'));
  c.append(head);
  const mine = state.rows.filter((r) => r._lib === lib.name).length;
  c.append(el('div', 'hint', `${lib.dirs.length} 个文件夹 · ${mine} 条 · ${lib.enabled === false ? '已停用' : '已启用'}`));
  if (lib.error) c.append(el('div', 'hint', '⚠ ' + lib.error));
  const ul = el('ul');
  for (const d of lib.dirs.slice(0, 6)) {
    const li = el('li');
    li.append(el('span', null, d));
    ul.append(li);
  }
  if (!lib.dirs.length) ul.append(el('li', 'hint', '还没有添加文件夹'));
  c.append(ul);
  const acts = el('div', 'acts');
  const tg = el('button', 'ghost' + (lib.enabled === false ? '' : ' on'), lib.enabled === false ? '启用' : '停用');
  tg.onclick = async () => {
    try {
      const cfg = await A.libEnable(lib.name, lib.enabled === false);
      state.libraries = cfg.libraries;
      await reloadRows();
      repaint();
    } catch (e) {
      setStatus('切换失败：' + e.message, 5000);
    }
  };
  const open = el('button', 'ghost primary', '设为当前');
  open.onclick = async () => {
    const cfg = await A.libUse(lib.name);
    state.activeLib = cfg.activeLibrary;
    await reloadRows();
    closeAll();
  };
  const edit = el('button', 'ghost', '编辑');
  edit.onclick = () => editLib(lib, repaint);
  acts.append(tg, open, edit);
  if (lib.store === 'shelf') {
    for (const mode of ['append', 'delta', 'full']) {
      const b = el('button', 'ghost', MODE_LABEL[mode]);
      b.title = mode === 'full' ? '清空后全部重新读取' : mode === 'append' ? '只读取没有的条目' : '只重读有变动的 nfo，并移除已消失的';
      b.onclick = () => runIngest(lib.name, mode);
      acts.append(b);
    }
    const del = el('button', 'ghost danger', '删除');
    del.onclick = async () => {
      if (!confirm(`删除库 ${lib.name}？只删本程序里的定义与它自己建立的条目数据，不会动你的视频文件。`)) return;
      const cfg = await A.libRemove(lib.name);
      state.libraries = cfg.libraries;
      await reloadRows();
      repaint();
    };
    acts.append(del);
  }
  c.append(acts);
  return c;
}

function editLib(lib, done) {
  modal((lib.name ? '编辑库 · ' : '新建库 · ') + lib.name, (m, close) => {
    const nameIn = input(lib.name, '中英文、数字、下划线或短横线，1-24 字');
    if (lib.store !== 'shelf') nameIn.disabled = true;
    const titleSel = select([['movie_编码', '番号'], ['movie_片名', '片名']], lib.titleField);
    m.append(field('名称', nameIn), field('主标题', titleSel));
    m.append(el('div', 'grouph', '文件夹'));
    const dirList = el('div');
    const addRow = (value) => {
      const row = el('div', 'row');
      const i = input(value || '');
      i.className = 'dirin';
      i.placeholder = 'D:\\media\\JAV_output';
      const pick = el('button', 'ghost', '浏览');
      pick.onclick = async () => {
        const d = await A.pickDir();
        if (d) i.value = d;
      };
      const rm = el('button', 'ghost', '移除');
      rm.onclick = () => row.remove();
      row.append(i, pick, rm);
      dirList.append(row);
    };
    for (const d of lib.dirs) addRow(d);
    if (!lib.dirs.length) addRow('');
    m.append(dirList);
    const addBtn = el('button', 'ghost', '+ 添加一个文件夹');
    addBtn.onclick = () => addRow('');
    m.append(addBtn);
    if (lib.store === 'shelf') m.append(hint('保存后会自动读取这些文件夹里的 nfo；也可以随时用「覆盖刷新 / 新增刷新 / 删改刷新」重新扫描。'));
    const btns = el('div', 'row');
    const save = el('button', 'ghost primary', '保存');
    const cancel = el('button', 'ghost', '取消');
    cancel.onclick = close;
    save.onclick = async () => {
      try {
        const cfg = await A.libSave({
          name: (nameIn.value || '').trim(),
          dirs: $$('#modalHost .dirin').map((i) => i.value.trim()).filter(Boolean),
          store: lib.store,
          enabled: lib.enabled !== false,
          view: lib.view || 'poster',
          titleField: titleSel.value,
          subtitleField: lib.subtitleField || 'movie_日期'
        });
        state.libraries = cfg.libraries;
        close();
        await reloadRows();
        setStatus('库已保存，正在扫描');
        autoIngest();
      } catch (e) {
        setStatus('保存失败：' + e.message, 6000);
      }
      done && done();
    };
    btns.append(save, cancel);
    m.append(btns);
  });
}

/* -------------------------------------------------------------------- 查重 */

// 归一化只吃掉字母与数字之间的那串前导零，其余一概不动：ABP-123 / abp123 / ABP-0123 是同一个,
// 而 ABP-123-2、ABP-123A 这种分包写法归一后仍然不同，不会被误判成重复。
const dupKey = (code) => {
  const s = String(code || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
  return s.replace(/^([A-Z]+)0+(?=\d)/, '$1');
};

// 库里 `only_code`（文件夹）是主键，所以同一个番号出现在两个文件夹里就是两行——那不是脏数据，
// 是真的存了两份。这里只分组与统计，删不删由他自己判断。
function dupGroups(rows) {
  const byCode = new Map();
  const byKey = new Map();
  for (const r of rows || state.rows) {
    const code = String(r.movie_编码 || '').trim();
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(r);
    const k = dupKey(code);
    // 归一之后什么都不剩的（整串都是非字母数字）不进近似那一层：它们彼此「相同」只是因为都读不出号。
    if (k) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
  }
  const shape = (label, list) => ({
    label,
    rows: list,
    libs: new Set(list.map((r) => r._lib)).size
  });
  const exact = [...byCode.entries()].filter(([, v]) => v.length > 1).map(([code, v]) => shape(code, v));
  // 近似那一层只收「字面不一样但归一相同」的：字面一样的已经被上面报过了。
  const near = [...byKey.entries()]
    .filter(([, v]) => v.length > 1 && new Set(v.map((r) => String(r.movie_编码 || '').trim())).size > 1)
    .map(([k, v]) => shape(k, v));
  const order = (a, b) => b.rows.length - a.rows.length || String(a.label).localeCompare(String(b.label), 'en');
  exact.sort(order);
  near.sort(order);
  return { exact, near };
}

const dupeFacts = new Map();
// 一批问失败（库刚改过、主进程正忙）不等于这些文件夹永远读不到：记「问过」免得每次 paint 都追打，
// 但下次打开查重窗口会清空重问。真正缓存下来的只有主进程给过明确答复的那一行。
const dupeAsked = new Set();
let dupeFailure = '';
const fmtBytes = (n) => {
  if (n == null) return '—';
  const gb = n / 1073741824;
  if (gb >= 1) return gb.toFixed(2) + ' GB';
  return (n / 1048576).toFixed(0) + ' MB';
};
// 体积这一格要么是实测值，要么是「为什么没有」。读过的文件夹都记在 dupeFacts 里，
// 第二次打开窗口不再问主进程，所以这一格必须能从缓存里直接算出来，而不是停在「…」。
const dupSizeText = (dir) => {
  if (!dir) return '—';
  const f = dupeFacts.get(dir);
  if (f) return f.ok ? fmtBytes(f.bytes) : f.error || '读不到';
  return dupeAsked.has(dir) ? '未测到' : '…';
};

// 一次渲染 150 组：整套库的重复组可以上千，全画出来既没有意义也会把窗口卡住。
const DUPE_PAGE = 150;

function dupesModal() {
  const found = dupGroups();
  const dupRows = found.exact.reduce((n, g) => n + g.rows.length, 0) + found.near.reduce((n, g) => n + g.rows.length, 0);
  dupeAsked.clear();
  dupeFailure = '';
  modal('查重：重复番号', (m, shut) => {
    m.classList.add('wide');
    let tab = found.exact.length ? 'exact' : 'near';
    let word = '';
    let shown = DUPE_PAGE;
    let filterTimer = 0;
    const sum = el('div', 'hint', `${state.rows.length} 行里比对出 完全重复 ${found.exact.length} 组 · 近似重复 ${found.near.length} 组 · 涉及 ${dupRows} 行`);
    const tabs = el('div', 'vtabs');
    const box = input('', '只筛这些组里的番号');
    box.placeholder = '筛番号，例如 ABP';
    box.setAttribute('aria-label', '筛选重复组里的番号');
    box.oninput = () => {
      word = box.value.trim().toUpperCase();
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        shown = DUPE_PAGE;
        paint();
      }, 180);
    };
    const filterRow = el('div', 'row');
    filterRow.append(el('label', null, '筛选'), box, el('span', 'hint', '体积按文件夹实测，网盘目录会慢几秒'));
    const list = el('div', 'dupes');
    m.append(sum, tabs, filterRow, list);

    const fetchSizes = async (groups) => {
      const need = [...new Set(groups.flatMap((g) => g.rows.map((r) => String(r.only_code || '')).filter(Boolean)))]
        .filter((d) => !dupeFacts.has(d) && !dupeAsked.has(d))
        .slice(0, 400);
      if (!need.length) return;
      for (const d of need) dupeAsked.add(d);
      let got = null;
      try {
        got = await A.dupeDetail(need);
      } catch (e) {
        // 整批没答上：这些格子写「未测到」而不是永远停在「…」，但绝不进 dupeFacts，
        // 免得一次网盘掉线就把「读不到」钉成这一轮的真相。
        dupeFailure = String((e && e.message) || e);
        paint();
        return;
      }
      for (const k of Object.keys(got || {})) {
        dupeFacts.set(k, got[k]);
        dupeAsked.delete(k);
      }
      for (const cell of list.querySelectorAll('[data-dir]')) {
        cell.textContent = dupSizeText(cell.dataset.dir);
      }
    };

    function paint() {
      tabs.textContent = '';
      for (const [key, label, n] of [['exact', '完全重复', found.exact.length], ['near', '近似重复', found.near.length]]) {
        const b = el('button', key === tab ? 'on' : '', `${label} ${n}`);
        b.onclick = () => {
          tab = key;
          shown = DUPE_PAGE;
          paint();
        };
        tabs.append(b);
      }
      list.textContent = '';
      const groups = (tab === 'exact' ? found.exact : found.near).filter((g) => !word || String(g.label).toUpperCase().includes(word));
      if (!groups.length) {
        list.append(el('div', 'hint', word ? '没有匹配的组' : '这一类没有重复：每个番号都只有一份'));
        return;
      }
      for (const g of groups.slice(0, shown)) {
        list.append(el('div', 'grouph', `${g.label} · ${g.rows.length} 处 · ${g.libs} 个库`));
        for (const r of g.rows) {
          const dir = String(r.only_code || '');
          const row = el('div', 'row dupe');
          const where = el('span', 'dupdir', dir ? dir.split(/[\/\x5c]/).filter(Boolean).slice(-2).join(String.fromCharCode(92)) : '（库里没记文件夹）');
          where.title = dir;
          const size = el('span', 'dupsize', dupSizeText(dir));
          size.dataset.dir = dir;
          const open = el('button', 'ghost', '打开所在文件夹');
          open.onclick = () => revealDir(dir, '这条记录没有存文件夹');
          const only = el('button', 'ghost', '在墙上只看它');
          only.onclick = () => {
            state.filters.q = String(r.movie_编码 || '').trim();
            $('#search').value = state.filters.q;
            shut();
            applyFilters();
            render();
          };
          row.append(el('span', 'duplib', String(r._lib || '')), where, size, open, only);
          list.append(row);
        }
      }
      if (groups.length > shown) {
        const more = el('button', 'ghost', `显示更多（还有 ${groups.length - shown} 组）`);
        more.onclick = () => {
          shown += DUPE_PAGE;
          paint();
        };
        list.append(more);
      }
      if (dupeFailure) list.append(el('div', 'hint', '体积没测到：' + dupeFailure));
      fetchSizes(groups.slice(0, shown));
    }
    paint();
  });
}

/* ------------------------------------------------------------- display cfg */

const DISPLAY_TABS = [['items', '条目'], ['actor', '演员'], ['studio', '制作'], ['series', '系列'], ['code', '番号']];

function displayModal() {
  modal('显示设置', (m, close) => {
    const patch = JSON.parse(JSON.stringify(state.disp));
    let tab = 'items';
    const tabs = el('div', 'vtabs');
    const body = el('div');
    m.append(tabs, body);
    const paint = () => {
      tabs.textContent = '';
      body.textContent = '';
      for (const [key, label] of DISPLAY_TABS) {
        const b = el('button', key === tab ? 'on' : '', label);
        b.onclick = () => {
          tab = key;
          paint();
        };
        tabs.append(b);
      }
      const d = patch[tab];
      if (tab === 'items') {
        body.append(el('div', 'grouph', '布局设置'));
        body.append(field('每页条目数量', num(d, 'pageSize', 30, 960)));
        body.append(field('每行数量', sel(d, 'perRow', [[0, '自适应'], [3, '3'], [4, '4'], [5, '5'], [6, '6'], [8, '8']])));
        body.append(check('默认开启瀑布流', d.waterfall, (v) => (d.waterfall = v)));
        body.append(el('div', 'grouph', '卡片设置'));
        body.append(field('标题最多行数', sel(d, 'titleLines', [[1, '1'], [2, '2'], [3, '3'], [4, '4']])));
        body.append(field('标签最多行数', sel(d, 'tagLines', [[0, '不显示'], [1, '1'], [2, '2'], [3, '3']])));
        body.append(check('不显示系列', d.hideSeries, (v) => (d.hideSeries = v)));
        body.append(check('不显示演员', d.hideActors, (v) => (d.hideActors = v)));
        body.append(check('不显示标签', d.hideTags, (v) => (d.hideTags = v)));
        body.append(check('不显示悬停操作按钮', d.hideActions, (v) => (d.hideActions = v)));
        body.append(check('展示完整喜爱度爱心', d.fullHeart, (v) => (d.fullHeart = v)));
      } else {
        body.append(el('div', 'grouph', '布局设置'));
        body.append(field('每页数量', num(d, 'pageSize', 30, 480)));
        body.append(field('每行数量', sel(d, 'perRow', [[0, '自适应'], [2, '2'], [3, '3'], [4, '4'], [6, '6']])));
        body.append(el('div', 'grouph', '排序'));
        body.append(field('默认排序', sel(d, 'sort', [['count', '按条目数'], ['name', '按名称'], ['height_cm', '按身高'], ['birth_date', '按年龄'], ['cup', '按罩杯'], ['bust', '胸围'], ['waist', '腰围'], ['hips', '臀围']])));
        body.append(field('排列方向', sel(d, 'sortDir', [['desc', '从多到少 / 从大到小'], ['asc', '从少到多 / 从小到大']])));
      }
    };
    const num = (d, key, min, max) => {
      const i = input(d[key], '', 'number');
      i.min = min;
      i.max = max;
      i.onchange = () => (d[key] = Number(i.value) || d[key]);
      return i;
    };
    const sel = (d, key, options) => {
      const s = select(options, d[key]);
      s.onchange = () => (d[key] = s.value === '0' ? 0 : Number.isFinite(Number(s.value)) && String(s.value).match(/^\d+$/) ? Number(s.value) : s.value);
      return s;
    };
    paint();
    const btns = el('div', 'row');
    const reset = el('button', 'ghost', '恢复默认');
    reset.onclick = async () => {
      if (!confirm('把显示设置恢复成默认？\n\n每页数量、每行数量、标题行数、排序这些都会回到出厂值；库和文件不受影响。')) return;
      reset.disabled = true;
      save.disabled = true;
      try {
        await A.saveSettings({ display: null });
        const cfg = await A.settings();
        state.disp = cfg.display;
        syncActorSort();
        applyDisplay();
        render();
        close();
        setStatus('显示设置已恢复默认');
      } catch (e) {
        reset.disabled = false;
        save.disabled = false;
        setStatus('恢复失败：' + ((e && e.message) || e), 7000);
      }
    };
    const save = el('button', 'ghost primary', '保存');
    save.onclick = async () => {
      save.disabled = true;
      reset.disabled = true;
      try {
        const cfg = await A.saveSettings({ display: patch });
        state.disp = cfg.display;
        syncActorSort();
        applyDisplay();
        render();
        close();
        setStatus('显示设置已保存');
      } catch (e) {
        save.disabled = false;
        reset.disabled = false;
        setStatus('保存失败：' + ((e && e.message) || e), 7000);
      }
    };
    const cancel = el('button', 'ghost', '取消');
    cancel.onclick = close;
    btns.append(reset, el('div', 'spacer'), save, cancel);
    m.append(btns);
  });
}

/* ------------------------------------------------------------- idol editor */

const IDOL_FIELDS = [
  ['japanese_name', '日文名'], ['roman_name', '罗马名'], ['chinese_name', '中文名'],
  ['height_cm', '身高'], ['birth_date', '生日'], ['bust', '胸围'], ['waist', '腰围'], ['hips', '臀围'],
  ['cup', '罩杯'], ['birth_place', '出身地']
];

// A rejected invoke() reaches the renderer wrapped as
// `Error invoking remote method 'idol:checkJavdb': Error: <正文>`. The handler's own sentence is
// what the user needs to read, so drop Electron's wrapper before it hits a hint line.
const errText = (e) =>
  String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');

// The manual binding row inside 编辑女优信息. The directory crawl can't reach everyone — she
// renamed herself, never made the list, or the library spells her differently — and one pasted
// address is the way back in. 校验 is optional (it needs the proxy) while 绑定 is a local write,
// so this also works offline; what 校验 learns goes into the editor's empty fields via onMeasured.
function javdbBindRow(name, existing, onMeasured) {
  const box = el('div', 'bindrow');
  const stateLine = el('div', 'hint');
  const paintState = () => {
    const p = state.idolMap.get(name) || {};
    stateLine.textContent = p.javdb_id
      ? `已绑定 JavDB ${p.javdb_id}${p.javdb_url ? '　' + p.javdb_url : ''}`
      : '还没绑定 JavDB 编号：绑定后她的头像、圆圈和「在 JavDB 中打开」才走她本人那一页';
  };
  paintState();
  const ref = input(existing.javdb_url || '', '把她的 JavDB 女优页地址整条粘进来，只填编号也行');
  ref.dataset.field = 'javdb';
  const result = el('div', 'hint');
  const checkBtn = el('button', 'ghost', '校验');
  const bindBtn = el('button', 'ghost primary', '绑定');
  let checked = null;
  // Editing the box after a 校验 invalidates it — 绑定 prefers the checked address, and a stale
  // one would bind whoever used to be in the box.
  ref.oninput = () => {
    if (!checked) return;
    checked = null;
    result.textContent = '';
  };
  const warn = () => {
    if (!checked || !checked.names || !checked.names.length) return '';
    return checked.names.some((n) => n === name || n.includes(name) || name.includes(n))
      ? ''
      : `　注意：JavDB 那一页写的是「${checked.names[0]}」，和库里的「${name}」对不上`;
  };
  checkBtn.onclick = async () => {
    checkBtn.disabled = true;
    result.textContent = '正在读 JavDB 这一页…';
    try {
      checked = await A.idolCheckJavdb(ref.value);
      const filled = onMeasured ? onMeasured(checked) : [];
      result.textContent =
        `JavDB 上她是：${(checked.names || []).join('、') || '（这一页没写出名字）'}` +
        (checked.videoCount ? ` · 全站 ${checked.videoCount} 部` : '') +
        (filled.length ? ` · 已把空着的${filled.join('/')}填上，点保存才写入` : '') +
        warn();
    } catch (e) {
      checked = null;
      result.textContent = '校验失败：' + errText(e);
    } finally {
      checkBtn.disabled = false;
    }
  };
  bindBtn.onclick = async () => {
    bindBtn.disabled = true;
    result.textContent = '正在绑定…';
    try {
      const r = await A.idolBindJavdb({ name, ref: checked ? checked.url : ref.value, avatar: (checked && checked.avatar) || '' });
      await loadIdols();
      if (r.avatarSaved) await refreshAvatars();
      paintState();
      renderFacets();
      render();
      result.textContent =
        `已绑定 ${r.id}` + (r.avatarSaved ? ' · 头像已存到本地' : r.avatarError ? ` · 头像：${r.avatarError}` : '') + warn();
      setStatus(`已绑定 ${name} → JavDB ${r.id}`, 5000);
    } catch (e) {
      result.textContent = '绑定失败：' + errText(e);
    } finally {
      bindBtn.disabled = false;
    }
  };
  const line = el('div', 'row');
  line.append(el('label', null, 'JavDB 女优页'), ref, checkBtn, bindBtn);
  box.append(stateLine, line, result);
  return box;
}

// Her Japanese Wikipedia article, into the blanks of this dialog. The infobox there is the only
// place that still publishes 身長 / スリーサイズ / ブラサイズ, and it is stamped with a 時点, so
// the newest one is what gets read. Like 校验 it only fills what is empty, writes nothing until
// 保存, and says so when the page disagrees with a value already on the row.
function wikiFillRow(name, inputs) {
  const box = el('div', 'bindrow');
  const btn = el('button', 'ghost', '从日文维基补全');
  const hint = el('div', 'hint', '读她那一页档案卡的最新时点（身高 / 三围 / 罩杯 / 生日 / 出身地），只填没写过的格子');
  btn.onclick = async () => {
    btn.disabled = true;
    hint.textContent = '正在读日文维基这一页…';
    try {
      const r = await A.idolWiki(name);
      const filled = [];
      const clash = [];
      for (const [key, label] of IDOL_FIELDS) {
        const val = String((r.measurements || {})[key] || '').trim();
        if (!val) continue;
        const cur = String(inputs[key].value || '').trim();
        if (!cur) {
          inputs[key].value = val;
          filled.push(label);
        } else if (key === 'cup' && cur !== val) clash.push(val);
      }
      hint.textContent =
        `来自「${r.page}」${r.asOf ? `（${r.asOf} 年时点）` : ''}　` +
        (filled.length ? `已把空着的${filled.join('/')}填上，点保存才写入` : '没有需要补的空项') +
        (clash.length ? `　注意：她那一页的罩杯是 ${clash[0]}，和你的记录不同，要改就手动改` : '');
    } catch (e) {
      hint.textContent = '读取失败：' + errText(e);
    } finally {
      btn.disabled = false;
    }
  };
  const line = el('div', 'row');
  line.append(el('label', null, '日文维基'), btn);
  box.append(line, hint);
  return box;
}

// The target of a merge has to be somebody who really exists. Typing her name by hand is
// how a merge looks like it did nothing: one character off creates a profile nobody has a
// poster for, and the two tiles stay on the wall exactly as they were.
function mergeTargetModal(name, onPick) {
  const pool = new Map();
  for (const [n, c] of (facetData.actor || [])) pool.set(n, c);
  for (const p of state.idols) if (!pool.has(p.name)) pool.set(p.name, 0);
  pool.delete(name);
  const all = [...pool].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'));
  modal(`把「${name}」合并到哪位女优`, (m, close) => {
    m.append(hint('只能选列表里的人。合并是记下「这两个写法是同一个人」，之后她的作品并到一处；库里的 nfo 文件不改动。'));
    const q = input('', '输入几个字筛选');
    q.className = 'mergesearch';
    q.placeholder = '输入几个字筛选';
    const list = el('div', 'mergepick');
    const paint = () => {
      const term = q.value.trim().toLowerCase();
      const hit = (term ? all.filter(([n]) => n.toLowerCase().includes(term)) : all).slice(0, 80);
      list.textContent = '';
      if (!hit.length) list.append(el('p', 'hint', '没有匹配的女优，换一个说法试试。'));
      for (const [n, c] of hit) {
        const b = el('button', 'ghost pickrow');
        b.append(el('span', 'pickname', n), el('span', 'pickn', c ? `${c} 部` : '库里没有作品'));
        b.onclick = () => {
          close();
          onPick(n);
        };
        list.append(b);
      }
      if (all.length > hit.length) list.append(el('p', 'hint', `只显示前 ${hit.length} 个，共 ${all.length} 位候选。继续输入缩小范围。`));
    };
    q.oninput = paint;
    q.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = list.querySelector('button.pickrow');
      if (first) first.click();
    };
    paint();
    m.append(q, list);
    q.focus();
  });
}

function idolModal(name, count) {
  const existing = state.idolMap.get(name) || { name, aliases: [] };
  modal('编辑女优信息', (m, close) => {
    m.append(el('div', 'hint', name + (count ? ` · 库内 ${count} 部` : '')));
    const inputs = {};
    const grid = el('div', 'grid2');
    for (const [key, label] of IDOL_FIELDS) {
      inputs[key] = input(existing[key] || '', key === 'birth_date' ? 'YYYY-MM-DD' : '');
      inputs[key].dataset.field = key;
      grid.append(field(label, inputs[key]));
    }
    // 校验 asks JavDB who lives at that address, so the numbers it reports can land in the
    // blanks right here — and nowhere else: a value he already typed always wins.
    const bindRow = javdbBindRow(name, existing, (r) => {
      const filled = [];
      for (const [key, label] of IDOL_FIELDS) {
        const val = String((r.measurements || {})[key] || '').trim();
        if (!val || inputs[key].value.trim()) continue;
        inputs[key].value = val;
        filled.push(label);
      }
      return filled;
    });
    const wikiRow = wikiFillRow(name, inputs);
    m.append(bindRow, grid, wikiRow);
    const aliasIn = input((existing.aliases || []).join('、'), '多个用顿号或逗号分隔');
    m.append(field('别名', aliasIn, '输入后按 Enter 也可以，用于把不同写法归到同一个人'));
    const btns = el('div', 'row');
    const save = el('button', 'ghost primary', '保存');
    const merge = el('button', 'ghost', '合并到其它女优');
    const cancel = el('button', 'ghost', '取消');
    cancel.onclick = close;
    save.onclick = async () => {
      try {
        await A.idolSave({
          name,
          ...Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()])),
          aliases: SPLIT(aliasIn.value.replace(/[，,、;；]/g, '/'))
        });
        await loadIdols();
        // 别名可以手打，改完就得当场把两个人并起来，不能等下一次启动。
        buildFacets();
        applyFilters();
        close();
        setStatus('女优资料已保存');
      } catch (e) {
        setStatus('保存失败：' + e.message, 6000);
      }
    };
    merge.onclick = () => {
      mergeTargetModal(name, (target) => {
        A.idolMerge(name, target)
          .then(async (res) => {
            await loadIdols();
            buildFacets();
            applyFilters();
            close();
            const carried = (res && res.filled ? res.filled.length : 0) + (res && res.avatar ? 1 : 0);
            setStatus(carried ? `已合并到 ${target}，顺带把她空着的 ${carried} 项补上了` : `已合并到 ${target}`);
          })
          .catch((e) => setStatus('合并失败：' + e.message, 6000));
      });
    };
    btns.append(save, merge, cancel);
    m.append(btns);
  });
}

function idolListModal() {
  modal('女优资料', (m) => {
    m.append(hint(`本机已存 ${state.idols.length} 位女优的资料。身高/罩杯等用于左侧演员列表的特色排序；没有资料的会排在最后。`));
    const row = el('div', 'row');
    const imp = el('button', 'ghost primary', '从本机已有安装导入');
    const list = el('div', 'prose');
    imp.onclick = async () => {
      const guess = await A.idolGuess();
      if (!guess) return setStatus('没找到可导入的来源数据库', 6000);
      const res = await A.idolImport(guess);
      await loadIdols();
      renderFacets();
      list.textContent = `从 ${guess} 导入 ${res.added} / ${res.total} 位。`;
      setStatus(`已导入 ${res.added} 位女优资料`);
    };
    row.append(imp);
    m.append(row, list);

    // Crawling is always opt-in and never automatic: it needs the proxy from 设置.
    const crawl = el('div', 'row');
    const pages = el('input');
    pages.type = 'number';
    pages.value = '0';
    pages.title = '抓取多少页 JavDB 女优目录（每页 50 人）；0 = 一直翻到目录末尾';
    const wikiN = el('input');
    wikiN.type = 'number';
    wikiN.value = '200';
    wikiN.title = '本次从维基百科补全多少人（0 = 不补）';
    const go = el('button', 'ghost', '抓取女优目录并绑定');
    go.onclick = () => {
      if (!state.cfg.proxy) return setStatus('先在设置里填好代理，JavDB 直连不通', 6000);
      A.javdbEnrich('idols', { pages: Number(pages.value) || 0, limit: Number(wikiN.value) || 0, wiki: true })
        .then(async (r) => {
          await loadIdols();
          renderFacets();
          list.textContent = `目录写入 ${r.indexed || 0} 个别名 · 绑定 ${r.bound?.idols || 0} 人 · 维基补全 ${r.wiki || 0} 人 · 未匹配 ${r.unmatched || 0} 人 · 用时 ${Math.round((r.ms || 0) / 100) / 10}s`;
        })
        .catch((e) => setStatus('抓取失败：' + e.message, 8000));
    };
    const stop = el('button', 'ghost', '停止');
    stop.onclick = () => A.javdbEnrichStop();
    const ava = el('button', 'ghost', '下载官方头像');
    ava.title = '把已绑定 JavDB 编号的女优头像下载到本地，用于侧栏圆圈与封面墙默认图';
    ava.onclick = () => {
      if (!state.cfg.proxy) return setStatus('先在设置里填好代理', 6000);
      A.javdbFetchAvatars({ limit: 0 })
        .then((r) => {
          setStatus(`头像下载完成：成功 ${r.done}，失败 ${r.failed}`);
          return refreshAvatars();
        })
        .catch((e) => setStatus('头像下载失败：' + e.message, 8000));
    };
    crawl.append(el('span', 'hint', '页数'), pages, el('span', 'hint', '维基人数'), wikiN, go, ava, stop);
    m.append(crawl);
    m.append(hint('女优的别名与 JavDB 编号来自 JavDB 目录；身高 / 生日 / 三围来自日文维基百科的档案卡，JavDB 本身已不再公布这些数字。'));
    const rows = state.idols.slice(0, 300).map((p) => `${p.name}${p.height_cm ? ' · ' + p.height_cm + 'cm' : ''}${p.cup ? ' · ' + p.cup : ''}`);
    if (rows.length) m.append(hint('例如：' + rows.slice(0, 6).join('　')));
  });
}

/* ---------------------------------------------------------------- settings */

const SETTINGS_TABS = [
  ['appearance', '外观'],
  ['playback', '播放'],
  ['shortcuts', '快捷键'],
  ['data', '数据与扩展']
];

const SETTINGS_SPEC = {
  appearance: [
    ['appearance.theme', '主题', 'select', [['auto', '跟随系统'], ['dark', '深色'], ['light', '浅色']], '跟随系统：Windows 切换深浅色时，界面和窗口底色一起切换'],
    ['appearance.radius', '封面圆角', 'range', [0, 24, 1], '海报四个角的圆角大小，0 为直角'],
    ['appearance.badgeSubtitle', '字幕标签', 'check', '字幕状态为「真」的条目，封面左上角出一枚「字」；没有字幕状态就没有'],
    ['appearance.badgeResolution', '分辨率标签', 'check', '分辨率取自文件名里的 4K/1080/720 等字样；文件名没写就没有标签可显示'],
    ['appearance.badgeCount', '评分与已看', 'check', '评分★需要 nfo 里有评分且 ≥4；「已看」标记只看状态，不依赖评分'],
    ['appearance.listCategory', '类别标签', 'check', '类别来自 nfo 的 类别/标签 字段，最多显示每行标签数 × 2 个里的前 3 个'],
    ['appearance.listSeries', '系列标签', 'check', '系列名单独出一枚标签（不再和类别混在一起）；nfo 里没有系列就没有'],
    ['appearance.staticLoad', '封面静态加载', 'check', '勾选=滚动到位才解码（省内存）；取消=提前多加载几行'],
    ['appearance.minWidth', '最小窗口宽度', 'number', null, '窗口能被拖到多窄；低于这个值会停住'],
    ['uiScale', '界面缩放', 'range', [0.8, 1.6, 0.05], '整个界面的缩放比例']
  ],
  playback: [
    ['playback.player', '播放器', 'select', [['system', '系统默认播放器'], ['custom', '指定播放器程序']], '系统默认播放器无需安装 PotPlayer；指定程序适合固定用 PotPlayer 的情况'],
    ['playerPath', '播放器路径', 'text', '只在上面选「指定播放器程序」时用；填可执行文件完整路径，路径无效时自动退回系统默认播放器'],
    ['playback.loop', '循环播放', 'check', '仅对指定路径的 PotPlayer 追加 /loop 参数；系统默认播放器由播放器自己控制'],
    ['playback.statFile', '读取视频文件信息', 'check', '播放前读取文件大小并显示在状态栏']
  ],
  shortcuts: [
    ['shortcuts.hotkey', '呼出窗口热键', 'select', ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].map((k) => [k, k]), '在任何程序里按下这个键都能把 JavShelf 叫到前面'],
    ['shortcuts.tray', '最小化到托盘', 'check', '关闭按钮改为隐藏窗口，从托盘菜单退出'],
    ['shortcuts.autostart', '开机启动', 'check', '登录 Windows 后自动启动 JavShelf'],
    ['shortcuts.startupTip', '打开提示', 'check', '启动后显示一行操作提示']
  ],
  data: [
    ['dataDir', '数据目录', 'text', '旧程序存放数据库和旧海报/剧照/头像图的那层目录。填了：导入旧库、读旧图、以及头像写回同一处；留空：JavShelf 用程序目录旁的 JavShelf-data 自己存'],
    ['proxy', '代理', 'text', '抓取头像用，如 http://127.0.0.1:7890'],
    ['javdbCookie', 'JavDB Cookie', 'text', '点下面的「从 Chrome 获取 Cookie」自动填；也可以手工粘贴 javdb.com 的 Cookie。留空时身高/三围走日文维基'],
    ['javdbThrottle', '抓取间隔(ms)', 'number', null, '低于 900 容易被 JavDB 边缘节点回 502'],
    ['bridge.enabled', '打开本地桥接', 'check', '浏览器拓展通过它查询「本地有没有这部」并调用播放器。只监听 127.0.0.1，且要求拓展专用的请求头'],
    ['bridge.port', '桥接端口', 'number', null, '拓展选项页里填同一个端口（默认 45789）；端口被别的程序占用时会显示未启动']
  ]
};

const dig = (o, p) => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
function put(obj, p, v) {
  const keys = p.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) cur = cur[keys[i]] = cur[keys[i]] && typeof cur[keys[i]] === 'object' ? cur[keys[i]] : {};
  cur[keys[keys.length - 1]] = v;
}

function settingsModal() {
  const before = { ...state.app };
  let saved = false;
  let previewed = false;
  const revertPreview = () => {
    if (saved || !previewed) return;
    state.app = { ...before };
    applyAppearance();
    render();
  };
  modal('设置', (m, close) => {
    m.classList.add('settings-modal');
    const patch = {};
    const touched = new Set();
    const controls = new Map();
    const valueOf = (path) => (touched.has(path) ? dig(patch, path) : dig(state.cfg, path));
    const set = (path, value, live = true) => {
      put(patch, path, value);
      touched.add(path);
      if (live) {
        if (path.startsWith('appearance.')) previewed = true;
        liveApply(path, value);
      }
    };

    const tabs = el('div', 'settings-tabs');
    tabs.setAttribute('role', 'tablist');
    const pane = el('div', 'settings-pane');
    const footer = el('div', 'settings-footer');
    m.append(tabs, pane, footer);

    const makeRow = (label, node, help) => {
      const row = el('div', 'settings-row');
      row.append(el('span', 'settings-label', label), node);
      if (help) node.title = row.title = help;
      return row;
    };
    const action = (label, title, fn) => {
      const b = el('button', 'ghost', label);
      if (title) b.title = title;
      b.onclick = fn;
      return b;
    };

    const paintDataTools = () => {
      const block = el('div', 'settings-block');
      block.append(el('div', 'settings-block-title', '头像与缓存'));
      const tools = el('div', 'settings-tools');
      const grab = action(
        '从 Chrome 获取 Cookie',
        '用你自己的 Chrome 打开 javdb.com，登录后自动取回 Cookie；只需登录一次，以后点一下就回填',
        async () => {
          grab.disabled = true;
          grab.textContent = '等待 Chrome 里登录…';
          setStatus('已打开 Chrome：请在里面登录 JavDB。那个窗口不会自动关闭，登录完成后会自动回填，之后你自己关掉它即可');
          try {
            const r = await A.javdbCookieFromChrome();
            if (r.ok) {
              state.cfg.javdbCookie = r.cookie;
              set('javdbCookie', r.cookie, false);
              if (controls.get('javdbCookie')) controls.get('javdbCookie').value = r.cookie;
              setStatus(
                `已回填 ${r.count} 条 Cookie，点保存设置生效` + (r.looksLoggedIn ? '' : '（未检测到登录状态，若抓取仍无权限请在 Chrome 里重新登录）'),
                9000
              );
            } else setStatus('没读到 Cookie：' + (r.reason || ''), 9000);
          } catch (e) {
            setStatus('读取失败：' + e.message, 9000);
          }
          grab.disabled = false;
          grab.textContent = '从 Chrome 获取 Cookie';
        }
      );
      const impDir = action('导入头像文件夹', '', async () => {
        const d = await A.pickDir();
        if (!d) return;
        await runLocalAvatarImport({ dir: d });
      });
      const impZip = action('导入头像压缩包', '', async () => {
        const z = await A.pickZipFile();
        if (!z) return;
        await runLocalAvatarImport({ zip: z });
      });
      const asCov = action(
        '头像设为封面墙封面',
        '把已有本地头像的女优，她的头像直接用作女优封面墙的封面；没有头像的保持默认（发行最早那部作品的封面）',
        async () => {
          asCov.disabled = true;
          try {
            const r = await A.actorUseAvatarsAsCovers();
            setStatus(`已把 ${r.applied} 位头像设为封面，${r.kept} 位没有头像保持默认`, 8000);
            await loadIdols();
            render();
          } catch (e) {
            setStatus('设置失败：' + e.message, 8000);
          }
          asCov.disabled = false;
        }
      );
      const cache = action(
        '清空图片缓存',
        '网盘挂载盘（如 X:）上的海报与 nfo 会在每次库扫描结束时自动预热一份本地副本（本地快盘不复制，变了的重取）；这里显示占用并可清空',
        async () => {
          cache.disabled = true;
          try {
            const info = await A.imgCacheInfo();
            if (!info.files) {
              const after = await A.imgCacheClear();
              setStatus(`图片缓存是空的（目录 ${after.dir}）`, 7000);
            } else {
              const mb = (info.bytes / 1048576).toFixed(1);
              if (confirm(`清空图片缓存？\n\n当前 ${info.files} 个文件 · ${mb} MB，位置：\n${info.dir}\n\n清掉后海报墙会先回原盘读一次；下一次扫描/刷新结束时会自动重新预热。`)) {
                const after = await A.imgCacheClear();
                setStatus(`已清空图片缓存（${after.files} 个文件）`, 6000);
              }
            }
          } catch (e) {
            setStatus('图片缓存操作失败：' + e.message, 8000);
          }
          cache.disabled = false;
        }
      );
      tools.append(grab, impDir, impZip, asCov, cache);
      block.append(tools);
      pane.append(block);

      const ext = el('div', 'settings-block');
      ext.append(el('div', 'settings-block-title', '浏览器拓展'));
      const status = el('div', 'settings-note', '状态读取中…');
      const show = async () => {
        try {
          const b = await A.bridgeStatus();
          const n = b.stats || {};
          status.textContent = b.running
            ? `运行中：127.0.0.1:${b.port}　查询 ${n.lookups || 0} 次 · 播放 ${n.plays || 0} 次 · 挡下没带专用头的请求 ${n.rejected || 0} 次`
            : b.error
              ? '未启动：' + b.error
              : '未开启（勾上「打开本地桥接」再保存）';
        } catch (e) {
          status.textContent = '状态读取失败：' + e.message;
        }
      };
      const open = action('打开拓展所在文件夹', '', async () => {
        try {
          const r = await A.bridgeOpenExtension();
          if (!r.ok) setStatus('打不开拓展目录：' + r.error, 7000);
        } catch (e) {
          setStatus('打不开拓展目录：' + e.message, 7000);
        }
      });
      const refresh = action('刷新状态', '', show);
      const row = el('div', 'settings-tools');
      row.append(open, refresh);
      ext.append(row, status);
      ext.append(
        hint('装法：浏览器里打开 chrome://extensions（Edge 是 edge://extensions）→ 开启「开发者模式」→「加载已解压的扩展程序」→ 选 extension 目录；再在拓展的选项页里填桥接端口。')
      );
      pane.append(ext);
      show();
    };

    const buildPane = (key) => {
      pane.textContent = '';
      controls.clear();
      const list = el('div', 'settings-list');
      for (const [path, label, kind, arg, help] of SETTINGS_SPEC[key]) {
        const cur = valueOf(path);
        let node;
        let extra = null;
        if (kind === 'check') {
          node = el('input');
          node.type = 'checkbox';
          node.checked = !!cur;
          node.onchange = () => set(path, node.checked);
        } else if (kind === 'select') {
          node = select(arg, cur);
          node.onchange = () => set(path, node.value);
        } else if (kind === 'range') {
          node = el('input');
          node.type = 'range';
          [node.min, node.max, node.step] = arg;
          node.value = cur == null ? arg[0] : cur;
          extra = el('span', 'num', String(node.value));
          node.oninput = () => {
            extra.textContent = node.value;
            set(path, Number(node.value));
          };
        } else {
          node = input(cur);
          if (kind === 'number') node.type = 'number';
          node.oninput = () => set(path, kind === 'number' ? Number(node.value) : node.value.trim());
        }
        node.dataset.setting = path;
        const row = makeRow(label, node, help);
        if (extra) row.append(extra);
        controls.set(path, node);
        list.append(row);
      }
      pane.append(list);
      if (key === 'data') paintDataTools();
    };

    let current = 'appearance';
    const paintTabs = () => {
      for (const b of tabs.querySelectorAll('button')) {
        const on = b.dataset.settingsTab === current;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', String(on));
      }
    };
    for (const [key, label] of SETTINGS_TABS) {
      const b = el('button', null, label);
      b.dataset.settingsTab = key;
      b.setAttribute('role', 'tab');
      b.onclick = () => {
        current = key;
        paintTabs();
        buildPane(key);
      };
      tabs.append(b);
    }

    const pathNote = el('span', 'settings-path', state.cfg.config ? '配置：' + state.cfg.config.file : '');
    const backup = action('立即备份数据库', '把当前媒体库备份到数据目录', async () => {
      try {
        setStatus('已备份：' + (await A.backup()), 6000);
      } catch (e) {
        setStatus('备份失败：' + e.message, 5000);
      }
    });
    const cancel = el('button', 'ghost', '取消');
    cancel.onclick = close;
    const save = el('button', 'ghost primary', '保存设置');
    save.onclick = async () => {
      const cfg = await A.saveSettings(patch);
      saved = true;
      state.cfg = cfg;
      state.app = { ...state.app, ...cfg.appearance };
      applyAppearance();
      render();
      // 桥接开没开成一句话说清：起不来（端口被占）时不能只写「已保存」。
      if (patch.bridge) {
        const b = cfg.bridge || {};
        setStatus(
          b.running ? `浏览器桥接已启动 127.0.0.1:${b.port}` : b.enabled ? `浏览器桥接没起来：${b.error || '未知原因'}` : '浏览器桥接已关闭',
          8000
        );
      } else setStatus('设置已保存并生效');
      close();
    };
    footer.append(pathNote, el('div', 'spacer'), backup, cancel, save);

    paintTabs();
    buildPane(current);
  }, revertPreview);
}

// Some settings are worth seeing immediately, before pressing 保存.
function liveApply(path, value) {
  if (path.startsWith('appearance.')) {
    put(state.app, path.slice('appearance.'.length), value);
    applyAppearance();
    if (path !== 'appearance.minWidth') render();
  } else if (path === 'uiScale') {
    A.saveSettings({ uiScale: value });
  }
}

/* -------------------------------------------------------------- avatar modal */

async function avatarModal() {
  modal('演员头像', async (m) => {
    let cov;
    try {
      cov = await A.actorCoverage();
    } catch (e) {
      m.append(hint(e.message));
      return;
    }
    const line = el('div', 'hint', cov.imported.length ? `已自动收下收件箱里的 ${cov.imported.length} 张图` : '未开始');
    const intro = el('div', 'prose');
    intro.innerHTML = `库内演员 <b>${cov.total}</b> 位，已有头像 <b>${cov.have}</b>，缺 <b>${cov.missing}</b>。<br>
      <span class="hint">这里就是 <b>数据目录</b> 的用处：<code class="f">${cov.dir}</code>。设置里填了旧程序的配置目录
      （放着它自己的数据库和旧海报的那层），头像就写进那里的 <code class="f">actor\\&lt;分桶&gt;\\&lt;演员名&gt;.jpg</code>；
      没填则写进 JavShelf 自己目录下的 <code class="f">JavShelf-data\\actor\\…</code>，两种都能直接用，
      下载头像不需要先填数据目录。图片一律压到 320px 宽的 JPEG。<br>
      不想联网就把图片按演员名丢进上面的 <code class="f">actor_inbox\\</code>，打开本窗口时会自动收进对应分桶。</span>`;
    m.append(intro);
    const dl = el('button', 'ghost primary', '从 JavDB 下载官方头像');
    dl.title = '给已绑定 JavDB 编号的演员下载官方写真，走 设置 → 数据 里的代理；还没绑定编号的先去「资料管理 → 抓取女优目录并绑定」';
    const fDir = el('button', 'ghost', '导入头像文件夹');
    const fZip = el('button', 'ghost', '导入头像压缩包');
    const main = el('div', 'row');
    dl.onclick = async () => {
      dl.disabled = true;
      line.textContent = '下载中…（进度见右下角任务面板）';
      try {
        const r = await A.javdbFetchAvatars({ limit: 0 });
        line.textContent = r.total
          ? `官方头像：成功 ${r.done} · 失败 ${r.failed} · 共 ${r.total}`
          : r.reason || '没有需要下载的头像';
        await refreshAvatars();
      } catch (e) {
        line.textContent = '下载失败：' + e.message;
      }
      dl.disabled = false;
    };
    fDir.onclick = async () => {
      const d = await A.pickDir();
      if (!d) return;
      line.textContent = '导入中…';
      await runLocalAvatarImport({ dir: d });
      line.textContent = '本地导入完成，左侧列表已刷新';
      await refreshAvatars();
    };
    fZip.onclick = async () => {
      const z = await A.pickZipFile();
      if (!z) return;
      line.textContent = '解压并导入中…';
      await runLocalAvatarImport({ zip: z });
      line.textContent = '本地导入完成，左侧列表已刷新';
      await refreshAvatars();
    };
    main.append(dl, fDir, fZip);
    m.append(main);
    m.append(hint('本地导入按文件名认人：图片名等于演员名（或她的任一别名）即视为同一人，支持子目录与 zip。'));
    m.append(line);
  });
}


/* ---------------------------------------------------------------- nfo modal */

const NFO_FIELDS = [
  ['title', '标题', 'text'], ['originaltitle', '原版标题', 'text'],
  ['premiered', '发行日期', 'text'], ['year', '年份', 'text'], ['runtime', '片长(分钟)', 'text'],
  ['rating', '评分', 'text'], ['studio', '片商', 'text'], ['maker', '制作', 'text'],
  ['publisher', '发行', 'text'], ['series', '系列', 'text'], ['countrycode', '国家', 'text'],
  ['genre', '类别', 'list'], ['director', '导演', 'list'], ['tag', '标签', 'list'],
  ['plot', '简介', 'area'], ['outline', '概要', 'area'], ['website', '网址', 'text']
];

async function nfoModal(code, nfoRel, meta = {}) {
  modal('编辑信息 · ' + code, async (m, close) => {
    let doc;
    try {
      doc = await A.nfoRead(nfoRel);
    } catch (e) {
      m.append(hint('读取 nfo 失败：' + e.message));
      return;
    }
    m.append(hint('直接改写视频目录里的 nfo；只替换你动过的标签，其余内容与未识别标签原样保留，首次保存生成 .nfo.bak。'));
    const inputs = {};
    for (const [tag, label, kind] of NFO_FIELDS) {
      const v = doc.fields[tag];
      if (v === undefined && !['genre', 'director', 'tag'].includes(tag)) continue;
      let node;
      if (kind === 'area') {
        node = el('textarea');
        node.rows = 4;
      } else {
        node = input(Array.isArray(v) ? v.join(' / ') : v || '');
      }
      node.value = Array.isArray(v) ? v.join(' / ') : (v || '');
      inputs[tag] = node;
      m.append(field(label, node));
    }
    const at = el('textarea');
    at.rows = 3;
    at.value = doc.actors.map((a) => (a.role ? `${a.name}|${a.role}` : a.name)).join('\n');
    m.append(field('演员', at, '每行一个，名字|角色'));
    if (doc.unknownTags.length) m.append(hint('未识别的标签会原样保留：' + doc.unknownTags.join(', ')));
    const btns = el('div', 'row');
    const save = el('button', 'ghost primary', '保存 nfo');
    const cancel = el('button', 'ghost', '取消');
    cancel.onclick = close;
    save.onclick = async () => {
      const fields = {};
      for (const [tag, , kind] of NFO_FIELDS) {
        const node = inputs[tag];
        if (!node) continue;
        fields[tag] = kind === 'list' ? node.value.split(/[/,、|]/).map((s) => s.trim()).filter(Boolean) : node.value;
      }
      const actors = at.value.split('\n').map((line) => {
        const [name, role] = line.split('|');
        return { name: (name || '').trim(), role: (role || '').trim() };
      }).filter((a) => a.name);
      // Remember which surface opened the editor: a drawer edit refreshes the drawer, and
      // only a full-detail edit rebuilds the overlay. It used to pop the overlay every time.
      const overlayOpen = !$('#detail').classList.contains('hidden');
      const drawerOpen = !$('#inspector').classList.contains('hidden');
      try {
        const res = await A.nfoWrite(nfoRel, {
          fields,
          actors,
          code,
          lib: meta.lib,
          onlyCode: meta.onlyCode
        });
        setStatus(res.changed ? '已保存 nfo（备份：' + res.backup.split(/[\/\x5c]/).pop() + '）' : '没有改动', 5000);
        if (res.changed) {
          delete mediaCache[code];
          if (res.refreshed) await reloadRows();
          if (overlayOpen) {
            await openDetail(code);
            if (drawerOpen) await openDrawer(code, { background: true });
          } else if (drawerOpen) {
            await openDrawer(code, { background: true });
          }
          close();
          if (!topModal()) {
            if (!$('#detail').classList.contains('hidden')) $('#detail .close').focus();
            else if (drawerOpen) ($('#inspector [data-inspect="full"]') || $('#navHome')).focus();
          }
        }
      } catch (e) {
        setStatus('保存失败：' + e.message, 6000);
      }
    };
    btns.append(save, cancel);
    m.append(btns);
  });
}

function manageModal() {
  modal('管理中心', (m, close) => {
    m.classList.add('wide');
    m.append(hint('浏览归浏览，管理归管理。已有的工具和数据操作都在这里。'));
    const grid = el('div', 'manage-grid');
    const entries = [
      ['libraries', '媒体库管理', '添加目录、入库、扫描与备份', libsModal],
      ['avatars', '演员头像', '导入、匹配与封面管理', avatarModal],
      ['idols', '演员资料', '资料编辑、别名与合并', idolListModal],
      ['dupes', '查重报告', '查看重复记录，不自动删除文件', dupesModal],
      ['display', '显示设置', '密度、瀑布流、各级页面排列', displayModal],
      ['settings', '偏好设置', '外观、播放、快捷、数据与浏览器拓展', settingsModal],
      ['logs', '运行日志', '查看扫描、抓取与错误记录', logModal],
      ['jobs', '后台任务', '查看最近的进度与停止入口', () => {
        const box = $('#jobPanel');
        if (box.children.length) box.classList.remove('hidden');
        else modal('后台任务', m => m.append(hint('当前没有后台任务。')));
      }]
    ];
    for (const [key, title, description, run] of entries) {
      const b = el('button', 'manage-card');
      b.dataset.manage = key;
      b.append(el('b', null, title), el('span', null, description));
      b.onclick = () => { close(); run(); };
      grid.append(b);
    }
    m.append(grid);
  });
}

/* -------------------------------------------------------------------- wire */

function wireUi() {
  $('#navHome').onclick = () => { state.nav = []; setQuick('all'); };
  $('#navFavorites').onclick = () => { state.nav = []; setQuick('fav'); };
  $('#btnManage').onclick = manageModal;
  $('#btnLibraries').onclick = () => libsModal();
  $$('#libraryIntro .stat-num').forEach((b) => {
    b.onclick = () => {
      state.nav = [];
      setQuick(b.dataset.stat);
    };
  });
  $('#btnFilters').onclick = () => setFiltersOpen($('#filterPanel').classList.contains('hidden'));
  $('#closeFilters').onclick = () => setFiltersOpen(false);
  $('#detailBackdrop').onclick = closeDetail;
  const grip = $('#inspector .drawer-grip');
  let drawerDrag = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drawerDrag = { startX: e.clientX, startW: $('#inspector').getBoundingClientRect().width };
    try { grip.setPointerCapture(e.pointerId); } catch { /* synthetic pointers cannot be captured */ }
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drawerDrag) return;
    setDrawerWidth(drawerDrag.startW + drawerDrag.startX - e.clientX, true);
  });
  const endDrawerDrag = () => { drawerDrag = null; };
  grip.addEventListener('pointerup', endDrawerDrag);
  grip.addEventListener('pointercancel', endDrawerDrag);
  grip.addEventListener('dblclick', () => setDrawerWidth(DRAWER_DEFAULT, true));
  for (const id of ['#gridHost', '#secondary']) {
    $(id).addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.card')) closeDrawer({ focus: false });
    });
  }
  $$('.rail-link').forEach(b => { b.title = b.textContent.trim(); b.setAttribute('aria-label', b.textContent.trim()); });
  const searchActor = $('#searchActor');
  const paintActorSuggest = () => {
    const name = actorJumpName($('#search').value);
    searchActor.dataset.actor = name;
    searchActor.textContent = name ? `按 Enter 进入演员「${name}」` : '';
    searchActor.classList.toggle('hidden', !name);
  };
  let deb = 0;
  $('#search').oninput = (e) => {
    paintActorSuggest();
    clearTimeout(deb);
    deb = setTimeout(() => {
      state.filters.q = e.target.value;
      state.page = 1;
      applyFilters();
    }, 160);
  };
  $('#search').onfocus = paintActorSuggest;
  $('#search').onblur = () => setTimeout(() => {
    if (document.activeElement !== searchActor) searchActor.classList.add('hidden');
  }, 120);
  $('#search').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const name = actorJumpName(e.target.value);
    if (!name) return;
    e.preventDefault();
    jumpToActor(name);
  };
  searchActor.onpointerdown = (e) => e.preventDefault();
  searchActor.onclick = () => jumpToActor(searchActor.dataset.actor);
  $('#sortKey').value = state.sort.key;
  $('#sortKey').onchange = (e) => {
    state.sort.key = e.target.value;
    applyFilters();
  };
  $('#sortDir').onclick = (e) => {
    state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
    e.target.textContent = state.sort.dir === 'desc' ? '↓' : '↑';
    applyFilters();
  };
  $('#titleField').value = state.titleField;
  $('#titleField').onchange = (e) => {
    state.titleField = e.target.value;
    for (const r of state.rows) r._title = String(r[e.target.value] || r.movie_编码 || '');
    render();
  };
  $('#cardWidth').value = state.cardW;
  $('#cardWidth').oninput = (e) => {
    state.cardW = Number(e.target.value);
    document.documentElement.style.setProperty('--card-w', state.cardW + 'px');
  };
  $('#density').oninput = (e) => {
    const n = Number(e.target.value);
    (state.disp.items || (state.disp.items = {})).perRow = n;
    paintDensity();
    gridCols(n);
  };
  $('#density').onchange = async (e) => {
    const n = Number(e.target.value);
    try {
      const cfg = await A.saveSettings({ display: { items: { ...(state.disp.items || {}), perRow: n } } });
      state.disp = cfg.display;
      applyDisplay();
      setStatus(n ? `海报密度：每行 ${n} 列` : '海报密度：自动', 3000);
    } catch (err) {
      setStatus('保存海报密度失败：' + err.message, 6000);
    }
  };
  paintPageSize();
  $('#pageSize').onchange = (e) => {
    state.pageSize = Number(e.target.value);
    (state.disp.items || (state.disp.items = {})).pageSize = state.pageSize;
    state.page = 1;
    render();
    updateBar();
  };
  $('#waterfall').onchange = (e) => {
    (state.disp.items || (state.disp.items = {})).waterfall = e.target.checked;
    applyDisplay();
    // Either direction restarts the wall from the top: the loaded set and the scroll
    // offset mean different things in the two layouts.
    state.page = 1;
    $('#gridHost').scrollTop = 0;
    render();
  };
  $('#gridHost').addEventListener('scroll', wfFill, { passive: true });
  $$('#quickFilters button').forEach((b) => (b.onclick = () => setQuick(b.dataset.quick)));
  $$('#facetTabs button').forEach((b) =>
    (b.onclick = () => {
      facetTab = b.dataset.tab;
      $$('#facetTabs button').forEach((x) => x.classList.toggle('active', x === b));
      renderFacets();
    })
  );
  $('#facetSearch').oninput = () => renderFacets();
  $('#btnSettings').onclick = settingsModal;
  $('#btnDisplay').onclick = displayModal;
  // Top-bar entries into the three secondary cover walls. Clicking one replaces the stack
  // rather than piling up, so the back button always returns to the home wall.
  $$('#wallEntries button').forEach((b) => {
    b.onclick = () => {
      closeDrawer({ focus: false });
      state.nav = [{ kind: 'covers', type: b.dataset.wall, page: 1 }];
      render();
    };
  });
  $('#btnLog').onclick = () => logModal();
  addEventListener('keydown', (e) => {
    const detailOpen = !$('#detail').classList.contains('hidden');
    const layer = topModal()?.node || (detailOpen ? $('#detail') : null);
    const typing = document.activeElement?.matches('input, textarea, select, [contenteditable="true"]');
    if (e.key === 'Tab' && layer && $('#lightbox').classList.contains('hidden')) {
      const focusable = [...layer.querySelectorAll('button, input, select, textarea, [tabindex="0"], a[href]')].filter(x => !x.disabled && x.getClientRects().length);
      const first = focusable[0] || layer;
      const last = focusable[focusable.length - 1] || layer;
      if (!layer.contains(document.activeElement) || (e.shiftKey && document.activeElement === first) || (!e.shiftKey && document.activeElement === last)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    }
    if (e.key === 'Escape') {
      if (!$('#lightbox').classList.contains('hidden')) return;
      const top = topModal();
      if (top) {
        top.shut();
        return;
      }
      if (!$('#modalHost').classList.contains('hidden')) {
        $('#modalHost').classList.add('hidden');
        $('#modalHost').textContent = '';
        return;
      }
      if (detailOpen) return closeDetail();
      if (!$('#inspector').classList.contains('hidden')) return closeDrawer();
      if (!$('#filterPanel').classList.contains('hidden')) return setFiltersOpen(false);
      // With nothing layered above it, Esc steps back out of the secondary pages.
      if (inSecondary()) return popFrame();
      return;
    }
    if (e.key === '/' && !typing && !layer && $('#lightbox').classList.contains('hidden')) {
      e.preventDefault();
      $('#search').focus();
    }
    if ((e.key === 'PageDown' || e.key === 'PageUp') && !typing && !layer && $('#lightbox').classList.contains('hidden')) {
      e.preventDefault();
      if (state.waterfall) {
        // Nothing swaps out here, so the keys move the viewport; the scroll handler loads.
        const host = $('#gridHost');
        host.scrollTop += (e.key === 'PageDown' ? 1 : -1) * Math.max(200, host.clientHeight - 60);
        return;
      }
      const pages = Math.max(1, Math.ceil(state.view.length / state.pageSize));
      state.page = Math.max(1, Math.min(pages, state.page + (e.key === 'PageDown' ? 1 : -1)));
      render();
      updateBar();
    }
  });
  A.onAppearance((a) => {
    state.app = { ...state.app, ...a };
    applyAppearance();
    render();
  });
  A.onMetrics((mm) => setDpi(mm));
  A.metrics().then((mm) => setDpi(mm));
  requestAnimationFrame(fpsLoop);
}

function setDpi(mm) {
  $('#stDpi').textContent = `DPR ${window.devicePixelRatio} · 缩放 ${(mm.scaleFactor * 100) | 0}%`;
}

let statusTimer = 0;
function setStatus(msg, ms = 4000) {
  $('#stMsg').textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { $('#stMsg').textContent = ''; }, ms);
}

// 「打开所在文件夹」在主进程要过媒体库边界这道检查，不在库里就答 {ok:false}。
// 不把它显示出来的话，按钮按下去就是什么都没发生。
async function revealDir(dir, emptyMsg) {
  if (!dir) return setStatus(emptyMsg || '还没定位到这个文件所在的文件夹', 4000);
  try {
    const r = await A.reveal(dir);
    if (r && !r.ok) setStatus(r.error || '打不开这个文件夹', 6000);
  } catch (e) {
    setStatus('打不开这个文件夹：' + ((e && e.message) || e), 6000);
  }
}

let fpsSamples = [];
let lastT = performance.now();
function fpsLoop(t) {
  const dt = t - lastT;
  lastT = t;
  fpsSamples.push(dt);
  if (fpsSamples.length > 40) fpsSamples.shift();
  const avg = fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length;
  window.__lastFps = { avg: Math.round(1000 / avg), worst: Math.max(...fpsSamples) };
  requestAnimationFrame(fpsLoop);
}

boot().catch((e) => {
  document.body.innerHTML = `<pre style="padding:20px;color:#ffb454;white-space:pre-wrap">启动失败：${e && e.stack}</pre>`;
});
