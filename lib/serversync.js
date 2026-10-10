// Two-way sync between the admin's Bifrost profile and the Valheim server (over SSH + docker exec):
//   - configs: profile BepInEx/config  <->  /config/valheimplus (the server's BepInEx/config is a symlink to it)
//     3-way: the hash of each file at the last sync says which side changed; both changed -> the newer one wins.
//     Hashes ignore CR, since the server (Linux) rewrites configs with LF.
//   - extras: mods someone put on the server by hand are brought into the profile, then managed by the mod sync.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REMOTE = '/config/valheimplus';
// the server's own BepInEx settings, per-player data and backups never travel
// ... nor runtime data the mods write while playing (saves, season state, logs) - only settings
const SKIP = [/^BepInEx\.cfg(\.default)?$/i, /\.(bak|old|tmp|log|bin|dat)$/i, /^(plugins|patchers)\//i, /^\.synced/,
  /(^|\/)(BountySaves|LastSeasonChangeData)\//i, /(^|\/)configstate\.json$/i];
const safeRel = rel => /^[\w.\- /()+,]+$/.test(rel) && !rel.split('/').includes('..');
const normHash = buf => crypto.createHash('sha256').update(Buffer.from(buf.toString('latin1').replace(/\r/g, ''), 'latin1')).digest('hex');

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

class ServerSync {
  constructor({ server, container, profileDir, stateFile, log }) {
    Object.assign(this, { server, container, profileDir, stateFile, log });
    this.configDir = path.join(profileDir, 'BepInEx', 'config');
  }
  // one ssh call; input = string/Buffer for stdin, binary = return stdout as Buffer
  ssh(cmd, { input, binary, timeout = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', this.server, cmd], { windowsHide: true });
      const out = [], err = [];
      const t = setTimeout(() => p.kill(), timeout);
      p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => err.push(d));
      p.on('error', reject);
      p.on('close', code => {
        clearTimeout(t);
        if (code !== 0) return reject(new Error(Buffer.concat(err).toString().trim().split('\n').pop() || `ssh exit ${code}`));
        const b = Buffer.concat(out); resolve(binary ? b : b.toString());
      });
      if (input !== undefined) p.stdin.end(input); else p.stdin.end();
    });
  }
  exec(script, opts) { return this.ssh(`docker exec -i ${this.container} sh -s`, { ...opts, input: script.replace(/\r/g, '') }); }

  // ---------- configs ----------
  async remoteConfigs() {
    const out = await this.exec(`cd ${REMOTE} 2>/dev/null || exit 0
find . -type f ! -path './plugins/*' ! -path './patchers/*' | while IFS= read -r f; do
  printf '%s|%s|%s\\n' "$(stat -c %Y "$f")" "$(tr -d '\\r' < "$f" | sha256sum | cut -d' ' -f1)" "\${f#./}"
done`);
    const map = {};
    for (const l of out.split('\n')) { const m = l.match(/^(\d+)\|([0-9a-f]{64})\|(.+)$/); if (m) map[m[3]] = { mtime: +m[1] * 1000, hash: m[2] }; }
    return map;
  }
  localConfigs() {
    const map = {};
    for (const rel of walk(this.configDir)) {
      const p = path.join(this.configDir, ...rel.split('/'));
      map[rel] = { mtime: fs.statSync(p).mtimeMs, hash: normHash(fs.readFileSync(p)) };
    }
    return map;
  }
  // sideOf(rels) -> Map rel -> 'server' | 'client': whose mod a config file belongs to (asked only on first contact)
  async syncConfigs({ dryRun, sideOf } = {}) {
    const last = (() => { try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { return {}; } })();
    const [R, L] = [await this.remoteConfigs(), this.localConfigs()];
    const push = [], pull = [], first = [];
    for (const rel of new Set([...Object.keys(R), ...Object.keys(L)])) {
      if (SKIP.some(r => r.test(rel)) || !safeRel(rel)) continue;
      const l = L[rel], r = R[rel], b = last[rel];
      if (l && r && l.hash === r.hash) { last[rel] = l.hash; continue; }
      if (l && !r) { push.push(rel); continue; }
      if (!l && r) { pull.push(rel); continue; }
      if (!b) { first.push(rel); continue; }
      const lc = l.hash !== b, rc = r.hash !== b;
      if (lc && !rc) push.push(rel);
      else if (rc && !lc) pull.push(rel);
      else (l.mtime >= r.mtime ? push : pull).push(rel);   // both changed since the last sync: the newer one wins
    }
    // never synced before and different: the server's values are the ones in force for server mods; a client mod's
    // file on the server is just the default it wrote when it was first loaded there -> the player's copy wins
    if (first.length) {
      const side = sideOf ? await sideOf(first) : new Map();
      for (const rel of first) (side.get(rel) === 'client' ? push : pull).push(rel);
    }
    if (dryRun) return { push, pull, dryRun: true };
    for (const rel of push) {
      const data = fs.readFileSync(path.join(this.configDir, ...rel.split('/')));
      await this.ssh(`docker exec -i ${this.container} sh -c 'mkdir -p "$(dirname "$0")" && cat > "$0"' '${REMOTE}/${rel}'`, { input: data });
      last[rel] = normHash(data);
    }
    for (const rel of pull) {
      const data = await this.ssh(`docker exec ${this.container} cat '${REMOTE}/${rel}'`, { binary: true });
      const p = path.join(this.configDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, data);
      last[rel] = normHash(data);
    }
    fs.writeFileSync(this.stateFile, JSON.stringify(last, null, 1));
    return { push, pull };
  }

  // ---------- mods put on the server by hand ----------
  async remotePlugins() {
    const out = await this.exec(`ls -1 ${REMOTE}/plugins 2>/dev/null || true`);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  }
  async fetchPlugin(name, destDir) {
    // the folder (or loose .dll) as a tar, unpacked with the bundled 7-Zip
    if (!safeRel(name) || name.includes('/')) throw new Error(`nume ciudat pe server: ${name}`);
    const tar = await this.ssh(`docker exec ${this.container} tar -cf - -C ${REMOTE}/plugins '${name}'`, { binary: true, timeout: 300000 });
    fs.mkdirSync(destDir, { recursive: true });
    const file = path.join(destDir, 'plugin.tar');
    fs.writeFileSync(file, tar);
    await require('./archive').extract(file, destDir);
    fs.rmSync(file, { force: true });
    return path.join(destDir, name);
  }
  removeRemotePlugin(name) {
    if (!safeRel(name) || name.includes('/')) throw new Error(`nume ciudat pe server: ${name}`);
    return this.ssh(`docker exec ${this.container} rm -rf -- '${REMOTE}/plugins/${name}'`);
  }
}

module.exports = { ServerSync, SKIP };
