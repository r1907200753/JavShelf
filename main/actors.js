'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { nativeImage } = require('electron');

// Owns everything about the avatar bucket: where a name's file lives, and how an incoming
// image is normalised before it gets there. Avatars are JavShelf's own asset, so the store
// works with or without 数据目录 — main.js points it at the app's data folder in that case.
class ActorStore {
  constructor(dataDir, root) {
    this.dataDir = dataDir;
    this.actorDir = path.join(dataDir, 'actor');
    this.inboxDir = path.join(dataDir, 'actor_inbox');
    fs.mkdirSync(this.actorDir, { recursive: true });
    fs.mkdirSync(this.inboxDir, { recursive: true });
    root.addRoot(this.actorDir);
    root.addRoot(this.inboxDir);
  }

  // Most performer names here are Japanese, so the ASCII bucket would dump every
  // file into OTHER. Non-latin names spread over 16 buckets by code point instead.
  // Only this class knows the layout; the renderer asks rather than duplicating it.
  static bucket(name) {
    const s = String(name || '').trim();
    if (!s) return 'OTHER';
    const c = s[0].toUpperCase();
    if (/[0-9A-Z]/.test(c)) return c;
    if (c === '_') return '_';
    return 'U' + (s.codePointAt(0) % 16);
  }

  static safeName(name) {
    return String(name).trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ');
  }

  pathOf(name) {
    return path.join(this.actorDir, ActorStore.bucket(name), ActorStore.safeName(name) + '.jpg');
  }

  relOf(name) {
    return `actor/${ActorStore.bucket(name)}/${ActorStore.safeName(name)}.jpg`;
  }

  // The ref the page puts into an <img>. One stable filename per performer is exactly the
  // problem: replacing her picture must not wait for a restart, so the ref carries the file's
  // mtime and the URL changes together with the bytes. Null means "no avatar here".
  async refOf(name) {
    let st;
    try {
      st = await fsp.stat(this.pathOf(name));
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    return this.relOf(name) + '?v=' + Math.round(st.mtimeMs);
  }

  has(name) {
    return fs.existsSync(this.pathOf(name));
  }

  // Everything lands as one uniform JPEG at <=320px wide, whatever the source was
  // (PNG from the inbox, WebP from a site). The renderer then only ever has to know
  // one filename, and 1145 avatars stay a few MB instead of hundreds.
  save(name, buf) {
    const img = nativeImage.createFromBuffer(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    if (img.isEmpty()) throw new Error('不是可解码的图片');
    const s = img.getSize();
    const out = s.width > 320 ? img.resize({ width: 320, quality: 'best' }) : img;
    const abs = this.pathOf(name);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = abs + '.tmp';
    fs.writeFileSync(tmp, out.toJPEG(90));
    fs.renameSync(tmp, abs);
    return this.relOf(name);
  }

  // Manual route: drop 名字.jpg (or .png/.webp) into actor_inbox and it lands in the
  // same bucket layout the library already uses. Offline, and good for retouching one.
  importInbox() {
    const moved = [];
    for (const e of fs.readdirSync(this.inboxDir)) {
      const p = path.join(this.inboxDir, e);
      if (!fs.statSync(p).isFile()) continue;
      const ext = path.extname(e).toLowerCase();
      if (!['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(ext)) continue;
      const name = path.basename(e, ext);
      try {
        this.save(name, fs.readFileSync(p));
        fs.rmSync(p);
        moved.push(name);
      } catch {
        /* leave an unreadable file in the inbox rather than destroying it */
      }
    }
    return moved;
  }

  coverage(names) {
    const have = names.filter((n) => this.has(n)).length;
    return { total: names.length, have, missing: names.length - have };
  }
}

module.exports = { ActorStore };
