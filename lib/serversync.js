// Two-way config sync between the admin's Bifrost profile (BepInEx/config) and the server's config folder, through
// any transport (lib/transport.js). 3-way: the hash of each file at the last sync says which side changed; both
// changed -> the newer one wins. Never synced before: a server mod's file comes from the server (its values are in
// force), a client mod's file from the player (on the server it is only the default the mod wrote there).
// Hashes ignore CR (Linux servers rewrite configs with LF).
const fs = require('fs');
const path = require('path');
const { walk, normSha } = require('./transport');

// the server's own BepInEx settings and runtime data the mods write while playing never travel - only settings
const SKIP = [/^BepInEx\.cfg(\.default)?$/i, /\.(bak|old|tmp|log|bin|dat)$/i, /^(plugins|patchers|core|cache)\//i, /^\.synced/,
  /(^|\/)(BountySaves|LastSeasonChangeData)\//i, /(^|\/)configstate\.json$/i];
const safeRel = rel => /^[\w.\- /()+,]+$/.test(rel) && !rel.split('/').includes('..');

function localConfigs(configDir) {
  const map = {};
  for (const rel of walk(configDir)) {
    const p = path.join(configDir, ...rel.split('/'));
    map[rel] = { mtime: fs.statSync(p).mtimeMs, hash: normSha(fs.readFileSync(p)) };
  }
  return map;
}

// sideOf(rels) -> Map rel -> 'server' | 'client'; cache: persisted object for hash-less transports (FTP)
async function syncConfigs({ transport: tr, configDir, stateFile, sideOf, cache, dryRun }) {
  const last = (() => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } })();
  const R = await tr.hashes(tr.configDir, { normalize: true, skipDirs: ['plugins', 'patchers', 'core', 'cache'], cache });
  const L = localConfigs(configDir);
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
    else (l.mtime >= r.mtime ? push : pull).push(rel);
  }
  if (first.length) {
    const side = sideOf ? await sideOf(first) : new Map();
    for (const rel of first) (side.get(rel) === 'client' ? push : pull).push(rel);
  }
  if (dryRun) return { push, pull, dryRun: true };
  if (push.length) {
    const files = push.map(rel => ({ name: rel, data: fs.readFileSync(path.join(configDir, ...rel.split('/'))) }));
    await tr.put(tr.configDir, files);
    for (const f of files) last[f.name] = normSha(f.data);
  }
  for (const rel of pull) {
    const data = await tr.read(tr.configDir, rel);
    const p = path.join(configDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    last[rel] = normSha(data);
  }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(last, null, 1));
  return { push, pull };
}

module.exports = { syncConfigs, SKIP, safeRel };
