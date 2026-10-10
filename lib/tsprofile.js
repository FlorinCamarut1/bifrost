// Thunderstore / r2modman profile codes: "Export profile as code" uploads "#r2modman\n" + base64(zip) to Thunderstore
// and gets a key back; the zip holds export.r2x (YAML: profileName + mods) and the profile's config files.
const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const { extract } = require('./archive');
const { walk } = require('./transport');

const API = 'https://thunderstore.io/api/experimental/legacyprofile';

async function importCode(fetch, code) {
  const key = String(code).trim().replace(/[^0-9a-f-]/gi, '');
  if (!/^[0-9a-f-]{20,}$/i.test(key)) throw new Error('codul de profil nu arată bine (ex. 018c1f7e-...)');
  const r = await fetch(`${API}/get/${key}/`);
  if (!r.ok) throw new Error(`Thunderstore ${r.status}: cod inexistent sau expirat`);
  const text = (await r.text()).trim();
  if (!text.startsWith('#r2modman')) throw new Error('nu e un profil r2modman / Thunderstore');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-code-'));
  try {
    const zip = path.join(tmp, 'profile.zip');
    fs.writeFileSync(zip, Buffer.from(text.slice('#r2modman'.length).trim(), 'base64'));
    const out = path.join(tmp, 'x');
    await extract(zip, out);
    const r2x = yaml.load(fs.readFileSync(path.join(out, 'export.r2x'), 'utf8')) || {};
    const mods = (r2x.mods || []).filter(m => m && m.name && m.enabled !== false)
      .map(m => ({ full: m.name, ver: m.version ? `${m.version.major}.${m.version.minor}.${m.version.patch}` : null }));
    // config files (BepInEx/config/...), returned as { rel, data }
    const configs = walk(out).filter(f => /^BepInEx\/config\//i.test(f)).map(f => ({ rel: f.replace(/^BepInEx\/config\//i, ''), data: fs.readFileSync(path.join(out, ...f.split('/'))) }));
    return { name: r2x.profileName || 'Profil importat', mods, configs };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// mods: [{ full, ver }], configDir: folder whose files go along (optional)
async function exportCode(fetch, { name, mods, configDir, sevenZip }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-export-'));
  try {
    const r2x = {
      profileName: name, mods: mods.map(m => {
        const [major, minor, patch] = m.ver.split('.').map(Number);
        return { name: m.full, version: { major, minor, patch }, enabled: true };
      }),
    };
    fs.writeFileSync(path.join(tmp, 'export.r2x'), yaml.dump(r2x));
    if (configDir && fs.existsSync(configDir)) fs.cpSync(configDir, path.join(tmp, 'BepInEx', 'config'), { recursive: true });
    const zip = path.join(os.tmpdir(), `bifrost-export-${Date.now()}.zip`);
    await sevenZip(['a', '-tzip', zip, '.', '-xr!*.log', '-xr!*.dat', '-xr!*.bin'], tmp);
    const body = '#r2modman\n' + fs.readFileSync(zip).toString('base64');
    fs.rmSync(zip, { force: true });
    const r = await fetch(`${API}/create/`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.key) throw new Error(`Thunderstore ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return j.key;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

module.exports = { importCode, exportCode };
