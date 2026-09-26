'use strict';
// Publishes the folder form: dist/JavShelf-v<ver>-windows-x86_64/ with the exe, its
// runtime, a starter config.json, and a .zip of that folder ready to hand to someone.
//   node tools/package-zip.js [--skip-unpacked]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NAME = `JavShelf-v${pkg.version}-windows-x86_64`;
const UNPACKED = path.join(ROOT, 'release', 'win-unpacked');
const OUT_DIR = path.join(ROOT, 'dist');
const TARGET = path.join(OUT_DIR, NAME);
const ZIP = path.join(OUT_DIR, NAME + '.zip');

function dirSize(dir) {
  let sum = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    sum += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return sum;
}

if (!process.argv.includes('--skip-unpacked')) {
  console.log('1/3 electron-builder --win dir');
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'), '--win', 'dir'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
      ELECTRON_BUILDER_BINARIES_MIRROR:
        process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/'
    }
  });
}
if (!fs.existsSync(path.join(UNPACKED, 'JavShelf.exe'))) {
  console.error('缺少 release\\win-unpacked\\JavShelf.exe，请先不带 --skip-unpacked 运行');
  process.exit(1);
}

console.log('2/3 复制到 ' + TARGET);
fs.rmSync(TARGET, { recursive: true, force: true });
fs.rmSync(ZIP, { force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.cpSync(UNPACKED, TARGET, { recursive: true });

// A starter file so the settings are editable without hunting through %APPDATA%.
// Libraries stay empty: the first run shows the setup screen instead of guessing.
const starter = {
  dataDir: '',
  libraries: [],
  activeLibrary: '',
  playerPath: '',
  proxy: '',
  uiScale: 1,
  sort: { key: 'movie_日期', dir: 'desc' },
  appearance: {
    theme: 'dark', radius: 8, badgeSubtitle: false, badgeResolution: true,
    badgeCount: true, listCategory: true, listSeries: true, staticLoad: true, minWidth: 1080
  },
  playback: { player: 'system', loop: true, statFile: false },
  shortcuts: { hotkey: 'F10', tray: true, startupTip: true, autostart: false }
};
// --config=<file> ships an existing settings file instead of the empty starter, so the
// recipient lands on a populated wall rather than the setup screen.
const cfgFlag = process.argv.find((a) => a.startsWith('--config='));
if (cfgFlag) {
  const src = path.resolve(cfgFlag.slice('--config='.length));
  if (!fs.existsSync(src)) {
    console.error('--config 指向的文件不存在: ' + src);
    process.exit(1);
  }
  const given = JSON.parse(fs.readFileSync(src, 'utf8'));
  // A login cookie is a credential: whoever receives the zip holds it. It also makes JavDB's
  // edge answer 502 to every page once it goes stale, so shipping one breaks crawling too.
  if (given.javdbCookie && !process.argv.includes('--allow-cookie')) {
    console.error('拒绝发布：--config 里带着 javdbCookie（登录凭据）。请清空该字段，或确认要带着它发布再加 --allow-cookie。');
    process.exit(1);
  }
  fs.writeFileSync(path.join(TARGET, 'config.json'), JSON.stringify({ ...starter, ...given }, null, 2));
  console.log('使用外部配置: ' + src + '（libraries=' + (given.libraries || []).length + ', 代理=' + (given.proxy ? '已填' : '空') + ', cookie=' + (given.javdbCookie ? '已填' : '空') + '）');
} else {
  fs.writeFileSync(path.join(TARGET, 'config.json'), JSON.stringify(starter, null, 2));
}

// --data=<file|dir> ships already-ingested runtime data, so the recipient opens on a full
// wall instead of waiting for the first scan. Only the named files are copied; Chromium's
// own profile junk is left out.
const dataFlag = process.argv.find((a) => a.startsWith('--data='));
if (dataFlag) {
  const src = path.resolve(dataFlag.slice('--data='.length));
  const dest = path.join(TARGET, 'JavShelf-data');
  fs.mkdirSync(dest, { recursive: true });
  const wanted = ['JavShelf.db'];
  let copied = 0;
  if (fs.statSync(src).isDirectory()) {
    for (const f of fs.readdirSync(src)) if (wanted.includes(f)) { fs.copyFileSync(path.join(src, f), path.join(dest, f)); copied++; }
  } else if (wanted.includes(path.basename(src))) {
    fs.copyFileSync(src, path.join(dest, path.basename(src)));
    copied++;
  }
  console.log(copied ? '已带运行数据: ' + copied + ' 个文件 → ' + dest : '--data 里没有可带的文件（只认 ' + wanted.join('/') + '）');
}

console.log('3/3 压缩');
execFileSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-Command',
  `Compress-Archive -Path '${TARGET}' -DestinationPath '${ZIP}' -Force`
], { stdio: 'inherit' });

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
console.log('目录 ' + TARGET + '  ' + mb(dirSize(TARGET)));
console.log('压缩包 ' + ZIP + '  ' + mb(fs.statSync(ZIP).size));
