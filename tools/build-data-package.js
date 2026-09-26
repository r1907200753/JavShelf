'use strict';
// Turns the clean folder build (dist/JavShelf-v<ver>-windows-x86_64) into the data-carrying
// variant: program files + his real runtime data + his own config, then zips it.
//   node tools/build-data-package.js [--zip-only]
// --zip-only skips the copy steps and just recompresses the folder that is already there.
// Read-only against G:\JavShelf-v1.6.1-windows-x86_64 — nothing there is written or moved.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const CLEAN = path.join(ROOT, 'dist', `JavShelf-v${pkg.version}-windows-x86_64`);
const SRC = 'G:\\JavShelf-v1.6.1-windows-x86_64';
const SRC_DATA = path.join(SRC, 'JavShelf-data');
const NAME = `JavShelf-v${pkg.version}-data-windows-x86_64`;
const TARGET = path.join(ROOT, 'dist', NAME);
const ZIP = path.join(ROOT, 'dist', NAME + '.zip');
const ZIP_ONLY = process.argv.includes('--zip-only');

// What counts as his data: library rows, image cache, actress avatars, the scan index and
// the JavDB browser profile. Chromium's own scratch (Cache/GPUCache/DIPS/Local Storage/…)
// and the *.before-copy leftovers are deliberately left out.
const WANTED = ['JavShelf.db', 'imgcache', 'actor', 'scan', 'javdb-chrome'];

function walk(dir) {
  let bytes = 0;
  let files = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = walk(p);
      bytes += sub.bytes;
      files += sub.files;
    } else {
      bytes += fs.statSync(p).size;
      files++;
    }
  }
  return { bytes, files };
}
function size(p) {
  const st = fs.statSync(p);
  return st.isFile() ? st.size : walk(p).bytes;
}
const countFiles = (dir) => walk(dir).files;
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (!ZIP_ONLY) {
  if (!fs.existsSync(path.join(CLEAN, 'JavShelf.exe'))) {
    console.error('先运行 npm run zip（不带 --config/--data）生成干净包：' + CLEAN);
    process.exit(1);
  }
  console.log('1/3 复制程序文件 ' + CLEAN + ' → ' + TARGET);
  fs.rmSync(TARGET, { recursive: true, force: true });
  fs.rmSync(ZIP, { force: true });
  fs.cpSync(CLEAN, TARGET, { recursive: true });

  console.log('2/3 带上运行数据（只读源目录）');
  const dest = path.join(TARGET, 'JavShelf-data');
  fs.mkdirSync(dest, { recursive: true });
  const skipped = [];
  for (const name of WANTED) {
    const from = path.join(SRC_DATA, name);
    const to = path.join(dest, name);
    if (!fs.existsSync(from)) {
      console.log('  ' + name.padEnd(14) + '  未带（源里没有）');
      skipped.push(name + '(源里没有)');
      continue;
    }
    if (name.endsWith('.db')) {
      // His app is running right now, so a plain copy can land mid-transaction: copy, then
      // prove the copy with integrity_check, and retry if it came out torn.
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        for (const suffix of ['', '-wal', '-shm']) {
          fs.rmSync(to + suffix, { force: true });
          if (fs.existsSync(from + suffix)) fs.copyFileSync(from + suffix, to + suffix);
        }
        try {
          const t = new DatabaseSync(to);
          if (fs.existsSync(to + '-wal')) t.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          const check = t.prepare('PRAGMA integrity_check').get();
          const tables = t.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get();
          t.close();
          ok = check && Object.values(check)[0] === 'ok' && tables.n > 0;
        } catch (e) {
          ok = false;
        }
        fs.rmSync(to + '-wal', { force: true });
        fs.rmSync(to + '-shm', { force: true });
        if (!ok) console.log('  JavShelf.db 第 ' + attempt + ' 次副本没通过校验,重拷');
      }
      if (!ok) throw new Error('JavShelf.db 三次副本都未通过 integrity_check,源头正在写入,稍后重试');
    } else {
      // robocopy because it is the fastest recursive copy here; 1-7 all mean "done".
      try {
        execFileSync('robocopy.exe', [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:0', '/W:0'], { stdio: 'pipe' });
      } catch (e) {
        if (e.status === undefined || e.status > 7) skipped.push(name + '(复制报错 ' + e.status + ')');
      }
      // A busy file (his app still owns it) copies short — better to drop the whole entry
      // than ship a half-written profile.
      if (fs.existsSync(to) && size(to) < size(from) * 0.999) {
        fs.rmSync(to, { recursive: true, force: true });
        skipped.push(name + '(源正被占用,未带)');
      }
    }
    console.log('  ' + name.padEnd(14) + (fs.existsSync(to) ? mb(size(to)) : '未带').padStart(10));
  }
  if (skipped.length) console.log('  未带入的条目: ' + skipped.join(', '));
  // His settings file, verbatim: this package is a personal upgrade copy, so libraries,
  // proxy, theme and the JavDB login all carry over. It is therefore NOT a shareable
  // artifact — the clean package next to it is.
  fs.copyFileSync(path.join(SRC, 'config.json'), path.join(TARGET, 'config.json'));
  console.log('  config.json    ' + mb(fs.statSync(path.join(TARGET, 'config.json')).size) + '（含 javdbCookie,勿外发）');
}

console.log('3/3 压缩');
// Compress-Archive aborts on the first file Defender happens to be holding right after the
// copy, and it crawls on a gigabyte of JPEG. tar (bsdtar, shipped with Windows) is faster
// and tolerant — but it reads "G:\..." as a remote host:path, so everything goes through
// relative paths with cwd set. Retry, then prove the archive really contains every file.
const expect = countFiles(TARGET);
console.log('  磁盘文件数 ' + expect);
const DIST = path.dirname(TARGET);
const relZip = path.basename(ZIP);
const relTarget = path.basename(TARGET);
for (let attempt = 1; ; attempt++) {
  fs.rmSync(ZIP, { force: true });
  let failed = null;
  try {
    execFileSync('tar.exe', ['--force-local', '-a', '-c', '-f', relZip, relTarget], { cwd: DIST, stdio: 'inherit' });
  } catch (e) {
    failed = e;
  }
  if (!failed && fs.existsSync(ZIP)) {
    const listed = execFileSync('tar.exe', ['--force-local', '-t', '-f', relZip], { cwd: DIST, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter((l) => l && !l.endsWith('/')).length;
    if (listed === expect) {
      console.log('  条目核对通过: ' + listed + ' 个文件');
      break;
    }
    console.log('  压缩包条目 ' + listed + ' ≠ 磁盘 ' + expect);
  } else {
    console.log('  压缩失败: ' + (failed && failed.message.split('\n')[0]));
  }
  if (attempt >= 4) throw new Error('压缩包连续 4 次没做对');
  console.log('  5 秒后重试（等占用文件的句柄放开）');
  sleep(5000);
}
console.log('目录 ' + TARGET + '  ' + mb(size(TARGET)));
console.log('压缩包 ' + ZIP + '  ' + mb(fs.statSync(ZIP).size));
