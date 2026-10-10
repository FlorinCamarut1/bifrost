// App updates without new executables: a release carries bifrost-app-<version>.zip (resources/app.asar +
// app.asar.unpacked). It is unpacked into %APPDATA%\Bifrost\app\<version>\ and main.js of the installed build hands
// over to it at the next start (see the top of main.js). Bifrost.exe itself stays the untouched Electron binary,
// so Windows Smart App Control has nothing new to judge. A different Electron major needs the full installer.
const fs = require('fs');
const path = require('path');
const { extract } = require('./archive');

const cmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };

function pointer(appData) { return path.join(appData, 'Bifrost', 'app', 'current.json'); }

// called before anything else by the installed build: -> folder of a newer app.asar, or null
function pick(appData, baseVersion, electronMajor) {
  try {
    const c = JSON.parse(fs.readFileSync(pointer(appData), 'utf8'));
    if (cmp(c.version, baseVersion) > 0 && c.electron === electronMajor && fs.existsSync(path.join(c.dir, 'app.asar', 'main.js'))) return c;
  } catch { }
  return null;
}

async function check({ fetch, repo, current, electronMajor }) {
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { 'User-Agent': 'Bifrost', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const rel = await r.json();
  const version = String(rel.tag_name || '').replace(/^v/, '');
  if (!version || cmp(version, current) <= 0) return { latest: version, newer: false };
  // Windows: bifrost-app-<v>-e<N>.zip, Linux: bifrost-app-<v>-e<N>-linux.tar.gz (the unpacked part has a native 7za)
  const re = process.platform === 'linux' ? /^bifrost-app-[\d.]+-e(\d+)-linux\.tar\.gz$/i : /^bifrost-app-[\d.]+-e(\d+)\.zip$/i;
  const bundle = (rel.assets || []).find(a => re.test(a.name));
  const em = (bundle && (bundle.name.match(re) || [])[1]) || null;
  return { latest: version, newer: true, bundle, electron: em ? +em : null, page: rel.html_url, needsInstaller: !bundle || (em && +em !== electronMajor) };
}

async function install({ download, appData, version, bundle, electronMajor }) {
  const dir = path.join(appData, 'Bifrost', 'app', version);
  const linux = /\.tar\.gz$/i.test(bundle.name);
  const zip = path.join(appData, 'Bifrost', 'app', `${version}.${linux ? 'tar.gz' : 'zip'}`);
  await download(bundle.browser_download_url, zip, bundle.size);
  fs.rmSync(dir, { recursive: true, force: true });
  if (linux) {
    // tar keeps the executable bit of 7za
    fs.mkdirSync(dir, { recursive: true });
    await new Promise((res, rej) => require('child_process').execFile('tar', ['-xzf', zip, '-C', dir], e => e ? rej(e) : res()));
  } else await extract(zip, dir);
  fs.rmSync(zip, { force: true });
  if (!fs.existsSync(path.join(dir, 'app.asar'))) throw new Error('pachetul de update nu conține app.asar');
  fs.writeFileSync(pointer(appData), JSON.stringify({ version, dir, electron: electronMajor }));
  // older unpacked versions are not needed any more
  for (const d of fs.readdirSync(path.dirname(dir))) {
    // (the running one may be locked - it goes next time)
    if (d !== version && /^\d+\.\d+\.\d+$/.test(d)) { try { fs.rmSync(path.join(path.dirname(dir), d), { recursive: true, force: true }); } catch { } }
  }
  return dir;
}

module.exports = { pick, check, install, cmp };
