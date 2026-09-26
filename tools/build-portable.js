'use strict';
// Builds the single-file portable exe: electron-builder produces the unpacked app
// folder, then our own NSIS script wraps it so it unpacks next to the launcher rather
// than into %TEMP%.
//   node tools/build-portable.js [--skip-unpacked]
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VER = pkg.version;
const RELEASE = path.join(ROOT, 'release');
const UNPACKED = path.join(RELEASE, 'win-unpacked');
const OUT = path.join(RELEASE, `JavShelf-${VER}-portable.exe`);
const NSI = path.join(ROOT, 'build', 'portable.nsi');

function findMakensis() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  const hits = [];
  (function walk(dir, depth) {
    if (depth > 4 || !fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^makensis\.exe$/i.test(e.name)) hits.push(p);
    }
  })(base, 0);
  if (!hits.length) throw new Error('找不到 makensis.exe。先跑一次 npm run dist 让 electron-builder 下载 NSIS，或手动安装 NSIS 3。');
  return hits[0];
}

function iconFile() {
  const cand = path.join(RELEASE, '.icon-ico', 'icon.ico');
  return fs.existsSync(cand) ? cand : null;
}

if (!process.argv.includes('--skip-unpacked')) {
  console.log('1/2 electron-builder --win dir');
  const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  execFileSync(process.execPath, [cli, '--win', 'dir'], {
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
  console.error('缺少 ' + UNPACKED + '\\JavShelf.exe，请先不带 --skip-unpacked 跑一次');
  process.exit(1);
}

const makensis = findMakensis();
const icon = iconFile();
console.log('2/2 makensis', path.basename(makensis), icon ? '(含图标)' : '(默认图标)');
fs.mkdirSync(RELEASE, { recursive: true });
execFileSync(makensis, ['-DAPPVER=' + VER, '-DUNPACKED=' + UNPACKED, '-DOUTFILE=' + OUT, '-DICON=' + (icon || ''), NSI], {
  stdio: 'inherit',
  cwd: ROOT
});

const st = fs.statSync(OUT);
console.log(`完成 ${OUT}`);
console.log(`大小 ${(st.size / 1048576).toFixed(1)} MB · 双击后展开为同目录的 JavShelf-app\\，设置写在 JavShelf-portable.exe 旁边的 config.json`);
