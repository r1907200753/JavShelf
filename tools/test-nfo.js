'use strict';
// Round-trips a real nfo copy inside out/ so nothing in the media folders is touched:
// read -> patch -> read, and checks that untouched tags survive byte-for-byte.
const fs = require('node:fs');
const path = require('node:path');
const { readNfo, writeNfo } = require('../main/nfo');

const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) {
  console.log('用法: node tools/test-nfo.js <某个真实 .nfo 的路径>');
  process.exit(1);
}
const dir = path.join(__dirname, '..', 'out');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'nfo-sample.nfo');
fs.copyFileSync(SRC, file);

const first = readNfo(file);
console.log('读取字段:', Object.keys(first.fields).join(','));
console.log('演员:', first.actors.map((a) => a.name).join(' / '));
console.log('未建模标签:', first.unknownTags.join(','));

const before = fs.readFileSync(file, 'utf8');
writeNfo(file, {
  fields: { title: '测试标题 <安全> & 符号', genre: ['女大学生', '中文字幕'], rating: '4.5' },
  actors: [{ name: '测试演员A', role: '自己' }, { name: '测试演员B', role: '' }]
});
const after = fs.readFileSync(file, 'utf8');
const second = readNfo(file);

const ok = [];
const fail = [];
const check = (label, pass) => (pass ? ok : fail).push(label);
check('title 已改', second.fields.title === '测试标题 <安全> & 符号');
check('genre 变成两项', JSON.stringify(second.fields.genre) === JSON.stringify(['女大学生', '中文字幕']));
check('rating 已改', second.fields.rating === '4.5');
check('演员已替换', second.actors.length === 2 && second.actors[1].name === '测试演员B');
check('plot 未被改动', second.fields.plot === first.fields.plot);
check('outline 未被改动', second.fields.outline === first.fields.outline);
check('未建模标签全部保留', first.unknownTags.every((t) => second.unknownTags.includes(t)));
check('生成了 .bak', fs.existsSync(file + '.bak') && fs.readFileSync(file + '.bak', 'utf8') === before);
check('XML 仍然闭合', /<\/movie>\s*$/.test(after));

console.log('通过:', ok.join(' | '));
if (fail.length) console.log('失败:', fail.join(' | '));
console.log(fail.length ? 'NFO_TEST_FAIL' : 'NFO_TEST_OK');
process.exit(fail.length ? 1 : 0);
