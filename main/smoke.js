'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const idolStore = require('./idols');
const { parseWikiInfobox } = require('./javdb');

// End-to-end regression driven through the real window. It starts from an empty profile
// so the first-run path is what gets exercised: add a library pointing at a folder, let
// the nfo ingest fill the wall, then measure everything the user cares about.
//
//   electron . --smoke --user-data=<scratch profile>
//
// Only local disks are touched — the cloud-mounted root is deliberately left out.

const LIB_DIR = 'G:\\JAV\\JAV_output';

async function runSmoke(win, outDir, opts = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(`(async () => { ${code} })()`, true);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (expr, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await js(`return !!(${expr});`)) return true;
      await wait(200);
    }
    throw new Error('超时等待: ' + expr);
  };
  const shot = async (name) => fs.writeFileSync(path.join(outDir, name), (await win.capturePage()).toPNG());
  const log = [];
  // Append as we go: a mid-run failure then leaves the last successful step on disk,
  // which is the only clue when the error comes back from the renderer without a stack.
  const logFile = path.join(outDir, 'smoke.log.txt');
  const step = (name, value) => {
    log.push(name + ' ' + JSON.stringify(value));
    fs.writeFileSync(logFile, log.join('\n') + '\n-- next: ' + name + ' done\n');
  };

  await waitFor('window.__booted');

  const first = await js(`
    const i = window.__bootInfo;
    return { needsSetup: i.needsSetup, rows: i.rows, libraries: (i.config.libraries||[]).length,
             setupVisible: !document.querySelector('#emptyState').classList.contains('hidden'),
             title: (document.querySelector('#emptyState h2')||{}).textContent,
             buttons: [...document.querySelectorAll('#emptyState button')].map(b=>b.textContent),
             dark: !document.body.classList.contains('light') };
  `);
  step('firstRun', first);
  await shot('smoke-01-setup.png');

  // ---- add a library pointing at a folder; the nfo ingest should fill the wall by itself
  await js(`
    document.querySelector('#emptyState button').click();
    // The modal is built asynchronously; a fixed sleep raced it and the run failed at random.
    const find=(t)=>{
      const b=[...document.querySelectorAll('#modalHost button')].find(x=>x.textContent===t);
      if(!b) throw new Error('对话框里没有按钮: '+t);
      return b;
    };
    for (let i=0;i<40 && !document.querySelector('#modalHost button');i++) await new Promise(r=>setTimeout(r,50));
    find('新建库').click();
    for (let i=0;i<40 && document.querySelectorAll('#modalHost input[type="text"]').length<2;i++) await new Promise(r=>setTimeout(r,50));
    const ins=[...document.querySelectorAll('#modalHost input[type="text"]')];
    ins[0].value='本地测试库';
    ins[1].value=${JSON.stringify(LIB_DIR)};
    find('保存').click();
    return 1;
  `);
  const filled = await waitFor('window.__state.rows.length > 500', 90000);
  const wall = await js(`
    return { rows: window.__state.rows.length, libs: window.__state.libraries.map(l=>({name:l.name,store:l.store,enabled:l.enabled!==false})),
             cards: document.querySelectorAll('#gridItems .card').length,
             setupHidden: document.querySelector('#emptyState').classList.contains('hidden'),
             job: !document.querySelector('#jobPanel').classList.contains('hidden'),
             jobText: document.querySelector('#jobPanel').textContent.slice(0,80) };
  `);
  step('ingest', { filled, ...wall });
  await shot('smoke-02-wall.png');

  // A second library, so the per-library switch can be proven to actually hide its rows.
  await js(`
    document.querySelector('#libPanel .head button').click();
    await new Promise(r=>setTimeout(r,250));
    [...document.querySelectorAll('#modalHost button')].find(b=>b.textContent==='新建库').click();
    await new Promise(r=>setTimeout(r,200));
    const ins=[...document.querySelectorAll('#modalHost input[type="text"]')];
    ins[0].value='第二库';
    ins[1].value='J:\\\\JAV2\\\\JAV_output';
    [...document.querySelectorAll('#modalHost button')].find(b=>b.textContent==='保存').click();
    return 1;
  `);
  await waitFor('window.__state.rows.length > 2500', 180000);
  step('secondLib', await js(`
    return { rows: window.__state.rows.length,
             perLib: window.__state.libraries.map(l=>({ name:l.name, rows: window.__state.rows.filter(r=>r._lib===l.name).length })) };
  `));

  const cards = await js(`
    await new Promise(r=>setTimeout(r,1500));
    const cs=[...document.querySelectorAll('#gridItems .card')];
    const imgs=cs.map(c=>c.querySelector('.poster img'));
    return { cards: cs.length, covers: imgs.length, loaded: imgs.filter(i=>i.complete&&i.naturalWidth>0).length,
             natural: imgs[0] && imgs[0].naturalWidth, code: cs[0] && cs[0].dataset.code,
             title: (cs[0]&&cs[0].querySelector('.title')||{}).textContent,
             sub: (cs[0]&&cs[0].querySelector('.sub')||{}).textContent,
             tags: cs[0] ? cs[0].querySelectorAll('.poster .tag').length : 0,
             hoverActions: cs[0] ? cs[0].querySelectorAll('.actions button').length : 0 };
  `);
  step('cards', cards);

  // The status-bar index counter must actually update after the walk; it once kept
  // painting from a stale config and read 0 forever. And every enabled library must still have
  // its own root indexed: preparing the second library used to drop the first one's index, which
  // left a fully scanned wall that could not play anything from that library.
  let stScan = await js(`return document.querySelector('#stScan').textContent;`);
  const indexed = () => parseInt((stScan.match(/\d+/) || ['0'])[0], 10);
  let scanState = null;
  for (let i = 0; i < 60; i++) {
    scanState = await js(`
      const cfg = await window.shelf.settings();
      const roots = cfg.scan || [];
      const want = [];
      for (const l of (cfg.libraries||[]).filter(l=>l.enabled!==false)) for (const d of (l.dirs||[])) want.push({ lib:l.name, dir:d });
      const key=(s)=>String(s||'').replace(/[\\\\/]+$/,'').toLowerCase();
      const missing = want.filter(w=>!roots.some(r=>key(r.dir)===key(w.dir) && r.entries>0 && !r.scanning));
      return { want, roots, missing: missing.map(m=>m.lib+' :: '+m.dir), total: roots.reduce((s,r)=>s+r.entries,0) };
    `);
    if (scanState && !scanState.missing.length && indexed() > 0) break;
    await wait(500);
    stScan = await js(`return document.querySelector('#stScan').textContent;`);
  }
  if (!indexed()) throw new Error('状态栏的「已索引文件」一直是 0：' + stScan);
  if (scanState.missing.length) throw new Error('有库的根目录没进扫描索引（播放会找不到文件）：' + JSON.stringify(scanState.missing));
  step('scanStat', { text: stScan, indexed: indexed(), roots: scanState.roots.map((r) => ({ dir: r.dir, entries: r.entries, stale: r.stale })) });

  // 帧率这一步以前只报数不断言，所以窗口被人挡住、rAF 一秒才出一帧的时候它照样"绿"，
  // 而文档里那个 FPS 就是从这种样本上抄下来的。现在把每一次停顿都摊开：只统计真出帧的
  // 那些帧，出帧占比不到八成（或中位帧比 60 Hz 慢一半以上）就判定这一轮样本作废、重来，
  // 三次都拿不到可信样本才算失败——数字宁可没有，不能是假的。
  const measure = () => js(`
    const host=document.querySelector('#gridHost');
    const frames=[]; let last=performance.now(); let stop=false;
    const tick=(t)=>{ frames.push(t-last); last=t; if(!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const H=host.scrollHeight-host.clientHeight; const t0=performance.now();
    for(let i=0;i<=30;i++){ host.scrollTop=H*i/30; await new Promise(r=>requestAnimationFrame(r)); await new Promise(r=>requestAnimationFrame(r)); }
    const end=performance.now(); host.scrollTop=0; stop=true;
    return { frames: frames.slice(2), sweepMs:+(end-t0).toFixed(0),
             domCards:document.querySelectorAll('#gridItems .card').length };
  `);
  const readScroll = (raw) => {
    const f = (raw && raw.frames) || [];
    if (!f.length) return null;
    const STALL = 200;
    const painted = f.filter((d) => d <= STALL);
    const s = [...painted].sort((a, b) => a - b);
    const q = (p) => (s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1) : 0);
    const mean = painted.reduce((a, b) => a + b, 0) / (painted.length || 1);
    return {
      frames: f.length,
      painted: painted.length,
      stalls: f.length - painted.length,
      avgFps: mean > 0 ? +(1000 / mean).toFixed(1) : 0,
      p50: q(0.5),
      p95: q(0.95),
      worst: q(1),
      sweepMs: raw.sweepMs,
      domCards: raw.domCards
    };
  };
  let perf = null;
  let scrollTries = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    scrollTries = attempt;
    perf = readScroll(await measure());
    if (perf && perf.painted >= perf.frames * 0.8 && perf.p50 <= 34) break;
    if (attempt < 3) await wait(3000);
  }
  if (!perf) throw new Error('海报墙滚动这一步一次帧都没采到');
  if (perf.painted < perf.frames * 0.8 || perf.p50 > 34) {
    throw new Error('三次采样都在挨饿，这一轮的帧率不可信：' + JSON.stringify(perf));
  }
  step('scroll', { ...perf, tries: scrollTries });


  const located = await js(`
    const codes = window.__state.rows.map(r=>r.movie_编码);
    const pick = []; for (let i=0;i<300 && codes.length;i++) pick.push(codes[Math.floor(i*codes.length/300)]);
    const found = await window.shelf.resolve(pick);
    const hits = pick.map(c=>found[c]).filter(Boolean);
    return { asked: pick.length, resolved: hits.length, withPoster: hits.filter(h=>h.poster).length,
             withNfo: hits.filter(h=>h.nfo).length, sample: hits[0] && hits[0].video,
             perLib: [...new Set(hits.map(h=>h.lib))].sort(),
             videos: hits.map(h=>({ lib:h.lib, video:h.video })) };
  `);
  {
    // 播放 resolves through this same path, so "the wall found it" is only worth asserting when
    // the answer is a real file on disk — a `r<n>/` reference or a dead path plays nothing.
    const bad = located.videos.filter((v) => !v.video || /^r\d+\//.test(v.video) || !fs.existsSync(v.video));
    if (bad.length) throw new Error(`${bad.length}/${located.videos.length} 条解析出的视频文件不在盘上：` + JSON.stringify(bad.slice(0, 3)));
    const libs = located.perLib;
    if (libs.length < 2) throw new Error('抽样只覆盖到一个库，测不出多库索引是否互相覆盖：' + JSON.stringify(libs));
    located.perLib = libs;
    located.videos = located.videos.length;
  }
  step('locate', located);

  // These codes sit in rows whose only_code is an absolute Windows path. The guard used to
  // reject it, so the exact folder was ignored and 覆写 nfo claimed there was no nfo.
  // The second half guards a later regression: the entries handed to the renderer carry
  // r<n>/ references, and passing one of those to fs lands it beside the exe (ENOENT), so the
  // real write path has to be absolute and on disk.
  const leaf = await js(`
    const codes = ['REAL-848', 'MIMK-015', 'STARS-923'];
    const found = await window.shelf.resolve(codes);
    const items = codes.map(c => {
      const e = found[c];
      return { code: c, ok: !!(e && e.nfo && e.video), depth: e && e.dir ? e.dir.split(String.fromCharCode(92)).filter(Boolean).length : 0 };
    });
    // A backslash has to be tested by code point: inside a regex literal /[\\\\/]/ the escape
    // collapses and the class ends up matching only "/", which would pass a rel path.
    const BS = String.fromCharCode(92);
    const abs = [];
    for (const c of codes) {
      const r = await window.shelf.nfoPath(c);
      const p = String(r.abs || '');
      abs.push({ code: c, onDisk: !!r.exists, absolute: /^[A-Za-z]:/.test(p) && p.indexOf(BS) > 0, looksRelative: /^r\\d+\\//.test(p) });
    }
    return { items, all: items.every(i => i.ok), nfoAbs: abs, nfoAllOnDisk: abs.every(a => a.onDisk && a.absolute), nfoNoneRelative: abs.every(a => !a.looksRelative) };
  `);
  step('leaf', leaf);


  const detail = await js(`
    const codes = window.__state.rows.slice(0,600).map(r=>r.movie_编码);
    const found = await window.shelf.resolve(codes);
    const code = codes.find(c=>found[c] && found[c].fanart && found[c].nfo);
    await window.__openDetail(code);
    await new Promise(r=>setTimeout(r,1500));
    const d=document.querySelector('#detail');
    const stills=[...d.querySelectorAll('.stills img')];
    return { code, open: !d.classList.contains('hidden'),
             actions: [...d.querySelectorAll('.actions button')].map(b=>b.textContent),
             stills: stills.length, stillsLoaded: stills.filter(i=>i.complete&&i.naturalWidth>0).length,
             ratio: stills[0] ? +(stills[0].naturalWidth/stills[0].naturalHeight).toFixed(2) : 0,
             path: (d.querySelector('.pathline span')||{}).textContent,
             hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  `);
  step('detail', detail);
  await shot('smoke-03-detail.png');

  const lightbox = await js(`
    const im=document.querySelector('#detail .stills img');
    if(!im) return { skipped:true };
    im.click(); await new Promise(r=>setTimeout(r,700));
    const box=document.querySelector('#lightbox'); const big=box.querySelector('img');
    const opened=!box.classList.contains('hidden')&&big.complete&&big.naturalWidth>0;
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
    await new Promise(r=>setTimeout(r,200));
    return { opened, closed: box.classList.contains('hidden') };
  `);
  step('lightbox', lightbox);

  // ---- 女优资料：导入 + 特色排序 + 编辑
  const idols = await js(`
    const guess = await window.shelf.idolGuess();
    const res = guess ? await window.shelf.idolImport(guess) : { added: 0, total: 0 };
    await window.__loadIdols();
    await window.__refreshAvatars();
    document.querySelector('#facetTabs button[data-tab="actor"]').click();
    await new Promise(r=>setTimeout(r,900));
    const chips=[...document.querySelectorAll('#actorSort button')].map(b=>b.textContent);
    const before=[...document.querySelectorAll('#facetList .facet .name')].slice(0,3).map(e=>e.textContent);
    const byHeight=[...document.querySelectorAll('#actorSort button')].find(b=>b.textContent==='身高');
    byHeight && byHeight.click();
    await new Promise(r=>setTimeout(r,700));
    const after=[...document.querySelectorAll('#facetList .facet')].slice(0,3).map(e=>e.querySelector('.name').textContent+' '+(e.querySelector('.extra')||{}).textContent);
    return { guess: !!guess, ...res, chips, before, byHeight: after,
             withAvatar: document.querySelectorAll('#facetList .facet img.avatar').length };
  `);
  step('idols', idols);

  // 右键菜单 must actually open 编辑女优信息 and 保存 must write the field back — this step used to
  // report opened:false forever because it counted inputs without clicking the menu item.
  const idolEdit = await js(`
    const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
    const row=document.querySelector('#facetList .facet');
    const name=row.querySelector('.name').textContent;
    row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:200,clientY:200}));
    await wait(300);
    const mi=[...document.querySelectorAll('.ctxmenu button')].find(b=>b.textContent==='编辑资料');
    if(!mi) throw new Error('演员右键菜单里没有「编辑资料」');
    mi.click();
    await wait(400);
    if(!document.querySelector('#modalHost .bindrow')) throw new Error('编辑女优信息里没有 JavDB 绑定块');
    const ins=[...document.querySelectorAll('#modalHost input[data-field]')];
    if(ins.length<11) throw new Error('编辑女优信息字段不齐，只有 '+ins.length+' 个：'+ins.map(i=>i.dataset.field).join(','));
    if(!ins.some(i=>i.dataset.field==='birth_place')) throw new Error('编辑女优信息没有出身地一格：'+ins.map(i=>i.dataset.field).join(','));
    const titles=[...document.querySelectorAll('#modalHost .field .lab')].map(e=>e.textContent);
    // Chosen by field, not by position: the manual JavDB row is part of this dialog now and
    // a positional pick used to grab whichever input happened to be fourth.
    const h=document.querySelector('#modalHost input[data-field="height_cm"]');
    if(!h) throw new Error('没有按字段名给出身高输入框：'+titles.join('/'));
    h.value='161';
    // 从日文维基补全 is reachable from this dialog. With no proxy configured it must say so in
    // plain language and never touch the network, which is the whole offline contract here.
    const wikiBtn=[...document.querySelectorAll('#modalHost button')].find(b=>b.textContent==='从日文维基补全');
    if(!wikiBtn) throw new Error('编辑女优信息里没有「从日文维基补全」按钮，实有：'+[...document.querySelectorAll('#modalHost button')].map(b=>b.textContent).join('/'));
    wikiBtn.click();
    await wait(1500);
    const wikiHint=[...document.querySelectorAll('#modalHost .bindrow .hint')].map(e=>e.textContent).join(' ');
    if(!/读取失败：/.test(wikiHint)) throw new Error('维基补全没给出结果行：'+wikiHint);
    if(!/代理/.test(wikiHint)) throw new Error('没配代理时维基补全没说清原因：'+wikiHint);
    if(/invoking remote method/i.test(wikiHint)) throw new Error('维基补全露出了 Electron 的报错壳子：'+wikiHint);
    const save=[...document.querySelectorAll('#modalHost button')].find(b=>b.textContent==='保存');
    save.click();
    await wait(900);
    const stored=(await window.shelf.idolList()).find(p=>p.name===name);
    if(!stored || String(stored.height_cm)!=='161') throw new Error('保存身高没写进库: '+JSON.stringify(stored&&{n:stored.name,h:stored.height_cm}));
    return { name, opened: ins.length, height: stored.height_cm };
  `);
  step('idolEdit', idolEdit);

  // ---- v1.6.5 的三件事：日志写本地钟点、罩杯存成字母、维基档案卡按最新时点解析。
  // These read the scratch profile's own database and a captured infobox, so no request leaves
  // the machine — the shapes are what regressed, not the network.
  const { app } = require('electron');
  const dataShape = await js(`
    // 1) 日志时间：必须是这台机器的钟点，差出几小时就是 UTC 又漏出来了。
    // The sample libraries are local disks, so the warm pass stays quiet by design — ask for a
    // code that isn't in the library to get one line written (it removes nothing, changes=0).
    const poke = await window.shelf.dbRemove('__NO_SUCH_CODE__', '本地测试库');
    if (poke.removed) throw new Error('探针番号被当成真记录删掉了：' + JSON.stringify(poke));
    const stamps=(await window.shelf.logList()).map(e=>e.t);
    if(!stamps.length) throw new Error('日志缓冲区是空的，测不了时间戳');
    const now=new Date(), localNow=now.getHours()*3600+now.getMinutes()*60+now.getSeconds();
    for (const t of stamps.slice(-6)) {
      const m=/^(\\d{2}):(\\d{2}):(\\d{2})$/.exec(t);
      if(!m) throw new Error('日志时间戳不是 HH:MM:SS：'+t);
      const d=Math.abs(Number(m[1])*3600+Number(m[2])*60+Number(m[3])-localNow);
      if(Math.min(d,86400-d)>600) throw new Error('日志时间不是本地钟点：'+t+'（本机 '+localNow+'）');
    }
    // 2) 罩杯与尺寸：编辑框里写进来什么形状，库里就该存成什么
    const probe='__归一样本';
    await window.shelf.idolSave({ name: probe, cup: '10.0', height_cm: '160 cm', bust: '88cm', waist: '58', hips: '85 厘米', birth_place: '東京都' });
    await window.shelf.idolSave({ name: probe+'2', cup: 'F65', height_cm: '155' });
    const rows=await window.shelf.idolList();
    const a=rows.find(p=>p.name===probe), b=rows.find(p=>p.name===probe+'2');
    if(!a||a.cup!=='J') throw new Error('枚举罩杯 10.0 没写成字母 J：'+JSON.stringify(a&&a.cup));
    if(!b||b.cup!=='F') throw new Error('带底围的 F65 没写成 F：'+JSON.stringify(b&&b.cup));
    if(a.height_cm!=='160'||a.bust!=='88'||a.hips!=='85') throw new Error('尺寸没归一成数字：'+JSON.stringify([a.height_cm,a.bust,a.hips]));
    // 3) 出身地有自己的格子，写进去就该读得回来
    if(a.birth_place!=='東京都') throw new Error('出身地没存进它自己那一格：'+JSON.stringify(a.birth_place));
    return { stamp: stamps.slice(-1)[0], cupA: a.cup, cupB: b.cup, measures: [a.height_cm, a.bust, a.waist, a.hips] };
  `);
  {
    const dbFile = path.join(app.getPath('userData'), 'JavShelf.db');
    // The import path and the startup repair have to agree with the dialog: no numeric cup left.
    const left = idolStore.list(dbFile).filter((p) => /^\d/.test(String(p.cup || '')));
    if (left.length) throw new Error('库里还有数字罩杯没归一：' + JSON.stringify(left.slice(0, 3).map((p) => [p.name, p.cup])));
    // An old row that predates the repair — 出身地 parked in 中文名, cup still an enum number.
    const db = new DatabaseSync(dbFile);
    db.prepare("UPDATE idol SET cup='6.0', chinese_name='東京都', birth_place='' WHERE name='__归一样本'").run();
    db.close();
    const rep = idolStore.repairLegacy(dbFile);
    const fixed = idolStore.get(dbFile, '__归一样本');
    if (fixed.cup !== 'F') throw new Error('启动修正没把 6.0 改成 F：' + fixed.cup);
    if (fixed.chinese_name !== '' || fixed.birth_place !== '東京都') throw new Error('出身地没从中文名迁出：' + JSON.stringify([fixed.chinese_name, fixed.birth_place]));
    const again = idolStore.repairLegacy(dbFile);
    if (again.cups || again.places) throw new Error('启动修正不幂等，第二次又改了：' + JSON.stringify(again));
    const clean = new DatabaseSync(dbFile);
    clean.prepare("DELETE FROM idol WHERE name LIKE '__归一样本%'").run();
    clean.close();
    dataShape.repaired = rep;
  }
  await js('await window.__loadIdols(); return true;');
  {
    // The infobox, as two real pages arrived on 2026-09-25: a machine-readable tail, a rendered
    // row that repeats everything in inches, and a 時点 stamp to pick between blocks by.
    const nine = parseWikiInfobox(
      '愛称 てな 生年月日 1993年 12月8日 現年齢 32歳 出身地 日本 ・ 愛知県 豊橋市 血液型 A型 ' +
        '公称サイズ（ 2024年 時点） 身長 / 体重 160 cm / ― kg スリーサイズ 98 - 70 - 104 cm ブラサイズ H ' +
        '英米単位系 身長 / 体重 5 ft 3 in / ― lb スリーサイズ 39 - 28 - 41 in 活動 ' +
        '時点 : wt : 2024年 , 身長 : wt : 160 , 体重 : wt : , バスト : wt : 98 , ウエスト : wt : 70 , ヒップ : wt : 104 , カップ : wt : H ,'
    );
    const deep = parseWikiInfobox(
      '生年月日 1998年 〈 平成 10年〉 3月18日 出身地 日本 ・ 栃木県 （ 埼玉県 との発言もある） 血液型 A型 ' +
        '公称サイズ（2020年 時点） 身長 / 体重 158 cm / ― kg スリーサイズ 87.8 - 63.5 - 91.1 cm ' +
        '英米単位系 身長 / 体重 5 ft 2 in / ― lb スリーサイズ 35 - 25 - 36 in ' +
        '時点 : wt : 2020年 , 身長 : wt : 158 , 体重 : wt : , バスト : wt : 87.8 , ウエスト : wt : 63.5 , ヒップ : wt : 91.1 , カップ : wt : ,'
    );
    const twice = parseWikiInfobox(
      '公称サイズ（ 2019年 時点） 身長 / 体重 158 cm / ― kg スリーサイズ 84 - 58 - 85 cm ブラサイズ E 活動 ' +
        '公称サイズ（ 2024年 時点） 身長 / 体重 160 cm / ― kg スリーサイズ 90 - 60 - 88 cm ブラサイズ F 活動'
    );
    const want = (label, got, exp) => {
      if (got !== exp) throw new Error(label + ' 解析错：期望 ' + JSON.stringify(exp) + '，实得 ' + JSON.stringify(got));
    };
    want('七海 身高', nine.height, '160');
    want('七海 三围', [nine.bust, nine.waist, nine.hips].join('-'), '98-70-104');
    want('七海 罩杯', nine.cup, 'H');
    want('七海 出身地', nine.birthPlace, '愛知県豊橋市');
    want('七海 生日', nine.birthDate, '1993-12-08');
    want('七海 时点', nine.asOf, '2024');
    want('深田 生日（年号夹在中间）', deep.birthDate, '1998-03-18');
    want('深田 三围', [deep.bust, deep.waist, deep.hips].join('-'), '87.8-63.5-91.1');
    want('深田 罩杯（页上没写）', deep.cup, '');
    want('深田 出身地', deep.birthPlace, '栃木県');
    want('两个时点取最新 身高', twice.height, '160');
    want('两个时点取最新 三围', [twice.bust, twice.waist, twice.hips].join('-'), '90-60-88');
    want('两个时点取最新 罩杯', twice.cup, 'F');
    dataShape.wiki = { nine, deep, twice };
  }
  step('idolData', dataShape);

  // ---- 手动绑定 JavDB：抓取认不出的女优，在她的二级界面贴一次链接就绑上。
  // 校验 is the half that needs the network, 绑定 is a local write — both must answer clearly
  // with no proxy configured, which is exactly the state this profile is in.
  const idolBind = await js(`
    const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
    const btn=(t)=>[...document.querySelectorAll('#modalHost button')].find(b=>b.textContent===t);
    window.__openSecondary('actress');
    await wait(1600);
    // Not the first tile: the later avatar steps work on the top actress, and this step leaves a
    // stored avatar behind for whoever it binds.
    const tiles=[...document.querySelectorAll('#secondary .covtile')];
    if(!tiles.length) throw new Error('女优封面墙是空的，绑不了');
    const tile=tiles[Math.min(2, tiles.length-1)];
    const name=tile.dataset.name;
    tile.click();
    await wait(1400);
    const nav=(document.querySelector('#secondary .navcount')||{}).textContent||'';
    const bindNav=[...document.querySelectorAll('#secondary .navbar2 button')].find(b=>/绑定 JavDB/.test(b.textContent));
    if(!bindNav) throw new Error('二级界面没有绑定 JavDB 按钮');
    bindNav.click();
    await wait(500);
    const rowShown=!!document.querySelector('#modalHost .bindrow');
    const ref=document.querySelector('#modalHost input[data-field="javdb"]');
    if(!ref) throw new Error('编辑女优信息里没有 JavDB 输入框');
    // 校验/绑定 的答复由主进程回来，多库后台预热正忙时固定 sleep 就是赌：以前赌 900 ms 直接读到空串，
    // 判成「没给出提示」。这里既不赌时间也不看「文本变没变」——编辑弹窗里有两块 .bindrow（JavDB 绑定
    // 与日文维基），静态那行一渲染就非空，等「变了」会在请求刚发出去时就返回。
    // 真正的信号是那颗按钮重新可用、并且结果行不再写着「正在…」，两个条件都满足才算落定。
    const bindRow=[...document.querySelectorAll('#modalHost .bindrow')].find(b=>b.querySelector('input[data-field="javdb"]'));
    if(!bindRow) throw new Error('绑定块没渲染出来');
    const resultEl=()=>{ const hs=[...bindRow.querySelectorAll('.hint')]; return hs[hs.length-1]; };
    const hintText=()=>(resultEl()?resultEl().textContent:'').trim();
    const busy=()=>[...bindRow.querySelectorAll('button')].some(b=>b.disabled||/正在/.test(b.textContent));
    const waitHint=async (prev, ms)=>{ const t0=Date.now(); for(;;){ await wait(120);
      const s=hintText();
      if(!busy() && s && s!==prev && !/^正在/.test(s)) return s;
      if(Date.now()-t0>ms) return s; } };
    // 1) nonsense in, plain-language error out — no request can leave the machine
    ref.value='她就是叫这个名字啊';
    btn('校验').click();
    const badText=await waitHint('', 6000);
    if(!/认不出 JavDB 编号/.test(badText)) throw new Error('乱输入没给出可懂的提示: '+badText);
    if(!/贴整条链接/.test(badText)) throw new Error('提示里没说该贴什么');
    if(/invoking remote method/i.test(badText)) throw new Error('给用户看了 Electron 的报错壳子: '+badText);
    // 2) a well-formed id but no proxy: 校验 must fail with the proxy hint, not hang or throw raw
    ref.value='https://www.javdb.com/actors/zz99/别人写的别名';
    btn('校验').click();
    const noProxy=await waitHint(badText, 12000);
    if(!/校验失败：.*(代理)/.test(noProxy)) throw new Error('没代理时校验没给出代理提示: '+noProxy);
    // 3) 绑定 is offline-safe: it writes the id + her index row so the avatar path works later
    btn('绑定').click();
    const bound=await waitHint(noProxy, 12000);
    document.querySelector('#modalHost .x').click();
    await wait(400);
    const stored=(await window.shelf.idolList()).find(p=>p.name===name);
    const navAfter=(document.querySelector('#secondary .navcount')||{}).textContent||'';
    const navBtn=[...document.querySelectorAll('#secondary .navbar2 button')].map(b=>b.textContent);
    if(!stored || stored.javdb_id!=='zz99') throw new Error('绑定没写进库里: '+JSON.stringify(stored&&{n:stored.name,id:stored.javdb_id}));
    if(stored.javdb_url!=='https://javdb.com/actors/zz99') throw new Error('地址没按编号重建: '+stored.javdb_url);
    if(!/JavDB zz99/.test(navAfter)) throw new Error('导航条没显示新绑定: '+navAfter);
    if(!navBtn.some(t=>/改绑/.test(t))) throw new Error('按钮没改成改绑: '+navBtn.join(','));
    // The local avatar short-circuits the download, so the reason string is the only proof the
    // index row exists — and it costs no request.
    const png=await new Promise((res)=>{
      const c=document.createElement('canvas'); c.width=120; c.height=160;
      const g=c.getContext('2d'); g.fillStyle='#3b6ea5'; g.fillRect(0,0,120,160);
      res(c.toDataURL('image/png'));
    });
    await window.shelf.actorSetFromData(name, png);
    const gap=await window.shelf.javdbFetchAvatarFor(name);
    if(!/本地已经有她的头像/.test(gap.reason||'')) throw new Error('绑定后演员索引里找不到她: '+JSON.stringify(gap));
    // 4) unbind back to nothing so the rows further down start clean
    await window.shelf.idolPatch(name, { javdb_id:'', javdb_url:'' });
    await window.__loadIdols();
    while (window.__state.nav.length) window.__nav.pop();
    await wait(600);
    return { name, nav, navAfter, rowShown, navClean: window.__state.nav.length===0,
             badText: badText.slice(0,80), noProxy: noProxy.slice(0,60),
             bound: bound.slice(0,90), id: stored.javdb_id, url: stored.javdb_url, reason: gap.reason };
  `);
  step('idolBind', idolBind);
  await shot('smoke-09-idol-bind.png');

  const facets = await js(`
    const out={};
    // The 制作 tab was removed on request; the wall entry in the top bar replaces it.
    out.studioTabGone = !document.querySelector('#facetTabs button[data-tab="studio"]');
    for (const b of [...document.querySelectorAll('#facetTabs button')]) {
      b.click();
      await new Promise(r=>setTimeout(r,350));
      out[b.dataset.tab]=document.querySelectorAll('#facetList .facet').length;
    }
    document.querySelector('#facetTabs button[data-tab="actor"]').click();
    await new Promise(r=>setTimeout(r,300));
    return out;
  `);
  step('facets', facets);

  // 排列方式：侧栏的方向按钮要真的翻转列表，并且和 显示设置 写同一个值。
  const actorOrder = await js(`
    const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
    const names=()=>[...document.querySelectorAll('#facetList .facet .name')].slice(0,3).map(e=>e.textContent);
    const chip=(t)=>[...document.querySelectorAll('#actorSort button')].find(b=>b.textContent===t);
    chip('身高').click(); await wait(400);
    const desc=names();
    const dirLabel=()=>{const b=[...document.querySelectorAll('#actorSort button')].find(x=>/升序|降序/.test(x.textContent));return b?b.textContent:'';};
    const beforeLabel=dirLabel();
    const dirBtn=[...document.querySelectorAll('#actorSort button')].find(b=>/升序|降序/.test(b.textContent));
    if(dirBtn){ dirBtn.click(); await wait(400); }
    const asc=names();
    const stored=window.__state.disp.actor;
    chip('作品数').click(); await wait(300);
    return { beforeLabel, afterLabel: dirLabel(), flipped: desc.join()!==asc.join(),
             desc: desc[0], asc: asc[0], sortKey: stored.sort, sortDir: stored.sortDir,
             chips: [...document.querySelectorAll('#actorSort button')].map(b=>b.textContent) };
  `);
  step('actorOrder', actorOrder);

  const filter = await js(`
    const first=document.querySelector('#facetList .facet');
    const name=first.querySelector('.name').textContent;
    first.click();
    await new Promise(r=>setTimeout(r,700));
    const picked={ name, view: window.__state.view.length, chips: document.querySelectorAll('#activeFilters .chip').length };
    document.querySelector('#activeFilters .chip button').click();
    await new Promise(r=>setTimeout(r,700));
    return { ...picked, cleared: window.__state.view.length };
  `);
  step('facetFilter', filter);

  // ---- 二级界面：封面墙 / 单个实体的作品列表 / 返回 ----
  const secondary = await js(`
    const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
    const tiles = ()=>document.querySelectorAll('#secondary .covtile').length;
    const withImg = ()=>document.querySelectorAll('#secondary .covtile img').length;
    const out = {};
    for (const type of ['actress','studio','series']) {
      window.__openSecondary(type);
      await wait(1200);
      out[type] = { tiles: tiles(), imgs: withImg(), shown: !document.querySelector('#secondary').classList.contains('hidden'),
                    homeHidden: document.querySelector('#gridHost').classList.contains('hidden'),
                    title: (document.querySelector('#secondary .navtitle')||{}).textContent };
      window.__nav.pop();
      await wait(400);
    }
    // actress tile -> her films -> back to covers -> back to home
    window.__openSecondary('actress');
    await wait(900);
    // The wheel must work here and the status bar must stay readable above everything.
    const sec = document.querySelector('#secondary');
    sec.scrollTop = 400;
    await wait(250);
    const scrolled = sec.scrollTop;
    sec.scrollTop = 0;
    const sb = document.querySelector('#statusbar').getBoundingClientRect();
    const probe = document.elementFromPoint(Math.round(sb.left + sb.width / 2), Math.round(sb.top + sb.height / 2));
    const barReadable = !!probe && (probe.id === 'statusbar' || document.querySelector('#statusbar').contains(probe));
    document.querySelector('#btnLog').click();
    await wait(300);
    const logOpen = !!document.querySelector('#logBox');
    document.querySelector('#modalHost .x').click();
    await wait(200);
    const firstName = document.querySelector('#secondary .covtile').dataset.name;
    document.querySelectorAll('#secondary .covtile')[0].click();
    await wait(900);
    const films = { cards: document.querySelectorAll('#secondary .card').length,
                    title: (document.querySelector('#secondary .navtitle')||{}).textContent,
                    pager: !!document.querySelector('#secondary .pager') };
    document.querySelector('#secondary .back').click();
    await wait(900);
    const backToCovers = tiles();
    document.querySelector('#secondary .back').click();
    await wait(900);
    const home = { secondaryHidden: document.querySelector('#secondary').classList.contains('hidden'),
                   cards: document.querySelectorAll('#gridItems .card').length,
                   rows: window.__state.rows.length, navDepth: window.__state.nav.length };
    return { ...out, firstName, films, backToCovers, home, scrolled, barReadable, logOpen };
  `);
  step('secondary', secondary);

  // ---- 三级界面（单个女优的作品列表）必须听顶栏那个「排序」 ----
  const entitySort = await js(`
    const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
    const codes=()=>[...document.querySelectorAll('#secondary .card')].map(c=>c.dataset.code);
    const byCode=new Map(window.__state.rows.map(r=>[String(r.movie_编码||''), r]));
    const val=(c,key)=>String(byCode.has(c) ? (byCode.get(c)[key] ?? '') : '');
    // 单调性就是这一屏的判据：方向不同、键不同，顺序必须跟着变，且变得有规律
    const mono=(list,key,dir)=>{
      const num=key==='movie_评分';
      for(let i=1;i<list.length;i++){
        const a=val(list[i-1],key), b=val(list[i],key);
        const cmp=num ? (Number(a)||0)-(Number(b)||0) : String(a).localeCompare(String(b),'zh');
        if(dir==='asc' ? cmp>0 : cmp<0) return false;
      }
      return true;
    };
    const setSort=async(key,dir)=>{
      const sel=document.querySelector('#sortKey');
      if(sel.value!==key){ sel.value=key; sel.dispatchEvent(new Event('change',{bubbles:true})); await wait(900); }
      const btn=document.querySelector('#sortDir');
      const want=dir==='desc' ? '↓' : '↑';
      if(btn.textContent.trim()!==want){ btn.click(); await wait(900); }
      await wait(250);
    };
    window.__openSecondary('actress');
    await wait(1400);
    // 那一墙按名字排并且只显示前 400 格，点第一格会落在一位只有一部片的女优身上——
    // 那一屏看不出任何顺序。所以直接从数据里挑作品最多的那位，再进她那一屏。
    const all=window.__nav.entries('actress');
    const top=all.reduce((a,b)=>(!a||b.count>a.count)?b:a, null);
    window.__nav.push({ kind:'entity', type:'actress', name: top.name, page: 1 });
    await wait(1400);
    const sec=document.querySelector('#secondary');
    const inEntity=!sec.classList.contains('hidden') && !!document.querySelector('#secondary .navtitle')
      && document.querySelectorAll('#secondary .card').length>0;
    const filmsOfTile=top.count;
    const rowsHead0=String((window.__state.rows[0]||{}).movie_编码||'');
    const key0=document.querySelector('#sortKey').value, dir0=document.querySelector('#sortDir').textContent.trim();
    const orders={};
    for(const [key,dir] of [['movie_日期','desc'],['movie_日期','asc'],['movie_编码','asc'],['movie_编码','desc']]){
      await setSort(key,dir);
      const list=codes();
      orders[key+'.'+dir]={ n: list.length, monoOk: mono(list,key,dir), head: list.slice(0,3).join(','), sig:list.join('|') };
    }
    await setSort(key0,dir0);
    const rowsHead1=String((window.__state.rows[0]||{}).movie_编码||'');
    while (window.__state.nav.length) window.__nav.pop();
    await wait(900);
    const sigs=Object.values(orders).map(o=>o.sig);
    return { inEntity, key0, dir0, filmsOfTile, cards: orders['movie_日期.desc'].n,
             distinctOrders: new Set(sigs).size,
             allMono: Object.values(orders).every(o=>o.monoOk),
             rowsUntouched: rowsHead0===rowsHead1,
             dateFlipped: orders['movie_日期.desc'].sig!==orders['movie_日期.asc'].sig,
             codeFlipped: orders['movie_编码.asc'].sig!==orders['movie_编码.desc'].sig,
             heads: Object.fromEntries(Object.entries(orders).map(([k,o])=>[k,o.head])) };
  `);
  const esOk = entitySort.inEntity && entitySort.filmsOfTile >= 8 && entitySort.cards >= 8 &&
    entitySort.allMono && entitySort.rowsUntouched && entitySort.dateFlipped && entitySort.codeFlipped;
  step('entitySort', { ...entitySort, ok: esOk });
  if (!esOk) throw new Error('三级界面的排序没生效：' + JSON.stringify(entitySort));

  // ---- 侧栏右键菜单 + 裁切对话框（用一张生成的图跑通导出链路） ----
  const avatarUi = await js(`
    const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
    const row=document.querySelector('#facetList .facet');
    row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:120,clientY:220}));
    await wait(200);
    const items=[...document.querySelectorAll('.ctxmenu button')].map(b=>b.textContent);
    const disabled=[...document.querySelectorAll('.ctxmenu button')].filter(b=>b.disabled).map(b=>b.textContent);
    document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
    await wait(120);
    const menuClosed=!document.querySelector('.ctxmenu');
    // 8x8 red png
    const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAF0lEQVR4nGP8z8Dwn4EIOBmVgYpQBQDMLQUB6ZBVAgAAAABJRU5ErkJggg==';
    let out=null;
    window.__cropDialog(png,(d)=>{ out=d; });
    await wait(400);
    const view=!!document.querySelector('.cropview');
    const save=[...document.querySelectorAll('.modal .row button')].find(b=>b.textContent==='保存');
    save&&save.click();
    await wait(400);
    return { items, disabled, menuClosed, view, exported: !!out && out.startsWith('data:image/png'),
             size: out? out.length:0 };
  `);
  step('avatarUi', avatarUi);

  // ---- 裁切框：长宽比离谱的横图必须能看全,滚轮必须能缩放 ----
  const cropWide = await js(`
    const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
    // 1200x150 的三段横条:左红、中绿、右蓝。三段就是三把尺子——只裁中间的话绝不会出现红和蓝
    const src=await new Promise(res=>{
      const c=document.createElement('canvas'); c.width=1200; c.height=150;
      const g=c.getContext('2d');
      g.fillStyle='#ff0000'; g.fillRect(0,0,400,150);
      g.fillStyle='#00ff00'; g.fillRect(400,0,400,150);
      g.fillStyle='#0000ff'; g.fillRect(800,0,400,150);
      res(c.toDataURL('image/png'));
    });
    let out=null;
    window.__cropDialog(src,(d)=>{ out=d; },'裁切横图',{ size:[300,400] });
    const box=()=>document.querySelector('.cropview');
    const pic=()=>document.querySelector('.cropview img');
    const wait2=async(fn,max)=>{ const t0=Date.now(); for(;;){ const v=fn(); if(v) return v; if(Date.now()-t0>(max||3000)) return null; await wait(60); } };
    if (!await wait2(()=>pic()&&pic().naturalWidth>0)) throw new Error('裁切框里的图没解码');
    await wait2(()=>Number((document.querySelector('.modal input[type=range]').min)||1)<1);
    const v0=box().getBoundingClientRect(), i0=pic().getBoundingClientRect();
    const slider=document.querySelector('.modal input[type=range]');
    const wholeBtn=[...document.querySelectorAll('.modal .row button')].find(b=>b.textContent==='看全图');
    const cover={ min:Number(slider.min), w:Math.round(i0.width), h:Math.round(i0.height),
                  coversFrame: i0.width>=v0.width-1 && i0.height>=v0.height-1 };
    // 滚轮向上 = 放大,而且必须吃掉事件(否则整个对话框跟着滚)
    const ev=new WheelEvent('wheel',{ deltaY:-300, bubbles:true, cancelable:true,
                                      clientX:v0.left+v0.width/2, clientY:v0.top+v0.height/2 });
    box().dispatchEvent(ev);
    await wait(120);
    const i1=pic().getBoundingClientRect();
    const wheel={ prevented: ev.defaultPrevented, bigger: i1.width>i0.width+1 };
    // 放大以后往右死拖:图必须仍然盖满框,不许拖出黑边
    const mid={ x:v0.left+v0.width/2, y:v0.top+v0.height/2 };
    const pe=(t,x)=>box().dispatchEvent(new PointerEvent(t,{ bubbles:true, pointerId:7, clientX:x, clientY:mid.y }));
    pe('pointerdown',mid.x); pe('pointermove',mid.x+4000); pe('pointerup',mid.x+4000);
    await wait(120);
    const i2=pic().getBoundingClientRect();
    const clamped={ keepsCoverX: i2.left<=v0.left+1 && i2.right>=v0.right-1,
                    keptCoverY: i2.top<=v0.top+1 && i2.bottom>=v0.bottom-1 };
    // 回到整张图都在框里
    wholeBtn.click();
    await wait(150);
    const i3=pic().getBoundingClientRect(), v3=box().getBoundingClientRect();
    const whole={ w:Math.round(i3.width), h:Math.round(i3.height), scale3:Number(slider.value),
                  inside: i3.width<=v3.width+1 && i3.height<=v3.height+1 && i3.width>v3.width/2 };
    // 看全之后横向没有富余,拖不动;纵向有,能拖
    pe('pointerdown',mid.x); pe('pointermove',mid.x+300); pe('pointerup',mid.x+300);
    await wait(120);
    const i4=pic().getBoundingClientRect();
    const locked={ sameX: Math.abs(i4.left-i3.left)<1 };
    // 导出:三段颜色都要在,上下是黑边——这就是「看到的是甚么就写出去甚么」
    const save=[...document.querySelectorAll('.modal .row button')].find(b=>b.textContent==='保存');
    save.click();
    if (!await wait2(()=>out,3000)) throw new Error('保存没有回调');
    const back=await new Promise((res)=>{
      const im=new Image();
      im.onload=()=>{
        const c=document.createElement('canvas'); c.width=im.width; c.height=im.height;
        const g=c.getContext('2d'); g.drawImage(im,0,0);
        const px=(x,y)=>{ const p=g.getImageData(x,y,1,1).data; return [p[0],p[1],p[2]]; };
        const midy=Math.round(im.height/2);
        res({ w:im.width, h:im.height, left:px(2,midy), mid:px(Math.round(im.width/2),midy),
              right:px(im.width-3,midy), top:px(Math.round(im.width/2),2), bottom:px(Math.round(im.width/2),im.height-3) });
      };
      im.onerror=()=>res(null);
      im.src=out;
    });
    if (!back) throw new Error('导出的 PNG 读不回来');
    return { cover, wheel, clamped, whole, locked, back };
  `);
  const cwOk =
    cropWide.cover.coversFrame && cropWide.cover.min < 1 &&
    cropWide.wheel.prevented && cropWide.wheel.bigger &&
    cropWide.clamped.keepsCoverX && cropWide.clamped.keptCoverY &&
    cropWide.whole.inside && cropWide.locked.sameX &&
    cropWide.back.left[0] > 150 && cropWide.back.left[1] < 90 &&
    cropWide.back.right[2] > 150 && cropWide.back.right[0] < 90 &&
    cropWide.back.mid[1] > 150 &&
    cropWide.back.top[0] + cropWide.back.top[1] + cropWide.back.top[2] < 30;
  step('cropWide', { ...cropWide, ok: cwOk });
  if (!cwOk) throw new Error('裁切框看不全横图或滚轮无效: ' + JSON.stringify(cropWide));
  await shot('smoke-crop-wide.png');

  // The circle must switch from the initial to her real avatar as soon as one exists —
  // verified by actually storing one, not by trusting the branch.
  const inCircle = await js(`
    const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
    const tab=[...document.querySelectorAll('#facetTabs button')].find(b=>b.dataset.tab==='actor');
    if(tab){ tab.click(); await wait(500); }
    const row=document.querySelector('#facetList .facet');
    const name=row.querySelector('.name').textContent;
    const beforeInitial=!!row.querySelector('.avatar.ph');
    // A canvas-encoded PNG, i.e. exactly what the crop dialog hands to actor:setFromData.
    const png=await new Promise((res)=>{
      const c=document.createElement('canvas'); c.width=120; c.height=160;
      const g=c.getContext('2d'); g.fillStyle='#c0504d'; g.fillRect(0,0,120,160);
      g.fillStyle='#ffffff'; g.fillRect(20,30,80,100);
      res(c.toDataURL('image/png'));
    });
    const r=await window.shelf.actorSetFromData(name, png);
    await window.__refreshAvatars();
    let img=null;
    for (let i=0;i<20;i++) {
      await wait(250);
      const row2=[...document.querySelectorAll('#facetList .facet')].find(e=>e.querySelector('.name')&&e.querySelector('.name').textContent===name);
      img=row2?row2.querySelector('img.avatar'):null;
      if(img&&img.complete&&img.naturalWidth>0) break;
    }
    return { beforeInitial: beforeInitial, rel: r.rel, hasImg: !!img,
             decoded: !!(img&&img.complete&&img.naturalWidth>0),
             stillInitial: !!(img&&img.closest('.facet').querySelector('.avatar.ph')) };
  `);
  step('avatarInCircle', inCircle);

  // v1.6.9：换头像不能等到重启才算数。这里连着换两次颜色，每次都不重启、不刷新页面，
  // 只等侧栏那个 <img> 自己变——它变不了的唯一原因就是 URL 没跟着文件变（v1.6.8 之前的症状）。
  const avatarLive = await js(`
    const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
    const paint=(fill)=>new Promise((res)=>{
      const c=document.createElement('canvas'); c.width=320; c.height=320;
      const g=c.getContext('2d'); g.fillStyle=fill; g.fillRect(0,0,320,320);
      res(c.toDataURL('image/png'));
    });
    const tab=[...document.querySelectorAll('#facetTabs button')].find(b=>b.dataset.tab==='actor');
    if(tab){ tab.click(); await wait(500); }
    const rowOf=(name)=>[...document.querySelectorAll('#facetList .facet')]
      .find(e=>e.querySelector('.name') && e.querySelector('.name').textContent===name);
    const start=[...document.querySelectorAll('#facetList .facet')].find(e=>e.querySelector('img.avatar'));
    if(!start) throw new Error('侧栏里没有任何已带头像的演员，这一步没测到东西');
    const name=start.querySelector('.name').textContent;
    const srcOf=()=>{const im=rowOf(name)&&rowOf(name).querySelector('img.avatar'); return im?im.src:'';};
    const first=start.querySelector('img.avatar').src;
    await window.shelf.actorSetFromData(name, await paint('#24537a'));
    await window.__refreshAvatars();
    let second='';
    for(let i=0;i<24;i++){
      await wait(250);
      second=srcOf();
      const im=rowOf(name)&&rowOf(name).querySelector('img.avatar');
      if(second && second!==first && im.complete && im.naturalWidth>0) break;
    }
    await wait(60);
    await window.shelf.actorSetFromData(name, await paint('#7a5324'));
    await window.__refreshAvatars();
    let third='';
    for(let i=0;i<24;i++){
      await wait(250);
      third=srcOf();
      // 只看 URL 换没换是不够的:这一轮就出现过「地址变了、图还没解出来」,
      // 下一步拿 naturalWidth 判定时读到的是一张正在加载的图。等它真的出图。
      const im2=rowOf(name)&&rowOf(name).querySelector('img.avatar');
      if(third && third!==second && im2 && im2.complete && im2.naturalWidth>0) break;
    }
    const ver=(u)=>{const m=/[?&]v=([0-9]+)/.exec(u||''); return m?Number(m[1]):0;};
    const stem=(u)=>(u||'').split('?')[0];
    let status=0, bytes=0, decoded=false;
    const r=await fetch(third); status=r.status; bytes=(await r.arrayBuffer()).byteLength;
    const im3=rowOf(name)&&rowOf(name).querySelector('img.avatar');
    decoded=!!(im3 && im3.complete && im3.naturalWidth>0);
    // 主进程交出的引用（不带 DOM）也要同一个版本号，说明它是从文件读出来的。
    const asked=(await window.shelf.actorPaths([name]))[name]||'';
    return { nameLen: name.length, stem: stem(first)===stem(second)&&stem(second)===stem(third),
             v1: ver(first), v2: ver(second), v3: ver(third), askedV: ver(asked),
             askedInSrc: !!asked && decodeURIComponent(third)===('shelfimg://local/'+asked),
             status: status, bytes: bytes, decoded: decoded };
  `);
  const liveOk =
    avatarLive.stem &&
    avatarLive.v1 > 0 &&
    avatarLive.v2 > avatarLive.v1 &&
    avatarLive.v3 > avatarLive.v2 &&
    avatarLive.askedV === avatarLive.v3 &&
    avatarLive.askedInSrc &&
    avatarLive.status === 200 &&
    avatarLive.bytes > 0 &&
    avatarLive.decoded;
  step('avatarLive', { ...avatarLive, ok: liveOk });
  if (!liveOk) throw new Error('avatarLive 断言失败 ' + JSON.stringify(avatarLive));

  // The 演员头像 dialog used to throw unless 数据目录 was filled in first; it must open on an
  // empty config now, and the dead jvThumbs row must be gone.
  const avatarDialog = await js(`
    document.querySelector('#btnAvatars').click();
    await new Promise(r=>setTimeout(r,900));
    const m=document.querySelector('#modalHost .modal');
    const btns=m?[...m.querySelectorAll('button')].map(b=>b.textContent):[];
    const text=m?m.textContent:'';
    const shut=m&&[...m.querySelectorAll('button')].find(b=>b.textContent.trim()==='关闭');
    if(shut) shut.click();
    await new Promise(r=>setTimeout(r,250));
    return { opened: !!m, dirShown: /actor\\\\/.test(text), legacyError: /还没有数据目录/.test(text),
             legacyRowGone: !btns.some(t=>/开始补全缺失头像|测试连通性|导入 actor_inbox/.test(t)),
             buttons: btns.filter(t=>/头像/.test(t)) };
  `);
  step('avatarDialog', avatarDialog);

  await shot('smoke-08-secondary.png');

  // ---- 封面编辑：选一张别的封面，再恢复默认 ----
  const coverEdit = await js(`
    const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
    const seeTile = async (name) => {
      // The wall re-renders asynchronously after a cover save; a fixed sleep raced it.
      for (let i = 0; i < 40; i++) {
        const t = [...document.querySelectorAll('#secondary .covtile')]
          .find(x => !name || x.dataset.name === name);
        if (t) return t;
        await wait(250);
      }
      throw new Error('二级封面墙里找不到' + (name || '任何') + ' tiles');
    };
    window.__openSecondary('actress');
    const tile = await seeTile(null);
    const name = tile.dataset.name;
    tile.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const btn = [...tile.querySelectorAll('.covacts button')].find(b=>b.textContent==='封面');
    if (!btn) return { name, error: '没有封面按钮' };
    btn.click();
    await wait(1500);
    const options = document.querySelectorAll('#modalHost .cpick').length;
    const before = (window.__state.idolMap.get(name)||{}).cover || '';
    let after = before, restored = before;
    if (options) {
      document.querySelector('#modalHost .cpick').click();
      await wait(1200);
      after = (window.__state.idolMap.get(name)||{}).cover || '';
      window.__openSecondary('actress');
      const t2 = await seeTile(name);
      t2.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      [...t2.querySelectorAll('.covacts button')].find(b=>b.textContent==='封面').click();
      await wait(1200);
      [...document.querySelectorAll('#modalHost button')].find(b=>b.textContent==='恢复默认').click();
      await wait(1200);
      restored = (window.__state.idolMap.get(name)||{}).cover || '';
    }
    while (window.__state.nav.length) window.__nav.pop();
    await wait(400);
    return { name, options, before, after, changed: before !== after, restored, navDepth: window.__state.nav.length };
  `);
  step('coverEdit', coverEdit);

  // v1.6.2:片商/系列封面墙也要能编辑封面(v1.6.0 女优那套 coverModal 的复用),
  // 且瓦片上不能出现女优专属的「信息」按钮。保存 → 实体表 cover 变化 → 恢复默认清空。
  const entityCover = await js(`
    const wait = (ms)=>new Promise(r=>setTimeout(r,ms));
    const seeTile = async (name) => {
      for (let i = 0; i < 40; i++) {
        const t = [...document.querySelectorAll('#secondary .covtile')]
          .find(x => !name || x.dataset.name === name);
        if (t) return t;
        await wait(250);
      }
      throw new Error('片商封面墙里找不到' + (name || '任何') + ' tiles');
    };
    window.__openSecondary('studio');
    const tile = await seeTile(null);
    const name = tile.dataset.name;
    const hasInfo = [...tile.querySelectorAll('.covacts button')].some(b => b.textContent === '信息');
    tile.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const btn = [...tile.querySelectorAll('.covacts button')].find(b=>b.textContent==='封面');
    if (!btn) return { name, error: '片商瓦片没有封面按钮' };
    btn.click();
    await wait(1500);
    const options = document.querySelectorAll('#modalHost .cpick').length;
    const covOf = () => { const s=(window.__state.entities.studio||[]).find(e=>e.name===name); return (s&&s.cover)||''; };
    const before = covOf();
    let after = before, restored = before;
    if (options) {
      document.querySelector('#modalHost .cpick').click();
      await wait(1200);
      after = covOf();
      window.__openSecondary('studio');
      const t2 = await seeTile(name);
      t2.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      [...t2.querySelectorAll('.covacts button')].find(b=>b.textContent==='封面').click();
      await wait(1200);
      [...document.querySelectorAll('#modalHost button')].find(b=>b.textContent==='恢复默认').click();
      await wait(1200);
      restored = covOf();
    }
    while (window.__state.nav.length) window.__nav.pop();
    await wait(400);
    return { name, options, hasInfo, before, after, changed: before !== after, restored };
  `);
  step('entityCover', entityCover);
  {
    const ec = entityCover;
    const ok = !ec.error && ec.options > 0 && ec.hasInfo === false &&
      ec.changed === true && /^r\d+\//.test(String(ec.after)) && ec.restored === '';
    if (!ok) throw new Error('entityCover 断言失败 ' + JSON.stringify(ec));
  }

  // ---- 右键海报墙：导入图片裁成封面（自定义 + 可选写进影片文件夹），再恢复 ----
  // Every claim here is about bytes on disk: a cover import that only changes what the wall
  // paints would still pass while quietly destroying his downloaded poster, and the reverse.
  const coverPick = await js(`
    const codes = [...document.querySelectorAll('#gridItems .card')].map(c=>c.dataset.code).filter(Boolean).slice(0, 80);
    if (!codes.length) throw new Error('海报墙上没有卡片，右键菜单测不到');
    const found = await window.shelf.resolve(codes);
    for (const c of codes) {
      const e = found[c];
      if (!(e && e.poster && /^r\\d+\\//.test(e.poster) && e.video && e.dir)) continue;
      // 那张 sidecar 到底在哪，问主进程：「r<n>/…」是相对库根目录的引用，把它接在 entry.dir 后面
      // 会拼出双层路径。写入位置与「覆盖还是新建」都必须和生产代码用同一个答案。
      const where = await window.shelf.videoCoverTarget(c, e.lib);
      if (!where.replaces) continue;
      return { code: c, lib: e.lib, dir: where.dir, poster: e.poster, target: where.target, custom: !!where.custom };
    }
    throw new Error('首屏 ' + codes.length + ' 张卡片里没有一部影片文件夹里已有海报的，测不到覆盖与还原');
  `);
  const posterAbs = coverPick.target;
  if (!fs.existsSync(posterAbs)) throw new Error('主进程给出的写入位置不在盘上：' + posterAbs);
  if (coverPick.custom) throw new Error('这条记录本来就有自定义封面，测不出「恢复」：' + coverPick.code);
  // 只允许动本地样例库,网盘挂载一根手指都不碰。
  const SAMPLE_ROOTS = ['G:\\JAV\\JAV_output', 'J:\\JAV2\\JAV_output'];
  const onSampleRoot = SAMPLE_ROOTS.some(
    (r) => path.resolve(posterAbs).toLowerCase().startsWith(r.toLowerCase())
  );
  if (!onSampleRoot) throw new Error('封面测试要写的文件不在样例库里：' + posterAbs);
  if (path.dirname(path.resolve(posterAbs)).toLowerCase() !== path.resolve(coverPick.dir).toLowerCase()) {
    throw new Error('主进程给出的写入位置不在这部影片自己的文件夹里：' + posterAbs);
  }
  const sha = (p) => require('node:crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
  const originalSha = sha(posterAbs);
  const bakAbs = posterAbs + '.bak';

  const menu = await js(`
    const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
    const code=${JSON.stringify(coverPick.code)};
    const cards=[...document.querySelectorAll('#gridItems .card')];
    const card=cards.find(c=>c.dataset.code===code);
    if (!card) throw new Error('首页卡片里没有 ' + code + '，右键菜单测不到');
    card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:120}));
    await wait(600);
    const labels=()=>[...document.querySelectorAll('#modalHost button')].map(b=>b.textContent);
    const first=labels();
    const crop=window.__cropDialog;
    let boxFound=null, saved=null;
    if (crop) {
      const png = await new Promise(res=>{ const c=document.createElement('canvas'); c.width=320; c.height=420;
        const g=c.getContext('2d'); g.fillStyle='#345'; g.fillRect(0,0,320,420); res(c.toDataURL('image/png')); });
      await new Promise((done)=>{
        crop(png, (data, flags)=>{ saved={ bytes: String(data).slice(0,120), flags: flags }; done(); },
          '裁切封面：测试', { folderLabel:'同时写入影片文件夹（覆盖 poster）', size:[600,800] });
        setTimeout(()=>{
          const m=document.querySelector('#modalHost .modal');
          const inp=m&&m.querySelector('input[type="checkbox"]');
          boxFound={ present: !!inp, label: inp? (inp.closest('label')||{}).textContent : null };
          if (!inp) { done(); return; }
          inp.checked=true;
          const ok=[...(m?m.querySelectorAll('button'):[])].find(b=>b.textContent==='保存');
          if (ok) ok.click();
        }, 400);
      });
    }
    const after=[...document.querySelectorAll('#modalHost button')].map(b=>b.textContent);
    return { menu:first, afterCrop:after, boxFound, saved };
  `);
  {
    if (!menu.menu.some((t) => t.indexOf('导入图片裁切为封面') === 0)) {
      throw new Error('右键菜单里没有「导入图片裁切为封面…」：' + JSON.stringify(menu.menu));
    }
    if (menu.menu.some((t) => t.indexOf('恢复原本封面') >= 0)) {
      throw new Error('还没有自定义封面却出现了「恢复原本封面」：' + JSON.stringify(menu.menu));
    }
    if (!menu.boxFound || menu.boxFound.present !== true) throw new Error('裁切框里没有「同时写入影片文件夹」这个勾：' + JSON.stringify(menu.boxFound));
    if (!menu.saved || !menu.saved.flags || menu.saved.flags.folder !== true) {
      throw new Error('勾上之后 onOk 没把 folder 带出来：' + JSON.stringify(menu.saved));
    }
    // 600x800 PNG starts wider than the old 300x400 export; the header carries the size.
    const pngHeader = Buffer.from(menu.saved.bytes.replace(/^data:image\/png;base64,/, ''), 'base64');
    const dims = pngHeader.length >= 24 ? [pngHeader.readUInt32BE(16), pngHeader.readUInt32BE(20)] : [0, 0];
    if (dims[0] !== 600 || dims[1] !== 800) {
      throw new Error('封面没有按 600x800 导出：' + JSON.stringify({ bytes: pngHeader.length, got: dims }));
    }
  }
  step('coverMenu', { code: coverPick.code, menu: menu.menu, box: menu.boxFound, size: [600, 800] });

  // Our own copies live under whatever the profile uses as its data root — the smoke run
  // never sets 数据目录, so asserting against a hardcoded path would be a false green.
  const coverBase = await js(`const c = window.__bootInfo.config; return c.dataDir || (c.config && c.config.userData) || '';`);
  if (!coverBase) throw new Error('拿不到 JavShelf 存放封面的根目录');

  // Step 1: no tick-box → only JavShelf's copy changes, his folder stays byte-for-byte as it was.
  const only = await js(`
    const code=${JSON.stringify(coverPick.code)}, lib=${JSON.stringify(coverPick.lib)};
    const png = await new Promise(res=>{ const c=document.createElement('canvas'); c.width=320; c.height=420;
      const g=c.getContext('2d'); g.fillStyle='#2ab'; g.fillRect(0,0,320,420); res(c.toDataURL('image/png')); });
    const r = await window.shelf.videoCoverSet(code, lib, png, false);
    await window.__resolveNow([code]);
    const e = window.__mediaCache[code] || {};
    const img = document.querySelector('#gridItems .card[data-code="'+CSS.escape(code)+'"] .poster img');
    let loaded=false, natural=0;
    for (let i=0;i<30;i++) { await new Promise(x=>setTimeout(x,200));
      if (img && img.complete && img.naturalWidth>0) { loaded=true; natural=img.naturalWidth; break; } }
    return { folder: r.folder || '', rel: e.poster || '', custom: !!e.custom,
             src: img?img.src:'', loaded, natural, count: await window.shelf.videoCoverCount() };
  `);
  {
    if (only.folder !== '') throw new Error('没勾「同时写入影片文件夹」却写了文件夹：' + JSON.stringify(only));
    if (!/^video_cover\//.test(only.rel) || only.custom !== true) throw new Error('墙上的封面没换成本地那一份：' + JSON.stringify(only));
    if (!only.loaded || !(only.natural >= 300)) throw new Error('自定义封面上墙后没解码：' + JSON.stringify(only));
    if (sha(posterAbs) !== originalSha) throw new Error('只改显示的那一步动了影片文件夹里的海报');
    if (fs.existsSync(bakAbs)) throw new Error('没写文件夹却留了 .bak');
    const ours = path.join(coverBase, ...only.rel.split('/'));
    if (!fs.existsSync(ours)) throw new Error('JavShelf 的封面文件不在盘上：' + ours);
    if (fs.readFileSync(ours).slice(0, 2).toString('hex') !== 'ffd8') throw new Error('JavShelf 的封面不是 JPEG');
    only.ours = ours;
  }

  // Step 2: ticked → the folder sidecar really changes, and the bytes it replaces are kept.
  let mirroredFolderSha = '';
  const mirrored = await js(`
    const code=${JSON.stringify(coverPick.code)}, lib=${JSON.stringify(coverPick.lib)};
    const png = await new Promise(res=>{ const c=document.createElement('canvas'); c.width=320; c.height=420;
      const g=c.getContext('2d'); g.fillStyle='#a2b'; g.fillRect(0,0,320,420); res(c.toDataURL('image/png')); });
    const r = await window.shelf.videoCoverSet(code, lib, png, true);
    return { folder: r.folder || '', rel: r.rel, count: await window.shelf.videoCoverCount() };
  `);
  {
    if (path.resolve(mirrored.folder) !== path.resolve(posterAbs)) {
      throw new Error('写进文件夹的路径不是这部影片自己的海报：' + JSON.stringify({ got: mirrored.folder, want: posterAbs }));
    }
    if (sha(posterAbs) === originalSha) throw new Error('勾了写入文件夹，海报文件却没变');
    if (!fs.existsSync(bakAbs)) throw new Error('覆盖原封面却没留 .bak：' + bakAbs);
    if (sha(bakAbs) !== originalSha) throw new Error('.bak 里存的不是原来那张封面');
    if (mirrored.count !== 1) throw new Error('第二次导入不该多出一条记录：' + JSON.stringify(mirrored));
    mirrored.ours = path.join(coverBase, ...mirrored.rel.split('/'));
    if (!fs.existsSync(mirrored.ours)) throw new Error('换图后 JavShelf 那一份不在盘上：' + mirrored.ours);
    if (fs.existsSync(only.ours) && only.ours !== mirrored.ours) {
      throw new Error('换了封面却把旧的那份留在自己文件夹里：' + only.ours);
    }
    mirroredFolderSha = sha(posterAbs);
  }

  // Step 2.5: re-import without the tick. His folder must not move again, and the .bak from the
  // mirrored import must survive — otherwise the next 恢复 would leave our picture in his folder.
  let keptBakSha = '';
  const retain = await js(`
    const code=${JSON.stringify(coverPick.code)}, lib=${JSON.stringify(coverPick.lib)};
    const png = await new Promise(res=>{ const c=document.createElement('canvas'); c.width=320; c.height=420;
      const g=c.getContext('2d'); g.fillStyle='#ab2'; g.fillRect(0,0,320,420); res(c.toDataURL('image/png')); });
    const r = await window.shelf.videoCoverSet(code, lib, png, false);
    return { folder: r.folder || '', rel: r.rel };
  `);
  {
    if (retain.folder !== '') throw new Error('没勾却写了影片文件夹：' + JSON.stringify(retain));
    if (sha(posterAbs) !== mirroredFolderSha) throw new Error('只改显示的那一步又动了文件夹里的海报');
    if (sha(bakAbs) !== originalSha) throw new Error('再导入一次把 .bak 里的原图覆盖了');
    // 记在这里：下一步「恢复」会把 .bak 用掉并删掉，到报告那一步再读就只剩 ENOENT 了。
    keptBakSha = sha(bakAbs);
    retain.ours = path.join(coverBase, ...retain.rel.split('/'));
    if (!fs.existsSync(retain.ours)) throw new Error('最新那份封面没落盘：' + retain.ours);
    if (fs.existsSync(mirrored.ours) && mirrored.ours !== retain.ours) {
      throw new Error('换图后上一份还留在自己文件夹里：' + mirrored.ours);
    }
  }

  // Step 3: 恢复原本封面 → his bytes go back, our copy and the .bak both disappear.
  const back = await js(`
    const code=${JSON.stringify(coverPick.code)}, lib=${JSON.stringify(coverPick.lib)};
    const cards=[...document.querySelectorAll('#gridItems .card')];
    const card=cards.find(c=>c.dataset.code===code);
    if (card) card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:120}));
    await new Promise(r=>setTimeout(r,500));
    const withCustom=[...document.querySelectorAll('#modalHost button')].map(b=>b.textContent);
    const shut=[...document.querySelectorAll('#modalHost button')].find(b=>b.textContent==='关闭');
    if (shut) shut.click();
    await new Promise(r=>setTimeout(r,300));
    const r = await window.shelf.videoCoverClear(code, lib);
    await window.__resolveNow([code]);
    const e = window.__mediaCache[code] || {};
    return { restored: r.restored || '', removedFolder: r.removedFolder || '', rel: e.poster || '',
             custom: !!e.custom, withCustom, count: await window.shelf.videoCoverCount() };
  `);
  {
    if (!back.withCustom.some((t) => t.indexOf('恢复原本封面') >= 0)) {
      throw new Error('有自定义封面时右键菜单没给「恢复原本封面」：' + JSON.stringify(back.withCustom));
    }
    if (path.resolve(back.restored) !== path.resolve(posterAbs)) throw new Error('恢复动作没落到那张海报上：' + JSON.stringify(back));
    if (sha(posterAbs) !== originalSha) throw new Error('恢复之后文件夹里的海报不是原来那份字节');
    if (fs.existsSync(bakAbs)) throw new Error('恢复之后 .bak 还留着');
    if (!/^r\d+\//.test(String(back.rel)) || back.custom) throw new Error('恢复之后墙上还挂着自定义封面：' + JSON.stringify(back));
    if (fs.existsSync(only.ours)) throw new Error('恢复之后 JavShelf 那份封面还在：' + only.ours);
    if (fs.existsSync(mirrored.ours)) throw new Error('恢复之后 JavShelf 那第二份封面还在：' + mirrored.ours);
    if (fs.existsSync(retain.ours)) throw new Error('恢复之后 JavShelf 最新那份封面还在：' + retain.ours);
    if (back.count !== 0) throw new Error('恢复之后计数没归零：' + JSON.stringify(back));
  }

  // A code that is not on the wall must not become a way to write anywhere.
  const refused = await js(`
    try { await window.shelf.videoCoverTarget('NO_SUCH_CODE_ZZ', ${JSON.stringify(coverPick.lib)}); return 'accepted'; }
    catch (e) { return String(e.message || e); }
  `);
  if (!refused.includes('记录不存在')) throw new Error('不存在的番号没有被挡住：' + refused);
  step('videoCover', {
    code: coverPick.code, lib: coverPick.lib, inSampleLib: onSampleRoot, originalSha,
    custom: only.rel, mirrored: !!mirrored.folder, keptBak: keptBakSha === originalSha,
    displayOnlyAgain: retain.folder === '', restored: !!back.restored, count: back.count, refused
  });

  /* -------------------------------------------------------------------- 查重 */

  // 归一化的答案必须和手算一致。这份报告只看不删，所以它唯一的用处是「不点进去也敢信」。
  const dupKeys = await js(`
    const k = window.__dupes.key;
    return [['ABP-123','ABP123'],['abp123','ABP123'],['ABP-0123','ABP123'],['ABP-00123','ABP123'],
      ['ABP-123-2','ABP1232'],['ABP-123A','ABP123A'],['SSIS-001','SSIS1'],['SSIS-1','SSIS1'],
      ['FC2-PPV-1234567','FC2PPV1234567'],['HUNTA-00123','HUNTA123'],['123456','123456'],
      ['  abp 123  ','ABP123'],['汉化合集',''],['','']]
      .map(([c,w]) => [c,k(c),w]);
  `);
  {
    const wrong = dupKeys.filter(([, got, want]) => got !== want);
    if (wrong.length) throw new Error('番号归一化和手算不符：' + JSON.stringify(wrong));
  }

  // 合成八行，把「哪几组该报、哪几组不该报」钉死：完全重复与近似重复两层不混。
  const DUP_FIX = [
    ['ABP-123', 'SMOKE-D1', '甲库'],
    ['ABP-123', 'SMOKE-D2', '乙库'],
    ['abp0123', 'SMOKE-D3', '甲库'],
    ['SSIS-001', 'SMOKE-D4', '甲库'],
    ['SSIS-1', 'SMOKE-D5', '乙库'],
    ['ABC-999', 'SMOKE-D6', '甲库'],
    ['汉化合集', 'SMOKE-D7', '甲库'],
    ['ABP-123-2', 'SMOKE-D8', '甲库']
  ];
  const fixRows = JSON.stringify(DUP_FIX.map(([code, dir, lib]) => ({ movie_编码: code, only_code: dir, _lib: lib })));
  const dupShape = await js(`
    const g = window.__dupes.groups(${fixRows});
    const shape = (list) => list.map((x) => ({ label: x.label, n: x.rows.length, libs: x.libs, codes: x.rows.map((r) => r.movie_编码) }));
    return { exact: shape(g.exact), near: shape(g.near) };
  `);
  {
    const e = dupShape.exact, n = dupShape.near;
    if (e.length !== 1 || e[0].label !== 'ABP-123' || e[0].n !== 2 || e[0].libs !== 2) {
      throw new Error('完全重复只该有 ABP-123 那一组：' + JSON.stringify(dupShape));
    }
    if (n.length !== 2 || n[0].label !== 'ABP123' || n[0].n !== 3 || n[1].label !== 'SSIS1' || n[1].n !== 2) {
      throw new Error('近似重复的组数或排序不对：' + JSON.stringify(dupShape));
    }
    const listed = new Set([...e, ...n].flatMap((g) => g.codes));
    for (const miss of ['ABC-999', 'ABP-123-2', '汉化合集']) {
      if (listed.has(miss)) throw new Error(miss + ' 只有一份，不该被报成重复：' + JSON.stringify(dupShape));
    }
  }

  // 真库上的结构不变量：完全重复的每组成员字面必须一致且落在不同文件夹，近似重复的每组成员
  // 归一后必须等于组名，而且字面不能全一样（那样早就被完全重复报了）。
  const dupReal = await js(`
    const rows = window.__state.rows, f = window.__dupes.groups(), bad = [];
    for (const g of f.exact) {
      const codes = new Set(g.rows.map((r) => String(r.movie_编码 || '').trim()));
      const dirs = new Set(g.rows.map((r) => String(r.only_code || '')));
      if (g.rows.length < 2 || codes.size !== 1 || !codes.has(g.label)) bad.push('完全重复组不成立 ' + g.label);
      if (dirs.size < 2) bad.push('完全重复组其实只有一个文件夹 ' + g.label);
    }
    for (const g of f.near) {
      if (new Set(g.rows.map((r) => String(r.movie_编码 || '').trim())).size < 2) bad.push('近似组字面全一样，本该在完全重复里 ' + g.label);
      for (const r of g.rows) if (window.__dupes.key(String(r.movie_编码 || '')) !== g.label) bad.push('近似组归一不一致 ' + g.label);
    }
    const dirs = [...new Set([...f.exact, ...f.near].flatMap((g) => g.rows.map((r) => String(r.only_code || '')).filter(Boolean)))];
    const sample = [...new Set(rows.map((r) => String(r.only_code || '')).filter(Boolean))].filter((d) => !dirs.includes(d));
    return { rows: rows.length, libs: [...new Set(rows.map((r) => r._lib))].length,
      exact: f.exact.length, near: f.near.length,
      exactRows: f.exact.reduce((n2, g) => n2 + g.rows.length, 0),
      nearRows: f.near.reduce((n2, g) => n2 + g.rows.length, 0),
      crossLib: [...f.exact, ...f.near].filter((g) => g.libs > 1).length,
      bad, dirs: dirs.slice(0, 40), dirTotal: dirs.length, sampleDirs: sample.slice(0, 60).filter((d) => !dirs.includes(d)) };
  `);
  {
    if (dupReal.bad.length) throw new Error('真库分组违反了结构不变量：' + JSON.stringify(dupReal.bad.slice(0, 6)));
    if (dupReal.rows < 4000 || dupReal.libs < 2) throw new Error('查重是在残缺的行集上跑的：' + JSON.stringify(dupReal));
    if (dupReal.exactRows > dupReal.rows || dupReal.nearRows > dupReal.rows) throw new Error('涉及的行数比总行数还多：' + JSON.stringify(dupReal));
    const strays = dupReal.dirs.filter((d) => !SAMPLE_ROOTS.some((root) => path.resolve(d).toLowerCase().startsWith(root.toLowerCase())));
    if (strays.length) throw new Error('分组里的文件夹不在样例库下，样本库被动了：' + JSON.stringify(strays.slice(0, 3)));
    if (dupReal.sampleDirs.length < 20) throw new Error('抽查用的普通文件夹不够多：' + dupReal.sampleDirs.length);
  }

  // 体积是主进程读盘给的，而它只能读库目录下面的文件夹——页面上递过去一个路径列表，
  // 不能变成一台随便读盘的机器。样例库里未必真有重复，所以问的目录混一批普通行。
  const probeDirs = JSON.stringify([
    ...dupReal.dirs.slice(0, 20),
    ...dupReal.sampleDirs.slice(0, 20),
    'C:\\Windows',
    'SMOKE-NOT-A-PATH'
  ]);
  const dupProbe = await js(`
    const got = await window.shelf.dupeDetail(${probeDirs});
    return { keys: Object.keys(got).length, out: got['C:\\\\Windows'] || null,
      miss: got['SMOKE-NOT-A-PATH'] || null, vals: Object.entries(got).map(([k, v]) => [k, v.ok, v.bytes, (v.videos || []).length, v.error || '']) };
  `);
  {
    const inside = dupProbe.vals.filter(([k]) => k !== 'C:\\Windows' && k !== 'SMOKE-NOT-A-PATH');
    const readable = inside.filter(([, ok]) => ok === true);
    const withVideo = readable.filter(([, , , nv]) => nv > 0);
    if (withVideo.length < 5) throw new Error('库内文件夹读不出体积与视频：成功 ' + readable.length + '、带视频 ' + withVideo.length + '/' + inside.length);
    if (readable.some(([, , bytes]) => !(Number(bytes) > 0))) throw new Error('成功的文件夹体积为 0');
    if (!dupProbe.out || dupProbe.out.ok !== false || dupProbe.out.error !== '不在库目录里') {
      throw new Error('库目录之外的路径没被拒绝：' + JSON.stringify(dupProbe.out));
    }
    if (!dupProbe.miss || dupProbe.miss.ok !== false) throw new Error('不存在的目录没被拒绝：' + JSON.stringify(dupProbe.miss));
    if (dupProbe.keys !== inside.length + 2) throw new Error('回答的条数和问的不一样：' + JSON.stringify(dupProbe.keys));
  }

  // 界面：把合成行塞进 state.rows 再点「查重」，这样组数、行数、按钮都是定死的。
  const dupUi = await js(`
    const keep = window.__state.rows;
    window.__state.rows = ${fixRows};
    document.querySelector('#btnDupes').click();
    await new Promise((r) => setTimeout(r, 1600));
    const host = document.querySelector('#modalHost');
    // 每次读都重新取当前那个窗口：关掉再打开之后旧的节点已经从 DOM 里摘掉了。
    const cur = () => host.querySelector('.modal');
    const read = () => {
      const m = cur();
      return {
      title: m.querySelector('h3').textContent.replace('关闭', '').trim(),
      hint: m.querySelector('.hint').textContent,
      tabs: [...m.querySelectorAll('.vtabs button')].map((b) => b.textContent),
      groups: [...m.querySelectorAll('.grouph')].map((b) => b.textContent),
      rows: [...m.querySelectorAll('.row.dupe')].length,
      libs: [...m.querySelectorAll('.duplib')].map((s) => s.textContent),
      dirs: [...m.querySelectorAll('.dupdir')].map((s) => s.textContent),
      sizes: [...m.querySelectorAll('[data-dir]')].map((s) => s.textContent),
      buttons: [...m.querySelectorAll('.row.dupe button')].map((b) => b.textContent)
      };
    };
    const first = read();
    const near = [...cur().querySelectorAll('.vtabs button')].find((b) => b.textContent.indexOf('近似') >= 0);
    near.click();
    await new Promise((r) => setTimeout(r, 700));
    const onNear = read();
    const box = cur().querySelector('input');
    box.value = 'SSIS';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 700));
    const filtered = read();
    const close = () => {
      [...cur().querySelectorAll('button')].find((b) => b.textContent === '关闭').click();
    };
    // 第二次打开不再问主进程：读过的文件夹（包括读不了的）都记在页面上，格子必须当场写出结论，
    // 不能停在「…」上。
    close();
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('#btnDupes').click();
    const again = read();
    close();
    await new Promise((r) => setTimeout(r, 300));
    window.__state.rows = keep;
    await window.__reloadRows();
    return { first, onNear, filtered, again, closed: host.classList.contains('hidden'), rows: window.__state.rows.length };
  `);
  {
    const f = dupUi.first;
    if (f.title !== '查重：重复番号') throw new Error('查重窗口标题不对：' + JSON.stringify(f.title));
    if (!/完全重复 1 组/.test(f.hint) || !/近似重复 2 组/.test(f.hint) || !/涉及 7 行/.test(f.hint)) {
      throw new Error('汇总行数字不对：' + JSON.stringify(f.hint));
    }
    if (f.tabs.join('|') !== '完全重复 1|近似重复 2') throw new Error('两个页签的计数不对：' + JSON.stringify(f.tabs));
    if (f.groups.length !== 1 || !/ABP-123 · 2 处 · 2 个库/.test(f.groups[0])) throw new Error('完全重复那一组的组头不对：' + JSON.stringify(f.groups));
    if (f.rows !== 2) throw new Error('组内成员行数不对：' + JSON.stringify(f.rows));
    if (f.libs.join('|') !== '甲库|乙库' || f.dirs.join('|') !== 'SMOKE-D1|SMOKE-D2') {
      throw new Error('报告没写清楚每一份在哪个库的哪个文件夹：' + JSON.stringify({ libs: f.libs, dirs: f.dirs }));
    }
    if (f.buttons.length !== 4 || !f.buttons.includes('打开所在文件夹') || !f.buttons.includes('在墙上只看它')) {
      throw new Error('每行少了入口按钮：' + JSON.stringify(f.buttons));
    }
    if (f.sizes.length !== 2 || f.sizes.some((s) => s !== '不在库目录里')) {
      throw new Error('体积格没等到主进程的回答（合成目录该是「不在库目录里」）：' + JSON.stringify(f.sizes));
    }
    if (dupUi.onNear.groups.length !== 2 || dupUi.onNear.rows !== 5) {
      throw new Error('近似重复页签下该有 2 组 5 行：' + JSON.stringify({ g: dupUi.onNear.groups.length, r: dupUi.onNear.rows }));
    }
    if (dupUi.filtered.groups.length !== 1 || dupUi.filtered.rows !== 2 || !/SSIS/.test(dupUi.filtered.groups[0])) {
      throw new Error('筛选「SSIS」之后没只剩那一组：' + JSON.stringify(dupUi.filtered.groups));
    }
    if (dupUi.again.rows !== 2 || dupUi.again.sizes.length !== 2 || dupUi.again.sizes.some((s) => s !== '不在库目录里')) {
      throw new Error('第二次打开还在等主进程（体积格没直接写结论）：' + JSON.stringify(dupUi.again));
    }
    if (!dupUi.closed || dupUi.rows !== dupReal.rows) throw new Error('关窗后行集没还原：' + JSON.stringify(dupUi));
  }
  step('dupes', {
    rows: dupReal.rows, libs: dupReal.libs, exact: dupReal.exact, near: dupReal.near,
    exactRows: dupReal.exactRows, nearRows: dupReal.nearRows, crossLib: dupReal.crossLib,
    folderTotal: dupReal.dirTotal, probed: dupProbe.vals.length,
    probedReadable: dupProbe.vals.filter(([, ok]) => ok === true).length, refusedOutside: dupProbe.out.error
  });

  // 一页只画 150 组：组数上千时，逐组测体积会把整台机器变成读盘机；所以超出部分要有「显示更多」，
  // 而筛选框连打字符必须防抖，不能每敲一下重建一次表格。
  const dupePaging = await js(`
    const keep = window.__state.rows;
    const rows = [];
    for (let i = 1; i <= 170; i++) {
      const code = 'PGN-' + i;
      rows.push({ movie_编码: code, _lib: '甲库', only_code: 'SMOKE-PG' + i + 'A' });
      rows.push({ movie_编码: code, _lib: '乙库', only_code: 'SMOKE-PG' + i + 'B' });
    }
    window.__state.rows = rows;
    document.querySelector('#btnDupes').click();
    await new Promise((r) => setTimeout(r, 600));
    const cur = () => document.querySelector('#modalHost .modal');
    const heads = () => [...cur().querySelectorAll('.grouph')].length;
    const more = () => [...cur().querySelectorAll('button')].find((b) => /显示更多/.test(b.textContent));
    const out = { first: heads(), hint: cur().querySelector('.hint').textContent, moreLabel: more() ? more().textContent : null };
    if (more()) {
      more().click();
      await new Promise((r) => setTimeout(r, 300));
      out.afterMore = heads();
      out.moreGone = !more();
    }
    const box = cur().querySelector('input');
    box.value = 'pgn-169';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    out.atOnce = heads(); // 防抖窗口内还不该重画
    await new Promise((r) => setTimeout(r, 500));
    out.filtered = heads();
    out.filteredLabel = cur().querySelector('.grouph') ? cur().querySelector('.grouph').textContent : '';
    const close = [...cur().querySelectorAll('button')].find((b) => b.textContent === '关闭');
    if (close) close.click();
    await new Promise((r) => setTimeout(r, 200));
    window.__state.rows = keep;
    await window.__reloadRows();
    return out;
  `);
  {
    const p = dupePaging;
    if (p.first !== 150) throw new Error('查重一页画了 ' + p.first + ' 组（该是 150）');
    if (!/还有 20 组/.test(p.moreLabel || '')) throw new Error('缺「显示更多（还有 20 组）」：' + JSON.stringify(p.moreLabel));
    if (!/完全重复 170 组/.test(p.hint)) throw new Error('分页之后汇总行不再报真实组数：' + JSON.stringify(p.hint));
    if (p.afterMore !== 170 || p.moreGone !== true) throw new Error('点了「显示更多」没补齐或按钮还在：' + JSON.stringify(p));
    if (p.atOnce !== 170) throw new Error('筛选没防抖：60 ms 内就重画了（' + p.atOnce + ' 组）');
    if (p.filtered !== 1 || !/PGN-169/.test(p.filteredLabel)) throw new Error('筛选「pgn-169」之后该只剩 1 组：' + JSON.stringify(p));
  }
  step('dupePaging', dupePaging);

  const paging = await js(`
    [...document.querySelectorAll('#pager button')].find(b=>b.textContent==='末页').click();
    await new Promise(r=>setTimeout(r,500));
    const last=window.__state.page;
    [...document.querySelectorAll('#pager button')].find(b=>b.textContent==='首页').click();
    await new Promise(r=>setTimeout(r,400));
    return { last, back: window.__state.page, bar: document.querySelector('#stCount').textContent };
  `);
  step('pagination', paging);

  const display = await js(`
    document.querySelector('#btnDisplay').click();
    await new Promise(r=>setTimeout(r,400));
    const tabs=[...document.querySelectorAll('#modalHost .vtabs button')].map(b=>b.textContent);
    const rows=[...document.querySelectorAll('#modalHost .row')].length;
    const inp=[...document.querySelectorAll('#modalHost input[type="number"]')][0];
    inp.value='24'; inp.dispatchEvent(new Event('change',{bubbles:true}));
    [...document.querySelectorAll('#modalHost button')].find(b=>b.textContent==='保存').click();
    await new Promise(r=>setTimeout(r,700));
    const d=window.__state.disp.items;
    return { tabs, rows, pageSize: d.pageSize, cards: document.querySelectorAll('#gridItems .card').length,
             topbar: document.querySelector('#pageSize').value };
  `);
  step('display', display);
  await shot('smoke-04-display.png');

  const waterfall = await js(`
    const wait=async(fn,max=6000)=>{const t0=Date.now();for(;;){const v=fn();if(v)return v;if(Date.now()-t0>max)return 'TIMEOUT';await new Promise(r=>setTimeout(r,60));}};
    const host=document.querySelector('#gridHost');
    const items=document.querySelector('#gridItems');
    const n=()=>items.querySelectorAll('.card').length;
    const w=document.querySelector('#waterfall');
    w.checked=true; w.dispatchEvent(new Event('change',{bubbles:true}));
    const on=items.classList.contains('waterfall');
    const cols=getComputedStyle(items).columnWidth;
    const first=n();
    const pagerText=document.querySelector('#pager').textContent;
    // 翻到底必须续加载,而不是停在第一屏;页数条不该再出现页码。
    // 先往上抬一点再压到底:直接写同一个值不会产生 scroll 事件,那一发就白等
    const toBottom=async()=>{ host.scrollTop=Math.max(0, host.scrollTop-120); await new Promise(r=>setTimeout(r,80)); host.scrollTop=host.scrollHeight; };
    await toBottom();
    await wait(()=>n()>first);
    const grew=n();
    await toBottom();
    await wait(()=>n()>grew);
    const again=n();
    const barText=document.querySelector('#stCount').textContent;
    const ps=window.__state.pageSize;
    w.checked=false; w.dispatchEvent(new Event('change',{bubbles:true}));
    await new Promise(r=>setTimeout(r,400));
    return { on, cols, first, grew, again, pageSize: ps,
             pager: pagerText, noPageNum: !pagerText.includes('页'), bar: barText,
             back: !items.classList.contains('waterfall'), pageReset: window.__state.page,
             cards: n() };
  `);
  if (waterfall.on !== true || waterfall.back !== true) throw new Error('waterfall 开关失效: ' + JSON.stringify(waterfall));
  if (waterfall.grew <= waterfall.first || waterfall.again <= waterfall.grew)
    throw new Error('瀑布流滚到底没有续加载: ' + JSON.stringify(waterfall));
  if (!/已加载/.test(waterfall.pager) || !waterfall.noPageNum || !/已加载/.test(waterfall.bar))
    throw new Error('瀑布流下仍在显示页数: ' + JSON.stringify(waterfall));
  if (waterfall.pageReset !== 1 || waterfall.cards !== waterfall.pageSize || waterfall.first < waterfall.pageSize)
    throw new Error('关闭瀑布流没有回到单页: ' + JSON.stringify(waterfall));
  step('waterfall', waterfall);

  const search = await js(`
    const s=document.querySelector('#search'); s.value='JULIA';
    s.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,800));
    const hit=window.__state.view.length;
    s.value=''; s.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,700));
    return { hit, cleared: window.__state.view.length };
  `);
  step('search', search);

  const fav = await js(`
    const r = window.__state.view[0];
    const code = r.movie_编码, lib = r._lib;
    await window.shelf.setState(code, 'state_收藏', '真', lib);
    await window.__reloadRows();
    document.querySelector('#quickFilters button[data-quick="fav"]').click();
    await new Promise(r=>setTimeout(r,700));
    const only = window.__state.view.length;
    const cards = document.querySelectorAll('#gridItems .card').length;
    document.querySelector('#quickFilters button[data-quick="all"]').click();
    await window.shelf.setState(code, 'state_收藏', '假', lib);
    await window.__reloadRows();
    const back = await window.shelf.row(code, lib);
    return { code, only, cards, all: window.__state.view.length, reverted: back.state_收藏 };
  `);
  step('favorites', fav);

  const nfo = await js(`
    const codes=window.__state.rows.slice(0,600).map(r=>r.movie_编码);
    const found=await window.shelf.resolve(codes);
    const one=codes.find(c=>found[c]&&found[c].nfo);
    const doc=await window.shelf.nfoRead(found[one].nfo);
    let denied='none';
    try { await window.shelf.nfoRead('r0/../../Windows/win.ini'); } catch(e){ denied='rejected'; }
    return { code: one, tags: Object.keys(doc.fields).length, actors: doc.actors.length, denied };
  `);
  step('nfo', nfo);

  // ---- v1.6.8：保存 nfo 走真按钮，写完原样还原 ------------------------------------------------
  // 旧断言只读不写，所以 nfo:write 交出去的载荷形状不对那一整版都没人发现：writeNfo 收到的
  // 不是 {fields, actors}，于是 changed:false、连 .bak 都不生成，「保存 nfo」整个空转。
  // 这一步真点详情侧栏的「编辑信息(nfo)」，改片长并追加一个演员（演员那一格是重点：它曾被
  // handler 单独丢掉），再按试写前抓下的字节还原，样例库不留痕迹。
  const nfoTargets = await js(`
    const codes=window.__state.rows.slice(0,600).map(r=>r.movie_编码);
    const found=await window.shelf.resolve(codes);
    const out=[];
    for (const c of codes) {
      if (!found[c] || !found[c].nfo) continue;
      const p=await window.shelf.nfoPath(c);
      if (!p.ok || !p.abs || !p.exists) continue;
      out.push({ code: c, rel: found[c].nfo, abs: p.abs });
      if (out.length >= 24) break;
    }
    return out;
  `);
  let nfoPick = null;
  for (const c of nfoTargets) {
    try {
      const abs = path.resolve(c.abs);
      if (!SAMPLE_ROOTS.some((r) => abs.toLowerCase().startsWith(r.toLowerCase()))) continue;
      const nfos = fs.readdirSync(path.dirname(abs)).filter((f) => f.toLowerCase().endsWith('.nfo'));
      if (nfos.length !== 1) continue;
      if (fs.existsSync(abs + '.bak') || fs.existsSync(abs + '.tmp')) continue;
      const original = fs.readFileSync(abs);
      if (original.includes('SMOKE-')) continue;
      nfoPick = { code: c.code, rel: c.rel, abs, original };
      break;
    } catch { /* 读不到就换下一个候选 */ }
  }
  if (!nfoPick) throw new Error('样例库里没有一个「只有一份 nfo、没有 .bak 残留」的条目能试写，这一步不能空过');
  const wrote = await js(`
    const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
    const code=${JSON.stringify(nfoPick.code)}, rel=${JSON.stringify(nfoPick.rel)};
    const marker='SMOKE-' + Date.now(), actorName='SMOKE-NFO-ACTOR';
    const box=(label)=>{
      const row=[...document.querySelectorAll('#modalHost .row')].find(x=>{const l=x.querySelector('label');return l&&l.textContent===label;});
      if(!row) throw new Error('编辑框里没有「'+label+'」那一格');
      const node=row.querySelector('input,textarea');
      if(!node) throw new Error('「'+label+'」那一格没有输入控件');
      return node;
    };
    window.__openDetail(code);
    await wait(900);
    const nfoBtn=[...document.querySelectorAll('#detail button')].find(b=>b.textContent==='编辑信息(nfo)');
    if(!nfoBtn) throw new Error('详情侧栏没有「编辑信息(nfo)」按钮');
    nfoBtn.click();
    let opened=false;
    for(let i=0;i<100;i++){ if(document.querySelectorAll('#modalHost .row').length){ opened=true; break; } await wait(80); }
    if(!opened) throw new Error('点了「编辑信息(nfo)」没弹出编辑框');
    const rt=box('片长(分钟)'), rtBefore=rt.value;
    rt.value=marker;
    const at=box('演员'), atBefore=at.value;
    at.value=(at.value ? at.value + String.fromCharCode(10) : '') + actorName;
    const saveBtn=[...document.querySelectorAll('#modalHost button')].find(b=>b.textContent==='保存 nfo');
    if(!saveBtn) throw new Error('编辑框里没有「保存 nfo」按钮');
    saveBtn.click();
    let closed=false;
    for(let i=0;i<125;i++){ if(!document.querySelector('#modalHost .row')){ closed=true; break; } await wait(80); }
    const status=(document.querySelector('#stMsg')||{}).textContent||'';
    const after=await window.shelf.nfoRead(rel);
    return { code, marker, actorName, rtBefore, atBefore, closed, status,
             runtime: String(after.fields.runtime||''),
             hasActor: (after.actors||[]).some(a=>a.name===actorName) };
  `);
  {
    const bak = nfoPick.abs + '.bak';
    if (!wrote.closed) throw new Error('点「保存 nfo」之后编辑框没关：' + JSON.stringify(wrote));
    if (wrote.runtime !== wrote.marker) throw new Error('保存之后读回来的片长还是旧的（nfo:write 空转）：' + JSON.stringify(wrote));
    if (!wrote.hasActor) throw new Error('保存之后盘上没有新加的那个演员（演员框又被丢了）：' + JSON.stringify(wrote));
    if (wrote.status.indexOf('已保存 nfo') < 0) throw new Error('状态栏没给出「已保存 nfo」：' + JSON.stringify(wrote));
    const onDisk = fs.readFileSync(nfoPick.abs, 'utf8');
    if (!onDisk.includes(wrote.actorName)) throw new Error('缓存说写好了，盘上那份 nfo 里却没有它：' + nfoPick.abs);
    if (!fs.existsSync(bak)) throw new Error('首次保存没有生成 .nfo.bak 备份');
    const bakMatches = fs.readFileSync(bak).equals(nfoPick.original);
    fs.writeFileSync(nfoPick.abs, nfoPick.original);
    fs.rmSync(bak, { force: true });
    const restored = fs.readFileSync(nfoPick.abs).equals(nfoPick.original);
    const reread = await js(`return String(((await window.shelf.nfoRead(${JSON.stringify(nfoPick.rel)})).fields.runtime)||'');`);
    if (!bakMatches) throw new Error('.bak 里不是覆写前那份原字节');
    if (!restored) throw new Error('还原之后盘上还不是原来那些字节');
    if (fs.existsSync(bak) || fs.existsSync(nfoPick.abs + '.tmp')) throw new Error('这一步在影片目录里留下了文件');
    if (reread === wrote.marker) throw new Error('盘上已经还原，读回来的还是刚写进去的那个片长（缓存没跟着变）');
    step('nfoSave', {
      code: wrote.code,
      runtime: !!wrote.rtBefore,
      actors: (wrote.atBefore || '').split(String.fromCharCode(10)).filter(Boolean).length,
      marker: true,
      backup: bakMatches,
      restored,
      rereadRestored: reread === (wrote.rtBefore || '')
    });
  }

  // ---- v1.6 预热缓存:纯后端断言,建在临时目录上。probeMs=0 强制走「慢盘」分支;
  // 默认探测必须拒绝复制本地快盘——两条分支都要真断言。
  {
    const { ImgCache } = require('./imgcache');
    const root = path.join(outDir, 'warm-root');
    for (const d of ['warm-root', 'warm-cache', 'warm-cache-local']) {
      fs.rmSync(path.join(outDir, d), { recursive: true, force: true });
    }
    const leaf = path.join(root, 'AAAA-1');
    fs.mkdirSync(leaf, { recursive: true });
    const poster = path.join(leaf, 'AAAA-1-poster.jpg');
    const nfoFile = path.join(leaf, 'AAAA-1.nfo');
    fs.writeFileSync(poster, Buffer.alloc(4096, 7));
    fs.writeFileSync(nfoFile, '<movie><title>x</title></movie>');
    const cache = new ImgCache(path.join(outDir, 'warm-cache'));
    const w1 = await cache.warm([poster, nfoFile], { ownerPrefix: root + path.sep, probeMs: 0 });
    const served = cache.bytes(poster);
    const w2 = await cache.warm([poster, nfoFile], { ownerPrefix: root + path.sep, probeMs: 0 });
    fs.writeFileSync(poster, Buffer.alloc(8192, 7)); // 「盘」上改了内容 → 必须重取
    const w3 = await cache.warm([poster, nfoFile], { ownerPrefix: root + path.sep, probeMs: 0 });
    const served2 = cache.bytes(poster);
    fs.rmSync(nfoFile, { force: true }); // 文件没了 → 清单条目跟着删
    const w4 = await cache.warm([poster], { ownerPrefix: root + path.sep, probeMs: 0 });
    const local = new ImgCache(path.join(outDir, 'warm-cache-local'));
    const w5 = await local.warm([poster], { ownerPrefix: root + path.sep }); // 真探测:本地文件读得快
    const ok =
      w1.copied === 2 && w1.skipped === 0 && !!served && served.length === 4096 &&
      w2.copied === 0 && w2.skipped === 2 &&
      w3.copied === 1 && !!served2 && served2.length === 8192 &&
      !cache.entry(nfoFile) && w4.dropped + w4.pruned >= 1 &&
      w5.skippedLocal === true && w5.copied === 0 &&
      cache.meta.size === 1 && local.meta.size === 0;
    step('warmcache', {
      firstCopy: w1.copied,
      againSkipped: w2.skipped,
      changedRecopied: w3.copied,
      removed: w4.dropped + w4.pruned,
      localSkip: w5.skippedLocal,
      probeMs: w5.probeMs,
      ok
    });
    if (!ok) throw new Error('warmcache 断言失败 ' + JSON.stringify({ w1, w2, w3, w4, w5 }));
  }

  // ---- v1.6.1 过期索引兜底:根目录 mtime 一变(网盘加新片就会变),旧索引必须
  // 立刻顶上而不是从空索引重来——否则整面海报墙「未索引」空转到后台重扫结束。
  {
    const { LibraryFiles } = require('./scan');
    const root = path.join(outDir, 'stale-root');
    const cache = path.join(outDir, 'stale-scan');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cache, { recursive: true, force: true });
    const leaf = path.join(root, 'STAA-1');
    fs.mkdirSync(leaf, { recursive: true });
    fs.writeFileSync(path.join(leaf, 'STAA-1.mp4'), '');
    fs.writeFileSync(path.join(leaf, 'STAA-1-poster.jpg'), Buffer.alloc(64, 3));
    const lf = new LibraryFiles(cache);
    await lf.prepare([root]);
    const n1 = lf.status()[0].entries;
    const later = new Date(Date.now() + 60000);
    fs.utimesSync(root, later, later); // 签名作废
    const leaf2 = path.join(root, 'STAA-2'); // 并新增一个条目
    fs.mkdirSync(leaf2, { recursive: true });
    fs.writeFileSync(path.join(leaf2, 'STAA-2.mp4'), '');
    const lf2 = new LibraryFiles(cache);
    const p = lf2.prepare([root]); // 先不 await:验证「同步引导」阶段旧索引就在
    const mid = lf2.status()[0];
    const midHit = !!lf2.lookup('STAA-1');
    await p;
    const after = lf2.status()[0];
    const ok =
      n1 === 1 &&
      mid.stale === true && mid.entries === 1 && midHit &&
      after.stale === false && after.entries === 2 && !!lf2.lookup('STAA-2');
    step('staleIndex', { seeded: mid.entries, midStale: mid.stale, midHit, after: after.entries, ok });
    if (!ok) throw new Error('staleIndex 断言失败 ' + JSON.stringify({ n1, mid, midHit, after }));
  }

  const libToggle = await js(`
    const before = window.__state.rows.length;
    const name = document.querySelector('#libPanel .librow .nm').textContent;
    const mine = window.__state.rows.filter(r=>r._lib===name).length;
    // A toggle re-boots the whole profile, so wait for the row count to actually settle
    // rather than guessing a sleep — and report how long that took.
    const settle = async (want) => {
      const t0 = performance.now();
      for (let i = 0; i < 120; i++) {
        await new Promise(r=>setTimeout(r,250));
        if (window.__state.rows.length === want) break;
      }
      return Math.round(performance.now() - t0);
    };
    document.querySelector('#libPanel .librow .toggle').click();
    const offMs = await settle(before - mine);
    const off = { rows: window.__state.rows.length, cards: document.querySelectorAll('#gridItems .card').length,
                  setup: !document.querySelector('#emptyState').classList.contains('hidden'),
                  stillThere: window.__state.rows.filter(r=>r._lib===name).length };
    document.querySelector('#libPanel .librow .toggle').click();
    const backMs = await settle(before);
    return { name, before, hidden: mine, off, offMs, back: window.__state.rows.length, backMs };
  `);
  step('libToggle', libToggle);

  const settings = await js(`
    document.querySelector('#btnSettings').click();
    await new Promise(r=>setTimeout(r,400));
    const m=document.querySelector('#modalHost .modal');
    const groups=[...m.querySelectorAll('.grouph')].map(e=>e.textContent);
    const alexText=/ALEX|Alex/i.test(m.textContent);
    const btns=[...m.querySelectorAll('button')].map(b=>b.textContent);
    const chromeBtn=btns.some(t=>/从 Chrome 获取 Cookie/.test(t));
    const embeddedGone=!btns.some(t=>/一键读取 JavDB Cookie/.test(t));
    const api={ chrome: typeof window.shelf.javdbCookieFromChrome, embedded: typeof window.shelf.javdbCookieFromBrowser };
    const playerSel=[...m.querySelectorAll('select')].some(s=>[...s.options].some(o=>o.value==='system'));
    const noPotPlayerOnly=!/调用本地播放器/.test(m.textContent);
    document.querySelector('#btnSettings').click();
    await new Promise(r=>setTimeout(r,200));
    return { groups, rows: m.querySelectorAll('.row').length, hasSave: btns.includes('保存设置'), alexText, chromeBtn, embeddedGone, api, playerSel, noPotPlayerOnly, coversBtn: btns.includes('头像设为封面墙封面') };
  `);
  step('settings', settings);

  // 一键把已有头像写成女优封面墙的封面：没有头像的必须保持原默认，不报错。
  const avatarCovers = await js(`
    const r = await window.shelf.actorUseAvatarsAsCovers();
    return { applied: r.applied, kept: r.kept, total: r.total };
  `);
  step('avatarCovers', avatarCovers);
  {
    // 版本号只准出现在页面 URL 上。它一旦跟着写进库，每次重启都会往旧值上再叠一层
    // （actor/xxx.jpg?v=1?v=2），而带 ? 的文件名在磁盘上根本对不上任何头像。
    const dbFile = path.join(app.getPath('userData'), 'JavShelf.db');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const stamped = [];
    for (const t of db.prepare("SELECT name AS tbl FROM sqlite_master WHERE type='table'").all()) {
      const cols = db.prepare(`PRAGMA table_info(${t.tbl})`).all().map((c) => c.name);
      if (!cols.includes('cover')) continue;
      const bad = db.prepare(`SELECT name FROM ${t.tbl} WHERE cover LIKE '%?v=%'`).all();
      if (bad.length) stamped.push([t.tbl, bad.slice(0, 3).map((r) => r.name)]);
    }
    db.close();
    step('coverStoredClean', { stamped, ok: stamped.length === 0 });
    if (stamped.length) throw new Error('库里存进了带头像版本号的封面：' + JSON.stringify(stamped));
  }

  // 右键卡片 → 从库中删除：记录少一条、文件仍在原处（只查存在性，不写不删）。
  const removeRow = await js(`
    const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
    const card=document.querySelector('#gridItems .card');
    const code=card.dataset.code;
    const before=window.__state.rows.length;
    const stub=window.confirm;
    window.confirm=()=>true;
    card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:240,clientY:240}));
    await wait(400);
    const btn=[...document.querySelectorAll('#modalHost .modal button')].find(b=>/从库中删除/.test(b.textContent));
    const hasBtn=!!btn;
    const file=(window.__mediaCache[code]||{}).video||'';
    if(btn) btn.click();
    await wait(1500);
    window.confirm=stub;
    return { hasBtn, before, after: window.__state.rows.length,
             goneFromIndex: !window.__state.byCode.has(code),
             cardsNow: document.querySelectorAll('#gridItems .card').length,
             locatedFile: !!file };
  `);
  step('removeRow', removeRow);

  // Wording guard: the app's own chrome must never say Alex. Library rows are excluded —
  // his data legitimately contains titles like "Alexa Grace".
  const uiText = await js(`
    const scratch=document.body.cloneNode(true);
    scratch.querySelectorAll('#gridItems,#facetList,#detail,#secondary,#jobPanel,#lightbox,#modalHost').forEach(e=>e.remove());
    const chrome=scratch.textContent+' '+[...document.querySelectorAll('input,select,button')].map(e=>e.placeholder+' '+e.title).join(' ');
    return { alexInChrome: /ALEX|Alex/.test(chrome), hits: (chrome.match(/.{0,30}(?:ALEX|Alex).{0,30}/g)||[]).slice(0,3), bar: document.querySelector('#stCount2').textContent };
  `);
  step('wording', uiText);

  // ---- v1.6.8 之一：停止与掉盘都不许清仓 -------------------------------------------------
  // 这两条都是拿真 Ingestor 在临时库上跑的，不是打桩：删掉的三个文件夹是「真的没了」，
  // 只有中断/读不到这两次才应该一行不删。少了后面那次正常 delta 对照，前面两条断言可以空过。
  {
    const { Ingestor } = require('./ingest');
    const { ensureShelfTable } = require('./libs');
    const root = path.join(outDir, 'ingest-root');
    const stash = path.join(outDir, 'ingest-root-stash');
    const dbFile = path.join(outDir, 'ingest-guard.db');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(stash, { recursive: true, force: true });
    fs.rmSync(dbFile, { force: true });
    fs.mkdirSync(root, { recursive: true });
    for (let i = 1; i <= 60; i++) {
      const c = 'SHLD-' + i;
      const d = path.join(root, c);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, c + '.mp4'), 'x');
      fs.writeFileSync(path.join(d, c + '.nfo'), '<movie><title>' + c + '</title><runtime>10</runtime></movie>');
    }
    ensureShelfTable(dbFile, { name: 'GUARD', store: 'shelf' });
    const rows = () => {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      try {
        return Number(db.prepare('SELECT COUNT(*) c FROM shelf_GUARD').get().c);
      } finally {
        db.close();
      }
    };
    const run = (mode, dirs, shouldStop) =>
      new Ingestor({ dbFile, table: 'shelf_GUARD', dirs, onProgress: () => {}, shouldStop }).run(mode);

    // 行数是每一步过去的事实，必须当场记：四次 run 都跑完再 rows() 三次，
    // 前面两次看到的都是最后那 57 行，断言就变成永远不可能成立的死条件。
    const seeded = await run('append', [root]);
    const seededRows = rows();
    for (const c of ['SHLD-58', 'SHLD-59', 'SHLD-60']) fs.rmSync(path.join(root, c), { recursive: true, force: true });
    const halted = await run('delta', [root], () => true);
    const haltedRows = rows();
    fs.renameSync(root, stash); // 整段读不到：网盘掉线的样子
    const dark = await run('delta', [root]);
    const darkRows = rows();
    fs.renameSync(stash, root);
    const clean = await run('delta', [root]);
    const cleanRows = rows();
    const ok =
      seeded.added === 60 && seededRows === 60 &&
      halted.stopped === true && halted.deleted === 0 && haltedRows === 60 &&
      dark.deleted === 0 && dark.shielded >= 57 && darkRows === 60 &&
      clean.deleted === 3 && clean.shielded === 0 && cleanRows === 57;
    step('ingestGuard', {
      seeded: seeded.added,
      stopped: halted.stopped,
      stoppedDeleted: halted.deleted,
      stoppedRows: haltedRows,
      darkShielded: dark.shielded,
      darkDeleted: dark.deleted,
      darkRows,
      cleanDeleted: clean.deleted,
      rows: cleanRows,
      ok
    });
    if (!ok) throw new Error('ingestGuard 断言失败 ' + JSON.stringify({ seeded, seededRows, halted, haltedRows, dark, darkRows, clean, cleanRows }));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dbFile, { force: true });
  }

  // ---- v1.6.8 之二：索引残缺要顶住旧数据并说清楚，「重新扫描」必须真的重走 ----------------
  {
    const { LibraryFiles } = require('./scan');
    const notDir = path.join(outDir, 'holes-not-a-dir');
    fs.writeFileSync(notDir, 'x'); // readdir 它必然失败，等价于网盘上有一段读不到
    const warns = [];
    const lfA = new LibraryFiles(path.join(outDir, 'holes-scan-a'));
    await lfA.prepare([notDir], { onWarn: (m) => warns.push(String(m)) });
    const hole = lfA.status()[0] || {};
    const phases = [];
    const lfA2 = new LibraryFiles(path.join(outDir, 'holes-scan-a'));
    await lfA2.prepare([notDir], { onProgress: (p) => phases.push(p.phase) });

    const root = path.join(outDir, 'holes-root');
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'HOLE-1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'HOLE-1', 'HOLE-1.mp4'), '');
    let indexed = 0;
    const lfB = new LibraryFiles(path.join(outDir, 'holes-scan-b'));
    const withIndex = () => lfB.prepare([root], { onIndexed: () => { indexed++; } });
    await withIndex(); // 第一次：走完并存档
    const first = indexed;
    await withIndex(); // 签名没变：缓存命中，不该再走一遍
    const cached = indexed;
    lfB.invalidate(); // 「重新扫描」：签名一样也得重走
    await withIndex();
    const forced = indexed;
    const ok =
      hole.stale === true && hole.unreadable >= 1 &&
      warns.some((w) => /没读到/.test(w) && /待重扫/.test(w)) &&
      phases.includes('incomplete') &&
      first === 1 && cached === 1 && forced === 2;
    step('scanHoles', {
      stale: hole.stale,
      unreadable: hole.unreadable,
      warn: (warns[0] || '').slice(0, 60),
      phases: phases.join(','),
      indexed: [first, cached, forced],
      ok
    });
    if (!ok) throw new Error('scanHoles 断言失败 ' + JSON.stringify({ hole, warns, phases, indexed: [first, cached, forced] }));
  }

  // ---- v1.6.8 之三：写入边界 / 越界读取 / 已删接口 / 样式令牌 / 图片缓存头 ----------------
  const guards = await js(`
    const A = window.shelf;
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = { reject: {} };
    // invoke 的 reject 自带一层壳（Error invoking remote method 'x': Error: 正文），
    // 主进程抛的是给人看的中文句子，直接看开头会被这层壳骗掉——和界面上的 errText 同一个道理。
    const peel = (s) => s.replace(/^Error invoking remote method '[^']+':\\s*(Error:\\s*)?/, '');
    const grab = async (label, fn) => {
      try { const v = await fn(); out.reject[label] = '没报错：' + JSON.stringify(v).slice(0, 50); }
      catch (e) { out.reject[label] = peel(String((e && e.message) || e)).slice(0, 46); }
    };
    const row0 = window.__state.rows[0] || {};
    const lib = row0._lib || (window.__state.libraries[0] || {}).name;
    await grab('写片名', () => A.setState(row0.movie_编码, 'movie_片名', 'X', lib));
    await grab('写观看数', () => A.setState(row0.movie_编码, 'state_观看', '9', lib));
    await grab('未知库取行', () => A.row(row0.movie_编码, '没有这个库'));
    await grab('未知库删行', () => A.dbRemove(row0.movie_编码, '没有这个库'));
    await grab('没挑过的图', () => A.readImageAsData('C:\\\\Windows\\\\win.ini'));
    const outside = await A.dupeDetail(['C:\\\\Windows']);
    out.dupeOutside = outside['C:\\\\Windows'] || Object.values(outside)[0] || null;
    // 停止按钮在没事可停的时候要如实说「没有」，别让玩家以为按下了什么。
    out.stopIdle = await A.ingestStop();
    const gone = ['javdbEnrichStatus', 'actorSetFromFile', 'javdbCookieFromBrowser'].filter((k) => A[k] !== undefined);
    const liveMissing = ['javdbEnrich', 'javdbEnrichStop', 'ingestStop', 'dupeDetail', 'videoCoverSet', 'actorSetFromData', 'logList']
      .filter((k) => typeof A[k] !== 'function');
    const hooksGone = ['__applyFilters', '__ingest', '__entities', '__actorMenu'].filter((k) => window[k] !== undefined);
    const hooksLive = ['__booted', '__bootInfo', '__state', '__openDetail', '__reloadRows', '__loadIdols',
                       '__mediaCache', '__refreshAvatars', '__nav', '__openSecondary', '__cropDialog', '__resolveNow', '__dupes']
      .filter((k) => window[k] === undefined);
    out.api = { gone, liveMissing, hooksGone, hooksLive };
    const cs = getComputedStyle(document.documentElement);
    out.tokens = ['--muted', '--panel', '--sunk', '--title-lines', '--card-w', '--poster-radius', '--topbar-h']
      .map((k) => k).filter((k) => !cs.getPropertyValue(k).trim());
    const probe = document.createElement('div');
    probe.className = 'hint';
    probe.textContent = 'x';
    document.body.appendChild(probe);
    out.hint = { size: getComputedStyle(probe).fontSize, color: getComputedStyle(probe).color };
    probe.remove();
    const card = document.querySelector('#gridItems .card');
    out.a11y = {
      cardTab: card ? card.tabIndex : -1,
      cardRole: card ? card.getAttribute('role') : null,
      cardLabel: card ? card.getAttribute('aria-label') : null,
      search: !!document.querySelector('#search[aria-label]'),
      facet: !!document.querySelector('#facetSearch[aria-label]'),
      gridRow: Math.round(parseFloat(getComputedStyle(document.body).gridTemplateRows.split(' ')[0]))
    };
    // 测试图用画布导出：nativeImage 解不开那种几十比特的极小 PNG（isEmpty 直接判「不是图片」），
    // 而裁切对话框真正发出去的本来就是画布 PNG。
    const png = await new Promise((res) => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 320;
      const g = c.getContext('2d'); g.fillStyle = '#245'; g.fillRect(0, 0, 320, 320); res(c.toDataURL('image/png'));
    });
    const av = await A.actorSetFromData('冒烟测试演员', png);
    const sc = await A.importCover('studio', '冒烟测试片商', null, png);
    const r1 = await fetch(A.imgUrl(av.rel));
    const r2 = await fetch(A.imgUrl(sc));
    out.img = {
      avRel: av.rel,
      avCache: r1.headers.get('cache-control'),
      avStatus: r1.status,
      scRel: sc,
      scCache: r2.headers.get('cache-control'),
      scStatus: r2.status
    };
    // 一个宿主只装一层模态：后开的把前一个换掉，Esc 关当前这层，第二次 Esc 不该再动任何东西。
    // 灯箱在最上面：它开着的时候 Esc 先关它，所以先把上一步可能留下的那层清掉，并记下清过。
    const lb = document.querySelector('#lightbox');
    out.lightboxWasOpen = !lb.classList.contains('hidden');
    if (out.lightboxWasOpen) lb.classList.add('hidden');
    const depth = () => document.querySelectorAll('#modalHost .modal').length;
    const title = () => (document.querySelector('#modalHost .modal h3') || {}).textContent || '';
    document.querySelector('#btnLog').click();
    await wait(400);
    out.modal = { logDepth: depth(), logTitle: title().slice(0, 12) };
    // 焦点回归要靠真聚焦：JS 的 .click() 不改焦点，所以先 focus 再点。
    document.querySelector('#btnSettings').focus();
    document.querySelector('#btnSettings').click();
    await wait(400);
    out.modal.settingsDepth = depth();
    out.modal.settingsTitle = title().slice(0, 12);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(300);
    out.modal.afterEsc = depth();
    out.modal.hostHidden = document.querySelector('#modalHost').classList.contains('hidden');
    out.modal.focusBack = document.activeElement === document.querySelector('#btnSettings');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(300);
    out.modal.afterSecondEsc = depth();
    out.searchAlive = !!document.querySelector('#search');
    return out;
  `);
  const guardOk =
    /^不允许写入字段/.test(guards.reject['写片名'] || '') &&
    /^不允许写入字段/.test(guards.reject['写观看数'] || '') &&
    /没有打开/.test(guards.reject['未知库取行'] || '') &&
    /旧程序的共享数据库|没有打开/.test(guards.reject['未知库删行'] || '') &&
    /请先在/.test(guards.reject['没挑过的图'] || '') &&
    guards.reject['写片名'].indexOf('没报错') < 0 &&
    (guards.dupeOutside || {}).ok === false &&
    /不在库目录里/.test((guards.dupeOutside || {}).error || '') &&
    guards.stopIdle === false &&
    !guards.api.gone.length &&
    !guards.api.liveMissing.length &&
    !guards.api.hooksGone.length &&
    !guards.api.hooksLive.length &&
    !guards.tokens.length &&
    guards.hint.size === '11.5px' &&
    guards.a11y.cardTab === 0 &&
    guards.a11y.cardRole === 'button' &&
    !!guards.a11y.cardLabel &&
    guards.a11y.search &&
    guards.a11y.facet &&
    guards.a11y.gridRow >= 46 &&
    /^actor\//.test(guards.img.avRel) &&
    guards.img.avCache === 'no-cache' &&
    guards.img.avStatus === 200 &&
    guards.img.scCache.indexOf('immutable') >= 0 &&
    guards.img.scStatus === 200 &&
    guards.modal.logDepth === 1 &&
    guards.modal.settingsDepth === 1 &&
    guards.modal.settingsTitle !== guards.modal.logTitle &&
    guards.modal.afterEsc === 0 &&
    guards.modal.hostHidden === true &&
    guards.modal.focusBack === true &&
    guards.modal.afterSecondEsc === 0 &&
    guards.searchAlive;
  step('guards', { ...guards, ok: guardOk });
  if (!guardOk) throw new Error('guards 断言失败 ' + JSON.stringify(guards));

  // ---- 后台图标的右键菜单：这一版多了一项「重启软件」，而他按下去要看到的就是这四行。
  // Electron 44 的 Tray 没有 getContextMenu()，所以由主进程把构造真实托盘时用的同一份模板
  // 交进来读——回归断言的菜单项与 click 处理函数就是托盘上那一份，不是另抄的副本。
  {
    const tmpl = typeof opts.trayTemplate === 'function' ? opts.trayTemplate() : null;
    const labels = (tmpl || []).map((i) => i.label || (i.type === 'separator' ? '—' : '?'));
    const restartItem = (tmpl || []).find((i) => i.label === '重启软件');
    const trayOk =
      !!tmpl &&
      labels.join('|') === '显示窗口|重启软件|—|退出' &&
      typeof (restartItem || {}).click === 'function' &&
      (tmpl || []).filter((i) => typeof i.click === 'function').length === 3;
    step('trayMenu', { ok: trayOk, labels, hasRestart: !!restartItem });
    if (!trayOk) throw new Error('托盘菜单不对：' + JSON.stringify(labels));
  }

  fs.writeFileSync(path.join(outDir, 'smoke.log.txt'), log.join('\n'));
  return Object.fromEntries(log.map((l) => [l.slice(0, l.indexOf(' ')), JSON.parse(l.slice(l.indexOf(' ') + 1))]));
}

// Second-launch check: run the full smoke first, then reopen the same profile with
//   electron . --smoke-reopen --user-data=out/smoke-profile
// He asked that a scanned library come straight back as a poster wall, not a setup screen.
async function runReopen(win, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const wc = win.webContents;
  const js = (code) => wc.executeJavaScript(`(async () => { ${code} })()`, true);
  for (let i = 0; i < 80; i++) {
    if (await js(`return !!window.__booted;`)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const info = await js(`
    await new Promise(r=>setTimeout(r,2500));
    const cs=[...document.querySelectorAll('#gridItems .card')];
    const imgs=cs.map(c=>c.querySelector('.poster img')).filter(Boolean);
    const ready=imgs.filter(i=>i.complete&&i.naturalWidth>0).length;
    return {
      rows: window.__state.rows.length,
      idols: (window.__state.idols || []).length,
      idolsWithHeight: (window.__state.idols || []).filter((p) => p.height_cm).length,
      needsSetup: window.__state.needsSetup,
      setupHidden: document.querySelector('#emptyState').classList.contains('hidden'),
      cards: cs.length, coversReady: ready,
      libs: window.__state.libraries.map(l=>l.name+'='+(l.enabled===false?'off':'on')),
      scan: document.querySelector('#stScan').textContent,
      page: document.querySelector('#stCount2').textContent.trim(),
      // Distinguish "no src assigned yet" from "assigned but not decoded".
      srcs: cs.slice(0,3).map(c=>{const i=c.querySelector('.poster img');return i?(i.getAttribute('src')||'').slice(0,60):'no-img';}),
      cached: cs.slice(0,3).map(c=>{const m=window.__mediaCache[c.dataset.code];return m?Object.keys(m).join(','):'null';})
    };
  `);
  fs.writeFileSync(path.join(outDir, 'smoke-07-reopen.png'), (await win.capturePage()).toPNG());
  // Posters are lazy-loaded, so counting every card of a 120-item page measures nothing —
  // the honest question is whether the first screen is painted promptly.
  const visible = `(() => {
    const host = document.querySelector('#gridHost');
    const box = host.getBoundingClientRect();
    const inView = [...document.querySelectorAll('#gridItems .card .poster img')]
      .filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > box.top && r.top < box.bottom; });
    return { total: inView.length, ready: inView.filter((i) => i.complete && i.naturalWidth > 0).length };
  })()`;
  const t0 = Date.now();
  let vis = await js(`return ${visible};`);
  const want = () => Math.max(1, Math.ceil(vis.total * 0.9));
  while (Date.now() - t0 < 15000 && vis.ready < want()) {
    await new Promise((r) => setTimeout(r, 200));
    vis = await js(`return ${visible};`);
  }
  info.firstScreen = { inView: vis.total, ready: vis.ready, ms: Date.now() - t0 };
  info.coversWanted = want();
  info.coversReady = vis.ready;
  info.msToCovers = Date.now() - t0;
  // Sample the whole wall, not a hand-picked few: this is the check that would have caught the
  // overwrite writing to a path relative to the exe instead of the real folder.
  const nfos = await js(`
    const codes = window.__state.rows.slice(0, 40).map(r => r.movie_编码);
    let onDisk = 0, relative = 0, probed = 0;
    for (const c of codes) {
      const r = await window.shelf.nfoPath(c);
      probed++;
      if (r.exists) onDisk++;
      if (/^r\\d+\\//.test(String(r.abs || ''))) relative++;
    }
    return { probed, onDisk, relative };
  `);
  info.nfoPaths = nfos;
  fs.writeFileSync(path.join(outDir, 'smoke-07-reopen.png'), (await win.capturePage()).toPNG());

  // Photograph the three cover walls too: tile counts prove the data, only pixels prove the
  // layout, and these pages are new.
  const shots = {};
  for (const type of ['actress', 'studio', 'series']) {
    await js(`window.__openSecondary(${JSON.stringify(type)}); return true;`);
    await new Promise((r) => setTimeout(r, 2200));
    shots[type] = await js(`return {
      tiles: document.querySelectorAll('#secondary .covtile').length,
      imgs: document.querySelectorAll('#secondary .covtile img').length,
      cols: getComputedStyle(document.querySelector('.covergrid')).gridTemplateColumns.split(' ').length,
      tileW: Math.round(document.querySelector('.covtile').getBoundingClientRect().width),
      overflowX: document.querySelector('#secondary').scrollWidth > document.querySelector('#secondary').clientWidth
    };`);
    fs.writeFileSync(path.join(outDir, `secondary-${type}.png`), (await win.capturePage()).toPNG());
    await js(`window.__nav.pop(); return true;`);
    await new Promise((r) => setTimeout(r, 500));
  }
  info.walls = shots;
  fs.writeFileSync(path.join(outDir, 'reopen.json'), JSON.stringify(info, null, 2));
  return info;
}

// A short live crawl against the real site. Run it against a throwaway profile:
//   electron . --smoke-crawl --user-data=out/crawl-profile
// Reports only counts and log levels — never page content.
async function runCrawlCheck(win, outDir) {
  const js = (code) => win.webContents.executeJavaScript(`(async () => { ${code} })()`, true);
  for (let i = 0; i < 80; i++) {
    if (await js('return !!window.__booted;')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const pages = Number(process.env.SHELF_CRAWL_PAGES || 3);
  const seconds = Number(process.env.SHELF_CRAWL_SECONDS || 0);
  const res = await js(`
    const t0 = Date.now();
    // A full run takes tens of minutes, so it can be cut short from the outside: the job is
    // cancelable exactly like the 停止 button does it.
    const cut = ${seconds} > 0 ? setTimeout(() => window.shelf.javdbEnrichStop(), ${seconds} * 1000) : 0;
    const r = await window.shelf.javdbEnrich('idols', { pages: ${pages}, limit: 0, wiki: false });
    if (cut) clearTimeout(cut);
    const av = await window.shelf.javdbFetchAvatars({ limit: 5 });
    const logs = await window.shelf.logList();
    const txt = logs.map((l) => l.level + ' ' + l.msg).join('\\n');
    const branches = ['有码', '无码', '欧美'].filter((b) => new RegExp(b + '目录开始').test(txt));
    return {
      ms: Date.now() - t0,
      pages: ${pages},
      branches,
      indexed: r.indexed || 0,
      bound: (r.bound && r.bound.idols) || 0,
      failed: r.failed || 0,
      unmatched: r.unmatched || 0,
      avatars: { done: av.done, failed: av.failed, total: av.total, reason: av.reason || '' },
      cookieInConfig: !!(window.__state.cfg.javdbCookie || '').trim(),
      cookieHealed: /去掉 Cookie 就正常|无 Cookie/.test(txt),
      lastFailures: logs.filter((l) => /502|失败/.test(l.msg)).slice(-3).map((l) => l.level + ': ' + l.msg.slice(0, 90))
    };
  `);
  fs.writeFileSync(path.join(outDir, 'crawl.json'), JSON.stringify(res, null, 2));
  return res;
}

module.exports = { runSmoke, runReopen, runCrawlCheck };
