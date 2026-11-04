// A picture for a Thunderstore mod's tile in Discover. Thunderstore has only a small square icon per mod (Nexus has a
// wide one); many mods show screenshots or a banner in their README, so its pictures are the candidates - badges,
// donate buttons and avatars left out, GitHub "blob" links made raw. The renderer loads them and keeps the first wide
// one. Remembered per mod version, so a README is read once.
const fs = require('fs'), path = require('path');

const SKIP = /shields\.io|badgen\.net|badge|buymeacoffee|ko-fi|patreon|paypal|discord(app)?\.com\/api|avatars\d*\.githubusercontent|gravatar|supporter|button|\.svg(\?|#|$)|thunderstore\.io\/.*icon/i;

function candidates(md, max = 6) {
  const out = [], re = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(String(md || ''))) && out.length < max * 3) {
    let u = (m[1] || m[2] || '').trim();
    if (u.startsWith('//')) u = 'https:' + u;
    if (!/^https:\/\/[^\s"'<>]+$/i.test(u) || SKIP.test(u)) continue;
    // github.com/<o>/<r>/blob/<ref>/<file> -> the file itself
    const gh = u.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/i);
    if (gh) u = `https://raw.githubusercontent.com/${gh[1]}/${gh[2].replace(/\?raw=true$/i, '')}`;
    if (/^https:\/\/imgur\.com\/\w+\.\w+$/i.test(u)) u = u.replace('://imgur.com/', '://i.imgur.com/');
    if (!out.includes(u)) out.push(u);
  }
  // still pictures first (a GIF can be many MB)
  return [...out.filter(u => !/\.gif(\?|$)/i.test(u)), ...out.filter(u => /\.gif(\?|$)/i.test(u))].slice(0, max);
}

class Covers {
  constructor({ file, fetch, readmeUrl }) {
    this.file = file; this.fetch = fetch; this.readmeUrl = readmeUrl;
    try { this.db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.db = {}; }
    this.busy = new Map(); this.waiting = []; this.running = 0; this.saveTimer = null;
  }
  key(p) { return `${p.owner}-${p.name}@${p.ver}`; }
  // { pick } once the renderer chose (null: none fits), else { list } to try
  async get(p) {
    if (![p?.owner, p?.name, p?.ver].every(x => typeof x === 'string' && x && x.length < 200)) throw new Error('bad package');
    const k = this.key(p), have = this.db[k];
    if (have) return have.pick !== undefined ? { pick: have.pick } : { list: have.list };
    if (!this.busy.has(k)) this.busy.set(k, this.slot(() => this.read(p)).then(list => { this.db[k] = { list }; this.save(); return { list }; }).finally(() => this.busy.delete(k)));
    return this.busy.get(k);
  }
  pick(p, url) {
    const k = this.key(p), have = this.db[k];
    if (!have || (url !== null && !(have.list || []).includes(url))) return false;
    // (an older version's entry of the same mod goes)
    const base = `${p.owner}-${p.name}@`;
    for (const o of Object.keys(this.db)) if (o !== k && o.startsWith(base)) delete this.db[o];
    this.db[k] = { pick: url }; this.save(); return true;
  }
  async read(p) {
    const r = await this.fetch(this.readmeUrl(p));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return candidates((await r.json()).markdown);
  }
  // 4 READMEs at a time
  slot(fn) {
    return new Promise((resolve, reject) => {
      const go = () => { this.running++; fn().then(resolve, reject).finally(() => { this.running--; const n = this.waiting.shift(); if (n) n(); }); };
      if (this.running < 4) go(); else this.waiting.push(go);
    });
  }
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.db)); fs.renameSync(this.file + '.tmp', this.file); } catch { }
    }, 2000);
  }
}

module.exports = { candidates, Covers };
