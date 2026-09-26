'use strict';
const path = require('node:path');

// Serves local images (posters, fanart, actor avatars, and the -poster/-fanart/-thumb
// files that sit next to each video) through a privileged scheme. Every request is
// confined to an allow-list of roots so the renderer cannot read arbitrary disk paths.
// A path with an `r<n>/` prefix is resolved against the nth registered root; anything
// else stays relative to the first root, which is what the 配置 layout uses.
class Media {
  // base is the 配置 directory: the original program's relative layout (poster/<桶>/…,
  // actor/<桶>/…) is resolved against it. Library folders are appended as extra roots
  // and reached through their r<n>/ prefix.
  constructor(base) {
    this.roots = [];
    this.addRoot(base || process.cwd());
  }

  addRoot(dir) {
    const abs = path.resolve(dir);
    const at = this.roots.indexOf(abs);
    if (at >= 0) return at;
    this.roots.push(abs);
    return this.roots.length - 1;
  }

  // Absolute path -> `r<n>/...` reference, or null when it is outside every root.
  relFor(abs) {
    const p = path.resolve(abs);
    for (let i = 0; i < this.roots.length; i++) {
      const r = this.roots[i];
      if (p === r || p.startsWith(r + path.sep)) return 'r' + i + '/' + path.relative(r, p);
    }
    return null;
  }

  resolve(rel) {
    const decoded = decodeURIComponent(String(rel || '')).replace(/^[\/\x5c]+/, '');
    const m = /^r(\d+)\//.exec(decoded);
    if (m) {
      const root = this.roots[Number(m[1])];
      if (!root) throw new Error('未知根目录');
      const abs = path.resolve(root, decoded.slice(m[0].length));
      if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('路径越界: ' + decoded);
      return abs;
    }
    const abs = path.resolve(this.roots[0], decoded);
    const ok = this.roots.some((r) => abs === r || abs.startsWith(r + path.sep));
    if (!ok) throw new Error('路径越界: ' + decoded);
    return abs;
  }

  // Reading goes through the image protocol in main.js (async, with the warm-copy cache in
  // front of it); this class only owns the allow-list and the two directions of translation.
}

module.exports = { Media };
