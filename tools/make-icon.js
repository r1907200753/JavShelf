'use strict';
// Draws build/icon.png with nothing but a bitmap buffer: a dark rounded tile, a
// cyan→blue film-frame outline and a play triangle. Rendered at 2x then downscaled so
// the edges stay smooth, which is also what the app's own UI palette looks like.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SS = 2;
const SIZE = 1024 * SS;
const px = (v) => v * SS;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const len = (x, y) => Math.hypot(x, y);

function roundedRect(x, y, cx, cy, w, h, r) {
  const dx = Math.abs(x - cx) - w / 2 + r;
  const dy = Math.abs(y - cy) - h / 2 + r;
  const ax = Math.max(dx, 0), ay = Math.max(dy, 0);
  return len(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}

function triangle(x, y, a, b, c) {
  let d = 0;
  const edges = [[a, b], [b, c], [c, a]];
  for (const [p, q] of edges) {
    const pqx = q[0] - p[0], pqy = q[1] - p[1];
    const vx = x - p[0], vy = y - p[1];
    const t = clamp((vx * pqx + vy * pqy) / (pqx * pqx + pqy * pqy), 0, 1);
    d = Math.max(d, len(vx - pqx * t, vy - pqy * t) * (((pqx * vy - pqy * vx) > 0) ? 1 : -1));
  }
  return d;
}

const mix = (c1, c2, t) => [0, 1, 2].map((i) => c1[i] + (c2[i] - c1[i]) * t);
const TOP = [27, 32, 40], BOT = [18, 21, 27];
const CYAN_A = [77, 163, 255], CYAN_B = [127, 212, 255];

app.whenReady().then(() => {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const cx = SIZE / 2, cy = SIZE / 2;
  const aa = SS * 1.4;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const tile = 1 - clamp(roundedRect(x, y, cx, cy, SIZE - px(24), SIZE - px(24), px(210)) / aa, 0, 1);
      if (tile <= 0) { buf[i + 3] = 0; continue; }
      let col = mix(TOP, BOT, y / SIZE);
      const frame = Math.abs(roundedRect(x, y, cx, cy, px(620), px(500), px(70))) - px(26);
      const g = clamp((cy - px(250) - (y - cy)) / px(500) * 0.5 + 0.5, 0, 1);
      const accent = mix(CYAN_A, CYAN_B, g);
      const f = 1 - clamp(frame / aa, 0, 1);
      col = mix(col, accent, f);
      const tri = 1 - clamp(triangle(x, y,
        [cx - px(70), cy - px(150)], [cx - px(70), cy + px(150)], [cx + px(160), cy]) / aa, 0, 1);
      col = mix(col, accent, tri);
      // createFromBitmap wants BGRA on little-endian, not the RGB order we mixed above.
      buf[i] = Math.round(col[2]);
      buf[i + 1] = Math.round(col[1]);
      buf[i + 2] = Math.round(col[0]);
      buf[i + 3] = Math.round(255 * tile);
    }
  }
  const big = nativeImage.createFromBitmap(buf, { width: SIZE, height: SIZE });
  const out = big.resize({ width: 1024, height: 1024, quality: 'best' });
  const dir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'icon.png'), out.toPNG());
  console.log('wrote build/icon.png', JSON.stringify(out.getSize()));
  app.quit();
});
