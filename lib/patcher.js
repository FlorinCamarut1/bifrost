// Enshrouded Patcher (Nexus mod 91, by KenUaena): a Windows tool that rewrites the game's .kfc archive (stack sizes,
// skill points, build limits...) with kfc-parser. Its author says it does not work together with EML, so a server
// in patcher mode has no EML (main.js usesPatcher). Bifrost keeps the tool in %APPDATA%\Bifrost\tools, writes its
// config.json (gameDirectory + the server's options) and answers its menu:
//   "Press any key..." -> Enter, "Enter number:" -> 1 Patch Fresh / 2 Repatch, then "N. Exit"
// The tool is interactive; when its menu cannot be driven through a pipe (it wants a real console), it opens in its
// own window with the config already written and the player picks the option there (fallback, see run()).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { extract } = require('./archive');

const MOD_ID = 91;
const EXE = 'enshrouded-patcher.exe';
// the archive is two files: <name>.kfc (the index) and <name>.kfc_resources; the patcher rewrites both
const KFC = { client: 'enshrouded.kfc', server: 'enshrouded_server.kfc' };
const archiveFiles = kind => [KFC[kind], `${KFC[kind]}_resources`];
// the files the patcher refuses to work next to (another loader in the game folder)
const EXTERNAL = ['dbghelp.dll', 'eml.json', 'dinput8.dll'];

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
// the server's options over the tool's own config (new options of a newer tool keep their defaults)
function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : v;
  return out;
}
// a stable hash of the options (key order does not count)
function optionsHash(o) {
  const norm = v => isObj(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, norm(v[k])])) : Array.isArray(v) ? v.map(norm) : v;
  return crypto.createHash('sha1').update(JSON.stringify(norm(o || {}))).digest('hex').slice(0, 16);
}
// what changes when Steam (or the patcher) rewrites an archive of several GB, without reading it
function fingerprint(file) { try { const st = fs.statSync(file); return `${st.size}:${Math.round(st.mtimeMs)}`; } catch { return null; } }
// the whole archive of a game folder (index + resources)
const archivePrint = (dir, kind) => archiveFiles(kind).map(f => fingerprint(path.join(dir, f))).join('|');
function fileSha(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}
const stripAnsi = s => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '\n');

class Patcher {
  // cmd: [program, ...args] instead of the tool's exe (tests drive a stand-in that prints the same menu)
  constructor({ dir, log = () => { }, cmd = null }) { this.dir = dir; this.log = log; this.cmd = cmd; }
  // the installed tool: { fileId, version, path } or null
  current() {
    const c = readJson(path.join(this.dir, 'current.json'));
    return c && fs.existsSync(path.join(c.path, EXE)) ? c : null;
  }
  async install({ archive, fileId, version }) {
    const dest = path.join(this.dir, String(fileId));
    const old = this.current();
    fs.rmSync(dest, { recursive: true, force: true });
    await extract(archive, dest);
    // (some zips wrap everything in one folder)
    let root = dest;
    if (!fs.existsSync(path.join(root, EXE))) {
      const sub = fs.readdirSync(dest).map(n => path.join(dest, n)).find(p => fs.existsSync(path.join(p, EXE)));
      if (!sub) throw new Error(`${EXE} is not in the downloaded file`);
      root = sub;
    }
    // the config (and kfc-parser it fetched) carry over from the previous version
    if (old && old.path !== root) for (const f of ['config.json']) { const p = path.join(old.path, f); if (fs.existsSync(p) && !fs.existsSync(path.join(root, f))) fs.copyFileSync(p, path.join(root, f)); }
    fs.writeFileSync(path.join(this.dir, 'current.json'), JSON.stringify({ fileId, version, path: root }));
    for (const d of fs.readdirSync(this.dir)) if (d !== String(fileId) && /^\d+$/.test(d)) { try { fs.rmSync(path.join(this.dir, d), { recursive: true, force: true }); } catch { } }
    return this.current();
  }
  config() { const c = this.current(); return c ? readJson(path.join(c.path, 'config.json')) : null; }
  writeConfig(gameDir, options) {
    const c = this.current(); if (!c) throw new Error('Enshrouded Patcher is not downloaded');
    const cfg = merge(this.config() || {}, options || {});
    if (gameDir) cfg.gameDirectory = gameDir.replace(/\\/g, '/');
    fs.writeFileSync(path.join(c.path, 'config.json'), JSON.stringify(cfg, null, 2));
    return cfg;
  }
  // the tool's own options (it writes config.json with every default at its first start): start it, leave at the menu
  async defaults(gameDir) {
    const has = () => Object.keys(this.config() || {}).some(k => k !== 'gameDirectory');
    if (!has()) {
      this.writeConfig(gameDir || this.current().path, {});
      const r = await this.drive('exit');
      if (!has() && r.needConsole) { this.log('  the patcher wants its own window: choose Exit there once it shows its menu', 'out'); await this.console(); }
      if (!has()) throw new Error('the patcher did not write its options (config.json)');
    }
    const cfg = this.config() || {};
    delete cfg.gameDirectory;
    return cfg;
  }
  // mode: 'fresh' (the archive is the game's original) | 'repatch' (options changed, the backup is the original) | 'exit'
  // -> { ok, out, console } ; console = it ran in its own window
  async run({ gameDir, options, mode, kind }) {
    const file = path.join(gameDir, KFC[kind]);
    if (!fs.existsSync(file)) throw new Error(`${KFC[kind]} is not in ${gameDir}`);
    const ext = EXTERNAL.filter(f => fs.existsSync(path.join(gameDir, f)));
    if (ext.length) throw new Error(`another mod loader is in the game folder (${ext.join(', ')}) - the patcher refuses to run next to it`);
    this.writeConfig(gameDir, options);
    const before = archivePrint(gameDir, kind);
    let r = await this.drive(mode);
    // (it may stumble on a key prompt only after it patched)
    if (r.needConsole && archivePrint(gameDir, kind) === before) {
      this.log(`  the patcher wants its own window: pick ${mode === 'fresh' ? '1 (Patch Fresh)' : '2 (Repatch)'} there, then Exit`, 'out');
      r = await this.console();
    }
    const changed = archivePrint(gameDir, kind) !== before;
    if (!changed) throw new Error(`the patcher finished but ${KFC[kind]} did not change${r.error ? ` (${r.error})` : ''} - its log is in ${path.join(this.current().path, 'logs')}`);
    return { ok: true, console: !!r.console };
  }
  // its menu through a pipe
  drive(mode) {
    const c = this.current();
    return new Promise(resolve => {
      const [prog, ...args] = this.cmd || [path.join(c.path, EXE)];
      const p = spawn(prog, args, { cwd: c.path, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let all = '', buf = '', chosen = mode === 'exit', settled = false, idle = null;
      const finish = r => { if (settled) return; settled = true; clearTimeout(idle); resolve({ out: all, ...r }); };
      const send = s => { try { p.stdin.write(s); } catch { } };
      // nothing for 20 minutes (unpacking and repacking take a few minutes)
      const alive = () => { clearTimeout(idle); idle = setTimeout(() => { p.kill(); finish({ error: 'no answer for 20 minutes' }); }, 1200e3); };
      alive();
      const onData = d => {
        alive();
        const t = stripAnsi(d.toString());
        all += t; buf += t;
        for (const l of t.split('\n').map(s => s.trim()).filter(Boolean)) this.log(`  patcher: ${l}`, 'out');
        if (/press any key/i.test(buf)) { buf = ''; send('\n'); return; }
        if (/Run\s+(Patch Fresh|Repatch)\s*\?|\(y\/n\)|\[y\/n\]/i.test(buf)) { buf = ''; send('y\n'); return; }
        if (/Enter number:\s*$/i.test(buf)) {
          buf = '';
          if (!chosen) { chosen = true; send(mode === 'fresh' ? '1\n' : '2\n'); return; }
          const exit = [...all.matchAll(/(\d)\.\s*Exit/gi)].pop();
          send(`${exit ? exit[1] : '4'}\n`);
        }
      };
      p.stdout.on('data', onData); p.stderr.on('data', onData);
      p.on('error', e => finish({ error: e.message, needConsole: true }));
      p.on('close', code => {
        // (a menu that reads single keys needs a console: stdin is not one)
        const tty = /setRawMode|isTTY|not a tty|ERR_TTY|raw mode/i.test(all);
        finish({ code, error: code ? `exit code ${code}` : null, needConsole: tty || (!chosen && mode !== 'exit') });
      });
    });
  }
  // its own console window; resolves when it is closed
  console() {
    const c = this.current();
    return new Promise(resolve => {
      const p = spawn('cmd.exe', ['/c', 'start', '"Enshrouded Patcher"', '/wait', EXE], { cwd: c.path, windowsHide: false });
      p.on('error', e => resolve({ console: true, error: e.message }));
      p.on('close', code => resolve({ console: true, code }));
    });
  }
}

module.exports = { Patcher, MOD_ID, EXE, KFC, EXTERNAL, archiveFiles, archivePrint, merge, optionsHash, fingerprint, fileSha };
