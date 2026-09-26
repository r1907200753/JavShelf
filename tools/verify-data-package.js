'use strict';
// Read-only comparison between his live install and the data-carrying package: same tables,
// same row counts, same file counts and bytes per data entry, same config bytes.
//   node tools/verify-data-package.js
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const LIVE = 'G:\\JavShelf-v1.6.1-windows-x86_64';
const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PACK = path.join(ROOT, 'dist', `JavShelf-v${pkg.version}-data-windows-x86_64`);

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

function tableCounts(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const out = {};
  for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    out[r.name] = db.prepare('SELECT COUNT(*) AS n FROM "' + r.name.replace(/"/g, '""') + '"').get().n;
  }
  db.close();
  return out;
}

const liveData = path.join(LIVE, 'JavShelf-data');
const packData = path.join(PACK, 'JavShelf-data');
let bad = 0;

const a = tableCounts(path.join(liveData, 'JavShelf.db'));
const b = tableCounts(path.join(packData, 'JavShelf.db'));
for (const t of new Set([...Object.keys(a), ...Object.keys(b)])) {
  const same = a[t] === b[t];
  if (!same) bad++;
  console.log(`表 ${t.padEnd(12)} 在用=${a[t] ?? '无'} 包内=${b[t] ?? '无'} ${same ? 'OK' : '不一致'}`);
}

for (const name of fs.readdirSync(packData)) {
  const lp = path.join(liveData, name);
  const pp = path.join(packData, name);
  if (!fs.existsSync(lp)) {
    console.log(`目录 ${name}: 源里没有了(包内 ${walk(pp).files} 个文件)`);
    continue;
  }
  const x = fs.statSync(lp).isDirectory() ? walk(lp) : { bytes: fs.statSync(lp).size, files: 1 };
  const y = fs.statSync(pp).isDirectory() ? walk(pp) : { bytes: fs.statSync(pp).size, files: 1 };
  // The live install keeps writing while we read it, so "包内 <= 源" with a small gap is fine.
  const ok = y.files >= x.files * 0.999 && y.bytes >= x.bytes * 0.999;
  if (!ok) bad++;
  console.log(`${(name + ' ').padEnd(16)} 源 ${String(x.files).padStart(5)} 个 / ${(x.bytes / 1048576).toFixed(1)} MB → 包 ${String(y.files).padStart(5)} 个 / ${(y.bytes / 1048576).toFixed(1)} MB ${ok ? 'OK' : '少了'}`);
}

const lc = fs.readFileSync(path.join(LIVE, 'config.json'), 'utf8');
const pc = fs.readFileSync(path.join(PACK, 'config.json'), 'utf8');
const diff = lc === pc;
if (!diff) bad++;
const cfg = JSON.parse(pc);
console.log(`config.json 与在用一致: ${diff}（libraries=${(cfg.libraries || []).length}, cookie=${cfg.javdbCookie ? '有' : '无'}, theme=${cfg.appearance.theme}）`);
console.log(bad ? `VERIFY_BAD ${bad}` : 'VERIFY_OK');
