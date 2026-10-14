// Where a server keeps its mods and configs, and how Bifrost talks to it.
//   ssh-docker : Linux host over SSH, Valheim in a Docker container (paths are inside the container)
//   ssh        : Linux host over SSH, plain folders
//   local      : folders on this PC (server on the same machine)
//   ftp        : FTP / FTPS (rented servers); no restart, no hashes on the server side
// Every transport: list(dir), hashes(dir, {normalize}), put(dir, files), remove(dir, names), read(dir, rel), pull(dir, name)
// Optional: restart(), isIdle(), status() for transports that can see the server process.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const tar = require('./tar');

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const normSha = buf => sha(Buffer.from(buf.toString('latin1').replace(/\r/g, ''), 'latin1'));
// a file's sha256, remembered by size + mtime (hundreds of MB of DLLs get hashed once, not at every sync) and read
// as a stream, so the app keeps answering while a big one is hashed
const hashCache = new Map();
const remoteHashCache = new Map();   // server + folder -> Map(rel -> { t: mtime, s: size, h: sha256 })
async function fileSha(abs) {
  const st = await fs.promises.stat(abs);
  const c = hashCache.get(abs);
  if (c && c.size === st.size && c.mtime === st.mtimeMs) return c.hash;
  const hash = await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(abs).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
  hashCache.set(abs, { size: st.size, mtime: st.mtimeMs, hash });
  return hash;
}
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;   // POSIX single quotes
const safeName = s => /^[^/\\\0]+$/.test(s) && s !== '.' && s !== '..';
const safeRel = s => s.split('/').every(safeName);

function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

// ---------- shell over ssh (with or without docker exec) ----------
class ShellTransport {
  constructor(conn, game = 'valheim') {
    this.conn = conn; this.game = game;
    this.docker = conn.type === 'ssh-docker';
    // the valheim-server image (supervisord, valheim-is-idle, ValheimPlus folders) - other games' containers are only
    // started / stopped / restarted
    this.valheimImage = this.docker && game === 'valheim';
    serverPaths(this, conn, game, this.valheimImage ? ['/config/valheimplus/plugins', '/config/valheimplus'] : ['', '']);
    this.canRestart = this.docker || !!conn.restartCmd;
  }
  label() { return this.docker ? `${this.conn.host} (docker ${this.conn.container})` : this.conn.host; }
  ssh(cmd, { input, binary, timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
      const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
      if (this.conn.port) args.push('-p', String(this.conn.port));
      if (this.conn.keyFile) args.push('-i', this.conn.keyFile);
      const p = spawn('ssh', [...args, this.conn.host, cmd], { windowsHide: true });
      const out = [], err = [];
      const t = setTimeout(() => p.kill(), timeout);
      p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => err.push(d));
      p.on('error', e => { clearTimeout(t); reject(new Error(`ssh: ${e.message}`)); });
      p.on('close', code => {
        clearTimeout(t);
        if (code !== 0) return reject(new Error(Buffer.concat(err).toString().trim().split('\n').pop() || `ssh exit ${code}`));
        const b = Buffer.concat(out); resolve(binary ? b : b.toString());
      });
      if (input !== undefined) p.stdin.end(input); else p.stdin.end();
    });
  }
  // a shell script on the server (inside the container for ssh-docker); data, if any, comes on stdin after it
  run(script, opts = {}) {
    // base64 so no quoting survives two shells; eval keeps stdin free for data and needs no temp file
    const b64 = Buffer.from(script.replace(/\r/g, '')).toString('base64');
    const inner = `sh -c ${q(`eval "$(echo ${b64} | base64 -d)"`)}`;
    return this.ssh(this.docker ? `docker exec -i ${q(this.conn.container)} ${inner}` : inner, opts);
  }
  async test() {
    if (!this.configDir) { const out = await this.run(`echo ok; [ -d ${q(this.pluginsDir)} ] && echo plugins; true`); return { ok: /ok/.test(out), plugins: /plugins/.test(out), config: true }; }
    const out = await this.run(`echo ok; [ -d ${q(this.pluginsDir)} ] && echo plugins; [ -d ${q(this.configDir)} ] && echo config; true`);
    return { ok: /ok/.test(out), plugins: /plugins/.test(out), config: /config/.test(out) };
  }
  async list(dir) {
    const out = await this.run(`ls -1A ${q(dir)} 2>/dev/null || true`);
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  }
  // the server's files: one listing (mtime + size) every time; sha256 only for files that are new or changed since the
  // last look (re-hashing 700 MB of DLLs on the server took seconds at every sync)
  async hashes(dir, { normalize, skipDirs = [] } = {}) {
    const prune = skipDirs.map(d => `! -path ${q(`./${d}/*`)}`).join(' ');
    const key = [this.conn.host, this.conn.container || '', dir, normalize ? 'n' : ''].join('|');
    const known = remoteHashCache.get(key) || new Map();
    const listing = await this.run(`cd ${q(dir)} 2>/dev/null || exit 0
find . -type f ${prune} -printf '%T@|%s|%P\\n'`);
    const files = [];
    for (const l of listing.split('\n')) { const m = l.match(/^([\d.]+)\|(\d+)\|(.+)$/); if (m) files.push({ t: m[1], s: +m[2], rel: m[3] }); }
    const need = files.filter(f => { const k = known.get(f.rel); return !k || k.t !== f.t || k.s !== f.s; });
    if (need.length) {
      const sum = normalize ? `tr -d '\\r' < "$f" | sha256sum` : `sha256sum < "$f"`;
      const out = await this.run(`cd ${q(dir)} 2>/dev/null || exit 0
while IFS= read -r f; do [ -f "$f" ] && printf '%s|%s\\n' "$(${sum} | cut -d' ' -f1)" "$f"; done`, { input: need.map(f => f.rel).join('\n') + '\n' });
      const byRel = new Map(need.map(f => [f.rel, f]));
      for (const l of out.split('\n')) { const m = l.match(/^([0-9a-f]{64})\|(.+)$/); const f = m && byRel.get(m[2]); if (f) known.set(f.rel, { t: f.t, s: f.s, h: m[1] }); }
    }
    const map = {}, seen = new Set();
    for (const f of files) { const k = known.get(f.rel); seen.add(f.rel); if (k && k.t === f.t && k.s === f.s) map[f.rel] = { mtime: Math.round(+f.t * 1000), hash: k.h }; }
    for (const rel of [...known.keys()]) if (!seen.has(rel)) known.delete(rel);
    remoteHashCache.set(key, known);
    return map;
  }
  async put(dir, files) {
    if (!files.length) return;
    for (const f of files) if (!safeRel(f.name)) throw new Error(`nume ciudat: ${f.name}`);
    await this.run(`mkdir -p ${q(dir)} && tar -xf - -C ${q(dir)}`, { input: tar.pack(files), timeout: 600000 });
  }
  async remove(dir, names) {
    if (!names.length) return;
    for (const n of names) if (!safeRel(n)) throw new Error(`nume ciudat: ${n}`);
    await this.run(`cd ${q(dir)} && rm -rf -- ${names.map(q).join(' ')}`);
  }
  async read(dir, rel) {
    if (!safeRel(rel)) throw new Error(`nume ciudat: ${rel}`);
    return this.run(`cat ${q(`${dir}/${rel}`)}`, { binary: true });
  }
  async pull(dir, name) {
    if (!safeName(name)) throw new Error(`nume ciudat: ${name}`);
    return tar.unpack(await this.run(`tar -cf - -C ${q(dir)} ${q(name)}`, { binary: true, timeout: 600000 }));
  }
  // ----- process control -----
  async restart() {
    if (this.docker) return this.ssh(`docker restart ${q(this.conn.container)}`, { timeout: 300000 });
    if (this.conn.restartCmd) return this.ssh(this.conn.restartCmd, { timeout: 300000 });
    throw new Error('serverul nu poate fi repornit de aici');
  }
  // valheim-server image: its start copies /config/<mod>/plugins into the game; doing just that and restarting the game
  // process skips the container restart and its Steam update check. false = not possible here (use restart())
  async reloadModsAndRestartGame() {
    if (!this.valheimImage) return false;
    const out = await this.run(`command -v bash >/dev/null 2>&1 || { echo NOFAST; exit 0; }
bash -c '
[ -f /usr/local/etc/valheim/common ] || { echo NOFAST; exit 0; }
[ -f /usr/local/etc/valheim/defaults ] && . /usr/local/etc/valheim/defaults
. /usr/local/etc/valheim/common
type -t write_bepinex_config >/dev/null || { echo NOFAST; exit 0; }
if [ "$VALHEIM_PLUS" = true ] && [ -d "$vp_config_path" ]; then write_bepinex_config "$vp_config_path" "$vp_install_path/BepInEx" >/dev/null 2>&1
elif [ "$BEPINEX" = true ] && [ -d "$bepinex_config_path" ]; then write_bepinex_config "$bepinex_config_path" "$bepinex_install_path/BepInEx" >/dev/null 2>&1
else echo NOFAST; exit 0; fi
echo SYNCED'`, { timeout: 120000 });
    if (!/SYNCED/.test(out)) return false;
    await this.gentleGameRestart();
    return true;
  }
  // the compose project the container belongs to (labels docker compose puts on it)
  async composeInfo() {
    if (!this.docker) return null;
    const out = await this.ssh(`docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}|{{index .Config.Labels "com.docker.compose.service"}}' ${q(this.conn.container)}`);
    const [workdir, files, service] = out.trim().split('|');
    if (!workdir || !files || !service) return null;
    return { workdir, files: files.split(',').filter(Boolean), service };
  }
  hostRead(file) { return this.ssh(`cat ${q(file)}`); }
  // a copy next to it first (name.bak-YYYYMMDD-HHMMSS), then the new content
  hostWriteWithBackup(file, text) {
    return this.ssh(`f=${q(file)}; cp -p "$f" "$f.bak-$(date +%Y%m%d-%H%M%S)" && cat > "$f"`, { input: text });
  }
  // new env values only reach the game when the container is recreated
  composeUp(info) {
    return this.ssh(`cd ${q(info.workdir)} && docker compose ${info.files.map(f => `-f ${q(f)}`).join(' ')} up -d ${q(info.service)}`, { timeout: 300000 });
  }
  stopGame() { return this.valheimImage ? this.ssh(`docker exec ${q(this.conn.container)} supervisorctl stop valheim-server`) : Promise.resolve(); }
  // ("already started" is fine: the image's updater may have started it meanwhile)
  startGame() { return this.valheimImage ? this.ssh(`docker exec ${q(this.conn.container)} supervisorctl start valheim-server || true`) : this.restart(); }
  async restartGame() {
    if (!this.valheimImage) return this.restart();
    return this.gentleGameRestart();
  }
  // stop, 30 s pause, start: an instant restart left the previous PlayFab lobby with the same join code behind, and
  // the new session's join code check then crashed (2026-10-11)
  gentleGameRestart() {
    const c = q(this.conn.container);
    return this.ssh(`docker exec ${c} supervisorctl stop valheim-server; sleep 30; docker exec ${c} supervisorctl start valheim-server || true`, { timeout: 180000 });
  }
  async isIdle() {
    if (!this.valheimImage) return null;   // unknown -> the caller asks the Steam query
    const out = await this.ssh(`docker exec ${q(this.conn.container)} valheim-is-idle >/dev/null 2>&1 && echo idle || echo busy`);
    return out.includes('idle');
  }
  // the valheim-server image logs: join code, players, character names
  async status() {
    if (!this.docker) return null;
    const c = q(this.conn.container);
    // another game's container: running or not; players come from the Steam query (main.js pollStatus)
    if (!this.valheimImage) return parseDockerStatus(await this.ssh(`echo "STATE|$(docker inspect -f '{{.State.Status}}|{{.State.StartedAt}}' ${c} 2>/dev/null || echo 'missing|')"`, { timeout: 30000 }));
    const out = await this.ssh(`st=$(docker inspect -f '{{.State.Status}}|{{.State.StartedAt}}' ${c} 2>/dev/null || echo 'missing|'); echo "STATE|$st"
case "$st" in running*)
  docker logs --since "\${st#*|}" ${c} 2>&1 | grep -E 'is active with|now [0-9]+ player|Got character ZDOID from|Connections [0-9]+ ZDOS|OnCheckJoinCodeSuccess|Game server connected|registered with join code|Server: New peer connected|Destroying abandoned non persistent zdo -?[0-9]+:[0-9]+ owner|Adding peer \\(|disconnected, removing from validated list|New session server|received local Platform ID' | tail -1500 | sed 's/^/LOG|/'
;; esac`, { timeout: 30000 });
    // (no valheim-is-idle here: it watches network traffic for ~3 s; the player count comes from the logs, and the
    // restart decision still asks isIdle())
    return parseDockerStatus(out);
  }
  async logsSince(sinceSec) {
    if (!this.valheimImage) return '';
    return this.ssh(`docker logs --since ${sinceSec} ${q(this.conn.container)} 2>&1 | grep -E 'is active with|OnCheckJoinCodeSuccess|valheim-server: started' || true`);
  }
}

function parseDockerStatus(out) {
  const s = { reachable: true, checkedAt: Date.now() };
  const logLines = [];
  for (const l of out.split('\n')) {
    if (l.startsWith('STATE|')) { const [, st, at] = l.trim().split('|'); s.container = st; s.startedAt = at ? Date.parse(at) : null; }
    else if (l.startsWith('IDLE|')) s.idle = l.trim().endsWith('1');
    else if (l.startsWith('LOG|')) logLines.push(l.slice(4));
  }
  const when = l => { const m = l.match(/(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d):(\d\d)/); return m ? new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]).getTime() : null; };
  let lastActive = -1, lastBad = -1;
  const seen = {};
  // who is on. Valheim's own counters are not reliable: the session's "now N player(s)" lags or is wrong (it
  // never said 0 after the last leave), "Destroying abandoned ... owner <id>" is missing for some leaves, and a
  // character gets a new id at every join. The ServerSync library (used by Warfare, Armory, Monstrum, ...) logs
  // every peer with its stable platform id: "Adding peer (Steam_X) to validated list" / "Peer (Steam_X)
  // disconnected" (about 90 s after leaving, when the server stops waiting for a reconnect). A game restart
  // ("New session server") empties the server. Names: "received local Platform ID Steam_X", then that peer's
  // "Got character ZDOID from <name>". Without ServerSync mods: characters by join line / abandoned zdo.
  const peers = new Set(), names = new Map(), chars = new Map();
  let syncSeen = false, pendingPlatform = null, changedAt = -1, conn = null, connAt = -1, sessionCount = null;
  logLines.forEach((l, i) => {
    let m;
    if ((m = l.match(/with join code (\d+) and IP (\S+) is active with (\d+) player/))) { s.joinCode = m[1]; s.publicIp = m[2]; s.joinCodeAt = when(l); lastActive = i; }
    if (/New session server/.test(l)) { peers.clear(); chars.clear(); changedAt = i; }
    if ((m = l.match(/(?:now|with) (\d+) player\(s\)/))) sessionCount = +m[1];
    if ((m = l.match(/Connections (\d+) ZDOS/))) { conn = +m[1]; connAt = i; if (conn === 0) { peers.clear(); chars.clear(); } s.playersAt = when(l); }
    if ((m = l.match(/received local Platform ID (\S+)/))) pendingPlatform = m[1];
    if ((m = l.match(/Adding peer \((\S+)\) to validated list/))) { syncSeen = true; if (!peers.has(m[1])) { peers.add(m[1]); changedAt = i; s.playersAt = when(l); } }
    if ((m = l.match(/Peer \((\S+)\) disconnected, removing from validated list/))) { syncSeen = true; if (peers.delete(m[1])) { changedAt = i; s.playersAt = when(l); } }
    if ((m = l.match(/Got character ZDOID from (.+?) : (-?\d+):(\d+)/)) && m[2] !== '0') {
      seen[m[1]] = when(l);
      if (pendingPlatform) { names.set(pendingPlatform, m[1]); pendingPlatform = null; }
      for (const [id, n] of chars) if (n === m[1]) chars.delete(id);   // the same player again, with a new id
      chars.set(m[2], m[1]); changedAt = i; s.playersAt = when(l);
    }
    if ((m = l.match(/Destroying abandoned non persistent zdo -?\d+:\d+ owner (-?\d+)/)) && chars.delete(m[1])) { changedAt = i; s.playersAt = when(l); }
    if (/Game server connected/.test(l)) s.gameUp = true;
    if (/OnCheckJoinCodeSuccess/.test(l)) lastBad = i;
  });
  s.codeBroken = lastBad > lastActive;
  const onlineCount = syncSeen ? peers.size : chars.size;
  s.players = changedAt >= 0 ? (connAt > changedAt && conn > onlineCount ? conn : onlineCount) : conn ?? sessionCount ?? undefined;
  s.online = syncSeen ? [...peers].map(id => names.get(id)).filter(Boolean) : [...new Set(chars.values())];
  s.recent = Object.entries(seen).map(([name, t]) => ({ name, t })).sort((a, b) => b.t - a.t);
  if (s.players != null) s.idle = s.players === 0;
  return s;
}

// ---------- folders on this PC ----------
class LocalTransport {
  constructor(conn, game = 'valheim') {
    this.conn = conn; this.game = game; serverPaths(this, conn, game, [conn.pluginsDir, conn.configDir]);
    this.canRestart = !!conn.restartCmd;
  }
  label() { return 'this PC'; }
  abs(dir, rel = '') { return path.join(dir, ...rel.split('/').filter(Boolean)); }
  async test() { return { ok: true, plugins: fs.existsSync(this.pluginsDir), config: !this.configDir || fs.existsSync(this.configDir) }; }
  async list(dir) { try { return fs.readdirSync(dir); } catch { return []; } }
  async hashes(dir, { normalize, skipDirs = [] } = {}) {
    const map = {};
    for (const rel of walk(dir)) {
      if (skipDirs.some(d => rel.startsWith(d + '/'))) continue;
      const p = this.abs(dir, rel);
      // (configs are small and compared without CRs; mod files can be huge)
      map[rel] = { mtime: fs.statSync(p).mtimeMs, hash: normalize ? normSha(fs.readFileSync(p)) : await fileSha(p) };
    }
    return map;
  }
  async put(dir, files) {
    for (const f of files) {
      if (!safeRel(f.name)) throw new Error(`nume ciudat: ${f.name}`);
      const p = this.abs(dir, f.name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.data);
    }
  }
  async remove(dir, names) { for (const n of names) { if (!safeRel(n)) throw new Error(`nume ciudat: ${n}`); fs.rmSync(this.abs(dir, n), { recursive: true, force: true }); } }
  async read(dir, rel) { return fs.readFileSync(this.abs(dir, rel)); }
  async pull(dir, name) {
    const base = this.abs(dir, name);
    if (!fs.existsSync(base)) return [];
    if (fs.statSync(base).isFile()) return [{ name, data: fs.readFileSync(base) }];
    return walk(base).map(rel => ({ name: `${name}/${rel}`, data: fs.readFileSync(this.abs(base, rel)) }));
  }
  restart() {
    return new Promise((resolve, reject) => {
      const p = spawn(this.conn.restartCmd, { shell: true, windowsHide: true });
      p.on('close', code => code === 0 ? resolve() : reject(new Error(`comanda de restart a ieșit cu ${code}`)));
      p.on('error', reject);
    });
  }
  async isIdle() { return null; }
  async status() { return null; }
}

// ---------- FTP / FTPS ----------
class FtpTransport {
  constructor(conn, password, game = 'valheim') {
    this.conn = conn; this.password = password; this.game = game;
    serverPaths(this, conn, game, ['/BepInEx/plugins', '/BepInEx/config']);
    this.canRestart = false; this.hashless = true;
  }
  label() { return `${this.conn.host} (FTP)`; }
  async client(fn) {
    const ftp = require('basic-ftp');
    const c = new ftp.Client(60000);
    try {
      await c.access({ host: this.conn.host, port: this.conn.port || 21, user: this.conn.user, password: this.password, secure: !!this.conn.secure, secureOptions: { rejectUnauthorized: false } });
      return await fn(c);
    } finally { c.close(); }
  }
  async test() {
    return this.client(async c => {
      const has = async d => { try { await c.cd(d); return true; } catch { return false; } };
      return { ok: true, plugins: await has(this.pluginsDir), config: !this.configDir || await has(this.configDir) };
    });
  }
  async list(dir) { return this.client(async c => { try { return (await c.list(dir)).map(e => e.name).filter(n => n !== '.' && n !== '..'); } catch { return []; } }); }
  async walkRemote(c, dir, base = '', out = []) {
    let list = [];
    try { list = await c.list(dir + (base ? '/' + base : '')); } catch { return out; }
    for (const e of list) {
      if (e.name === '.' || e.name === '..') continue;
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory) await this.walkRemote(c, dir, rel, out); else out.push({ rel, size: e.size, mtime: e.modifiedAt ? e.modifiedAt.getTime() : 0 });
    }
    return out;
  }
  // FTP cannot hash on the server: sizes + mtimes only (contents are hashed when downloaded, see cache)
  async hashes(dir, { normalize, skipDirs = [], cache } = {}) {
    return this.client(async c => {
      const map = {};
      for (const e of await this.walkRemote(c, dir)) {
        if (skipDirs.some(d => e.rel.startsWith(d + '/'))) continue;
        const key = `${e.size}|${e.mtime}`;
        if (normalize && cache) {
          // configs are small: download changed ones to know their content
          if (!cache[e.rel] || cache[e.rel].key !== key) {
            const chunks = []; const { Writable } = require('stream');
            await c.downloadTo(new Writable({ write(ch, _e, cb) { chunks.push(ch); cb(); } }), `${dir}/${e.rel}`);
            cache[e.rel] = { key, hash: normSha(Buffer.concat(chunks)) };
          }
          map[e.rel] = { mtime: e.mtime, hash: cache[e.rel].hash, size: e.size };
        } else map[e.rel] = { mtime: e.mtime, size: e.size, hash: null };
      }
      return map;
    });
  }
  async put(dir, files) {
    const { Readable } = require('stream');
    await this.client(async c => {
      for (const f of files) {
        if (!safeRel(f.name)) throw new Error(`nume ciudat: ${f.name}`);
        const p = `${dir}/${f.name}`;
        await c.ensureDir(p.slice(0, p.lastIndexOf('/')));
        await c.cd('/');
        await c.uploadFrom(Readable.from(f.data), p);
      }
    });
  }
  async remove(dir, names) {
    await this.client(async c => {
      for (const n of names) {
        if (!safeRel(n)) throw new Error(`nume ciudat: ${n}`);
        try { await c.removeDir(`${dir}/${n}`); } catch { try { await c.remove(`${dir}/${n}`); } catch { } }
      }
    });
  }
  async read(dir, rel) {
    const { Writable } = require('stream');
    return this.client(async c => { const chunks = []; await c.downloadTo(new Writable({ write(ch, _e, cb) { chunks.push(ch); cb(); } }), `${dir}/${rel}`); return Buffer.concat(chunks); });
  }
  async pull(dir, name) {
    return this.client(async c => {
      const { Writable } = require('stream');
      const files = await this.walkRemote(c, `${dir}/${name}`);
      const out = [];
      const get = async p => { const chunks = []; await c.downloadTo(new Writable({ write(ch, _e, cb) { chunks.push(ch); cb(); } }), p); return Buffer.concat(chunks); };
      if (!files.length) { try { out.push({ name, data: await get(`${dir}/${name}`) }); } catch { } }
      for (const f of files) out.push({ name: `${name}/${f.rel}`, data: await get(`${dir}/${name}/${f.rel}`) });
      return out;
    });
  }
  async isIdle() { return null; }
  async status() { return null; }
}

// where the mods (and configs) live on the server. Valheim: the BepInEx plugins + config folders. Enshrouded: the
// dedicated server's folder (enshrouded_server.exe) - EML's dbghelp.dll goes there, the mods into its mods/ folder; no
// config folder (EML mods carry their settings inside the mod)
function serverPaths(t, conn, game, [plugins, config]) {
  if (game === 'enshrouded') {
    t.serverDir = (conn.serverDir || '').replace(/[\\/]+$/, '');
    t.pluginsDir = conn.pluginsDir || (t.serverDir ? `${t.serverDir}${conn.type === 'local' ? '\\' : '/'}mods` : '');
    t.configDir = '';
    return;
  }
  t.pluginsDir = conn.pluginsDir || plugins; t.configDir = conn.configDir || config;
}

function makeTransport(conn, secret, game = 'valheim') {
  if (!conn || !conn.type) return null;
  if (conn.type === 'ssh-docker' || conn.type === 'ssh') return new ShellTransport(conn, game);
  if (conn.type === 'local') return new LocalTransport(conn, game);
  if (conn.type === 'ftp') return new FtpTransport(conn, secret, game);
  throw new Error(`tip de conexiune necunoscut: ${conn.type}`);
}

module.exports = { makeTransport, walk, sha, normSha, fileSha, parseDockerStatus };
