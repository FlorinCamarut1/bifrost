// Bifrost - Valheim mod manager for playing on modded servers with friends.
// Every server is its own entry with its own mod profile:
//   player: reads the server's list (server.json: Gist / GitHub / URL), installs exactly those mods, starts Valheim.
//   admin : manages the mods in Bifrost, syncs them + configs to the server (SSH+Docker / SSH / local / FTP),
//           restarts it when nobody plays, publishes the list and hands out invite links.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const OWN_VERSION = require('./package.json').version;

// ---------- code updates: an installed build hands over to a newer app.asar (lib/codeupdate.js) ----------
if (app.isPackaged && !global.__bifrostInner) {
  const target = require('./lib/codeupdate').pick(app.getPath('appData'), OWN_VERSION, +process.versions.electron.split('.')[0]);
  if (target && path.resolve(target.dir, 'app.asar') !== path.resolve(__dirname)) {
    global.__bifrostInner = true;
    require(path.join(target.dir, 'app.asar', 'main.js'));
    return;
  }
}

const { BrowserWindow, Tray, Menu, ipcMain, Notification, shell, nativeImage, safeStorage, clipboard, protocol, net, dialog } = require('electron');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { Profile, BEPINEX, cmpVer, parseDep } = require('./lib/profile');
const { Nexus } = require('./lib/nexus');
const { build: buildServerList } = require('./lib/manifest');
const listhost = require('./lib/listhost');
const { makeTransport, walk } = require('./lib/transport');
const { syncMods } = require('./lib/modsync');
const { syncConfigs } = require('./lib/serversync');
const a2s = require('./lib/a2s');
const tsprofile = require('./lib/tsprofile');
const importers = require('./lib/importers');
const codeupdate = require('./lib/codeupdate');
const { run7z } = require('./lib/archive');

const APP_ID = 'io.github.florincamarut1.bifrost';
const REPO = 'FlorinCamarut1/bifrost';
const JOIN_PAGE = 'https://florincamarut1.github.io/bifrost/join.html';
// GitHub OAuth App (device flow) used for "Log in with GitHub"; without it Bifrost falls back to the GitHub CLI or
// a pasted token
const GITHUB_CLIENT_ID = process.env.BIFROST_GITHUB_CLIENT_ID || '';
const ICON = path.join(__dirname, 'ui', 'app.png');
const TS = 'https://thunderstore.io';
const ELECTRON_MAJOR = +process.versions.electron.split('.')[0];
const fetchN = (...a) => net.fetch(...a);

app.setAppUserModelId(APP_ID);
// --data=<dir>: a separate Bifrost (own settings + profiles), for tests
const dataArg = process.argv.find(a => a.startsWith('--data='));
if (dataArg) app.setPath('userData', path.resolve(dataArg.slice(7)));
const linkArg = argv => argv.find(a => /^(nxm|bifrost):\/\//i.test(a));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
protocol.registerSchemesAsPrivileged([{ scheme: 'modicon', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// =====================================================================================================
// SETTINGS: global + one entry per server
// =====================================================================================================
const DATA = app.getPath('userData');                              // %APPDATA%\Bifrost
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return def; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); };
const slug = s => String(s || 'server').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'server';

const GLOBAL_DEFAULTS = {
  lang: null, notifications: true, startWithWindows: null, gameDir: null, shortcutsV2: false,
  nexusKeyEnc: null, nexusUser: null, githubTokenEnc: null, githubUser: null, activeServer: null, servers: [], shortcutTarget: null,
};
const SERVER_DEFAULTS = {
  id: '', name: 'Server', role: 'player', list: null, profileDir: null, createdAt: 0,
  // admin
  conn: null, connSecretEnc: null, world: '', addresses: '', builtin: 'BepInExPack',
  autoSync: true, quietSeconds: 8, retryMinutes: 5, syncConfigs: true, syncAllMods: true, pullServerMods: true,
  autoPublish: true, publishAddress: false, modpackTeam: '', modpackName: '', tsTokenEnc: null, nexusLinks: {},
  // player
  recommended: {}, nexusChosen: {},
};
let G = { ...GLOBAL_DEFAULTS, ...readJson(SETTINGS_FILE, {}) };
const serverDir = id => path.join(DATA, 'servers', id);

// before 1.1 there was one server, with its settings at the top level
function migrateFlat() {
  if (Array.isArray(G.servers) && G.servers.length) return;
  const raw = readJson(SETTINGS_FILE, null);
  if (!raw || !raw.role) { G.servers = []; return; }
  const cached = readJson(path.join(DATA, 'server-list.json'), null);
  const name = raw.serverName && raw.serverName !== 'Server' ? raw.serverName : cached?.server?.name || 'Server';
  const id = slug(name);
  const s = {
    ...SERVER_DEFAULTS, id, name, role: raw.role === 'admin' ? 'admin' : 'player', createdAt: Date.now(),
    list: { kind: 'github', repo: raw.manifestRepo || REPO, path: 'server.json' }, profileDir: path.join(DATA, 'profile'),
    recommended: raw.recommended || {}, nexusChosen: raw.nexusChosen || {},
  };
  if (s.role === 'admin') {
    Object.assign(s, {
      conn: raw.server ? { type: 'ssh-docker', host: raw.server, container: raw.container || 'valheim' } : null,
      builtin: 'ValheimPlus|BepInExPack', world: raw.serverWorld || '', addresses: raw.addresses || '',
      autoSync: raw.autoSync !== false, syncConfigs: raw.syncConfigs !== false, syncAllMods: raw.syncAllMods !== false,
      pullServerMods: raw.pullServerMods !== false, autoPublish: raw.autoPublish !== false, publishAddress: !!raw.publishAddress,
      retryMinutes: raw.retryMinutes || 5, modpackTeam: raw.modpackTeam || '', modpackName: raw.modpackName || '',
      tsTokenEnc: raw.tokenEnc || null, nexusLinks: raw.nexusLinks || {},
    });
    // the sync state lived next to the old PowerShell script
    const old = raw.adminFolder && readJson(path.join(raw.adminFolder, 'mods.json'), null);
    if (old) writeJson(path.join(serverDir(id), 'state.json'), { mods: old.mods || {}, installed: Array.isArray(old.installed) ? old.installed : [], restartPending: !!old.restartPending, uploaded: {} });
  }
  for (const [from, to] of [['config-sync.json', 'config-sync.json'], ['server-list.json', 'list-cache.json']]) {
    try { if (fs.existsSync(path.join(DATA, from))) { fs.mkdirSync(serverDir(id), { recursive: true }); fs.renameSync(path.join(DATA, from), path.join(serverDir(id), to)); } } catch { }
  }
  G = {
    ...GLOBAL_DEFAULTS, lang: raw.lang || null, notifications: raw.notifications !== false, startWithWindows: raw.startWithWindows ?? null,
    gameDir: raw.gameDir || null, shortcutsV2: !!raw.shortcutsV2, nexusKeyEnc: raw.nexusKeyEnc || null, nexusUser: raw.nexusUser || null,
    activeServer: id, servers: [s],
  };
}
migrateFlat();
G.servers = G.servers.map(s => ({ ...SERVER_DEFAULTS, ...s }));
if (!G.servers.find(s => s.id === G.activeServer)) G.activeServer = G.servers[0]?.id || null;
if (G.startWithWindows === null) G.startWithWindows = G.servers.some(s => s.role === 'admin');
const saveSettings = () => writeJson(SETTINGS_FILE, G);
saveSettings();

const srv = () => G.servers.find(s => s.id === G.activeServer) || null;
const isAdmin = () => srv()?.role === 'admin';
const enc = s => safeStorage.encryptString(String(s).trim()).toString('base64');
const dec = s => { try { return s ? safeStorage.decryptString(Buffer.from(s, 'base64')) : null; } catch { return null; } };
const LOG_FILE = path.join(DATA, 'bifrost.log');
// English is the default; the texts are written in Romanian and translated on the way out (ui/i18n.js)
const i18n = require('./ui/i18n.js');
const tr = s => (G.lang || 'en') === 'en' ? i18n.t(s) : s;

function publicServer(s) {
  if (!s) return null;
  const { connSecretEnc, tsTokenEnc, ...rest } = s;
  return { ...rest, hasConnSecret: !!connSecretEnc, hasToken: !!tsTokenEnc, invite: s.list ? listhost.inviteCode(s.list) : null, inviteLink: s.list ? listhost.inviteLink(s.list, JOIN_PAGE) : null };
}
const publicSettings = () => {
  const { nexusKeyEnc, githubTokenEnc, servers, ...g } = G;
  const s = srv();
  return {
    ...g, lang: G.lang || 'en', hasNexusKey: !!nexusKeyEnc, hasGithubToken: !!githubTokenEnc, githubLogin: !!GITHUB_CLIENT_ID,
    servers: servers.map(x => ({ id: x.id, name: x.name, role: x.role })), server: publicServer(s),
    isAdmin: isAdmin(), ownSource: isAdmin(), packaged: app.isPackaged, version: OWN_VERSION,
    // flat aliases the UI reads
    ...(s ? { role: s.role, serverName: s.name, serverWorld: s.world, addresses: s.addresses, autoSync: s.autoSync, quietSeconds: s.quietSeconds,
      retryMinutes: s.retryMinutes, syncConfigs: s.syncConfigs, syncAllMods: s.syncAllMods, pullServerMods: s.pullServerMods,
      autoPublish: s.autoPublish, publishAddress: s.publishAddress, hasToken: !!s.tsTokenEnc } : {}),
  };
};

// =====================================================================================================
// WINDOW / TRAY / LOG
// =====================================================================================================
let win = null, tray = null, quitting = false;
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send('event', ch, data); };
function notify(title, body, kind) {
  if (!G.notifications || !Notification.isSupported()) return;
  const n = new Notification({ title: tr(title), body: String(body || '').split('\n').map(tr).join('\n'), icon: ICON, silent: kind !== 'warn' });
  n.on('click', showWindow);
  n.show();
}
const toast = (text, kind = 'info') => send('toast', { text: tr(text), kind });
function showWindow() {
  if (!win || win.isDestroyed()) createWindow(true);
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}
function createWindow(show) {
  const shotMode = process.argv.some(x => x.startsWith('--shot='));
  win = new BrowserWindow({
    width: 1220, height: 800, minWidth: 940, minHeight: 620, show: false, ...(shotMode ? { x: -6000, y: 0 } : {}),
    title: 'Bifrost', icon: ICON, backgroundColor: '#0e1115',
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#0e1115', symbolColor: '#d8d2c4', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: !shotMode },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => { if (shotMode) win.showInactive(); else if (show) win.show(); });
  // test hook: --shot=<dir> --pages=a,b saves a screenshot of every page once the data is in
  const shot = (process.argv.find(a => a.startsWith('--shot=')) || '').slice(7);
  if (shot) win.webContents.once('did-finish-load', () => setTimeout(async () => {
    const pages = ((process.argv.find(a => a.startsWith('--pages=')) || '').slice(8) || 'home,server,mods,browse,settings').split(',');
    for (const p of pages) {
      if (p.startsWith('drawer:')) await win.webContents.executeJavaScript(`openDrawer(${JSON.stringify(p.slice(7))})`);
      else if (p === 'nexus') await win.webContents.executeJavaScript("closeDrawer(); go('browse'); setSource('nx')");
      else if (p.startsWith('js:')) await win.webContents.executeJavaScript(decodeURIComponent(p.slice(3)));
      else await win.webContents.executeJavaScript(`closeDrawer(); go(${JSON.stringify(p)})`);
      await new Promise(r => setTimeout(r, p === 'browse' || p === 'nexus' ? 8000 : /drawer:/.test(p) ? 4000 : 1200));
      fs.writeFileSync(path.join(shot, `${p.replace(/[^\w-]+/g, '_').slice(0, 40)}.png`), (await win.webContents.capturePage()).toPNG());
    }
  }, 10000));
  win.on('close', e => {
    if (quitting) return;
    // admins keep it in the tray (auto-sync); a player who closes it is done
    if (G.servers.some(s => s.role === 'admin') || G.startWithWindows) { e.preventDefault(); win.hide(); } else quitting = true;
  });
  win.on('show', () => pollStatus());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
}
function updateTray() {
  if (!tray) return;
  const s = srv(), lines = ['Bifrost'];
  if (s) lines.push(s.name);
  if (status.joinCode) lines.push(`join code ${status.joinCode}${status.players != null ? ` - ${status.players} online` : ''}`);
  if (isAdmin() && watch.text) lines.push(watch.text);
  tray.setToolTip(lines.join('\n').slice(0, 127));
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tr('Deschide Bifrost'), click: showWindow },
    { label: tr('Joacă'), click: () => playerSync({ launch: true }) },
    { label: tr('Copiază join code'), click: () => { if (status.joinCode) clipboard.writeText(status.joinCode); } },
    { type: 'separator' },
    { label: tr('Ieșire'), click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
  updateTray();
}

const devShortcut = extraArgs => ({
  target: process.execPath, args: `"${__dirname}"${extraArgs ? ' ' + extraArgs : ''}`, cwd: __dirname,
  icon: path.join(__dirname, 'ui', 'app.ico'), iconIndex: 0, appUserModelId: APP_ID, description: 'Bifrost - Valheim',
});
const startMenu = () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
// the shortcut for whichever Bifrost runs: from source (electron.exe + folder) or a build (Bifrost.exe, portable or installed)
const ownShortcut = extraArgs => app.isPackaged
  ? { target: process.execPath, args: extraArgs || '', cwd: path.dirname(process.execPath), icon: path.join(process.resourcesPath, 'app.ico'), iconIndex: 0, appUserModelId: APP_ID, description: 'Bifrost - Valheim' }
  : devShortcut(extraArgs);
function applyStartup() {
  try {
    const lnk = path.join(startMenu(), 'Startup', 'Bifrost.lnk');
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: !!G.startWithWindows, args: ['--hidden'] });
      if (fs.existsSync(lnk)) fs.unlinkSync(lnk);   // left over from running from source
      return;
    }
    if (G.startWithWindows) shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', devShortcut('--hidden'));
    else if (fs.existsSync(lnk)) fs.unlinkSync(lnk);
  } catch (e) { log(`autostart: ${e.message}`); }
}
// Desktop + Start menu point at the Bifrost that runs now (the Start menu one carries the AppUserModelID notifications need)
function ensureShortcuts() {
  const target = app.isPackaged ? process.execPath : `${process.execPath}|${__dirname}`;
  if (G.shortcutTarget === target) return;
  for (const l of [path.join(startMenu(), 'Bifrost.lnk'), path.join(app.getPath('desktop'), 'Bifrost.lnk')]) {
    try { shell.writeShortcutLink(l, fs.existsSync(l) ? 'replace' : 'create', ownShortcut('')); } catch (e) { log(`shortcut ${l}: ${e.message}`); }
  }
  G.shortcutTarget = target; G.shortcutsV2 = true; saveSettings();
}
function registerProtocols() {
  for (const p of ['bifrost', ...(G.nexusKeyEnc ? ['nxm'] : [])]) {
    try { if (app.isPackaged) app.setAsDefaultProtocolClient(p); else app.setAsDefaultProtocolClient(p, process.execPath, [path.resolve(__dirname)]); }
    catch (e) { log(`${p}://: ${e.message}`); }
  }
}

const logTail = [];
function log(line, kind = 'info') {
  const t = new Date();
  const entry = { t: t.getTime(), line, kind };
  logTail.push(entry); if (logTail.length > 3000) logTail.splice(0, logTail.length - 3000);
  send('log', entry);
  try { fs.appendFileSync(LOG_FILE, `${t.toLocaleString('sv-SE')}  ${line}\n`); } catch { }
}
try { if (fs.statSync(LOG_FILE).size > 2e6) fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-5000).join('\n')); } catch { }

// =====================================================================================================
// PROFILE + JOBS (shared)
// =====================================================================================================
let profile = null, profileFor = null;
function getProfile() {
  const s = srv();
  const dir = s?.profileDir || path.join(DATA, 'profiles', s?.id || 'none');
  if (!profile || profileFor !== dir) { profile = new Profile({ dir, cacheDir: path.join(DATA, 'cache'), fetch: fetchN, log }); profileFor = dir; }
  return profile;
}
const pluginsDir = () => path.join(getProfile().dir, 'BepInEx', 'plugins');
const configDir = () => path.join(getProfile().dir, 'BepInEx', 'config');
const statePath = () => path.join(serverDir(srv().id), 'state.json');
function readState() { const j = srv() ? readJson(statePath(), {}) : {}; return { mods: j.mods || {}, installed: j.installed || [], restartPending: !!j.restartPending, uploaded: j.uploaded || {} }; }
const writeState = st => writeJson(statePath(), st);

let job = null;
function setJob(j) { job = j; send('job', job); }
let progress = null;
function setProgress(p) { progress = p; send('progress', progress); }

// =====================================================================================================
// THUNDERSTORE CATALOG
// =====================================================================================================
const CATALOG_FILE = path.join(DATA, 'catalog.json');
let catalog = readJson(CATALOG_FILE, null);
let catalogIndex = new Map();
let catalogBusy = null;
let updates = {};
const ownPack = () => `${srv()?.modpackTeam}-${srv()?.modpackName}`;
function indexCatalog() {
  catalogIndex = new Map((catalog?.packages || []).map(p => [p.full, p]));
  const out = {};
  if (srv()) for (const k of Object.keys(getProfile().packages)) { const p = catalogIndex.get(k); if (p) out[k] = { latest: p.ver, downloads: p.dl }; }
  const own = catalogIndex.get(ownPack());
  if (own) out[ownPack()] = { latest: own.ver };
  updates = out;
}
function refreshCatalog() {
  if (catalogBusy) return catalogBusy;
  send('catalogState', { busy: true });
  catalogBusy = new Promise(resolve => {
    const p = spawn(process.execPath, [path.join(__dirname.replace(/app\.asar$/, 'app.asar.unpacked'), 'catalog-worker.js'), CATALOG_FILE],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', code => {
      catalogBusy = null;
      if (code === 0) { catalog = readJson(CATALOG_FILE, catalog); indexCatalog(); log(`Catalog Thunderstore actualizat: ${out.trim()}`); }
      else log(`Catalogul Thunderstore nu s-a putut descărca: ${err.trim()}`, 'error');
      send('updates', updates); send('modpack', modpackInfo());
      send('catalogState', { busy: false, fetched: catalog?.fetched || null, error: code === 0 ? null : err.trim() });
      resolve(code === 0);
    });
  });
  return catalogBusy;
}
async function checkUpdates(maxAgeMs = 0) {
  if (!catalog || Date.now() - catalog.fetched > maxAgeMs) await refreshCatalog();
  else { indexCatalog(); send('updates', updates); send('modpack', modpackInfo()); }
}

// =====================================================================================================
// INSTALLING (Thunderstore + Nexus) into the current server's profile
// =====================================================================================================
const nexus = new Nexus({ fetch: fetchN, appName: 'Bifrost', appVersion: OWN_VERSION });
const installing = {};
let nexusWaiting = [];
const nexusPending = {};

async function installThunderstore(item, wanted) {
  const pr = getProfile();
  const queue = [item];
  while (queue.length) {
    const d = queue.shift();
    const have = pr.packages[d.key];
    if (have && have.ver === d.ver) continue;
    if (have && d.role === 'dep' && cmpVer(have.ver, d.ver) >= 0) continue;
    setProgress({ ...progress, text: `${d.title || d.full} ${d.ver}`, bytes: 0, totalBytes: 0 });
    const zip = await pr.thunderstoreZip(d.full, d.ver, (got, total) => setProgress({ ...progress, bytes: got, totalBytes: total }));
    const deps = await pr.installZip(d.key, zip, {
      ver: d.ver, role: have && have.role !== 'dep' && d.role === 'dep' ? have.role : d.role,
      source: 'thunderstore', title: d.title || d.full, size: fs.statSync(zip).size,
    }, () => Profile.thunderstoreMap(d.full));
    log(`  instalat ${d.full} ${d.ver}`, 'out');
    for (const dep of deps) {
      const x = parseDep(dep);
      if (!x || wanted.has(x.full)) continue;
      const h = pr.packages[x.full];
      if (h && cmpVer(h.ver, x.ver) >= 0) continue;
      queue.push({ key: x.full, full: x.full, ver: x.ver, role: 'dep', title: x.full });
    }
  }
}
async function installNexus(entry, nxm) {
  const pr = getProfile();
  const key = dec(G.nexusKeyEnc);
  if (!key) throw new Error('Pune cheia Nexus în Setări.');
  nexus.key = key;
  const url = await nexus.downloadUrl(entry.modId, entry.fileId, nxm);
  setProgress({ ...progress, text: `${entry.title} (Nexus)`, bytes: 0, totalBytes: 0 });
  // newer Nexus files have extension-less CDN names: the archive type is read from the file itself (lib/archive.js)
  const name = (decodeURIComponent(new URL(url).pathname.split('/').pop() || '').replace(/[^\w.\- ]+/g, '_') || 'file').slice(-80);
  const zip = await pr.download(url, path.join(pr.cacheDir, 'nexus', `${entry.modId}-${entry.fileId}-${name}`), (got, total) => setProgress({ ...progress, bytes: got, totalBytes: total }));
  const dllName = `${String(entry.title || entry.key).replace(/[^\w.\-]+/g, '_')}.dll`;
  await pr.installZip(entry.key, zip, { ver: entry.ver, role: entry.role, source: 'nexus', title: entry.title, modId: entry.modId, fileId: entry.fileId, size: fs.statSync(zip).size },
    Profile.nexusMap(entry.key), dllName);
  log(`  instalat ${entry.title} (Nexus ${entry.modId})`, 'out');
}
const sideFromCats = p => { const c = p?.cats || []; return c.includes('Server-side') ? 'server' : c.includes('Client-side') ? 'client' : null; };
function hintSide(name, side) {
  if (!isAdmin() || !side) return;
  const st = readState();
  if (!st.mods[name]) { st.mods[name] = side; writeState(st); }
}

// a mod picked in Descoperă (players: their own extra; admins: goes to the server too)
async function installPackage(full, ver) {
  if (!srv()) return { ok: false, error: 'Adaugă sau creează întâi un server.' };
  if (job) return { ok: false, error: 'Lucrez deja - încearcă în câteva secunde.' };
  const p = catalogIndex.get(full);
  ver = ver || p?.ver;
  if (!ver) return { ok: false, error: 'Nu găsesc pachetul în catalog.' };
  setJob({ kind: 'install', label: `Instalez ${full}`, started: Date.now() });
  installing[full] = { ver, at: Date.now() }; send('installing', installing);
  try {
    setProgress({ phase: 'install', text: full, done: 0, total: 1 });
    const have = getProfile().packages[full];
    await installThunderstore({ key: full, full, ver, role: have && have.role !== 'dep' ? have.role : 'user', title: p ? p.name.replace(/_/g, ' ') : full }, new Set(desired().map(d => d.key)));
    hintSide(full, sideFromCats(p));
    log(`${full} ${ver} instalat`, 'done');
    return { ok: true, via: 'bifrost', side: sideFromCats(p) };
  } catch (e) { log(`${full}: ${e.message}`, 'error'); return { ok: false, error: e.message }; }
  finally { delete installing[full]; send('installing', installing); setProgress(null); setJob(null); afterProfileChange(); }
}
function removePackage(key) {
  if (job) return { ok: false, error: 'Lucrez deja.' };
  const pr = getProfile(), p = pr.packages[key];
  if (!p) return { ok: false, error: 'Nu e instalat.' };
  if (p.role === 'required') return { ok: false, error: 'Serverul are nevoie de el.' };
  if (key === BEPINEX) return { ok: false, error: 'BepInEx e baza tuturor modurilor - nu se scoate.' };
  const users = Object.entries(pr.packages).filter(([k, x]) => k !== key && (x.deps || []).some(d => parseDep(d)?.full === key)).map(([k]) => k);
  if (users.length) return { ok: false, error: `Au nevoie de el: ${users.join(', ')}. Scoate-le întâi pe acelea.` };
  if (p.role === 'recommended') { const s = srv(); delete s.recommended[key]; delete s.nexusChosen[key]; saveSettings(); }
  pr.remove(key);
  for (const k of pr.orphans()) pr.remove(k);
  log(`${key} dezinstalat`);
  afterProfileChange();
  return { ok: true };
}
async function updateAll() {
  if (job) return { ok: false, error: 'Lucrez deja.' };
  const pr = getProfile();
  const todo = Object.entries(pr.packages).filter(([k, x]) => x.source === 'thunderstore' && x.role !== 'required' && catalogIndex.get(k) && cmpVer(catalogIndex.get(k).ver, x.ver) > 0);
  if (!todo.length) return { ok: true, count: 0 };
  setJob({ kind: 'update', label: `Actualizez ${todo.length} moduri`, started: Date.now() });
  log(`▶ ${job.label}`, 'start');
  try {
    setProgress({ phase: 'install', text: '', done: 0, total: todo.length });
    for (const [i, [k, x]] of todo.entries()) {
      setProgress({ ...progress, done: i });
      await installThunderstore({ key: k, full: k, ver: catalogIndex.get(k).ver, role: x.role, title: x.title }, new Set(todo.map(t => t[0])));
    }
    for (const k of pr.orphans()) pr.remove(k);
    log(`■ ${todo.length} moduri actualizate`, 'done');
    return { ok: true, count: todo.length };
  } catch (e) { log(`■ ${e.message}`, 'error'); return { ok: false, error: e.message }; }
  finally { setProgress(null); setJob(null); afterProfileChange(); }
}
function afterProfileChange() { indexCatalog(); send('mods', modsPayload()); send('player', playerInfo()); send('updates', updates); }

// =====================================================================================================
// PLAYER: the server's list
// =====================================================================================================
let manifest = null, manifestErr = null, manifestAt = null;
const listCache = () => path.join(serverDir(srv().id), 'list-cache.json');
function loadManifestCache() { manifest = srv() ? readJson(listCache(), null) : null; manifestErr = null; manifestAt = null; }
async function refreshManifest() {
  const s = srv();
  if (!s?.list) { manifest = null; send('player', playerInfo()); return null; }
  try {
    manifest = await listhost.fetchList(fetchN, s.list);
    writeJson(listCache(), manifest);
    manifestErr = null;
    if (s.role === 'player' && manifest.server?.name && manifest.server.name !== s.name) { s.name = manifest.server.name; saveSettings(); send('settings', publicSettings()); }
  } catch (e) { manifestErr = e.message; }
  manifestAt = Date.now();
  send('player', playerInfo());
  return manifest;
}
function desired() {
  const s = srv(), out = [];
  if (!manifest || !s || s.role === 'admin') return out;
  for (const m of manifest.required) out.push({ key: m.full, full: m.full, ver: m.ver, role: 'required', source: 'thunderstore', title: m.title });
  for (const m of manifest.recommended || []) if (s.recommended[m.full]) out.push({ key: m.full, full: m.full, ver: m.ver, role: 'recommended', source: 'thunderstore', title: m.title });
  for (const n of manifest.nexus || []) if (n.required || s.nexusChosen[n.key])
    out.push({ key: n.key, full: n.key, ver: String(n.version || n.fileId), role: n.required ? 'required' : 'recommended', source: 'nexus', title: n.title, modId: n.modId, fileId: n.fileId });
  return out.sort((a, b) => (b.full === BEPINEX) - (a.full === BEPINEX));
}
function playerMods() {
  const p = srv() ? getProfile().packages : {};
  return {
    mods: Object.entries(p).map(([k, x]) => ({ name: k, version: x.ver, role: x.role, source: x.source, title: x.title || k, size: x.size || 0, installedAt: x.installedAt, icon: catalogIndex.get(k)?.icon || null })),
    profileFound: true, profile: srv()?.name || 'Bifrost',
  };
}
let game = { game: null, steam: null };
function playerInfo() {
  const s = srv();
  if (!s) return { none: true, game };
  const pr = getProfile();
  const plan = manifest && s.role === 'player' ? pr.plan(desired()) : { install: [], remove: [] };
  const bytes = plan.install.reduce((t, d) => t + (catalogIndex.get(d.full)?.size || 0), 0);
  return {
    manifest, error: manifestErr, at: manifestAt, role: s.role, progress, busy: !!job, status,
    game: { ...game, ...(game.game ? Profile.gameOwner(game.game) : {}), backup: !!(game.game && fs.existsSync(path.join(game.game, 'bifrost-backup'))) },
    plan: { install: plan.install.map(d => ({ key: d.key, ver: d.ver, have: pr.packages[d.key]?.ver || null, source: d.source, title: d.title })), remove: plan.remove, bytes },
    required: manifest ? manifest.required.length + (manifest.nexus || []).filter(n => n.required).length : 0,
    installed: Object.keys(pr.packages).length, nexusWaiting: nexusWaiting.map(n => ({ key: n.key, title: n.title, modId: n.modId, fileId: n.fileId })),
    nexusUser: G.nexusUser, recommended: s.recommended, nexusChosen: s.nexusChosen,
  };
}
async function launchGame() {
  game = await Profile.findGame();
  if (G.gameDir && fs.existsSync(path.join(G.gameDir, 'valheim.exe'))) game.game = G.gameDir;
  if (!game.game) throw new Error('Nu găsesc Valheim (Steam). Alege folderul jocului în Setări.');
  getProfile().prepareGame(game.game);
  getProfile().launch(game.steam);
  log(`Pornesc Valheim cu profilul „${srv().name}” (${game.game})`, 'done');
}
async function playerSync({ launch } = {}) {
  if (!srv()) return { ok: false, error: 'Adaugă sau creează întâi un server.' };
  if (job) return { ok: false, error: 'Lucrez deja.' };
  // admins and personal profiles (no list): the profile is the source - just play
  if (isAdmin() || !srv().list) {
    try { if (launch) await launchGame(); return { ok: true }; } catch (e) { log(e.message, 'error'); return { ok: false, error: e.message }; }
  }
  setJob({ kind: 'play', label: launch ? 'Pregătesc jocul' : 'Actualizez modurile', started: Date.now() });
  log(`▶ ${job.label}`, 'start');
  try {
    await refreshManifest();
    if (!manifest) throw new Error(`Nu am lista serverului (${manifestErr || 'necunoscut'}).`);
    const pr = getProfile();
    const want = desired();
    const wanted = new Set(want.map(d => d.key));
    const plan = pr.plan(want);
    const ts = plan.install.filter(d => d.source === 'thunderstore');
    const nx = plan.install.filter(d => d.source === 'nexus');
    setProgress({ phase: 'install', text: '', done: 0, total: plan.install.length });
    for (const [i, d] of ts.entries()) { setProgress({ ...progress, done: i }); await installThunderstore(d, wanted); }
    nexusWaiting = [];
    for (const d of nx) { if (G.nexusUser?.premium) await installNexus(d); else nexusWaiting.push(d); }
    for (const k of plan.remove) { pr.remove(k); log(`  scos ${k}`, 'out'); }
    for (const k of pr.orphans()) { pr.remove(k); log(`  scos ${k} (nu mai e nevoie de el)`, 'out'); }
    setProgress(null);
    if (nexusWaiting.length) {
      send('player', playerInfo());
      shell.openExternal(Nexus.filesPage(nexusWaiting[0].modId, nexusWaiting[0].fileId));
      const missing = nexusWaiting.filter(n => n.role === 'required');
      if (missing.length) throw new Error(`Mai trebuie de pe Nexus: ${missing.map(n => n.title).join(', ')} - apasă „Slow download” pe pagina care s-a deschis.`);
      toast('Pe pagina Nexus care s-a deschis apasă „Slow download” - Bifrost îl instalează singur.', 'info');
    }
    log(`■ Modurile sunt la zi (${Object.keys(pr.packages).length} pachete)`, 'done');
    if (launch) await launchGame();
    return { ok: true };
  } catch (e) { setProgress(null); log(`■ ${e.message}`, 'error'); return { ok: false, error: e.message }; }
  finally { setJob(null); afterProfileChange(); }
}

// =====================================================================================================
// ADMIN: mods, server sync, status, list
// =====================================================================================================
function transport(s = srv()) {
  if (!s?.conn) return null;
  return makeTransport(s.conn, dec(s.connSecretEnc));
}
function adminMods() {
  const st = readState(), pr = getProfile(), s = srv();
  const builtin = new RegExp(s.builtin || 'BepInExPack', 'i');
  const mods = Object.entries(pr.packages).map(([k, x]) => {
    const c = catalogIndex.get(k);
    return {
      name: k, displayName: (c?.name || x.title || k).replace(/_/g, ' '),
      author: c?.owner || (x.source === 'nexus' ? 'Nexus' : x.source === 'manual' ? 'instalat manual' : k.split('-')[0]),
      description: c?.desc || (x.source === 'manual' ? 'Nu e din Thunderstore / Nexus.' : ''), version: x.ver, enabled: true,
      url: c?.url || (x.modId ? `https://www.nexusmods.com/valheim/mods/${x.modId}` : null), builtin: builtin.test(k),
      modpack: !!s.modpackName && k.endsWith(`-${s.modpackName}`), side: st.mods[k] || null, onServer: st.installed.includes(k),
      icon: fs.existsSync(path.join(pluginsDir(), k, 'icon.png')) ? `modicon://icon/${encodeURIComponent(k)}` : (c?.icon || null),
      manual: x.source !== 'thunderstore', role: x.role, source: x.source, size: x.size || 0,
      nexus: x.source === 'nexus' ? { modId: x.modId, fileId: x.fileId, version: x.ver, title: x.title } : (s.nexusLinks[k] || null),
    };
  });
  return { mods, restartPending: st.restartPending, profileFound: true, profile: s.name, source: 'bifrost' };
}
const modsPayload = () => !srv() ? { mods: [], profileFound: false } : isAdmin() ? adminMods() : playerMods();
function setSide(name, side) {
  if (job) return { ok: false, error: 'O sincronizare rulează acum - încearcă după ce termină.' };
  const st = readState(); st.mods[name] = side; writeState(st);
  log(`${name} -> ${side}`);
  send('mods', modsPayload());
  watch.dirty = true; changedAt = Date.now() - Math.max(0, srv().quietSeconds - 2) * 1000; setWatch('change', 'modurile s-au schimbat...');
  return { ok: true };
}

const watch = { text: '', state: 'idle', dirty: false, lastSync: null, lastResult: null, retryAt: null, twoWay: null };
let seenSig = null, syncedSig = null, changedAt = null, failStreak = 0;
function setWatch(state, text) { if (state) watch.state = state; if (text !== undefined) watch.text = text; send('watch', watch); updateTray(); }
function signature() {
  const pr = getProfile(), parts = [];
  try { const s = fs.statSync(pr.stateFile); parts.push(`p|${s.mtimeMs}|${s.size}`); } catch { parts.push('p|none'); }
  try { for (const e of fs.readdirSync(pluginsDir()).sort()) { try { parts.push(`${e}|${fs.statSync(path.join(pluginsDir(), e)).mtimeMs}`); } catch { } } } catch { }
  return parts.join('\n');
}

async function confirmMass(list) {
  if (!win) return false;
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Anulează', 'Scoate-le de pe server'], defaultId: 0, cancelId: 0, title: 'Bifrost',
    message: `S-ar scoate ${list.length} moduri de pe server`, detail: `${list.join(', ')}\n\nUn profil gol sau greșit arată exact așa. Continui?`,
  });
  return r.response === 1;
}

async function syncNow(reason) {
  const s = srv();
  if (!isAdmin() || !s.conn) return;
  if (job) { toast('Rulează deja ceva - aștept să termine.'); return; }
  const manual = reason === 'manual', tr = transport();
  const sig = signature();
  changedAt = null; watch.retryAt = null;
  setJob({ kind: 'sync', label: `Sincronizare (${reason})`, started: Date.now() });
  setWatch('syncing', 'sincronizez...');
  log(`▶ Sincronizare (${reason}) → ${tr.label()}`, 'start');
  const st = readState();
  try {
    const r = await syncMods(st, {
      pluginsDir: pluginsDir(), transport: tr, builtin: new RegExp(s.builtin || 'BepInExPack', 'i'), allMods: s.syncAllMods,
      confirmMassRemoval: manual ? confirmMass : null, log: l => log(l, 'out'),
    });
    writeState(st);
    for (const n of r.newMods) log(`  ${n.name} -> ${n.side} (${n.why})`, 'out');
    const what = [r.copy.length && `Actualizat: ${r.copy.join(', ')}`, r.remove.length && `Scos: ${r.remove.join(', ')}`,
    r.newMods.length && `Moduri noi (ghicit): ${r.newMods.map(n => `${n.name} → ${n.side}`).join('; ')}`].filter(Boolean).join('\n');
    log(`■ Sincronizare: ${r.copy.length} copiate, ${r.remove.length} scoase`, 'done');
    syncedSig = sig; failStreak = 0; watch.lastSync = Date.now();
    setJob(null);
    await maybeRestart({ manual, what });
  } catch (e) {
    setJob(null);
    if (e.code === 'MASS_REMOVAL') {
      watch.lastResult = { kind: 'warn', text: `Oprit: ${e.message}` }; syncedSig = sig;
      notify('Bifrost: sincronizare oprită', e.message, 'warn'); setWatch('attention', 'necesită atenție');
    } else {
      failStreak++;
      watch.lastResult = { kind: 'error', text: `Eroare: ${e.message}` };
      watch.retryAt = Date.now() + 5 * 60e3;
      log(`■ Sincronizarea a eșuat: ${e.message}`, 'error');
      if (failStreak === 1) notify('Bifrost: sincronizarea a eșuat', `${e.message}\nReîncerc în 5 minute.`, 'warn');
      setWatch('error', 'eroare - reîncerc');
    }
  } finally { watch.dirty = signature() !== syncedSig; send('mods', modsPayload()); send('watch', watch); }
}

// restart only while nobody plays; afterwards configs + list
async function maybeRestart({ manual, what = '', force } = {}) {
  const s = srv(), tr = transport(), st = readState();
  if (!st.restartPending && !force) {
    watch.lastResult = { kind: 'ok', text: 'Serverul e la zi', what };
    if (manual) toast('Serverul e la zi.', 'ok');
    setWatch('idle', 'la zi');
    schedulePublish('mods sincronizate'); setTimeout(() => twoWay('după sincronizare'), 1500);
    return { ok: true };
  }
  if (!tr.canRestart) {
    watch.lastResult = { kind: 'wait', text: 'Moduri copiate - repornește serverul din panoul hostului', what };
    notify('Moduri copiate pe server', `${what}\nRepornește serverul din panoul hostului ca să le încarce.`.trim());
    setWatch('waiting', 'așteaptă restart manual');
    setTimeout(() => twoWay('după sincronizare'), 1500);
    return { ok: true, manualRestart: true };
  }
  if (!force) {
    let idle = await tr.isIdle().catch(() => null);
    if (idle === null) idle = await steamPlayers().then(p => p === 0).catch(() => null);
    if (idle !== true) {
      watch.lastResult = { kind: 'wait', text: idle === false ? 'Moduri copiate - restartul așteaptă să iasă jucătorii' : 'Moduri copiate - nu știu dacă e cineva pe server, restartul îl faci tu', what };
      watch.retryAt = idle === false ? Date.now() + s.retryMinutes * 60e3 : null;
      notify('Moduri copiate pe server', `${what}\n${idle === false ? 'Sunt jucători online - serverul repornește când se golește.' : 'Apasă Restart server când nu e nimeni.'}`.trim());
      setWatch('waiting', idle === false ? 'restart după ce iese lumea' : 'restart manual');
      setTimeout(() => twoWay('după sincronizare'), 1500);
      return { ok: true, postponed: true };
    }
  }
  const r = await restartServer();
  watch.lastResult = { kind: 'ok', text: r.joinCode ? `Server repornit - join code ${r.joinCode}` : 'Server repornit', what };
  notify('Serverul Valheim e actualizat', `${what}\nRepornit${r.joinCode ? ` - join code ${r.joinCode}` : ''}`.trim());
  setWatch('idle', 'la zi');
  pollStatus(); schedulePublish('restart'); setTimeout(() => twoWay('după restart'), 1500);
  return { ok: true, joinCode: r.joinCode };
}
async function restartServer() {
  const tr = transport();
  setJob({ kind: 'restart', label: 'Restart server', started: Date.now() });
  log(`▶ Restart server (${tr.label()})`, 'start');
  try {
    let since = Math.floor(Date.now() / 1000);
    await tr.restart();
    const st = readState(); st.restartPending = false; writeState(st);
    if (!tr.docker) { log('■ Server repornit', 'done'); return { ok: true }; }
    // the valheim-server image: wait for an active join code; its join-code check sometimes crashes
    // (NullReferenceException in OnCheckJoinCodeSuccess) and leaves a code nobody can resolve -> restart the game only
    for (let attempt = 1; attempt <= 4; attempt++) {
      let code = null, bad = false;
      for (let i = 0; i < 60 && !code && !bad; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const out = await tr.logsSince(since).catch(() => '');
        const m = out.match(/with join code (\d+) and IP .* is active/);
        if (m) code = m[1]; else if (/OnCheckJoinCodeSuccess/.test(out)) bad = true;
      }
      if (code) { log(`■ Server pornit - join code ${code}`, 'done'); return { ok: true, joinCode: code }; }
      if (!bad) { log('■ Server pornit (fără join code - crossplay oprit?)', 'done'); return { ok: true }; }
      log(`  verificarea join code-ului a crăpat pe server (încercarea ${attempt}) - repornesc doar jocul`, 'out');
      since = Math.floor(Date.now() / 1000);
      await tr.restartGame();
    }
    return { ok: true };
  } finally { setJob(null); }
}

function tick() {
  if (!isAdmin() || !srv().conn || job) return;
  const s = srv(), sig = signature();
  if (sig !== seenSig) {
    const first = seenSig === null;
    seenSig = sig;
    if (!first) { changedAt = Date.now(); watch.dirty = true; send('mods', modsPayload()); setWatch('change', 'modurile s-au schimbat...'); }
    else if (syncedSig === null) syncedSig = sig;
    return;
  }
  if (changedAt && sig === syncedSig) { changedAt = null; watch.dirty = false; setWatch('idle', 'la zi'); }
  if (!s.autoSync) { if (watch.dirty && watch.state !== 'off') setWatch('off', 'auto-sync oprit - ai schimbări nesincronizate'); return; }
  if (changedAt && Date.now() - changedAt >= s.quietSeconds * 1000) { syncNow('modurile s-au schimbat'); return; }
  if (watch.retryAt && Date.now() >= watch.retryAt) { watch.retryAt = null; if (readState().restartPending) maybeRestart({}); else syncNow('reîncercare'); }
}

// ---------- status ----------
let status = { reachable: null, checkedAt: null };
let polling = false;
const publicAddress = () => (srv()?.role === 'player' ? manifest?.server?.address : status.publicIp) || null;
async function steamPlayers() {
  const a = a2s.parseAddress(publicAddress() || (srv()?.addresses || '').split(/[;\n]/).map(x => x.split('=')[1]).find(Boolean));
  if (!a) return null;
  const i = await a2s.info(a.host, a.queryPort);
  return i.players;
}
async function pollStatus() {
  const s = srv();
  if (!s || polling) return;
  polling = true;
  const prevCode = status.joinCode;
  try {
    if (s.role === 'admin' && s.conn) {
      const tr = transport();
      let st = await tr.status().catch(e => ({ reachable: false, error: e.message, checkedAt: Date.now() }));
      if (!st) {
        // no process view (plain SSH, local, FTP): the Steam query says if it is up and who plays
        st = { reachable: true, checkedAt: Date.now(), container: 'running' };
        try { const i = await (async () => { const a = a2s.parseAddress((s.addresses || '').split(/[;\n]/).map(x => x.split('=')[1]).find(Boolean)); return a ? a2s.info(a.host, a.queryPort) : null; })(); if (i) { st.players = i.players; st.gameUp = true; st.idle = i.players === 0; } }
        catch { st.gameUp = false; }
      }
      status = st;
    } else if (s.role === 'player') {
      const sv = manifest?.server || {};
      status = { reachable: true, checkedAt: Date.now(), container: 'running', joinCode: sv.joinCode || null, publicIp: sv.address || null, fromList: true };
      if (sv.address) { const a = a2s.parseAddress(sv.address); try { const i = await a2s.info(a.host, a.queryPort); status.players = i.players; status.gameUp = true; } catch { } }
    }
  } catch (e) { status = { reachable: false, error: e.message, checkedAt: Date.now() }; }
  polling = false;
  send('status', status); updateTray();
  if (s.role === 'admin' && status.joinCode && prevCode !== undefined && status.joinCode !== prevCode && !status.codeBroken) schedulePublish('join code nou');
}

// ---------- configs + mods put on the server by hand ----------
let twoWayBusy = false;
// which mod a config file belongs to: BepInEx names configs after the plugin GUID, and that GUID is a string inside
// the plugin's DLL; other mods may mention it too, so the package whose name matches best wins
async function configSides(rels) {
  const st = readState(), pr = getProfile(), best = new Map();
  const names = rels.map(r => r.split('/')[0].replace(/\.(cfg|ya?ml|json|txt)$/i, ''));
  const tokens = names.map(n => n.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3));
  for (const [k, p] of Object.entries(pr.packages)) {
    for (const f of (p.files || []).filter(x => /\.dll$/i.test(x))) {
      let txt;
      try { txt = fs.readFileSync(path.join(pr.dir, ...f.split('/'))).toString('latin1'); } catch { continue; }
      rels.forEach((r, i) => {
        if (names[i].length < 4 || !txt.includes(names[i])) return;
        const score = tokens[i].filter(t => k.toLowerCase().includes(t)).length;
        if (!best.has(r) || score > best.get(r).score) best.set(r, { key: k, score });
      });
      await new Promise(res => setImmediate(res));
    }
  }
  return new Map([...best].map(([r, b]) => [r, st.mods[b.key] === 'client' ? 'client' : 'server']));
}
async function twoWay(reason) {
  const s = srv();
  if (!isAdmin() || !s.conn || twoWayBusy || job || !(s.syncConfigs || s.pullServerMods)) return;
  twoWayBusy = true;
  const tr = transport(), pr = getProfile(), res = { at: Date.now(), push: 0, pull: 0, mods: [], error: null };
  try {
    if (s.pullServerMods) {
      const st = readState(), have = new Set(Object.keys(pr.packages)), builtin = new RegExp(s.builtin || 'BepInExPack', 'i');
      const extras = (await tr.list(tr.pluginsDir)).filter(n => !have.has(n) && !st.installed.includes(n) && !builtin.test(n));
      for (const e of extras) {
        if (job) break;
        const m = e.match(/^(.+?)-(\d+\.\d+\.\d+)$/), full = m ? m[1] : e, ver = m ? m[2] : null;
        setJob({ kind: 'pull', label: `Aduc de pe server: ${e}`, started: Date.now() });
        try {
          if (pr.packages[full]) {
            await tr.remove(tr.pluginsDir, [e]);
            log(`Pe server era și ${e} (pus de mână) - îl înlocuiesc cu ${full} din profil`);
          } else if (catalogIndex.get(full)) {
            await installThunderstore({ key: full, full, ver: ver || catalogIndex.get(full).ver, role: 'user', title: catalogIndex.get(full).name }, new Set());
            await tr.remove(tr.pluginsDir, [e]);
            log(`Adus de pe server: ${full} ${ver || ''} (din Thunderstore)`, 'done');
          } else {
            const tmp = path.join(DATA, 'cache', 'tmp', `srv-${Date.now()}`);
            for (const f of await tr.pull(tr.pluginsDir, e)) { const p = path.join(tmp, ...f.name.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.data); }
            pr.importManual(e, path.join(tmp, e), { ver: '', role: 'user', source: 'manual', title: e });
            fs.rmSync(tmp, { recursive: true, force: true });
            log(`Adus de pe server: ${e} (manual)`, 'done');
          }
          res.mods.push(full);
        } finally { setJob(null); }
      }
      if (res.mods.length) {
        const st2 = readState(); for (const n of res.mods) st2.mods[n] = 'server'; writeState(st2);
        notify('Moduri aduse de pe server', res.mods.join(', '));
        send('mods', modsPayload());
      }
    }
    if (s.syncConfigs) {
      const cacheFile = path.join(serverDir(s.id), 'remote-cache.json'), cache = readJson(cacheFile, {});
      const r = await syncConfigs({ transport: tr, configDir: configDir(), stateFile: path.join(serverDir(s.id), 'config-sync.json'), sideOf: configSides, cache });
      if (tr.hashless) writeJson(cacheFile, cache);
      res.push = r.push.length; res.pull = r.pull.length;
      if (r.push.length) log(`Configurări trimise pe server (${reason}): ${r.push.join(', ')}`, 'done');
      if (r.pull.length) log(`Configurări aduse de pe server (${reason}): ${r.pull.join(', ')}`, 'done');
    }
  } catch (e) { res.error = e.message; log(`Sincronizarea configurărilor: ${e.message}`, 'error'); }
  finally { twoWayBusy = false; watch.twoWay = res; send('watch', watch); }
}

// ---------- the list players read ----------
const listState = { at: null, ok: null, error: null, changed: null, busy: false };
let publishTimer = null;
function schedulePublish(reason) {
  const s = srv();
  if (!isAdmin() || !s.autoPublish) return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => publishList(reason), 4000);
}
function buildList() {
  const s = srv();
  return buildServerList({
    mods: adminMods().mods, nexusLinks: s.nexusLinks,
    server: { name: s.name, world: s.world, joinCode: status.codeBroken ? null : status.joinCode || null, joinCodeAt: status.joinCodeAt || null, address: s.publishAddress ? status.publicIp || null : null },
  });
}
let ghCliToken = undefined;
async function githubToken() {
  const t = dec(G.githubTokenEnc);
  if (t) return t;
  if (ghCliToken === undefined) ghCliToken = await new Promise(res => execFile('gh', ['auth', 'token'], { windowsHide: true }, (e, out) => res(e ? null : out.trim() || null)));
  return ghCliToken;
}
async function publishList(reason) {
  const s = srv();
  if (!isAdmin() || listState.busy) return { ok: false, error: 'ocupat' };
  const list = { ...buildList(), updatedAt: Date.now() };
  if (!list.required.length) { listState.error = 'Profilul nu are moduri de server - nu public lista.'; send('list', listState); return { ok: false, error: listState.error }; }
  if (readState().restartPending) { listState.error = 'Serverul nu a repornit încă cu modurile noi - public după restart.'; send('list', listState); return { ok: false, error: listState.error }; }
  const token = await githubToken();
  if (!token) { listState.error = 'Conectează-te la GitHub (Setări → GitHub) ca să public lista.'; send('list', listState); return { ok: false, error: listState.error }; }
  listState.busy = true; send('list', listState);
  try {
    const r = await listhost.publish(fetchN, token, s.list || { kind: 'gist' }, list, reason);
    if (!s.list || r.src.id !== s.list.id) { s.list = r.src; saveSettings(); send('settings', publicSettings()); }
    Object.assign(listState, { at: Date.now(), ok: true, error: null, changed: r.changed });
    if (r.changed) log(`Lista pentru prieteni publicată (${reason}): ${list.required.length} obligatorii, ${list.recommended.length} recomandate`, 'done');
    return { ok: true, changed: r.changed, invite: listhost.inviteLink(s.list, JOIN_PAGE) };
  } catch (e) {
    Object.assign(listState, { at: Date.now(), ok: false, error: e.message });
    log(`Lista pentru prieteni nu s-a publicat: ${e.message}`, 'error');
    return { ok: false, error: e.message };
  } finally { listState.busy = false; send('list', listState); }
}

// ---------- modpack (Thunderstore package that depends on the server's mods, for people without Bifrost) ----------
const modpackDir = () => path.join(serverDir(srv().id), 'modpack');
function modpackInfo() {
  const s = srv();
  if (!s || !isAdmin() || !s.modpackName) return { configured: false };
  const man = readJson(path.join(modpackDir(), 'manifest.json'), null);
  const prof = adminMods().mods.filter(m => !m.manual && !m.modpack);
  const inPack = {};
  for (const d of (man?.dependencies || [])) { const m = parseDep(d); if (m) inPack[m.full] = m.ver; }
  const added = [], changed = [], removed = [];
  for (const m of prof) {
    if (!(m.name in inPack)) added.push({ name: m.name, to: m.version });
    else if (inPack[m.name] !== m.version) changed.push({ name: m.name, from: inPack[m.name], to: m.version });
  }
  const names = new Set(prof.map(m => m.name));
  for (const n of Object.keys(inPack)) if (!names.has(n)) removed.push({ name: n, from: inPack[n] });
  const local = man?.version_number || null;
  const zip = local && path.join(modpackDir(), `${s.modpackName}-${local}.zip`);
  return {
    configured: true, name: ownPack(), local, published: updates[ownPack()]?.latest || null, count: Object.keys(inPack).length,
    added, changed, removed, hasToken: !!s.tsTokenEnc, zip: zip && fs.existsSync(zip) ? zip : null, url: `${TS}/c/valheim/p/${s.modpackTeam}/${s.modpackName}/`,
  };
}
async function buildModpack() {
  const s = srv(), dir = modpackDir();
  fs.mkdirSync(dir, { recursive: true });
  const deps = adminMods().mods.filter(m => !m.manual && !m.modpack).map(m => `${m.name}-${m.version}`);
  const old = readJson(path.join(dir, 'manifest.json'), null);
  let version = '1.0.0';
  if (old) { const [a, b, c] = old.version_number.split('.').map(Number); version = `${a}.${b}.${c + 1}`; }
  const published = updates[ownPack()]?.latest;
  if (published && cmpVer(published, version) >= 0) { const [a, b, c] = published.split('.').map(Number); version = `${a}.${b}.${c + 1}`; }
  const manifestJson = { name: s.modpackName, version_number: version, website_url: '', description: `Mods for the ${s.name} Valheim server.`.slice(0, 250), dependencies: deps };
  const stage = path.join(dir, 'stage');
  fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage);
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifestJson, null, 2));
  fs.writeFileSync(path.join(stage, 'README.md'), `# ${s.modpackName}\n\nAll the mods of the **${s.name}** Valheim server.\n\n## Mods (${deps.length})\n${deps.map(d => `- ${d}`).join('\n')}\n`);
  fs.copyFileSync(path.join(__dirname, 'ui', 'app.png'), path.join(stage, 'icon.png'));
  const zip = path.join(dir, `${s.modpackName}-${version}.zip`);
  fs.rmSync(zip, { force: true });
  await run7z(['a', '-tzip', zip, 'manifest.json', 'README.md', 'icon.png'], stage);
  fs.copyFileSync(path.join(stage, 'manifest.json'), path.join(dir, 'manifest.json'));
  fs.rmSync(stage, { recursive: true, force: true });
  log(`Modpack ${s.modpackName} ${version}: ${deps.length} moduri`, 'done');
  send('modpack', modpackInfo());
  return { ok: true, info: modpackInfo() };
}
async function tsApi(token, method, p, body) {
  const r = await fetchN(`${TS}${p}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { }
  if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status} ${text.slice(0, 300)}`);
  return j;
}
async function publishModpack() {
  const s = srv(), token = dec(s.tsTokenEnc);
  if (!token) return { ok: false, error: 'Lipsește tokenul Thunderstore (Setări).' };
  const b = await buildModpack();
  const zip = b.info.zip;
  if (!zip) return { ok: false, error: 'Nu găsesc zip-ul construit.' };
  setJob({ kind: 'publish', label: `Public ${path.basename(zip)}`, started: Date.now() });
  let uuid = null;
  try {
    const data = fs.readFileSync(zip);
    const init = await tsApi(token, 'POST', '/api/experimental/usermedia/initiate-upload/', { filename: path.basename(zip), file_size_bytes: data.length });
    uuid = init.user_media.uuid;
    const parts = [];
    for (const u of init.upload_urls) {
      const chunk = data.subarray(u.offset, u.offset + u.length);
      const r = await fetchN(u.url, { method: 'PUT', body: chunk, headers: { 'Content-MD5': crypto.createHash('md5').update(chunk).digest('base64') } });
      const etag = r.headers.get('etag');
      if (!r.ok || !etag) throw new Error(`upload partea ${u.part_number}: HTTP ${r.status}`);
      parts.push({ ETag: etag, PartNumber: u.part_number });
    }
    await tsApi(token, 'POST', `/api/experimental/usermedia/${uuid}/finish-upload/`, { parts });
    let cats = [];
    try { const c = await tsApi(token, 'GET', '/api/experimental/community/valheim/category/'); const hit = (c.results || []).find(x => /modpack/i.test(x.slug) || /modpack/i.test(x.name)); if (hit) cats = [hit.slug]; } catch { }
    const res = await tsApi(token, 'POST', '/api/experimental/submission/submit/', { author_name: s.modpackTeam, communities: ['valheim'], community_categories: { valheim: cats }, categories: [], has_nsfw_content: false, upload_uuid: uuid });
    const v = res?.package_version?.version_number || b.info.local;
    log(`■ Publicat ${s.modpackName} ${v}`, 'done');
    updates[ownPack()] = { latest: v };
    return { ok: true, version: v };
  } catch (e) {
    if (uuid) { try { await tsApi(token, 'POST', `/api/experimental/usermedia/${uuid}/abort-upload/`, {}); } catch { } }
    log(`■ Publicarea a eșuat: ${e.message}`, 'error');
    return { ok: false, error: e.message };
  } finally { setJob(null); send('modpack', modpackInfo()); }
}

// =====================================================================================================
// SERVERS: add (invite), create (admin), import, switch, remove
// =====================================================================================================
function uniqueId(name) { let id = slug(name), i = 2; while (G.servers.some(s => s.id === id)) id = `${slug(name)}-${i++}`; return id; }
function activate(id) {
  G.activeServer = id; saveSettings();
  profile = null; seenSig = null; syncedSig = null; changedAt = null; status = { reachable: null };
  Object.assign(watch, { text: '', state: 'idle', dirty: false, lastSync: null, lastResult: null, retryAt: null, twoWay: null });
  Object.assign(listState, { at: null, ok: null, error: null, changed: null, busy: false });
  loadManifestCache(); indexCatalog();
  if (win) win.webContents.reload();
  setTimeout(() => { pollStatus(); if (srv()?.role === 'player') refreshManifest(); }, 1500);
}
async function addServer(invite) {
  const src = listhost.parseInvite(invite);
  if (!src) return { ok: false, error: 'Nu recunosc invitația - lipește linkul sau codul primit (ex. g.1a2b3c...).' };
  const existing = G.servers.find(s => JSON.stringify(s.list) === JSON.stringify(src));
  if (existing) { activate(existing.id); return { ok: true, id: existing.id, existed: true }; }
  let m;
  try { m = await listhost.fetchList(fetchN, src); } catch (e) { return { ok: false, error: `Nu pot citi lista serverului: ${e.message}` }; }
  const name = m.server?.name || 'Server';
  const id = uniqueId(name);
  G.servers.push({ ...SERVER_DEFAULTS, id, name, role: 'player', list: src, profileDir: path.join(DATA, 'profiles', id), createdAt: Date.now() });
  writeJson(path.join(serverDir(id), 'list-cache.json'), m);
  saveSettings();
  log(`Server adăugat: ${name} (${listhost.inviteCode(src)})`, 'done');
  activate(id);
  return { ok: true, id, name, required: m.required.length };
}
// cfg: { name, world, conn, secret, builtin, source: { kind: 'empty'|'local'|'code'|'server', dir, code }, list: { kind: 'gist'|'github', repo } }
async function createServer(cfg) {
  if (job) return { ok: false, error: 'Lucrez deja.' };
  const id = uniqueId(cfg.name);
  const s = {
    ...SERVER_DEFAULTS, id, name: cfg.name || 'Server', role: cfg.personal ? 'player' : 'admin', world: cfg.world || '', createdAt: Date.now(),
    profileDir: path.join(DATA, 'profiles', id), conn: cfg.conn || null, connSecretEnc: cfg.secret ? enc(cfg.secret) : null,
    builtin: cfg.builtin || (cfg.conn?.type === 'ssh-docker' ? 'ValheimPlus|BepInExPack' : 'BepInExPack'),
    list: cfg.list?.kind === 'github' && cfg.list.repo ? { kind: 'github', repo: cfg.list.repo, path: 'server.json' } : null,
  };
  G.servers.push(s); saveSettings();
  G.activeServer = id; profile = null;
  log(`Server nou: ${s.name} (${s.conn ? s.conn.type : 'fără conexiune'})`, 'done');
  const r = await importInto(cfg.source || { kind: 'empty' });
  activate(id);
  if (r.ok && s.conn) setTimeout(() => syncNow('server nou'), 4000);
  return { ...r, id };
}
// fill the current profile: other mod managers, a profile code or what the server already runs
async function importInto(source) {
  if (source.kind === 'empty') {
    await installThunderstore({ key: BEPINEX, full: BEPINEX, ver: catalogIndex.get(BEPINEX)?.ver || '5.4.2351', role: 'user', title: 'BepInExPack Valheim' }, new Set()).catch(e => log(e.message, 'error'));
    return { ok: true, count: Object.keys(getProfile().packages).length };
  }
  setJob({ kind: 'import', label: 'Import moduri', started: Date.now() });
  const pr = getProfile();
  try {
    let mods = [], manual = [], configs = null;
    if (source.kind === 'local') {
      const p = importers.readProfileMods(source.dir);
      mods = p.mods; manual = p.manual.map(n => ({ name: n, abs: path.join(p.pluginsDir, n) })); configs = { dir: p.configDir };
    } else if (source.kind === 'code') {
      const p = await tsprofile.importCode(fetchN, source.code);
      mods = p.mods.map(m => ({ ...m, ver: m.ver || catalogIndex.get(m.full)?.ver })).filter(m => m.ver); configs = { files: p.configs };
    } else if (source.kind === 'server') {
      // a server's plugin folders: Thunderstore copies carry manifest.json; the rest comes over as manual mods
      const tr = transport(), st = readState();
      const builtin = new RegExp(srv().builtin || 'BepInExPack', 'i');
      for (const n of (await tr.list(tr.pluginsDir)).filter(x => !builtin.test(x))) {
        let man = null;
        try { man = JSON.parse((await tr.read(tr.pluginsDir, `${n}/manifest.json`)).toString('utf8').replace(/^﻿/, '')); } catch { }
        const base = n.replace(/-\d+\.\d+\.\d+$/, '');
        const full = man?.name && base.endsWith(man.name) ? base : catalogIndex.has(base) ? base : null;
        if (full && (man?.version_number || catalogIndex.get(full))) mods.push({ full, ver: man?.version_number || catalogIndex.get(full).ver, title: full, serverFolder: n });
        else manual.push({ name: n, server: true });
        // being on the server does not make it a server mod (with "all mods on the server" client mods are there too):
        // Thunderstore's categories when they say it, otherwise the README/DLL guess at the first sync
        const side = full ? sideFromCats(catalogIndex.get(full)) : null;
        if (side) st.mods[full] = side;
      }
      writeState(st);
      if (!mods.some(m => m.full === BEPINEX)) mods.unshift({ full: BEPINEX, ver: catalogIndex.get(BEPINEX)?.ver || '5.4.2351', title: 'BepInExPack Valheim' });
    }
    const names = new Set(mods.map(m => m.full));
    setProgress({ phase: 'install', text: '', done: 0, total: mods.length + manual.length });
    for (const [i, m] of mods.sort((a, b) => (b.full === BEPINEX) - (a.full === BEPINEX)).entries()) {
      setProgress({ ...progress, done: i });
      try { await installThunderstore({ key: m.full, full: m.full, ver: m.ver, role: 'user', title: m.title || m.full }, names); }
      catch (e) { log(`  ${m.full} ${m.ver}: ${e.message}`, 'error'); }
    }
    for (const m of manual) {
      if (m.server) {
        const tmp = path.join(DATA, 'cache', 'tmp', `srv-${Date.now()}`);
        for (const f of await transport().pull(transport().pluginsDir, m.name)) { const p = path.join(tmp, ...f.name.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.data); }
        pr.importManual(m.name, path.join(tmp, m.name), { ver: '', role: 'user', source: 'manual', title: m.name });
        fs.rmSync(tmp, { recursive: true, force: true });
      } else pr.importManual(m.name, m.abs, { ver: '', role: 'user', source: 'manual', title: m.name });
      log(`  copiat ${m.name} (manual)`, 'out');
    }
    if (configs?.dir && fs.existsSync(configs.dir)) fs.cpSync(configs.dir, configDir(), { recursive: true, force: true });
    if (configs?.files) for (const f of configs.files) { const p = path.join(configDir(), ...f.rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.data); }
    log(`■ Import gata: ${Object.keys(pr.packages).length} pachete`, 'done');
    return { ok: true, count: Object.keys(pr.packages).length };
  } catch (e) { log(`■ Importul a eșuat: ${e.message}`, 'error'); return { ok: false, error: e.message }; }
  finally { setProgress(null); setJob(null); afterProfileChange(); }
}
function removeServer(id) {
  const s = G.servers.find(x => x.id === id);
  if (!s) return { ok: false, error: 'nu există' };
  if (job) return { ok: false, error: 'Lucrez deja.' };
  G.servers = G.servers.filter(x => x.id !== id);
  // its profile and data; the shared download cache stays
  for (const d of [s.profileDir, serverDir(id)]) { try { if (d && d.startsWith(DATA)) fs.rmSync(d, { recursive: true, force: true }); } catch { } }
  log(`Server șters: ${s.name}`);
  activate(G.activeServer === id ? (G.servers[0]?.id || null) : G.activeServer);
  return { ok: true };
}

// =====================================================================================================
// NEXUS (shared)
// =====================================================================================================
async function nexusInstallNow(e, nxm) {
  setJob({ kind: 'nexus', label: `Instalez ${e.title} (Nexus)`, started: Date.now() });
  log(`▶ ${job.label}`, 'start');
  try {
    setProgress({ phase: 'install', text: e.title, done: 0, total: 1 });
    await installNexus({ key: `nexus-${e.modId}`, full: `nexus-${e.modId}`, ver: String(e.version || e.fileId), role: e.role || 'user', title: e.title, modId: e.modId, fileId: e.fileId }, nxm);
    if (e.role === 'recommended') { srv().nexusChosen[`nexus-${e.modId}`] = true; saveSettings(); }
    delete nexusPending[e.modId];
    nexusWaiting = nexusWaiting.filter(n => n.modId !== e.modId);
    log(`■ ${e.title} instalat`, 'done');
    notify('Instalat de pe Nexus', e.title);
    return { ok: true };
  } catch (err) { log(`■ Nexus: ${err.message}`, 'error'); return { ok: false, error: err.message }; }
  finally { setProgress(null); setJob(null); send('nexusPending', nexusPending); afterProfileChange(); }
}
async function nexusInstall({ modId, fileId, title, version, fileName }) {
  if (!srv()) return { ok: false, error: 'Adaugă sau creează întâi un server.' };
  if (!dec(G.nexusKeyEnc)) return { ok: false, error: 'Pune întâi cheia ta Nexus în Setări → Nexus Mods.', needKey: true };
  if (!fileId) {
    const f = Nexus.pickMain(await nexus.modFiles(modId));
    if (!f) return { ok: false, error: 'Modul nu are fișiere de descărcat.' };
    fileId = f.fileId; version = version || f.version;
  }
  const e = { modId: +modId, fileId: +fileId, title, version, fileName };
  if (G.nexusUser?.premium) { if (job) return { ok: false, error: 'Lucrez deja.' }; return nexusInstallNow(e); }
  nexusPending[e.modId] = { ...e, at: Date.now() };
  send('nexusPending', nexusPending);
  shell.openExternal(Nexus.filesPage(e.modId, e.fileId));
  return { ok: true, waiting: true };
}
async function handleLink(url) {
  showWindow();
  if (/^bifrost:\/\//i.test(url)) {
    const r = await addServer(url);
    toast(r.ok ? (r.existed ? 'Serverul era deja adăugat.' : `Server adăugat: ${r.name}. Apasă JOACĂ.`) : r.error, r.ok ? 'ok' : 'error');
    return;
  }
  const x = Nexus.parseNxm(url);
  if (!x) return toast('Link Nexus nevalid.', 'error');
  if (x.game !== 'valheim') return toast(`Linkul e pentru ${x.game}, nu Valheim.`, 'error');
  if (job) return toast('Lucrez deja - apasă din nou după ce termin.', 'error');
  if (!srv()) return toast('Adaugă sau creează întâi un server.', 'error');
  const pend = nexusPending[x.modId];
  const want = nexusWaiting.find(n => n.modId === x.modId) || (manifest?.nexus || []).filter(n => n.modId === x.modId)
    .map(n => ({ modId: n.modId, title: n.title, version: n.version, role: n.required ? 'required' : 'recommended' }))[0];
  let e = pend ? { ...pend } : want ? { ...want } : null;
  if (!e) { const m = await nexus.modInfo(x.modId).catch(() => null); e = { modId: x.modId, title: m?.name || `Nexus ${x.modId}`, version: m?.version || '' }; }
  e.fileId = x.fileId;
  const r = await nexusInstallNow(e, x);
  toast(r.ok ? `${e.title} instalat.` : r.error, r.ok ? 'ok' : 'error');
  if (r.ok && nexusWaiting.length) shell.openExternal(Nexus.filesPage(nexusWaiting[0].modId, nexusWaiting[0].fileId));
}

// =====================================================================================================
// APP UPDATES (code bundles, see lib/codeupdate.js)
// =====================================================================================================
let appUpdate = null;
let updateBusy = false;
async function checkAppUpdate() {
  if (updateBusy) return;
  updateBusy = true;
  try {
    const r = await codeupdate.check({ fetch: fetchN, repo: REPO, current: OWN_VERSION, electronMajor: ELECTRON_MAJOR });
    const base = { current: OWN_VERSION, latest: r.latest, checkedAt: Date.now(), source: !app.isPackaged, page: r.page || `https://github.com/${REPO}/releases/latest` };
    if (!r.newer) { if (!appUpdate?.ready) { appUpdate = { ...base, upToDate: true }; send('appUpdate', appUpdate); } return; }
    if (r.needsInstaller || !app.isPackaged) { appUpdate = { ...base, version: r.latest, ready: false, installer: true }; send('appUpdate', appUpdate); return; }
    if (appUpdate?.ready && appUpdate.version === r.latest) return;
    appUpdate = { ...base, version: r.latest, ready: false, downloading: true }; send('appUpdate', appUpdate);
    await codeupdate.install({ download: (u, f, size) => new Profile({ dir: path.join(DATA, 'app'), cacheDir: path.join(DATA, 'app'), fetch: fetchN }).download(u, f, null, size), appData: app.getPath('appData'), version: r.latest, bundle: r.bundle, electronMajor: ELECTRON_MAJOR });
    appUpdate = { ...base, version: r.latest, ready: true }; send('appUpdate', appUpdate);
    log(`Bifrost ${r.latest} descărcat - se folosește la următoarea pornire`, 'done');
    notify('Bifrost', `Versiunea ${r.latest} e gata - repornește Bifrost ca s-o folosești.`);
  } catch (e) { log(`update: ${e.message}`); appUpdate = { ...(appUpdate || {}), current: OWN_VERSION, error: e.message, checkedAt: Date.now() }; send('appUpdate', appUpdate); }
  finally { updateBusy = false; }
}

// =====================================================================================================
// IPC
// =====================================================================================================
ipcMain.handle('init', () => ({
  settings: publicSettings(), profile: modsPayload(), status, job, watch, installing, catalogFetched: catalog?.fetched || null,
  log: logTail.slice(-400), updates, modpack: modpackInfo(), list: listState, player: playerInfo(), appUpdate, version: OWN_VERSION,
}));
ipcMain.handle('action', (_e, name, arg) => action(name, arg));
ipcMain.handle('installUpdate', () => { quitting = true; app.relaunch(); app.quit(); });
const SERVER_SETTABLE = { serverName: 'name', serverWorld: 'world', addresses: 'addresses', autoSync: 'autoSync', quietSeconds: 'quietSeconds', retryMinutes: 'retryMinutes',
  syncConfigs: 'syncConfigs', syncAllMods: 'syncAllMods', pullServerMods: 'pullServerMods', autoPublish: 'autoPublish', publishAddress: 'publishAddress', builtin: 'builtin', modpackTeam: 'modpackTeam', modpackName: 'modpackName' };
const GLOBAL_SETTABLE = ['startWithWindows', 'notifications', 'gameDir', 'lang'];
async function action(name, arg) {
  const s = srv();
  switch (name) {
    // ----- servers -----
    case 'addServer': return addServer(arg);
    case 'createServer': return createServer(arg);
    case 'switchServer': if (G.servers.some(x => x.id === arg)) activate(arg); return { ok: true };
    case 'removeServer': return removeServer(arg);
    case 'localProfiles': return { ok: true, profiles: importers.localProfiles(app.getPath('appData')) };
    case 'testConnection': {
      try { const tr = makeTransport(arg.conn, arg.secret || dec(s?.connSecretEnc)); const r = await tr.test(); let mods = null; try { mods = (await tr.list(tr.pluginsDir)).length; } catch { } return { ok: true, ...r, mods }; }
      catch (e) { return { ok: false, error: e.message }; }
    }
    case 'setConnection': {
      if (!isAdmin()) return { ok: false };
      s.conn = arg.conn; if (arg.secret !== undefined) s.connSecretEnc = arg.secret ? enc(arg.secret) : null;
      if (arg.builtin !== undefined) s.builtin = arg.builtin;
      saveSettings(); send('settings', publicSettings()); pollStatus(); return { ok: true };
    }
    case 'importInto': { const r = await importInto(arg); if (r.ok && isAdmin()) setTimeout(() => syncNow('import'), 3000); return r; }
    case 'exportCode': {
      if (!s) return { ok: false };
      try {
        const mods = Object.entries(getProfile().packages).filter(([, x]) => x.source === 'thunderstore').map(([k, x]) => ({ full: k, ver: x.ver }));
        const code = await tsprofile.exportCode(fetchN, { name: s.name, mods, configDir: arg?.configs ? configDir() : null, sevenZip: run7z });
        return { ok: true, code };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    // ----- admin -----
    case 'sync': syncNow('manual'); return { ok: true };
    case 'dryrun': {
      if (!s?.conn) return { ok: false, error: 'Serverul nu are conexiune.' };
      try {
        const st = readState();
        const r = await syncMods(st, { pluginsDir: pluginsDir(), transport: transport(), builtin: new RegExp(s.builtin || 'BepInExPack', 'i'), allMods: s.syncAllMods, dryRun: true });
        return { ok: true, toCopy: r.copy.join(', ') || '-', toRemove: r.remove.join(', ') || '-' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    case 'restart': try { const st = readState(); st.restartPending = true; writeState(st); return await maybeRestart({ manual: true, force: true }); } catch (e) { return { ok: false, error: e.message }; }
    case 'fixcode': try { await transport().restartGame(); setTimeout(pollStatus, 20000); setTimeout(pollStatus, 60000); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
    case 'startServer': try { await transport().ssh(`cd ~ && docker start ${s.conn.container}`); setTimeout(pollStatus, 5000); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
    case 'setSide': return setSide(arg.name, arg.side);
    case 'refresh': pollStatus(); send('mods', modsPayload()); return { ok: true };
    case 'publishList': return publishList('manual');
    case 'twoWay': await twoWay('manual'); return { ok: !watch.twoWay?.error, ...(watch.twoWay || {}) };
    case 'nexusLink': {
      if (!arg.url) { delete s.nexusLinks[arg.name]; saveSettings(); send('mods', modsPayload()); return { ok: true }; }
      const modId = Nexus.parseModUrl(arg.url);
      if (!modId) return { ok: false, error: 'Lipește linkul paginii Nexus (nexusmods.com/valheim/mods/...).' };
      try {
        const [m, files] = await Promise.all([nexus.modInfo(modId), nexus.modFiles(modId)]);
        const f = Nexus.pickMain(files);
        if (!f) return { ok: false, error: 'Modul nu are fișiere.' };
        s.nexusLinks[arg.name] = { modId, fileId: f.fileId, fileName: f.name, version: f.version || m?.version, title: m?.name || f.name };
        saveSettings(); send('mods', modsPayload()); schedulePublish('legătură Nexus');
        return { ok: true, link: s.nexusLinks[arg.name] };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    case 'buildModpack': return buildModpack();
    case 'publishModpack': return publishModpack();
    case 'showZip': { const z = modpackInfo().zip; if (z) shell.showItemInFolder(z); return { ok: !!z }; }
    case 'setToken': s.tsTokenEnc = arg ? enc(arg) : null; saveSettings(); send('settings', publicSettings()); send('modpack', modpackInfo()); return { ok: true };
    // ----- shared -----
    case 'checkUpdates': await checkUpdates(10 * 60e3); return { ok: true };
    case 'catalog':
      if (!catalog) await refreshCatalog(); else if (Date.now() - catalog.fetched > 6 * 3600e3) refreshCatalog();
      return { ok: !!catalog, fetched: catalog?.fetched || null, packages: catalog?.packages || [] };
    case 'refreshCatalog': { const ok = await refreshCatalog(); return { ok, fetched: catalog?.fetched || null, packages: ok ? catalog.packages : null }; }
    case 'install': return installPackage(arg.full, arg.ver);
    case 'remove': return removePackage(arg);
    case 'updateAll': return updateAll();
    case 'readme': {
      try {
        const r = await fetchN(`${TS}/api/experimental/package/${encodeURIComponent(arg.owner)}/${encodeURIComponent(arg.name)}/${encodeURIComponent(arg.ver)}/readme/`);
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
        return { ok: true, markdown: (await r.json()).markdown || '' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    case 'setNexusKey': {
      if (!arg) { G.nexusKeyEnc = null; G.nexusUser = null; saveSettings(); send('settings', publicSettings()); return { ok: true }; }
      nexus.key = String(arg).trim();
      try {
        const u = await nexus.validate();
        G.nexusKeyEnc = enc(arg); G.nexusUser = { name: u.name, premium: !!u.is_premium };
        saveSettings(); registerProtocols(); send('settings', publicSettings()); send('player', playerInfo());
        return { ok: true, user: G.nexusUser };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    case 'githubLogin': {
      if (!GITHUB_CLIENT_ID) return { ok: false, error: 'Login-ul GitHub din app nu e configurat - lipește un token (scope „gist”).' };
      try {
        const start = await listhost.deviceStart(fetchN, GITHUB_CLIENT_ID);
        shell.openExternal(start.verification_uri);
        listhost.devicePoll(fetchN, GITHUB_CLIENT_ID, start).then(async t => {
          const u = await listhost.whoami(fetchN, t);
          G.githubTokenEnc = enc(t); G.githubUser = u.login; saveSettings(); send('settings', publicSettings());
          toast(`Conectat la GitHub ca ${u.login}.`, 'ok');
        }).catch(e => toast(e.message, 'error'));
        return { ok: true, code: start.user_code, uri: start.verification_uri };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    case 'setGithubToken': {
      if (!arg) { G.githubTokenEnc = null; G.githubUser = null; ghCliToken = undefined; saveSettings(); send('settings', publicSettings()); return { ok: true }; }
      try { const u = await listhost.whoami(fetchN, String(arg).trim()); G.githubTokenEnc = enc(arg); G.githubUser = u.login; saveSettings(); send('settings', publicSettings()); return { ok: true, user: u.login }; }
      catch (e) { return { ok: false, error: e.message }; }
    }
    case 'setSetting': {
      if (GLOBAL_SETTABLE.includes(arg.key)) { G[arg.key] = arg.value; saveSettings(); if (arg.key === 'startWithWindows') applyStartup(); }
      else if (SERVER_SETTABLE[arg.key] && s) {
        s[SERVER_SETTABLE[arg.key]] = arg.value; saveSettings();
        if (arg.key === 'autoSync') { if (arg.value && watch.dirty) changedAt = Date.now() - s.quietSeconds * 1000; setWatch(arg.value ? 'idle' : 'off', arg.value ? 'pornit' : 'auto-sync oprit'); }
        if (arg.key === 'publishAddress' || arg.key === 'serverName' || arg.key === 'serverWorld') schedulePublish('setări');
      } else return { ok: false };
      send('settings', publicSettings()); return { ok: true };
    }
    case 'copy': clipboard.writeText(String(arg)); return { ok: true };
    case 'open': {
      const targets = { log: LOG_FILE, folder: DATA, profile: s ? getProfile().dir : DATA, game: game.game };
      if (targets[arg]) { const err = await shell.openPath(targets[arg]); return { ok: !err, error: err || null }; }
      if (/^https:\/\//.test(arg)) { shell.openExternal(arg); return { ok: true }; }
      return { ok: false };
    }
    case 'quit': quitting = true; app.quit(); return { ok: true };
    // ----- player -----
    case 'play': return playerSync({ launch: true });
    case 'updateMods': return playerSync({ launch: false });
    case 'refreshList': await refreshManifest(); return { ok: !manifestErr, error: manifestErr };
    case 'setRecommended': {
      const bag = arg.nexus ? s.nexusChosen : s.recommended;
      if (arg.on) bag[arg.key] = true; else delete bag[arg.key];
      saveSettings(); send('player', playerInfo()); return { ok: true };
    }
    case 'nexusPage': shell.openExternal(Nexus.filesPage(arg.modId, arg.fileId)); return { ok: true };
    case 'nexusSearch': try { return { ok: true, ...(await nexus.search(arg)) }; } catch (e) { return { ok: false, error: e.message }; }
    case 'nexusFiles': try { return { ok: true, files: await nexus.modFiles(arg) }; } catch (e) { return { ok: false, error: e.message }; }
    case 'nexusInstall': try { return await nexusInstall(arg); } catch (e) { return { ok: false, error: e.message }; }
    case 'nexusInstalled': {
      const out = {};
      if (s) for (const p of Object.values(getProfile().packages)) if (p.source === 'nexus') out[p.modId] = p.ver;
      return { ok: true, installed: out, pending: nexusPending };
    }
    case 'findGame': game = await Profile.findGame(); send('player', playerInfo()); return { ok: !!game.game, game };
    case 'restoreLoader': {
      if (!game.game) return { ok: false, error: 'Nu găsesc folderul jocului.' };
      const ok = Profile.restoreGame(game.game);
      send('player', playerInfo());
      return ok ? { ok: true } : { ok: false, error: 'Nu există backup (Bifrost nu a înlocuit nimic).' };
    }
    case 'checkAppUpdate': await checkAppUpdate(); return { ok: true, update: appUpdate };
  }
  return { ok: false, error: `unknown action ${name}` };
}

// =====================================================================================================
// START
// =====================================================================================================
app.on('second-instance', (_e, argv) => { const l = linkArg(argv); if (l) handleLink(l); else showWindow(); });
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (quitting) app.quit(); });

app.whenReady().then(async () => {
  protocol.handle('modicon', req => {
    const name = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''));
    if (!name || name.includes('..') || /[\\/]/.test(name)) return new Response('', { status: 404 });
    return net.fetch(pathToFileURL(path.join(pluginsDir(), name, 'icon.png')).toString());
  });
  if (!dataArg) ensureShortcuts();
  if (!dataArg) { applyStartup(); registerProtocols(); }
  createTray();
  createWindow(!process.argv.includes('--hidden'));
  log(`Bifrost ${OWN_VERSION} pornit (${G.servers.length} servere${srv() ? `, activ: ${srv().name} - ${srv().role === 'admin' ? 'admin' : 'jucător'}` : ''})`);
  loadManifestCache();
  indexCatalog();
  setTimeout(() => checkUpdates(6 * 3600e3), 6000);
  setInterval(() => checkUpdates(6 * 3600e3), 3600e3);
  setTimeout(checkAppUpdate, 15000); setInterval(checkAppUpdate, 4 * 3600e3);
  game = await Profile.findGame();
  if (G.gameDir) game.game = G.gameDir;
  // admin: watch the profile, sync, configs; everyone: status + the list
  setTimeout(() => { if (isAdmin() && srv().conn && srv().autoSync) syncNow('pornire'); }, 4000);
  setInterval(tick, 3000);
  setInterval(() => twoWay('verificare periodică'), 3 * 60e3);
  pollStatus();
  setInterval(() => { if (win && win.isVisible()) pollStatus(); }, 20000);
  setInterval(() => { if (!win || !win.isVisible()) pollStatus(); }, 120000);
  refreshManifest();
  setInterval(() => { if (!job && srv()?.role === 'player') refreshManifest(); }, 10 * 60e3);
  const l = linkArg(process.argv); if (l) setTimeout(() => handleLink(l), 2500);
  // test hook: --run=<action>[:json arg]
  const run = (process.argv.find(a => a.startsWith('--run=')) || '').slice(6);
  if (run) setTimeout(async () => { const [n, ...rest] = run.split(':'); const raw = rest.join(':'); const arg = !raw ? undefined : raw.startsWith('@') ? readJson(raw.slice(1), null) : JSON.parse(raw); log(`--run ${n}: ${JSON.stringify(await action(n, arg))}`); }, 8000);
});
