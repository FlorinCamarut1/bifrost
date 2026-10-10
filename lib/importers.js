// Valheim profiles of other mod managers on this PC (Thunderstore Mod Manager, r2modman), for a one-time import.
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function roots(appData) {
  return [
    { manager: 'Thunderstore Mod Manager', dir: path.join(appData, 'Thunderstore Mod Manager', 'DataFolder', 'Valheim', 'profiles') },
    { manager: 'r2modman', dir: path.join(appData, 'r2modmanPlus-local', 'Valheim', 'profiles') },
  ];
}

function readProfileMods(dir) {
  let list = [];
  try { list = yaml.load(fs.readFileSync(path.join(dir, 'mods.yml'), 'utf8')) || []; } catch { }
  const mods = list.filter(m => m && m.name && m.enabled !== false).map(m => {
    const v = m.versionNumber || {};
    return { full: m.name, ver: `${v.major ?? 0}.${v.minor ?? 0}.${v.patch ?? 0}`, title: (m.displayName || m.name).replace(/_/g, ' ') };
  });
  const known = new Set(list.map(m => m && m.name));
  const plugins = path.join(dir, 'BepInEx', 'plugins');
  let manual = [];
  try { manual = fs.readdirSync(plugins, { withFileTypes: true }).filter(e => !known.has(e.name) && (e.isDirectory() || /\.dll$/i.test(e.name))).map(e => e.name); } catch { }
  return { mods, manual, pluginsDir: plugins, configDir: path.join(dir, 'BepInEx', 'config') };
}

function localProfiles(appData) {
  const out = [];
  for (const r of roots(appData)) {
    let names = [];
    try { names = fs.readdirSync(r.dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { continue; }
    for (const n of names) {
      const dir = path.join(r.dir, n);
      const p = readProfileMods(dir);
      if (p.mods.length || p.manual.length) out.push({ manager: r.manager, name: n, dir, mods: p.mods.length, manual: p.manual.length });
    }
  }
  return out;
}

module.exports = { localProfiles, readProfileMods };
