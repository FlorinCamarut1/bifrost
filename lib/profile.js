// A self-managed Valheim mod profile (used in player mode): installs Thunderstore / Nexus packages the same way
// Thunderstore Mod Manager does, keeps track of every file it put there, and launches Valheim with it.
//
// Layout rules (checked against a TMM profile):
//   denikson-BepInExPack_Valheim : BepInExPack_Valheim/*            -> profile root
//   plugins/*, BepInEx/plugins/*, loose files                       -> BepInEx/plugins/<Owner-Name>/
//   config/*, BepInEx/config/*                                      -> BepInEx/config/   (never overwritten)
//   patchers/*, monomod/* (also under BepInEx/)                     -> BepInEx/<kind>/<Owner-Name>/
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { extract } = require('./archive');
const bepcfg = require('./bepcfg');

const BEPINEX = 'denikson-BepInExPack_Valheim';
const VALHEIM_APPID = '892970';
const LINUX = process.platform === 'linux';
const isGameDir = g => !!g && (fs.existsSync(path.join(g, 'valheim.exe')) || fs.existsSync(path.join(g, 'valheim.x86_64')));
// Linux: the native build (BepInEx through LD_PRELOAD) or the Windows build under Proton (winhttp.dll proxy, like Windows)
const gameKind = g => !LINUX ? 'windows' : fs.existsSync(path.join(g, 'valheim.x86_64')) ? 'native' : 'proton';
// a Linux path as Wine/Proton sees it
const winPath = p => 'Z:' + p.replace(/\//g, '\\');

// Steam on Linux: the normal package, its Debian/Snap variants or the Flatpak; each has its own launcher command
function steamRoots() {
  const h = os.homedir();
  return [
    { dir: path.join(h, '.steam', 'steam'), cmd: ['steam'] },
    { dir: path.join(h, '.local', 'share', 'Steam'), cmd: ['steam'] },
    { dir: path.join(h, '.steam', 'debian-installation'), cmd: ['steam'] },
    { dir: path.join(h, 'snap', 'steam', 'common', '.local', 'share', 'Steam'), cmd: ['snap', 'run', 'steam'] },
    { dir: path.join(h, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'), cmd: ['flatpak', 'run', 'com.valvesoftware.Steam'] },
  ];
}
function findGameLinux() {
  let first = null;
  for (const root of steamRoots()) {
    if (!fs.existsSync(root.dir)) continue;
    first = first || root;
    const libs = [root.dir];
    try {
      const vdf = fs.readFileSync(path.join(root.dir, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1]);
    } catch { }
    for (const l of [...new Set(libs)]) {
      const g = path.join(l, 'steamapps', 'common', 'Valheim');
      if (fs.existsSync(path.join(l, 'steamapps', `appmanifest_${VALHEIM_APPID}.acf`)) && isGameDir(g)) return { game: g, steam: root.dir, steamCmd: root.cmd };
    }
  }
  return { game: null, steam: first?.dir || null, steamCmd: first?.cmd || ['steam'] };
}
// Proton only loads winhttp.dll from the game folder when the prefix says so (what r2modman does too)
function protonOverride(game) {
  const reg = path.resolve(game, '..', '..', 'compatdata', VALHEIM_APPID, 'pfx', 'user.reg');
  if (!fs.existsSync(reg)) throw new Error('Valheim rulează prin Proton, dar n-a pornit încă niciodată: pornește-l o dată din Steam, închide-l, apoi apasă JOACĂ.');
  let s = fs.readFileSync(reg, 'utf8');
  const line = '"winhttp"="native,builtin"';
  const m = s.match(/^\[Software\\\\Wine\\\\DllOverrides\][^\n]*\n/m);
  if (!m) s += `\n[Software\\\\Wine\\\\DllOverrides] ${Math.floor(Date.now() / 1000)}\n${line}\n`;
  else {
    const start = m.index + m[0].length, next = s.indexOf('\n[', start), end = next < 0 ? s.length : next;
    const sec = s.slice(start, end);
    if (sec.split('\n').includes(line)) return;
    const nsec = /^"winhttp"=.*$/m.test(sec) ? sec.replace(/^"winhttp"=.*$/m, line) : sec.replace(/^(#time=.*\n)?/, `$1${line}\n`);
    s = s.slice(0, start) + nsec + s.slice(end);
  }
  fs.writeFileSync(reg, s);
}

const rmrf = p => fs.rmSync(p, { recursive: true, force: true });
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
const cmpVer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const splitFull = full => { const i = full.indexOf('-'); return { owner: full.slice(0, i), name: full.slice(i + 1) }; };
const parseDep = d => { const m = String(d).match(/^(.+)-(\d+\.\d+\.\d+)$/); return m ? { full: m[1], ver: m[2] } : null; };

class Profile {
  constructor({ dir, cacheDir, fetch, log = () => { }, stateFile }) {
    this.dir = dir; this.cacheDir = cacheDir; this.fetch = fetch; this.log = log;
    this.stateFile = stateFile || path.join(dir, 'bifrost-profile.json');
    fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(cacheDir, { recursive: true });
    this.state = { packages: {} };
    try { this.state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { }
    if (!this.state.packages) this.state.packages = {};
  }
  save() { fs.writeFileSync(this.stateFile + '.tmp', JSON.stringify(this.state, null, 2)); fs.renameSync(this.stateFile + '.tmp', this.stateFile); }
  get packages() { return this.state.packages; }
  get preloader() { return path.join(this.dir, 'BepInEx', 'core', 'BepInEx.Preloader.dll'); }

  // ---------- download ----------
  async download(url, file, onBytes, expectedSize) {
    if (fs.existsSync(file) && (!expectedSize || fs.statSync(file).size === expectedSize)) return file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const r = await this.fetch(url);
    if (!r.ok) throw new Error(`descărcare ${r.status}: ${url}`);
    const total = +r.headers.get('content-length') || expectedSize || 0;
    const part = file + '.part';
    const out = fs.createWriteStream(part);
    const reader = r.body.getReader();
    let got = 0;
    try {
      for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise(res => out.once('drain', res));
        onBytes && onBytes(got, total);
      }
    } finally { await new Promise(res => out.end(res)); }
    if (total && got !== total) { rmrf(part); throw new Error(`descărcare incompletă (${got}/${total} B)`); }
    fs.renameSync(part, file);
    return file;
  }
  thunderstoreZip(full, ver, onBytes, size) {
    const { owner, name } = splitFull(full);
    return this.download(`https://thunderstore.io/package/download/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${ver}/`,
      path.join(this.cacheDir, 'thunderstore', `${full}-${ver}.zip`), onBytes, size);
  }

  // ---------- install / uninstall ----------
  async unpack(zip, dllName) {
    const tmp = path.join(this.cacheDir, 'tmp', crypto.randomBytes(6).toString('hex'));
    rmrf(tmp); fs.mkdirSync(tmp, { recursive: true });
    await extract(zip, tmp, dllName);
    return tmp;
  }
  place(tmp, rels, mapFn) {
    const files = [], configs = [];
    for (const rel of rels) {
      const dest = mapFn(rel);
      if (!dest) continue;
      const abs = path.join(this.dir, ...dest.path.split('/'));
      if (dest.config && fs.existsSync(abs)) continue;   // keep the player's own config
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(path.join(tmp, ...rel.split('/')), abs);
      (dest.config ? configs : files).push(dest.path);
    }
    return { files, configs };
  }
  static thunderstoreMap(full) {
    if (full === BEPINEX) {
      return rel => {
        const parts = rel.split('/');
        if (parts[0] !== 'BepInExPack_Valheim' || parts.length < 2) return null;
        const p = parts.slice(1).join('/');
        return { path: p, config: /^BepInEx\/config\//.test(p) };
      };
    }
    // like TMM: a known folder (plugins/config/patchers/monomod) at any depth is routed with its sub-structure;
    // files under unknown folders are flattened into BepInEx/plugins/<Owner-Name>/
    return rel => {
      const parts = rel.split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i].toLowerCase(), rest = parts.slice(i + 1).join('/');
        if (seg === 'plugins') return { path: `BepInEx/plugins/${full}/${rest}` };
        if (seg === 'config') return { path: `BepInEx/config/${rest}`, config: true };
        if (seg === 'patchers' || seg === 'monomod') return { path: `BepInEx/${seg}/${full}/${rest}` };
      }
      return { path: `BepInEx/plugins/${full}/${parts[parts.length - 1]}` };
    };
  }
  static nexusMap(folder) {
    // Nexus archives have no standard layout: use BepInEx/ or plugins/ if present, else everything goes into one folder
    return rels => {
      const lower = rels.map(r => r.toLowerCase());
      const bep = lower.map(r => r.split('/').indexOf('bepinex')).find(i => i >= 0);
      const plug = lower.map(r => r.split('/').indexOf('plugins')).find(i => i >= 0);
      // a single top-level folder is just a wrapper
      const tops = new Set(rels.map(r => r.split('/')[0]));
      const strip = tops.size === 1 && rels.every(r => r.includes('/')) ? 1 : 0;
      return rel => {
        const parts = rel.split('/'), lp = parts.map(x => x.toLowerCase());
        const bi = lp.indexOf('bepinex');
        if (bep !== undefined && bi >= 0) {
          const inner = parts.slice(bi + 1), kind = (inner[0] || '').toLowerCase(), rest = inner.slice(1).join('/');
          if (kind === 'config') return { path: `BepInEx/config/${rest}`, config: true };
          if (kind === 'plugins' || kind === 'patchers') return { path: `BepInEx/${kind}/${folder}/${rest}` };
          return null;
        }
        const pi = lp.indexOf('plugins');
        if (plug !== undefined && pi >= 0) return { path: `BepInEx/plugins/${folder}/${parts.slice(pi + 1).join('/')}` };
        if (lp[strip] === 'config' && parts.length > strip + 1) return { path: `BepInEx/config/${parts.slice(strip + 1).join('/')}`, config: true };
        return { path: `BepInEx/plugins/${folder}/${parts.slice(strip).join('/')}` };
      };
    };
  }
  async installZip(key, zip, meta, mapper, dllName) {
    const tmp = await this.unpack(zip, dllName);
    try {
      const rels = walk(tmp);
      let deps = [];
      if (rels.includes('manifest.json')) { try { deps = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8').replace(/^\uFEFF/, '')).dependencies || []; } catch { } }
      if (this.packages[key]) this.remove(key, { keepState: true });
      const map = mapper(rels);
      const { files, configs } = this.place(tmp, rels, map);
      if (!files.length) throw new Error('arhiva nu conține nimic de instalat');
      this.packages[key] = { ...meta, deps, files, configs, installedAt: Date.now() };
      this.save();
      return deps;
    } finally { rmrf(tmp); }
  }
  // copy a folder or a loose .dll from another profile (mods that are not on Thunderstore/Nexus)
  importManual(key, src, meta) {
    const files = [];
    const put = (from, rel) => {
      const abs = path.join(this.dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(from, abs); files.push(rel);
    };
    if (fs.statSync(src).isDirectory()) for (const rel of walk(src)) put(path.join(src, ...rel.split('/')), `BepInEx/plugins/${key}/${rel}`);
    else put(src, `BepInEx/plugins/${key}`);
    if (this.packages[key]) this.remove(key, { keepState: true });
    this.packages[key] = { ...meta, deps: [], files, configs: [], installedAt: Date.now() };
    this.save();
  }
  remove(key, { keepState } = {}) {
    const p = this.packages[key];
    if (!p) return;
    for (const f of p.files || []) { try { fs.rmSync(path.join(this.dir, ...f.split('/')), { force: true }); } catch { } }
    // empty folders left behind (BepInEx/plugins/<Owner-Name>, ...)
    const dirs = new Set((p.files || []).map(f => path.dirname(path.join(this.dir, ...f.split('/')))));
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      let cur = d;
      while (cur.startsWith(path.join(this.dir, 'BepInEx')) && cur !== path.join(this.dir, 'BepInEx')) {
        try { if (fs.readdirSync(cur).length) break; fs.rmdirSync(cur); } catch { break; }
        cur = path.dirname(cur);
      }
    }
    if (!keepState) { delete this.packages[key]; this.save(); }
  }

  // ---------- planning ----------
  // desired: [{ key, full, ver, role, source }]. Returns what has to change; packages the player added stay.
  plan(desired) {
    const want = new Map(desired.map(d => [d.key, d]));
    const install = [], remove = [];
    const rank = { dep: 0, user: 1, recommended: 2, required: 3 };
    let dirty = false;
    for (const d of desired) {
      const have = this.packages[d.key];
      if (!have || have.ver !== d.ver) install.push(d);
      else if ((rank[d.role] || 0) > (rank[have.role] || 0)) { have.role = d.role; dirty = true; }
    }
    // still needed by something else that stays -> keep it as a dependency
    const needed = new Set();
    for (const [k, p] of Object.entries(this.packages)) {
      if (!want.has(k) && (p.role === 'required' || p.role === 'recommended')) continue;
      for (const dep of p.deps || []) { const x = parseDep(dep); if (x) needed.add(x.full); }
    }
    for (const [k, p] of Object.entries(this.packages)) {
      if (want.has(k) || !(p.role === 'required' || p.role === 'recommended')) continue;
      if (needed.has(k)) { p.role = 'dep'; dirty = true; } else remove.push(k);
    }
    if (dirty) this.save();
    return { install, remove };
  }
  // dependencies nobody needs any more
  orphans() {
    const needed = new Set();
    for (const p of Object.values(this.packages)) for (const d of p.deps || []) { const x = parseDep(d); if (x) needed.add(x.full); }
    return Object.entries(this.packages).filter(([k, p]) => p.role === 'dep' && !needed.has(k)).map(([k]) => k);
  }

  // ---------- game folder + launch ----------
  static async findGame() {
    if (LINUX) return findGameLinux();
    const steam = await new Promise(res => execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true },
      (e, out) => res(e ? null : ((out.match(/SteamPath\s+REG_SZ\s+(.+)/) || [])[1] || '').trim().replace(/\//g, '\\'))));
    const libs = [];
    for (const base of [steam, 'C:\\Program Files (x86)\\Steam'].filter(Boolean)) {
      libs.push(base);
      try {
        const vdf = fs.readFileSync(path.join(base, 'steamapps', 'libraryfolders.vdf'), 'utf8');
        for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.push(m[1].replace(/\\\\/g, '\\'));
      } catch { }
    }
    for (const l of [...new Set(libs)]) {
      if (fs.existsSync(path.join(l, 'steamapps', `appmanifest_${VALHEIM_APPID}.acf`))) {
        const g = path.join(l, 'steamapps', 'common', 'Valheim');
        if (fs.existsSync(path.join(g, 'valheim.exe'))) return { game: g, steam: steam || l };
      }
    }
    return { game: null, steam };
  }
  // BepInEx's console window: 'errors' (only errors and fatal ones), 'off' or 'all'. Printing every line to a Windows
  // console is slow and the mods' harmless warnings only worry people; BepInEx/LogOutput.log always keeps everything.
  // A profile that never ran has no BepInEx.cfg yet: BepInEx keeps these values and adds the rest of its defaults.
  setConsole(mode = 'errors') {
    const f = path.join(this.dir, 'BepInEx', 'config', 'BepInEx.cfg');
    const enabled = String(mode !== 'off'), levels = mode === 'all' ? 'Fatal, Error, Warning, Message, Info' : 'Fatal, Error';
    let text = null;
    try { text = fs.readFileSync(f, 'utf8'); } catch { }
    if (text === null) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, `[Logging.Console]\n\nEnabled = ${enabled}\n\nLogLevels = ${levels}\n`);
      return;
    }
    const sec = bepcfg.parse(text).sections.find(s => s.name === 'Logging.Console');
    if (!sec) { fs.writeFileSync(f, text.replace(/\s*$/, `\n\n[Logging.Console]\n\nEnabled = ${enabled}\n\nLogLevels = ${levels}\n`)); return; }
    const changes = [];
    const cur = k => sec.entries.find(e => e.key === k);
    if (cur('Enabled') && cur('Enabled').value !== enabled) changes.push({ section: sec.name, key: 'Enabled', value: enabled });
    if (cur('LogLevels') && mode !== 'off' && cur('LogLevels').value !== levels) changes.push({ section: sec.name, key: 'LogLevels', value: levels });
    if (changes.length) fs.writeFileSync(f, bepcfg.apply(text, changes));
  }
  // the doorstop proxy (winhttp.dll) must sit next to valheim.exe; its config points at this profile
  prepareGame(game) {
    if (!fs.existsSync(this.preloader)) throw new Error('BepInEx nu e instalat în profil');
    // native Linux: nothing goes into the game folder, the profile's start script preloads doorstop
    const kind = gameKind(game);
    if (kind === 'native') return;
    if (kind === 'proton') protonOverride(game);
    const items = ['winhttp.dll', 'doorstop_libs', '.doorstop_version'];
    const backup = path.join(game, 'bifrost-backup');
    if (!fs.existsSync(backup)) {
      const old = [...items, 'doorstop_config.ini'].filter(i => fs.existsSync(path.join(game, i)));
      if (old.length) { fs.mkdirSync(backup, { recursive: true }); for (const i of old) fs.cpSync(path.join(game, i), path.join(backup, i), { recursive: true }); }
    }
    for (const i of items) { const src = path.join(this.dir, i); if (fs.existsSync(src)) fs.cpSync(src, path.join(game, i), { recursive: true, force: true }); }
    let cfg = '';
    try { cfg = fs.readFileSync(path.join(this.dir, 'doorstop_config.ini'), 'utf8'); } catch { cfg = '[General]\nenabled = true\ntarget_assembly=x\n'; }
    cfg = cfg.replace(/^target_assembly\s*=.*$/m, `target_assembly=${kind === 'proton' ? winPath(this.preloader) : this.preloader}`);
    fs.writeFileSync(path.join(game, 'doorstop_config.ini'), cfg);
  }
  // put back what was next to valheim.exe before Bifrost (e.g. Thunderstore Mod Manager / r2modman's loader)
  static restoreGame(game) {
    const backup = path.join(game, 'bifrost-backup');
    if (!fs.existsSync(backup)) return false;
    for (const i of ['winhttp.dll', 'doorstop_libs', '.doorstop_version', 'doorstop_config.ini']) rmrf(path.join(game, i));
    for (const i of fs.readdirSync(backup)) fs.cpSync(path.join(backup, i), path.join(game, i), { recursive: true });
    rmrf(backup);
    return true;
  }
  static gameOwner(game) {
    // who loads mods for this game folder right now: bifrost / another manager / nothing
    if (gameKind(game) === 'native') return { owner: 'native', target: '' };
    try {
      const t = (fs.readFileSync(path.join(game, 'doorstop_config.ini'), 'utf8').match(/^target_assembly\s*=\s*(.*)$/m) || [])[1] || '';
      if (/[\\/]Bifrost[\\/]profiles?[\\/]/i.test(t)) return { owner: 'bifrost', target: t };
      if (/Thunderstore Mod Manager|r2modman/i.test(t)) return { owner: 'tmm', target: t };
      return { owner: fs.existsSync(path.join(game, 'winhttp.dll')) ? 'other' : 'none', target: t };
    } catch { return { owner: 'none', target: '' }; }
  }
  // g = findGame()'s result: { game, steam, steamCmd }
  launch(g, extra = []) {
    if (LINUX) return this.launchLinux(g, extra);
    const steam = g.steam;
    const exe = path.join(steam, 'steam.exe');
    const args = ['-applaunch', VALHEIM_APPID, '--doorstop-enabled', 'true', '--doorstop-target-assembly', this.preloader, ...extra];
    if (fs.existsSync(exe)) spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    else throw new Error('Nu găsesc steam.exe');
  }
  launchLinux(g, extra = []) {
    let cmd, args, opts = { detached: true, stdio: 'ignore' };
    if (gameKind(g.game) === 'native') {
      const script = path.join(this.dir, 'start_game_bepinex.sh');
      if (!fs.existsSync(script)) throw new Error('BepInEx nu e instalat în profil');
      const env = { ...process.env, SteamAppId: VALHEIM_APPID, SteamGameId: VALHEIM_APPID };
      delete env.ELECTRON_RUN_AS_NODE;
      // an AppImage puts its own libraries first - the game must not inherit them
      if (env.APPDIR) for (const k of ['LD_LIBRARY_PATH', 'LD_PRELOAD']) if (env[k]) env[k] = env[k].split(':').filter(p => p && !p.startsWith(env.APPDIR)).join(':');
      cmd = 'sh'; args = [script, path.join(g.game, 'valheim.x86_64'), ...extra]; opts = { ...opts, cwd: g.game, env };
    } else {
      const c = g.steamCmd || ['steam'];
      cmd = c[0]; args = [...c.slice(1), '-applaunch', VALHEIM_APPID, '--doorstop-enabled', 'true', '--doorstop-target-assembly', winPath(this.preloader), ...extra];
    }
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, opts);
      p.once('error', e => reject(new Error(e.code === 'ENOENT' ? `Nu găsesc ${cmd} - e instalat Steam?` : e.message)));
      p.once('spawn', () => { p.unref(); resolve(); });
    });
  }
}

Profile.isGameDir = isGameDir;
module.exports = { Profile, BEPINEX, cmpVer, splitFull, parseDep };
