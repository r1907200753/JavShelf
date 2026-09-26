'use strict';
// JavDB reader. Everything here is scoped parsing of server-rendered HTML, verified against
// live pages on 2026-09-22: the video panel is `div.movie-panel-info`, the actress directory is
// `div.box.actor-box`, and the ids are short alphanumeric codes (/v/xxxx, /actors/xxxx,
// /makers/xxx, /series/xxxx). Navbar links also point at /makers and /actors, so every query is
// confined to the region that owns it — otherwise the studio row picks up a promoted maker.
//
// JavDB no longer publishes height/measurements on the actress page, so that part comes from
// the Japanese Wikipedia infobox (wikiActress).
const { ProxyAgent, fetch: undiciFetch } = require('undici');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BASE = 'https://javdb.com';

const strip = (h) =>
  String(h)
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<[^>]+>/g, '|')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\|+/g, '|')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();

// The slice of a page owned by one container, found by its class. Keeps the panel parser from
// reading the navbar or the "related titles" carousel.
function region(html, cls, from) {
  const start = html.indexOf(cls, from || 0);
  if (start < 0) return '';
  const next = html.indexOf('movie-panel-form', start);
  const end = html.indexOf('</section>', start);
  const stop = [end, next > start ? next : Infinity].filter((n) => Number.isFinite(n)).sort((a, b) => a - b)[0];
  return html.slice(start, stop === undefined ? start + 4000 : Math.min(stop, start + 6000));
}

// The panel is a run of `<div class="panel-block"><strong>片商:</strong> &nbsp;<span
// class="value">…</span></div>`. Splitting per block rather than regexing the whole panel is
// what keeps 番號 from swallowing 日期: the value span nests (the score row carries star
// icons), so the end of a row can only be found by taking the block apart first.
function panelValues(html) {
  const out = {};
  for (const chunk of String(html).split('<div class="panel-block"').slice(1)) {
    const block = chunk.slice(0, 1400);
    const label = (block.match(/<strong>\s*([^<>]+?)\s*[:：]\s*<\/strong>/) || [])[1];
    if (!label) continue;
    const start = block.indexOf('<span class="value"');
    if (start < 0) continue;
    const end = block.indexOf('</div>', start);
    const body = block.slice(start, end < 0 ? start + 900 : end);
    out[label.trim()] = {
      text: strip(body)
        .replace(/\|/g, '')
        .replace(/^[:：\s]+/, '')
        .replace(/\s*-\s*/g, '-')
        .replace(/\s{2,}/g, ' ')
        .trim(),
      links: [...body.matchAll(/href="([^"]+)"/g)].map((x) => x[1]),
      html: body
    };
  }
  return out;
}

// JavDB marks women with class="actor-female" and leaves men bare, which is the only
// reliable way to honour "排除男演员" without a name list.
function parseActorLinks(html) {
  const out = [];
  for (const m of String(html).matchAll(/<a([^>]*)href="(\/actors\/([A-Za-z0-9]+))"[^>]*>([^<]+)<\/a>/g)) {
    const cls = m[1] || '';
    out.push({
      id: m[3],
      name: m[4].trim(),
      female: /actor-female/.test(cls),
      male: /actor-male/.test(cls)
    });
  }
  return out;
}

const first = (arr, re) => {
  for (const s of arr || []) {
    const m = String(s).match(re);
    if (m) return m[1];
  }
  return '';
};

function parseCode(title) {
  const m = String(title || '').match(/([AIPKSUZ]{0,3}[A-Z]{2,10}[-_ ]?\d{2,6}[A-Za-z]?(?:-[A-Za-z]\d?)?)/);
  return m ? m[1].toUpperCase() : '';
}

// People type a proxy as "127.0.0.1:7890" out of habit; ProxyAgent needs a real URL and
// otherwise throws a bare "Invalid URL" that tells the user nothing.
function normalizeProxy(proxy) {
  const s = String(proxy || '').trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://' + s;
}

// JavDB ids are short and alphanumeric; anything else a user pastes is not an id.
const ACTOR_ID = /^[A-Za-z0-9]{2,12}$/;

// JavDB buckets covers and avatars by the first two id characters lower-cased while keeping
// the id's own casing in the filename (verified on a live page: W1EGe -> /avatars/w1/W1EGe.jpg),
// so her photo is derivable from the id even when the served HTML carries no <img>. A photo the
// page did serve is only accepted from JavDB's own CDN.
const AVATAR_HOST = /^https:\/\/[a-z0-9.-]*jdbstatic\.com\/[a-z0-9._/-]+$/i;
function avatarFor(id, servedUrl) {
  const s = String(servedUrl || '');
  if (AVATAR_HOST.test(s)) return s;
  return ACTOR_ID.test(String(id || ''))
    ? `https://c0.jdbstatic.com/avatars/${String(id).slice(0, 2).toLowerCase()}/${id}.jpg`
    : '';
}

// What a user pastes into 绑定 JavDB: the whole address bar (any mirror domain), a bare id, or
// a link with a name slug or ?page= glued on. Only the id survives — every request this app then
// makes is rebuilt from it as `/actors/<id>`, so a paste can never point the fetcher somewhere
// else. Returns { id, url } or { error } with a message meant to be shown as-is.
function parseActorRef(text) {
  const s = String(text || '').trim().replace(/[\s<>"']/g, '');
  if (!s) return { error: '先把她的 JavDB 链接或编号贴进来。' };
  const hit = s.match(/\/actors?\/([A-Za-z0-9]+)/i);
  const id = hit ? hit[1] : s;
  if (ACTOR_ID.test(id)) return { id, url: `${BASE}/actors/${id}` };
  if (/\/search\b|\/(?:v|makers|series|directors|publishers)\//i.test(s) || /[?&]q=/i.test(s))
    return { error: '这是搜索页或作品／片商／系列的链接。要在浏览器里打开她本人那一页，地址形如 https://javdb.com/actors/abc12' };
  return { error: '认不出 JavDB 编号。贴整条链接（形如 https://javdb.com/actors/abc12），或者只填编号。' };
}

// One box per actress: <div class="box actor-box"><a href="/actors/kzx6" title="名, 别名…">
// …<img class="avatar" src="…"> — parsed in steps because the boxes are short but the
// attribute order is not guaranteed.
function parseActorBoxes(html) {
  const out = [];
  for (const chunk of String(html || '').split('<div class="box actor-box">').slice(1)) {
    const box = chunk.slice(0, 1200);
    const href = (box.match(/href="(\/actors\/([A-Za-z0-9]+))"/) || [])[1];
    if (!href) continue;
    const title = (box.match(/title="([^"]*)"/) || [])[1] || '';
    const img = (box.match(/src="([^"]+\.(?:jpg|jpeg|png|webp))"/i) || [])[1] || '';
    out.push({
      id: href.split('/').pop(),
      url: BASE + href,
      names: title.split(',').map((s) => s.trim()).filter(Boolean),
      avatar: img
    });
  }
  return out;
}

class JavDB {
  constructor(proxy, opts = {}) {
    this.proxy = normalizeProxy(proxy);
    // A pasted browser cookie makes JavDB serve the logged-in actress page, which is the
    // only place its body measurements still appear.
    this.cookie = String(opts.cookie || '').trim();
    this.agent = this.proxy ? new ProxyAgent({ uri: this.proxy, headersTimeout: 30000, bodyTimeout: 30000, connections: 2 }) : null;
    this.throttleMs = opts.throttleMs === undefined ? 350 : opts.throttleMs;
    this.last = 0;
    this.cancelled = false;
    // Set when a rejected cookie is dropped so the rest of the run stops paying 30 seconds
    // per page for it.
    this.cookieBroken = false;
    this.onCookieFallback = null;
  }

  close() {
    if (this.agent && this.agent.close) this.agent.close().catch(() => {});
    this.agent = null;
  }

  async wait(slot) {
    const delta = Date.now() - this.last;
    if (delta < slot) await new Promise((r) => setTimeout(r, slot - delta));
    this.last = Date.now();
  }

  async get(pathOrUrl, attempt = 0) {
    if (this.cancelled) throw new Error('已取消');
    await this.wait(this.throttleMs * (attempt + 1));
    const url = /^https?:/.test(pathOrUrl) ? pathOrUrl : BASE + pathOrUrl;
    const r = await undiciFetch(url, {
      dispatcher: this.agent || undefined,
      redirect: 'manual',
      headers: { 'user-agent': UA, 'accept-language': 'zh-TW,zh;q=0.8,ja;q=0.7', ...(this.cookie ? { cookie: this.cookie } : {}) }
    });
    // A stale or flagged login cookie shows up as a blanket 502 on *every* page, which looks
    // exactly like rate limiting but never recovers. Try without it: if that answers, the
    // cookie is the problem, so drop it for the rest of the run and say so.
    if (r.status === 502 && this.cookie && attempt === 0) {
      const saved = this.cookie;
      this.cookie = '';
      try {
        const again = await this.get(pathOrUrl, 0);
        this.cookieBroken = true;
        if (this.onCookieFallback) this.onCookieFallback(saved);
        return again;
      } catch {
        this.cookie = saved;
      }
    }
    // A burst of fast paging gets 502s from the edge, not a block page. Backing off and
    // retrying twice keeps a batch crawl going instead of losing the whole run.
    if ((r.status === 502 || r.status === 429 || r.status === 503) && attempt < 2) {
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1) * (attempt + 2)));
      return this.get(pathOrUrl, attempt + 1);
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location') || '';
      if (!loc) throw new Error('重定向无目标: ' + url);
      return this.get(new URL(loc, url).href);
    }
    if (r.status === 403) throw new Error('JavDB 拒绝了请求（可能被风控），稍后再试或更换代理节点');
    if (r.status === 502 && this.cookieBroken) throw new Error('JavDB 返回 502（去掉 Cookie 也仍然 502，多为代理节点被风控）');
    if (r.status !== 200) throw new Error('JavDB 返回 ' + r.status);
    return r.text();
  }

  // ---- one title -------------------------------------------------------------

  async searchVideo(code) {
    const html = await this.get('/search?q=' + encodeURIComponent(code) + '&f=all');
    const ids = [...new Set([...html.matchAll(/href="(\/v\/[A-Za-z0-9]+)"/g)].map((m) => m[1]))];
    const want = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    for (const id of ids.slice(0, 6)) {
      const title = (html.match(new RegExp('href="' + id + '"[^>]*>([\\s\\S]{0,200}?)</a>')) || [])[1];
      const t = strip(title || '');
      if (!want || t.toUpperCase().replace(/[^A-Z0-9]/g, '').includes(want)) return { id, title: t };
    }
    return ids.length ? { id: ids[0], title: strip((html.match(/<title>([^<]*)</) || [])[1] || '') } : null;
  }

  async videoByCode(code) {
    const hit = await this.searchVideo(code);
    if (!hit) return null;
    const html = await this.get(hit.id);
    return this.parseVideo(html, hit.id);
  }

  parseVideo(html, href) {
    const panel = region(html, 'movie-panel-info');
    const v = panelValues(panel);
    const pick = (label) => (v[label] ? v[label].text : '');
    const linksOf = (label) => (v[label] ? v[label].links : []);
    const title = (html.match(/<title>\s*([\s\S]*?)\s*<\/title>/) || [])[1] || '';
    const cleanTitle = title.split('|')[0].trim();
    const vid = (href || '').replace(/^\/v\//, '');
    const people = parseActorLinks(v['演員'] ? v['演員'].html : '');
    return {
      javdb: vid,
      url: BASE + (href || ''),
      title: cleanTitle,
      code: pick('番號') || parseCode(cleanTitle),
      date: pick('日期'),
      minutes: (pick('時長').match(/\d+/) || [])[0] || '',
      director: pick('導演'),
      directorId: first(linksOf('導演'), /\/directors\/([A-Za-z0-9]+)/),
      studio: pick('片商'),
      studioId: first(linksOf('片商'), /\/makers\/([A-Za-z0-9]+)/),
      publisher: pick('發行'),
      publisherId: first(linksOf('發行'), /\/publishers\/([A-Za-z0-9]+)/),
      series: pick('系列'),
      seriesId: first(linksOf('系列'), /\/series\/([A-Za-z0-9]+)/),
      score: (pick('評分').match(/(\d+(?:\.\d+)?)/) || [])[1] || '',
      genres: strip(pick('類別')).split(/[,，|]/).map((s) => s.trim()).filter(Boolean),
      actors: people,
      actressNames: people.filter((p) => p.female || (!p.male && people.every((q) => !q.female))).map((p) => p.name),
      // Screenshots and og:image are login-gated; the cover is public and bucketed by id.
      cover: /\/v\//.test(href || '') ? `https://c0.jdbstatic.com/covers/${vid.slice(0, 2).toLowerCase()}/${vid}.jpg` : ''
    };
  }

  // ---- actresses -------------------------------------------------------------

  // The censored directory is the route that maps a name to an id: search is walled, but the
  // paginated index is not, and its title attribute already carries every alias.
  async actressDirectoryPage(page, branch) {
    const path = branch || '/actors/censored';
    // Right after a 502 the edge can answer with a real JavDB page that simply is not the
    // listing (same size class, no boxes in it). Only the parser can tell that apart, so the
    // retry lives here — one refetch recovers it.
    let out = [];
    for (let tryNo = 0; tryNo < 2 && !out.length; tryNo++) {
      if (tryNo) await new Promise((res) => setTimeout(res, 1500));
      out = parseActorBoxes(await this.get(`${path}?page=${page}`));
    }
    // A page that parses to nobody is never the end of the directory — paging past the last
    // page hands back the last page again, so an empty result means the layout changed or the
    // edge served something that is not a listing. Saying so beats silently stopping the crawl.
    if (!out.length) throw new Error('目录页解析不出任何演员（页面结构变化或被风控）');
    return out;
  }

  async actressByName(name) {
    const want = String(name || '').trim();
    if (!want) return null;
    // /actors/<id> is not searchable by name, so walk the directory until an alias matches.
    for (let page = 1; page <= 400; page++) {
      const rows = await this.actressDirectoryPage(page);
      const hit = rows.find((r) => r.names.some((n) => n === want) || r.names.some((n) => n.includes(want) || want.includes(n)));
      if (hit) return hit;
    }
    return null;
  }

  async actressDetail(idOrUrl) {
    const href = /^https?:/.test(idOrUrl) ? idOrUrl.replace(BASE, '') : idOrUrl;
    const html = await this.get(href.startsWith('/actors/') ? href : '/actors/' + href);
    const id = (href.match(/\/actors\/([A-Za-z0-9]+)/) || [])[1] || String(href).replace(/^\/?actors\//, '').replace(/[/?#].*$/, '');
    const name = strip((html.match(/class="actor-section-name">([\s\S]*?)<\/span>/) || [])[1] || '');
    const metas = [...html.matchAll(/class="section-meta">([\s\S]*?)<\/span>/g)].map((m) => strip(m[1]));
    const avatar =
      (html.match(/class="avatar"[^>]*style="background-image:\s*url\(([^)]+)\)/) || [])[1] ||
      (html.match(/property="og:image"\s+content="([^"]+)"/) || [])[1] || '';
    const flat = strip(html);
    const grab = (label) => {
      const i = flat.indexOf(label);
      return i < 0 ? '' : (flat.slice(i, i + 90).match(/[:：]?\s*([^|]{1,28})/) || [])[1] || '';
    };
    const bd = grab('出生日期').match(/([12]\d{3})[^\d]{0,2}(\d{1,2})[^\d]{0,2}(\d{1,2})/);
    const nums = ((grab('三圍') || grab('三围')).match(/\d{2,3}/g) || []).slice(0, 3);
    return {
      id,
      names: name.split(',').map((x) => x.trim()).filter(Boolean),
      aliases: (metas[0] || '').split(',').map((x) => x.trim()).filter(Boolean),
      videoCount: (metas.join(' ').match(/(\d+)\s*部影片/) || [])[1] || '',
      url: `${BASE}/actors/${id}`,
      avatar: avatarFor(id, avatar),
      // All empty unless the request carried a login cookie.
      height: (grab('身高').match(/\d{2,3}/) || [])[1] || '',
      birthDate: bd ? `${bd[1]}-${String(bd[2]).padStart(2, '0')}-${String(bd[3]).padStart(2, '0')}` : '',
      bust: nums[0] || '',
      waist: nums[1] || '',
      hips: nums[2] || '',
      cup: cupOf(grab('罩杯'))
    };
  }

  // ---- maker / series --------------------------------------------------------

  async makerDetail(id) {
    const href = /^https?:/.test(id) ? id.replace(BASE, '') : '/makers/' + id;
    return this._entityPage(href);
  }

  async seriesDetail(id) {
    const href = /^https?:/.test(id) ? id.replace(BASE, '') : '/series/' + id;
    return this._entityPage(href);
  }

  async _entityPage(href) {
    const html = await this.get(href);
    // section-name is the header itself; the <h2> wrapper also catches the login modal's
    // heading, which is how this used to return "登入" as a studio name.
    const name =
      strip((html.match(/class="section-name">([\s\S]*?)<\/span>/) || [])[1] || '') ||
      ((html.match(/<title>\s*([^<|]+)/) || [])[1] || '').trim();
    const covers = [...new Set([...html.matchAll(/https:\/\/c0\.jdbstatic\.com\/covers\/[A-Za-z0-9]+\/[A-Za-z0-9]+\.jpg/g)])];
    return {
      name,
      cover: covers[0] || '',
      covers,
      videoCount: (strip(html).match(/(\d+)\s*部影片/) || [])[1] || '',
      url: BASE + href
    };
  }
}

// ---- Japanese Wikipedia: the only reachable source for measurements ----------
// JavDB dropped the body-measurement block; the ja.wiki infobox still carries
// 生年月日 / 身長 / スリーサイズ / ブラサイズ for most well-known actresses.
const WIKI_UA = 'JavShelf/1.2 (personal library manager; run locally)';

// The body-measurement block is published twice on the page: the rendered rows
// (公称サイズ（ 2024年 時点） 身長 / 体重 160 cm / …) and the template's machine-readable tail,
// which wikiPlain() flattens into `身長 : wt : 160 , バスト : wt : 98 , カップ : wt : H ,`.
// The tail is steadier than the rendered row, and a page can carry several 時点 blocks, so both
// are scanned per key and the newest year wins — 取最新时点 is what the reader asks for.
function blocksAfter(flat, marker) {
  const re = new RegExp(marker, 'g');
  const out = [];
  let m;
  while ((m = re.exec(flat))) out.push(flat.slice(m.index, m.index + 420));
  return out;
}

// Pick the block tagged with the latest year; an untagged block still counts (year 0) so a page
// with a single 公称サイズ row parses even when nobody wrote a 時点.
function newestBlock(blocks) {
  let best = '';
  let bestYear = -1;
  for (const b of blocks) {
    const y = Number((b.match(/(\d{4})\s*年/) || [])[1] || 0);
    if (y >= bestYear) {
      bestYear = y;
      best = b;
    }
  }
  return best;
}

function wikiField(block, key) {
  if (!block) return '';
  const m = block.match(new RegExp(key + '\\s*:\\s*wt\\s*:\\s*([^,]*)'));
  return m ? m[1].trim() : '';
}

// Cups are letters. JavDB writes 罩杯, the wiki row writes ブラサイズ, and both sometimes tack on
// the band size (F65, E-65) — keep the letter and let idols.normCup settle the rest.
const cupOf = (v) => (String(v || '').toUpperCase().match(/[A-Z]+/) || [''])[0].slice(0, 2);

function parseWikiInfobox(flat) {
  const out = { page: '', birthDate: '', height: '', bust: '', waist: '', hips: '', cup: '', birthPlace: '', bloodType: '', asOf: '' };
  const machine = newestBlock(blocksAfter(flat, '時点\\s*:\\s*wt\\s*:'));
  const rendered = newestBlock(blocksAfter(flat, '公称サイズ'));
  const from = (key) => wikiField(machine, key) || wikiField(rendered, key);
  out.asOf = (from('時点').match(/\d{4}/) || [])[0] || (rendered.match(/[（(]\s*(\d{4})\s*年/) || [])[1] || '';
  out.height = (from('身長').match(/\d{2,3}(?:\.\d)?/) || [])[0] || '';
  out.bust = (from('バスト').match(/\d{2,3}(?:\.\d)?/) || [])[0] || '';
  out.waist = (from('ウエスト').match(/\d{2,3}(?:\.\d)?/) || [])[0] || '';
  out.hips = (from('ヒップ').match(/\d{2,3}(?:\.\d)?/) || [])[0] || '';
  out.cup = cupOf(from('カップ')) || cupOf((rendered.match(/ブラサイズ\s*([^\s,]{1,6})/) || [])[1]);
  if (!out.height) out.height = (rendered.match(/身長\s*\/\s*体重\s*(\d{2,3})\s*cm/) || [])[1] || '';
  // The infobox repeats the measurements in an imperial block right after the metric one, so the
  // unit is required — bare numbers return 35-25-36 inches as if they were centimetres.
  if (!out.bust) {
    const th = rendered.match(/スリーサイズ[^0-9]{0,10}(\d{2,3})(?:\.\d)?\s*-\s*(\d{2,3})(?:\.\d)?\s*-\s*(\d{2,3})(?:\.\d)?\s*cm/);
    if (th) {
      out.bust = th[1];
      out.waist = th[2];
      out.hips = th[3];
    }
  }
  const bd = flat.match(/生年月日[^\d]{0,8}([12]\d{3})年.{0,12}?(\d{1,2})月\s*(\d{1,2})日/);
  if (bd) out.birthDate = `${bd[1]}-${String(bd[2]).padStart(2, '0')}-${String(bd[3]).padStart(2, '0')}`;
  // 出身地 reads `出身地 : wt : ・愛知県豊橋市` in the machine tail and `出身地 日本 ・ 愛知県 豊橋市`
  // in the rendered row, with footnote markers sprinkled through both — and in neither case is it
  // a name, which is why it gets its own field here instead of 中文名.
  const placeCandidates = [
    (flat.match(/出身地\s*:\s*wt\s*:\s*([^,]*)/) || [])[1] || '',
    (flat.match(/出身地\s+([^,]{2,28}?)(?=\s+(?:血液型|生年月日|現年齢|デビュー|活動|公称サイズ|瞳|身長)|\s*$)/) || [])[1] || ''
  ];
  for (const c of placeCandidates) {
    const v = String(c)
      .replace(/\[\s*\d+[a-z]?\s*\]/g, ' ')
      .replace(/^日本\s*[・,，]?\s*/, '')
      .replace(/[（(].*$/, '')
      .replace(/^[・,，\s]+/, '')
      .replace(/\s+/g, '')
      .trim();
    // A place in this infobox is written in kanji; anything carrying latin letters or colons is a
    // template fragment that leaked through, not an address.
    if (!v || /[a-z:]/i.test(v)) continue;
    if (/(?:都|道|府|県|市|区|町|村)/.test(v) || /^[一-鿿々ー・]{2,8}$/.test(v)) {
      out.birthPlace = v;
      break;
    }
  }
  const bl = flat.match(/血液型\s*([ABOAB]{1,2})型/) || [];
  out.bloodType = bl[1] ? bl[1] + '型' : '';
  return out;
}

// The REST HTML still carries {{template}} and [[link]] markup inside the infobox, so the
// text is flattened before matching rather than regexed in place.
function wikiPlain(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{\{[^{}]*\}\}/g, ' ')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/[{}"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function wikiActress(name, proxy) {
  const agent = normalizeProxy(proxy) ? new ProxyAgent({ uri: normalizeProxy(proxy), headersTimeout: 25000, bodyTimeout: 25000, connections: 1 }) : null;
  // ja.wikipedia answers 429 + Retry-After once the requests come faster than a reader clicking
  // around; without honouring it a directory crawl reports "no page" for everyone past the
  // eighth name, which looks like missing data rather than a throttled client. 404 is a real
  // answer (no such article) and goes straight to the search fallback.
  const grab = async (url) => {
    let last = { status: 0, text: '' };
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await undiciFetch(url, { dispatcher: agent || undefined, redirect: 'follow', headers: { 'user-agent': WIKI_UA, 'accept-language': 'ja,en;q=0.8' } });
        const text = await r.text();
        if (r.status === 200 || r.status === 404) return { status: r.status, text };
        last = { status: r.status, text };
        await new Promise((res) => setTimeout(res, Math.min(8000, Math.max(1500, Number(r.headers.get('retry-after') || 0) * 1000 + 500))));
      } catch (e) {
        last = { status: 0, text: String((e && e.message) || e) };
        await new Promise((res) => setTimeout(res, 1500));
      }
    }
    return last;
  };
  const want = String(name || '').trim();
  if (!want) return null;
  try {
    let page = '';
    let resolved = want;
    const direct = await grab('https://ja.wikipedia.org/api/rest_v1/page/html/' + encodeURIComponent(want)).catch(() => null);
    if (direct && direct.status === 200) {
      page = direct.text;
    } else {
      // A bare title hit can land on a novel or a fruit (檸檬 -> 檸檬 (小説)), so the search
      // asks for 女優 alongside the name and prefers an exact title.
      const s = await grab(
        'https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
          encodeURIComponent(want + ' 女優') +
          '&srsort=relevance&format=json&srlimit=8'
      ).catch(() => null);
      if (!s || s.status !== 200) return null;
      let hits = [];
      try {
        hits = (JSON.parse(s.text).query || {}).search || [];
      } catch {
        return null;
      }
      const hit =
        hits.find((h) => h.title === want) ||
        hits.find((h) => /AV女優|アダルト|グラビア|タレント/.test(String(h.snippet || ''))) ||
        hits[0];
      if (!hit) return null;
      resolved = hit.title;
      const h = await grab('https://ja.wikipedia.org/api/rest_v1/page/html/' + encodeURIComponent(resolved));
      if (h.status !== 200) return null;
      page = h.text;
    }
    const out = parseWikiInfobox(wikiPlain(page));
    out.page = resolved;
    return out.birthDate || out.height || out.bust ? out : null;
  } finally {
    if (agent && agent.close) agent.close().catch(() => {});
  }
}

// Avatars live on a CDN that only answers through the proxy, same as everything else here.
async function fetchImage(url, proxy) {
  const p = normalizeProxy(proxy);
  const agent = p ? new ProxyAgent({ uri: p, headersTimeout: 30000, bodyTimeout: 30000, connections: 2 }) : null;
  try {
    const r = await undiciFetch(url, { dispatcher: agent || undefined, headers: { 'user-agent': UA } });
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    if (agent && agent.close) agent.close().catch(() => {});
  }
}

module.exports = { JavDB, wikiActress, parseWikiInfobox, strip, BASE, fetchImage, parseActorRef, avatarFor };
