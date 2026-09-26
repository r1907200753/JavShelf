'use strict';
// Throwaway probe: exercise main/covers.js file semantics without the full suite.
//   npx electron tools/probe-covers.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { app, nativeImage } = require('electron');
const { CoverStore } = require('../main/covers');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);

// Distinct solid-colour JPEGs: every import in this probe must produce its own content hash,
// otherwise the "old copy pruned" checks compare one file against itself.
const jpg = (r, g, b) => {
  const w = 8;
  const h = 8;
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = b;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = r;
    buf[i * 4 + 3] = 255;
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h }).toJPEG(90);
};

app.whenReady().then(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'covers-'));
  const store = new CoverStore(base, path.join(base, 'JavShelf.db'));
  const lib = 'probe';
  const folder = path.join(base, 'movie');
  fs.mkdirSync(folder, { recursive: true });
  const poster = path.join(folder, 'ABC-1-poster.jpg');
  const jpegA = jpg(10, 120, 200);
  const jpegB = jpg(200, 120, 10);
  const jpegC = jpg(20, 200, 20);
  fs.writeFileSync(poster, jpg(90, 90, 90));
  const originalSha = sha(poster);
  const done = [];
  const fail = (m) => {
    console.log('FAIL ' + m);
    process.exitCode = 1;
  };

  (async () => {
    const r1 = await store.save(lib, 'ABC-1', jpegA, '');
    if (!/^video_cover\/A\/ABC-1-[0-9a-f]{10}\.jpg$/.test(r1.rel)) fail('rel 形状不对: ' + r1.rel);
    if (r1.folder !== '') fail('没勾却返回了 folder');
    if (sha(poster) !== originalSha) fail('只改显示动了他的文件');
    if (store.count() !== 1) fail('count 应为 1');
    if (store.relOf(lib, 'ABC-1') !== r1.rel) fail('relOf 没认出自定义封面');
    done.push('display-only');

    const r2 = await store.save(lib, 'ABC-1', jpegB, poster);
    if (path.resolve(r2.folder) !== path.resolve(poster)) fail('folder 指针不对');
    if (sha(poster) === originalSha) fail('勾了却没覆写');
    if (!fs.existsSync(poster + '.bak') || sha(poster + '.bak') !== originalSha) fail('.bak 不是原图');
    if (r2.rel === r1.rel) fail('换了图却生成同一个文件名: ' + r2.rel);
    if (fs.existsSync(store.absOf(r1.rel))) fail('上一份没清掉');
    done.push('mirrored');

    const r3 = await store.save(lib, 'ABC-1', jpegC, '');
    if (r3.folder !== '') fail('第二次不勾却报了 folder');
    if (fs.existsSync(store.absOf(r2.rel))) fail('不勾的那次没换掉自己那份');
    if (sha(poster + '.bak') !== originalSha) fail('不勾的那次把 .bak 覆盖了');
    if (sha(poster) === originalSha) fail('不勾的那次反而还原了他的文件');
    done.push('retain');

    const c = await store.clear(lib, 'ABC-1');
    if (path.resolve(c.restored) !== path.resolve(poster)) fail('restored 不对: ' + JSON.stringify(c));
    if (sha(poster) !== originalSha) fail('恢复后字节不对');
    if (fs.existsSync(poster + '.bak')) fail('.bak 还在');
    if (store.count() !== 0) fail('count 没归零');
    if (store.relOf(lib, 'ABC-1') !== '') fail('relOf 还认旧记录');
    if (fs.existsSync(store.absOf(r3.rel))) fail('自己那份没删');
    done.push('restore');

    const r4 = await store.save(lib, 'DEF-2', jpegA, '');
    const c4 = await store.clear(lib, 'DEF-2');
    if (c4.restored !== '' || c4.removedFolder !== '' || !c4.removed) fail('纯显示的恢复返回值不对: ' + JSON.stringify(c4));
    if (fs.existsSync(store.absOf(r4.rel))) fail('DEF-2 那份没删');
    done.push('clear-without-mirror');

    const fresh = path.join(folder, 'NEW-9-poster.jpg');
    await store.save(lib, 'NEW-9', jpegA, fresh);
    if (!fs.existsSync(fresh)) fail('新建的 sidecar 没写出来');
    const c5 = await store.clear(lib, 'NEW-9');
    if (c5.removedFolder !== fresh || fs.existsSync(fresh)) fail('新建的 sidecar 没撤掉: ' + JSON.stringify(c5));
    done.push('clear-of-created-sidecar');

    console.log('PROBE_OK ' + done.join(' | '));
    fs.rmSync(base, { recursive: true, force: true });
    app.quit();
  })().catch((e) => {
    console.log('FAIL threw ' + e.stack);
    process.exitCode = 1;
    app.quit();
  });
});
