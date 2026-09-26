'use strict';
const fs = require('node:fs');

// Kodi-style movie nfo, which is what these folders carry. There is no XML library in
// this project, so rather than parse and re-serialise (which would quietly drop
// whatever the scraper stored in tags we do not model), the writer edits the original
// text in place: only the tags the user touched are replaced, everything else keeps its
// bytes, comments and odd shapes.
//
// Deliberately absent: `set` (it nests <name>), `type` and `name` (they also live
// inside <actor>, so a top-level regex would hit the wrong one).
const TEXT_TAGS = [
  'title', 'originaltitle', 'sorttitle', 'plot', 'outline', 'originalplot', 'tagline',
  'premiered', 'releasedate', 'year', 'runtime', 'rating', 'votes', 'criticrating', 'customrating',
  'studio', 'label', 'maker', 'publisher', 'countrycode', 'mpaa', 'series',
  'tag', 'genre', 'director', 'website', 'trailer', 'num', 'javdbsearchid', 'cover', 'poster'
];
const CDATA_TAGS = new Set(['plot', 'outline', 'originalplot', 'tagline', 'title', 'originaltitle']);
const LIST_TAGS = new Set(['tag', 'genre', 'director']);

function clean(v) {
  const s = String(v == null ? '' : v);
  const c = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(s);
  return (c ? c[1] : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .trim();
}

function escape(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wrap(tag, value) {
  const v = String(value == null ? '' : value);
  return CDATA_TAGS.has(tag) && v ? `<![CDATA[${v}]]>` : escape(v);
}

function readNfo(file, preloaded) {
  // The caller may hand in the text it already fetched (cache hit); reading here is
  // the fallback, not the norm.
  const text = typeof preloaded === 'string' ? preloaded : fs.readFileSync(file, 'utf8');
  const body = text.replace(/<actor>[\s\S]*?<\/actor>/gi, '');
  const fields = {};
  for (const tag of TEXT_TAGS) {
    const hits = [...body.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'gi'))].map((m) => clean(m[1]));
    if (!hits.length) continue;
    fields[tag] = LIST_TAGS.has(tag) ? hits : hits[0];
  }
  const actors = [...text.matchAll(/<actor>([\s\S]*?)<\/actor>/gi)].map((m) => ({
    name: clean((/<name>([\s\S]*?)<\/name>/i.exec(m[1]) || [])[1]),
    role: clean((/<role>([\s\S]*?)<\/role>/i.exec(m[1]) || [])[1])
  }));
  const known = new Set([...TEXT_TAGS, 'actor', 'name', 'role', 'type', 'movie', 'uniqueid', 'id', 'credits', 'thumb', 'fanart']);
  const unknown = new Set();
  for (const m of body.matchAll(/<([a-zA-Z_][\w:-]*)>/g)) if (!known.has(m[1])) unknown.add(m[1]);
  return { file, fields, actors, unknownTags: [...unknown], bytes: Buffer.byteLength(text) };
}

function setTag(text, tag, value) {
  const one = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'i');
  const body = `<${tag}>${wrap(tag, value)}</${tag}>`;
  if (one.test(text)) return text.replace(one, body);
  if (value === '' || value == null) return text;
  const close = text.lastIndexOf('</movie>');
  return close < 0 ? text : text.slice(0, close) + '  ' + body + '\n' + text.slice(close);
}

function setList(text, tag, value) {
  const items = (Array.isArray(value) ? value : String(value || '').split(/[/,、|]/).map((s) => s.trim()).filter(Boolean))
    .map((v) => `  <${tag}>${wrap(tag, v)}</${tag}>`)
    .join('\n');
  const stripped = text.replace(new RegExp(`[ \\t]*<${tag}>[\\s\\S]*?<\\/${tag}>[ \\t]*\\n?`, 'gi'), '');
  if (!items) return stripped;
  const close = stripped.lastIndexOf('</movie>');
  return close < 0 ? stripped : stripped.slice(0, close) + items + '\n' + stripped.slice(close);
}

function setActors(text, actors) {
  const stripped = text.replace(/[ \t]*<actor>[\s\S]*?<\/actor>[ \t]*\n?/gi, '');
  const block = (actors || [])
    .filter((a) => a && String(a.name || '').trim())
    .map((a) => `  <actor>\n    <name>${wrap('x', a.name)}</name>\n    <role>${wrap('x', a.role || '')}</role>\n    <type>Actor</type>\n  </actor>`)
    .join('\n');
  if (!block) return stripped;
  const close = stripped.lastIndexOf('</movie>');
  return close < 0 ? stripped : stripped.slice(0, close) + block + '\n' + stripped.slice(close);
}

function writeNfo(file, patch) {
  const before = fs.readFileSync(file, 'utf8');
  let text = before;
  for (const [tag, value] of Object.entries(patch.fields || {})) {
    if (!TEXT_TAGS.includes(tag)) throw new Error('不支持修改的字段: ' + tag);
    text = LIST_TAGS.has(tag) ? setList(text, tag, value) : setTag(text, tag, value);
  }
  if (Array.isArray(patch.actors)) text = setActors(text, patch.actors);
  if (text === before) return { file, changed: false };
  const bak = file + '.bak';
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, before);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return { file, changed: true, bytes: Buffer.byteLength(text), backup: bak };
}

// Build a whole document for a folder that has a video but no nfo yet — otherwise 从 JavDB
// 覆写 can only ever patch files that already exist.
function buildNfo(patch) {
  const NL = String.fromCharCode(10);
  const one = (tag, value) => (value === '' || value == null ? '' : `  <${tag}>${wrap(tag, value)}</${tag}>` + NL);
  const many = (tag, values) => {
    const list = Array.isArray(values) ? values : String(values || '').split(/[/,、|]/).map((v) => v.trim()).filter(Boolean);
    if (!list.length) return '';
    return list.map((v) => `  <${tag}>${wrap(tag, v)}</${tag}>`).join(NL) + NL;
  };
  let body = '';
  for (const [tag, value] of Object.entries(patch.fields || {})) {
    if (!TEXT_TAGS.includes(tag)) throw new Error('不支持修改的字段: ' + tag);
    body += LIST_TAGS.has(tag) ? many(tag, value) : one(tag, value);
  }
  for (const a of patch.actors || []) {
    if (!a || !String(a.name || '').trim()) continue;
    body +=
      `  <actor>` + NL + `    <name>${wrap('x', a.name)}</name>` + NL + `    <role>${wrap('x', a.role || '')}</role>` + NL + `    <type>Actor</type>` + NL + `  </actor>` + NL;
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' + NL + '<movie>' + NL + body + '</movie>' + NL;
}

function createNfo(file, patch) {
  if (fs.existsSync(file)) throw new Error('文件已存在，不该走新建: ' + file);
  const text = buildNfo(patch);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return { file, changed: true, created: true, bytes: Buffer.byteLength(text) };
}

module.exports = { readNfo, writeNfo, createNfo };
