// Mod sync: Bifrost profile -> server plugins folder (was sync-valheim-mods.ps1).
//   - every mod is "server" (the server and all players need it) or "client" (players only); new mods are guessed from
//     their README and DLLs, dependencies of server mods are server mods too
//   - copies changed mods, removes the ones it put there that are gone, never touches anything else
//   - refuses a mass removal (an emptied profile looks exactly like that) unless confirmed
const fs = require('fs');
const path = require('path');
const { walk, sha, fileSha } = require('./transport');
const { metadata } = require('./dllmeta');

const SERVER_MARKERS = ['ServerSync', 'NetworkCompatibility', 'EveryoneMustHaveMod', 'ConfigSync'];
const README_SERVER = /(server and all (players|clients)|must be installed on (both|the server)|install(ed)? (it )?on (the )?(dedicated )?server|required on (the )?server|server[- ]side (mod|required))/i;
const README_CLIENT = /(client[- ]side only|client only|nothing goes on the server|not (needed|required) on (the )?server|does not need to be on (the )?servers?)/i;

function guess(itemPath) {
  const dir = fs.existsSync(itemPath) && fs.statSync(itemPath).isDirectory();
  const readme = dir ? ['README.md', 'readme.md', 'README.txt'].map(f => path.join(itemPath, f)).find(f => fs.existsSync(f)) : null;
  if (readme) {
    const t = fs.readFileSync(readme, 'utf8');
    let m = t.match(README_SERVER); if (m) return ['server', `README: "${m[0]}"`];
    m = t.match(README_CLIENT); if (m) return ['client', `README: "${m[0]}"`];
  }
  const dlls = dir ? walk(itemPath).filter(f => /\.dll$/i.test(f)).map(f => path.join(itemPath, ...f.split('/'))) : [itemPath];
  const hits = new Set();
  for (const d of dlls) {
    const b = metadata(d); if (!b.length) continue;
    const txt = b.toString('latin1') + b.toString('utf16le');
    for (const m of SERVER_MARKERS) if (txt.includes(m)) hits.add(m);
  }
  return hits.size ? ['server', `DLL: ${[...hits].join(', ')}`] : ['client', 'no signs of a server mod'];
}

function deps(itemPath) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(itemPath, 'manifest.json'), 'utf8').replace(/^﻿/, ''));
    return (j.dependencies || []).map(d => String(d).replace(/-\d[\d.]*$/, ''));
  } catch { return []; }
}

// local files of one mod as { 'Mod/sub/file': abs }
function modFiles(pluginsDir, name) {
  const abs = path.join(pluginsDir, name);
  if (!fs.existsSync(abs)) return {};
  if (fs.statSync(abs).isFile()) return { [name]: abs };
  const out = {};
  for (const rel of walk(abs)) out[`${name}/${rel}`] = path.join(abs, ...rel.split('/'));
  return out;
}

/**
 * state: { mods: {name: side}, installed: [names Bifrost put on the server], restartPending, uploaded: {rel: hash} }
 * opts : { pluginsDir, transport, builtin: RegExp, allMods, dryRun, confirmMassRemoval: async(list) => bool, log }
 */
async function syncMods(state, opts) {
  // guessSide(path): [side, why] for games whose mods show no sign of where they run (default: README / DLL guess);
  const { pluginsDir, transport: tr, builtin, allMods, dryRun, log = () => { }, guessSide = guess } = opts;
  state.mods = state.mods || {}; state.installed = state.installed || []; state.uploaded = state.uploaded || {};
  const names = (fs.existsSync(pluginsDir) ? fs.readdirSync(pluginsDir, { withFileTypes: true }) : [])
    .filter(e => e.isDirectory() || /\.dll$/i.test(e.name)).map(e => e.name).filter(n => !builtin || !builtin.test(n));
  // an empty profile with mods still on the server is either a wiped profile or "I removed them all": only a manual
  // sync may ask; automatic syncs stop (EMPTY_PROFILE) instead of retrying. Nothing on the server -> nothing to do.
  let emptyOk = false;
  if (!names.length && state.installed.length && !dryRun) {
    emptyOk = !!(opts.confirmMassRemoval && await opts.confirmMassRemoval(state.installed, true));
    if (!emptyOk) { const e = new Error(`Nu e niciun mod în profil - cele ${state.installed.length} de pe server rămân. Apasă Sync now ca să le scoți și de pe server.`); e.code = 'EMPTY_PROFILE'; e.remove = [...state.installed]; throw e; }
  }

  // classify new mods, then pull dependencies of server mods along
  const newMods = [];
  for (const n of names) if (!state.mods[n]) { const [side, why] = guessSide(path.join(pluginsDir, n)); state.mods[n] = side; newMods.push({ name: n, side, why }); }
  for (let more = true; more;) {
    more = false;
    for (const n of names.filter(x => state.mods[x] === 'server')) for (const d of deps(path.join(pluginsDir, n))) {
      if (names.includes(d) && state.mods[d] !== 'server') { state.mods[d] = 'server'; more = true; newMods.push({ name: d, side: 'server', why: `dependency of ${n}` }); }
    }
  }
  const wanted = allMods ? names : names.filter(n => state.mods[n] === 'server');
  const remove = state.installed.filter(n => !wanted.includes(n));
  if (!emptyOk && !dryRun && remove.length >= 3 && remove.length >= state.installed.length / 2) {
    const ok = opts.confirmMassRemoval && await opts.confirmMassRemoval(remove);
    if (!ok) { const e = new Error(`S-ar scoate ${remove.length} din ${state.installed.length} moduri de pe server - oprit (profil gol sau greșit?).`); e.code = 'MASS_REMOVAL'; e.remove = remove; throw e; }
  }

  // what differs on the server
  const remote = await tr.hashes(tr.pluginsDir);
  const copy = [];
  for (const n of wanted) {
    const local = modFiles(pluginsDir, n);
    let same = true;
    for (const [rel, abs] of Object.entries(local)) {
      const r = remote[rel];
      if (!r) { same = false; break; }
      const h = await fileSha(abs);
      if (tr.hashless ? state.uploaded[rel] !== h || (r.size !== undefined && r.size !== fs.statSync(abs).size) : r.hash !== h) { same = false; break; }
    }
    if (same) for (const rel of Object.keys(remote)) if ((rel === n || rel.startsWith(n + '/')) && !local[rel]) { same = false; break; }
    if (!same) copy.push(n);
  }
  const result = { wanted, copy, remove, newMods, changed: false };
  if (dryRun) return result;

  if (remove.length) { await tr.remove(tr.pluginsDir, remove); for (const n of remove) log(`  removed ${n}`); }
  if (copy.length) {
    await tr.remove(tr.pluginsDir, copy);
    // a few mods per batch keeps each transfer reasonable
    for (let i = 0; i < copy.length; i += 6) {
      const files = [];
      for (const n of copy.slice(i, i + 6)) for (const [rel, abs] of Object.entries(modFiles(pluginsDir, n))) {
        const data = fs.readFileSync(abs); files.push({ name: rel, data }); state.uploaded[rel] = sha(data);
      }
      await tr.put(tr.pluginsDir, files);
      for (const n of copy.slice(i, i + 6)) log(`  copied ${n}`);
    }
  }
  for (const rel of Object.keys(state.uploaded)) if (!wanted.some(n => rel === n || rel.startsWith(n + '/'))) delete state.uploaded[rel];
  result.changed = remove.length > 0 || copy.length > 0;
  state.installed = wanted;
  if (result.changed) state.restartPending = true;
  return result;
}

module.exports = { syncMods, guess, deps, modFiles };
