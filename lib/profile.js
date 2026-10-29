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
const { GAMES } = require('./games');

const BEPINEX = 'denikson-BepInExPack_Valheim';
// Enshrouded Mod Loader: its proxy dbghelp.dll from the GitHub releases (https://github.com/Brabb3l/kfc-parser);
// EML loads every <game>/mods/<mod-id>/ that has a mod.json (Lua mods, src/mod.lua)
const EML = 'eml-loader';
const EML_REPO = 'Brabb3l/kfc-parser';
const EML_FILES = ['dbghelp.dll'];
// EML reads the game's data file (.kfc), whose first 4 bytes name its format. Each EML release knows the formats of its
// time: Enshrouded 1.0 (2026-10-15) moved to KFC4, which EML 0.1.2 cannot open - it then stops the game (and the
// dedicated server) with "Fatal error ... Failed to create AppState". Releases not listed here are newer and assumed
// to know the newer formats.
const EML_KFC = { 'v0.1.0': ['KFC3'], 'v0.1.1': ['KFC3'], 'v0.1.2': ['KFC3'] };
const emlSupports = (ver, magic) => !magic || !EML_KFC[ver] || EML_KFC[ver].includes(magic);
function kfcMagic(file) {
  try { const fd = fs.openSync(file, 'r'), b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd); return b.toString('latin1'); } catch { return null; }
}
const VALHEIM_APPID = GAMES.valheim.appId;
const LINUX = process.platform === 'linux';
const isGameDir = (g, gd = GAMES.valheim) => !!g && gd.exe.some(x => fs.existsSync(path.join(g, x)));
// Linux: the native build (BepInEx through LD_PRELOAD) or the Windows build under Proton (winhttp.dll proxy, like Windows)
// (Enshrouded has only the Windows build)
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
function findGameLinux(gd = GAMES.valheim) {
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
      const g = path.join(l, 'steamapps', 'common', gd.folder);
      if (fs.existsSync(path.join(l, 'steamapps', `appmanifest_${gd.appId}.acf`)) && isGameDir(g, gd)) return { game: g, steam: root.dir, steamCmd: root.cmd };
    }
  }
  return { game: null, steam: first?.dir || null, steamCmd: first?.cmd || ['steam'] };
}
// Proton only loads a proxy DLL (winhttp.dll / dbghelp.dll) from the game folder when the prefix says so (what
// r2modman does too; EML's docs ask for WINEDLLOVERRIDES="dbghelp=native,builtin", the same thing)
function protonOverride(game, appId = VALHEIM_APPID, dll = 'winhttp', name = 'Valheim') {
  const reg = path.resolve(game, '..', '..', 'compatdata', appId, 'pfx', 'user.reg');
  if (!fs.existsSync(reg)) throw new Error(`${name} runs through Proton but has never started yet: start it once from Steam, close it, then press PLAY.`);
  let s = fs.readFileSync(reg, 'utf8');
  const line = `"${dll}"="native,builtin"`;
  const m = s.match(/^\[Software\\\\Wine\\\\DllOverrides\][^\n]*\n/m);
  if (!m) s += `\n[Software\\\\Wine\\\\DllOverrides] ${Math.floor(Date.now() / 1000)}\n${line}\n`;
  else {
    const start = m.index + m[0].length, next = s.indexOf('\n[', start), end = next < 0 ? s.length : next;
    const sec = s.slice(start, end);
    if (sec.split('\n').includes(line)) return;
    const re = new RegExp(`^"${dll}"=.*$`, 'm');
    const nsec = re.test(sec) ? sec.replace(re, line) : sec.replace(/^(#time=.*\n)?/, `$1${line}\n`);
    s = s.slice(0, start) + nsec + s.slice(end);
  }
  fs.writeFileSync(reg, s);
}

const rmrf = p => fs.rmSync(p, { recursive: true, force: true });
// a junction's target (Windows may give it as \\?\C:\...)
const readLink = p => fs.readlinkSync(p).replace(/^\\\\\?\\/, '');
// a junction / symlink itself, never what it points to (Electron 44's Node: fs.rmSync on a junction throws
// ERR_FS_EISDIR "Path is a directory" - PLAY on a server that switched to Enshrouded Patcher, 2026-10-29)
const unlinkLink = p => { try { fs.unlinkSync(p); } catch (e) { if (e.code === 'ENOENT') return; fs.rmdirSync(p); } };
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}
// EML stops the whole game (or server) with a "Fatal error" box when one mod.json is wrong, so a bad one is refused at
// install time: id (lowercase letter first, then a-z 0-9 - _), name, a semver version (crates/mod-loader-base manifest.rs)
function checkEmlManifests(tmp, rels) {
  const ids = [];
  for (const rel of rels.filter(r => r.split('/').pop().toLowerCase() === 'mod.json')) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(tmp, ...rel.split('/')), 'utf8').replace(/^﻿/, '')); }
    catch (e) { throw new Error(`${rel} is not valid JSON (${e.message}) - EML would refuse to start the game with it`); }
    const bad = [!/^[a-z][a-z0-9_-]*$/.test(m?.id || '') && `id "${m?.id ?? ''}"`, !m?.name && 'name',
      !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(String(m?.version ?? '')) && `version "${m?.version ?? ''}" (must be like 1.2.3)`].filter(Boolean);
    if (bad.length) throw new Error(`${rel} has a bad ${bad.join(', ')} - EML would refuse to start the game with it`);
    ids.push(m.id);
  }
  return ids;
}
const cmpVer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const splitFull = full => { const i = full.indexOf('-'); return { owner: full.slice(0, i), name: full.slice(i + 1) }; };
const parseDep = d => { const m = String(d).match(/^(.+)-(\d+\.\d+\.\d+)$/); return m ? { full: m[1], ver: m[2] } : null; };

class Profile {
  // game: the lib/games.js entry - where mods go (BepInEx/plugins or mods/), how the game folder is prepared and started
  constructor({ dir, cacheDir, fetch, log = () => { }, stateFile, game = GAMES.valheim }) {
    this.dir = dir; this.cacheDir = cacheDir; this.fetch = fetch; this.log = log; this.game = game;
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
    // (no-store: the file itself is the cache - Chromium's HTTP cache would keep a second copy of every mod)
    const r = await this.fetch(url, { cache: 'no-store' });
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
  // EML mods: a folder with mod.json (+ src/mod.lua) goes to mods/<that folder's name> (an archive's mods/ wrapper or a
  // single top folder is skipped; mod.json at the archive's root -> mods/<key>). Several mods in one archive stay apart.
  // Archives with no mod.json are not EML mods (Cheat Engine tables, saves, Shroudtopia DLLs, Reshade presets).
  static emlMap(key) {
    return rels => {
      const roots = rels.filter(r => r.split('/').pop().toLowerCase() === 'mod.json').map(r => r.split('/').slice(0, -1).join('/'));
      if (!roots.length) {
        const what = rels.some(r => /\.ct$/i.test(r)) ? 'a Cheat Engine table' : rels.some(r => /\.dll$/i.test(r)) ? 'a DLL mod (Shroudtopia?) or a patcher'
          : rels.some(r => /(^|\/)[0-9a-f]{8}(_\d+)?$|\.sav$/i.test(r)) ? 'a save file' : 'not an EML mod';
        throw new Error(`This file has no mod.json, so EML cannot load it (${what}) - install it by hand following its page.`);
      }
      // the deepest wrapper first, so a mod inside another mod's folder is not swallowed
      roots.sort((a, b) => b.length - a.length);
      return rel => {
        const root = roots.find(r => r === '' || rel.startsWith(r + '/'));
        if (root === undefined) return null;
        const name = root === '' ? key : root.split('/').pop();
        const inner = root === '' ? rel : rel.slice(root.length + 1);
        return { path: `mods/${name}/${inner}` };
      };
    };
  }
  // EML from GitHub: ver = a release tag or 'latest'. Its DLLs are kept in loader/ and copied next to the game's exe
  // (and the server's, by the sync) - they must not sit in mods/
  async installEml(ver = 'latest', onBytes) {
    const api = `https://api.github.com/repos/${EML_REPO}/releases/${ver === 'latest' ? 'latest' : `tags/${encodeURIComponent(ver)}`}`;
    const r = await this.fetch(api, { cache: 'no-store', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Bifrost' } });
    if (!r.ok) throw new Error(`GitHub ${r.status} (${EML_REPO} ${ver})`);
    const rel = await r.json();
    const tag = rel.tag_name;
    const have = this.packages[EML];
    if (have && have.ver === tag && (have.files || []).every(f => fs.existsSync(path.join(this.dir, ...f.split('/'))))) return { ver: tag, changed: false };
    const files = [];
    for (const name of EML_FILES) {
      const a = (rel.assets || []).find(x => x.name.toLowerCase() === name);
      if (!a) throw new Error(`EML ${tag} has no ${name}`);
      const cached = await this.download(a.browser_download_url, path.join(this.cacheDir, 'github', `eml-${tag}-${name}`), onBytes, a.size);
      const dest = path.join(this.dir, 'loader', name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(cached, dest);
      files.push(`loader/${name}`);
    }
    fs.mkdirSync(path.join(this.dir, 'mods'), { recursive: true });
    this.packages[EML] = { ver: tag, role: have?.role || 'user', source: 'github', repo: EML_REPO, title: 'EML - Enshrouded Mod Loader', deps: [], files, configs: [], size: files.reduce((t, f) => t + fs.statSync(path.join(this.dir, ...f.split('/'))).size, 0), installedAt: Date.now() };
    this.save();
    return { ver: tag, changed: true };
  }
  // the loader's files as { rel (next to the exe), abs (in the profile) }
  loaderFiles() {
    return (this.packages[EML]?.files || []).map(f => ({ rel: f.split('/').pop(), abs: path.join(this.dir, ...f.split('/')) })).filter(f => fs.existsSync(f.abs));
  }
  // the same mod from another store (Thunderstore vs Nexus vs manual): another package already has one of its plugin
  // DLLs (by file name; shared libraries that several mods ship are not counted)
  sameMod(key, rels) {
    const SHARED = /^(0harmony|newtonsoft\.json|yamldotnet|serversync|system\..+|microsoft\..+|mono\..+)\.dll$/i;
    const dlls = new Set(rels.filter(r => /\.dll$/i.test(r)).map(r => r.split('/').pop().toLowerCase()).filter(n => !SHARED.test(n)));
    if (!dlls.size) return null;
    for (const [k, p] of Object.entries(this.packages)) {
      if (k === key) continue;
      const hit = (p.files || []).find(f => /\.dll$/i.test(f) && dlls.has(f.split('/').pop().toLowerCase()));
      if (hit) return { key: k, title: p.title || k, source: p.source, role: p.role, dll: hit.split('/').pop() };
    }
    return null;
  }
  async installZip(key, zip, meta, mapper, dllName) {
    const tmp = await this.unpack(zip, dllName);
    try {
      const rels = walk(tmp);
      // (EML mods often ship a copy of EML itself, dbghelp.dll beside their mods folder: that is the loader, not the
      // mod, and it is not installed - emlMap takes only what is under a mod.json. It made every XHL mod "already
      // installed: EML has the same dbghelp.dll", 2026-10-29)
      const twin = this.sameMod(key, this.game.loader === 'eml' ? rels.filter(r => !EML_FILES.includes(r.split('/').pop().toLowerCase())) : rels);
      if (twin) {
        // a user install of a mod that is already there is refused; something the server's list needs (or a
        // dependency) replaces the user's own copy from the other store; two packages the list itself wants stay
        if (meta.role === 'user') {
          const where = { thunderstore: 'Thunderstore', nexus: 'Nexus Mods', manual: 'instalare manuală' }[twin.source] || twin.source || '';
          throw Object.assign(new Error(`E deja instalat: ${twin.title}${where ? ` (din ${where})` : ''} are același ${twin.dll}. Nu îl pun de două ori.`), { code: 'DUPLICATE', twin: twin.key });
        }
        if (twin.role === 'user' || twin.role === 'recommended') {
          this.log(`  ${twin.title} (${twin.source}) is the same mod as ${meta.title || key} - replacing it`);
          this.remove(twin.key);
        }
      }
      let deps = [];
      if (rels.includes('manifest.json')) { try { deps = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8').replace(/^\uFEFF/, '')).dependencies || []; } catch { } }
      // (two mods with the same EML id stop the game too)
      let emlIds;
      if (this.game.loader === 'eml') {
        emlIds = checkEmlManifests(tmp, rels);
        for (const [k, p] of Object.entries(this.packages)) {
          const same = k !== key && (p.emlIds || []).find(id => emlIds.includes(id));
          // what the server's list needs replaces the player's own copy (as for Valheim's same-DLL rule)
          if (same && meta.role !== 'user' && (p.role === 'user' || p.role === 'recommended')) { this.log(`  ${p.title || k} is the same mod as ${meta.title || key} - replacing it`); this.remove(k); continue; }
          if (same) throw Object.assign(new Error(`${p.title || k} is the same EML mod (id "${same}") - it is installed already.`), { code: 'DUPLICATE', twin: k });
        }
      }
      if (this.packages[key]) this.remove(key, { keepState: true });
      const map = mapper(rels);
      const { files, configs } = this.place(tmp, rels, map);
      if (!files.length) throw new Error('arhiva nu conține nimic de instalat');
      this.packages[key] = { ...meta, deps, files, configs, ...(emlIds ? { emlIds } : {}), installedAt: Date.now() };
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
    const base = this.game.modsDir;
    if (fs.statSync(src).isDirectory()) for (const rel of walk(src)) put(path.join(src, ...rel.split('/')), `${base}/${key}/${rel}`);
    else put(src, `${base}/${key}`);
    if (this.packages[key]) this.remove(key, { keepState: true });
    this.packages[key] = { ...meta, deps: [], files, configs: [], installedAt: Date.now() };
    this.save();
  }
  remove(key, { keepState } = {}) {
    const p = this.packages[key];
    if (!p) return;
    for (const f of p.files || []) { try { fs.rmSync(path.join(this.dir, ...f.split('/')), { force: true }); } catch { } }
    // empty folders left behind (BepInEx/plugins/<Owner-Name>, mods/<mod-id>/src, ...)
    const dirs = new Set((p.files || []).map(f => path.dirname(path.join(this.dir, ...f.split('/')))));
    const top = path.join(this.dir, this.game.loader === 'eml' ? 'mods' : 'BepInEx');
    for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
      let cur = d;
      while (cur.startsWith(top) && cur !== top) {
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
      // a Nexus file is the same file whatever version text was stored with it (older builds stored its file id)
      if (have && have.ver !== d.ver && d.source === 'nexus' && d.fileId && String(have.fileId) === String(d.fileId)) { have.ver = d.ver; dirty = true; }
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
  static async findGame(gd = GAMES.valheim) {
    if (LINUX) return findGameLinux(gd);
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
      if (fs.existsSync(path.join(l, 'steamapps', `appmanifest_${gd.appId}.acf`))) {
        const g = path.join(l, 'steamapps', 'common', gd.folder);
        if (fs.existsSync(path.join(g, gd.exe[0]))) return { game: g, steam: steam || l };
      }
    }
    return { game: null, steam };
  }
  // BepInEx's console window: 'nowarn' (everything but warnings - the mods' harmless warnings only worry people),
  // 'errors', 'off' or 'all'. BepInEx/LogOutput.log always keeps everything. (Steam's own lines such as "Setting
  // breakpad minidump AppID" are written straight to the console by steam_api64.dll and cannot be filtered.)
  // A profile that never ran has no BepInEx.cfg yet: BepInEx keeps these values and adds the rest of its defaults.
  setConsole(mode = 'nowarn') {
    const f = path.join(this.dir, 'BepInEx', 'config', 'BepInEx.cfg');
    const LEVELS = { all: 'Fatal, Error, Warning, Message, Info', nowarn: 'Fatal, Error, Message, Info', errors: 'Fatal, Error' };
    const enabled = String(mode !== 'off'), levels = LEVELS[mode] || LEVELS.nowarn;
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
  // EML: dbghelp.dll next to enshrouded.exe, and <game>/mods is a junction (Linux: symlink) to this profile's mods, so
  // every server keeps its own mods and switching is instant. What was there before (another manager's dbghelp.dll, a
  // real mods folder) goes to bifrost-backup once.
  // can this profile's EML read this game's data file? { ok, ver, magic }
  emlCompat(game) {
    const ver = this.packages[EML]?.ver || null, magic = kfcMagic(path.join(game, 'enshrouded.kfc'));
    return { ok: emlSupports(ver, magic), ver, magic };
  }
  prepareEml(game) {
    // (eml.json set aside while the server used Enshrouded Patcher: back with EML)
    const cfg = path.join(game, 'eml.json');
    if (fs.existsSync(cfg + '.bifrost-off') && !fs.existsSync(cfg)) fs.renameSync(cfg + '.bifrost-off', cfg);
    const loader = this.loaderFiles();
    if (!loader.length) throw new Error('EML is not installed in the profile - press PLAY again (it installs it).');
    // a game version this EML cannot read: the game starts without mods instead of EML's "Fatal error" box
    const compat = this.emlCompat(game);
    if (!compat.ok) {
      for (const f of loader) { const dest = path.join(game, f.rel); if (Profile.isOurs(dest, [f])) fs.rmSync(dest, { force: true }); }
      return { emlOff: compat };
    }
    const proton = gameKind(game) === 'proton';
    if (proton) protonOverride(game, this.game.appId, 'dbghelp', this.game.name);
    const backup = path.join(game, 'bifrost-backup');
    const mods = path.join(game, 'mods'), target = path.join(this.dir, 'mods');
    fs.mkdirSync(target, { recursive: true });
    let link = null;
    try { link = fs.lstatSync(mods).isSymbolicLink() ? readLink(mods) : 'dir'; } catch { }
    if (!fs.existsSync(backup)) {
      const old = [...loader.map(f => f.rel).filter(f => fs.existsSync(path.join(game, f)) && !Profile.isOurs(path.join(game, f), loader)), ...(link === 'dir' ? ['mods'] : [])];
      if (old.length) { fs.mkdirSync(backup, { recursive: true }); for (const i of old) fs.renameSync(path.join(game, i), path.join(backup, i)); if (link === 'dir') link = null; }
    }
    if (link === 'dir') {
      // (a backup from before already exists: this folder came later - kept beside it)
      fs.renameSync(mods, path.join(backup, `mods-${Date.now()}`)); link = null;
    }
    if (link !== null && path.resolve(game, link) !== path.resolve(target)) { unlinkLink(mods); link = null; }
    if (link === null) fs.symlinkSync(target, mods, 'junction');
    for (const f of loader) {
      const dest = path.join(game, f.rel);
      if (!Profile.isOurs(dest, [f])) fs.copyFileSync(f.abs, dest);
    }
  }
  static isOurs(file, loader) {
    try { const st = fs.statSync(file); return loader.some(f => { const a = fs.statSync(f.abs); return a.size === st.size && fs.readFileSync(f.abs).equals(fs.readFileSync(file)); }); } catch { return false; }
  }
  // the doorstop proxy (winhttp.dll) must sit next to valheim.exe; its config points at this profile
  prepareGame(game) {
    if (this.game.loader === 'eml') return this.prepareEml(game);
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
  static restoreGame(game, gd = GAMES.valheim) {
    const backup = path.join(game, 'bifrost-backup');
    if (gd.loader === 'eml') {
      // EML patched the game's data file (keeping the original as <name>.kfc.bak): put the original back too
      let link = false; try { link = fs.lstatSync(path.join(game, 'mods')).isSymbolicLink(); } catch { }
      if (link) unlinkLink(path.join(game, 'mods'));
      for (const f of EML_FILES) rmrf(path.join(game, f));
      // (only a copy of the same format: after a game update the .bak is the OLD game's file - copying it back broke
      // the game; EML makes a new one at its next start)
      const kfc = path.join(game, 'enshrouded.kfc');
      if (fs.existsSync(kfc + '.bak')) { if (kfcMagic(kfc + '.bak') === kfcMagic(kfc)) fs.copyFileSync(kfc + '.bak', kfc); else fs.rmSync(kfc + '.bak', { force: true }); }
      if (fs.existsSync(backup)) { for (const i of fs.readdirSync(backup)) if (!fs.existsSync(path.join(game, i))) fs.renameSync(path.join(backup, i), path.join(game, i)); rmrf(backup); }
      return true;
    }
    if (!fs.existsSync(backup)) return false;
    for (const i of ['winhttp.dll', 'doorstop_libs', '.doorstop_version', 'doorstop_config.ini']) rmrf(path.join(game, i));
    for (const i of fs.readdirSync(backup)) fs.cpSync(path.join(backup, i), path.join(game, i), { recursive: true });
    rmrf(backup);
    return true;
  }
  static gameOwner(game, gd = GAMES.valheim) {
    // who loads mods for this game folder right now: bifrost / another manager / nothing
    if (gd.loader === 'eml') {
      let t = ''; try { if (fs.lstatSync(path.join(game, 'mods')).isSymbolicLink()) t = readLink(path.join(game, "mods")); } catch { }
      if (/[\\/]Bifrost[\\/]profiles?[\\/]/i.test(t) || (t && fs.existsSync(path.join(game, 'dbghelp.dll')))) return { owner: 'bifrost', target: t };
      return { owner: fs.existsSync(path.join(game, 'dbghelp.dll')) || fs.existsSync(path.join(game, 'winmm.dll')) ? 'other' : 'none', target: t };
    }
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
    // EML needs nothing on the command line: Steam starts the game in its folder, the proxy DLL there does the rest
    const eml = this.game.loader === 'eml';
    if (LINUX && eml) {
      const c = g.steamCmd || ['steam'];
      return new Promise((resolve, reject) => {
        const p = spawn(c[0], [...c.slice(1), '-applaunch', this.game.appId, ...extra], { detached: true, stdio: 'ignore' });
        p.once('error', e => reject(new Error(e.code === 'ENOENT' ? `${c[0]} is not found - is Steam installed?` : e.message)));
        p.once('spawn', () => { p.unref(); resolve(); });
      });
    }
    if (LINUX) return this.launchLinux(g, extra);
    const steam = g.steam;
    const exe = path.join(steam, 'steam.exe');
    const args = eml ? ['-applaunch', this.game.appId, ...extra] : ['-applaunch', VALHEIM_APPID, '--doorstop-enabled', 'true', '--doorstop-target-assembly', this.preloader, ...extra];
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
module.exports = { Profile, BEPINEX, EML, EML_REPO, cmpVer, splitFull, parseDep, emlSupports };
