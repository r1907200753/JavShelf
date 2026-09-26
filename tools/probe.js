const { app } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const out = { node: process.versions.node, electron: process.versions.electron, chrome: process.versions.chrome };
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(String.raw`G:\video\配置\ALEX.db`, { readOnly: true });
    const n = db.prepare('SELECT COUNT(*) AS c FROM local_JAV').get();
    const s = db.prepare('SELECT movie_编码, movie_演员, movie_日期 FROM local_JAV WHERE movie_日期 IS NOT NULL ORDER BY movie_日期 DESC LIMIT 3').all();
    db.close();
    out.sqlite = 'OK';
    out.count = n.c;
    out.sample = s;
  } catch (e) {
    out.sqlite = 'FAIL: ' + e.message;
  }
  out.scale = require('electron').screen.getPrimaryDisplay().scaleFactor;
  console.log('PROBE_RESULT ' + JSON.stringify(out));
  app.quit();
});
