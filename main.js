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
const LINUX = process.platform === 'linux';
// test hook: --perf prints startup marks and, every 10 s, the CPU and memory of all Bifrost processes
const PERF = process.argv.includes('--perf');
const perf = m => { if (PERF) console.log(`[perf] ${Math.round(process.uptime() * 1000)}ms ${m}`); };
perf('main.js loaded');
// AppImage: Chromium's setuid sandbox helper cannot work from the read-only mount (and Ubuntu 24.04 blocks the other one)
if (LINUX && process.env.APPIMAGE) app.commandLine.appendSwitch('no-sandbox');
// Chromium's HTTP cache (Discover icons, API answers) stays small; mod files have their own cache
app.commandLine.appendSwitch('disk-cache-size', String(100 * 1024 * 1024));
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { Profile, BEPINEX, cmpVer, parseDep } = require('./lib/profile');
const { Nexus } = require('./lib/nexus');
const { build: buildServerList } = require('./lib/manifest');
const listhost = require('./lib/listhost');
const { makeTransport, walk, normSha } = require('./lib/transport');
const { syncMods } = require('./lib/modsync');
const { syncConfigs, SKIP: CFG_SKIP, safeRel } = require('./lib/serversync');
const bepcfg = require('./lib/bepcfg');
const serverenv = require('./lib/serverenv');
const { metadata: dllMetadata } = require('./lib/dllmeta');
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
  lang: null, notifications: true, startWithWindows: null, gameDir: null, shortcutsV2: false, bepConsoleMode: 'nowarn',
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
  // PLAY joins the server straight away (Valheim's +connect / -password); address empty = from the list / server logs
  directJoin: true, joinAddress: '', joinPassEnc: null,
};
// settings.json that does not parse (a crash while writing, a bad hand edit) is never replaced with empty defaults:
// the last good copy (settings.json.bak, refreshed at every start) is used and the broken file is kept beside it
const settingsNotes = [];
function loadSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  const raw = readJson(SETTINGS_FILE, null);
  if (raw && typeof raw === 'object') { try { fs.copyFileSync(SETTINGS_FILE, SETTINGS_FILE + '.bak'); } catch { } return raw; }
  const broken = SETTINGS_FILE.replace(/\.json$/, `.broken-${Date.now()}.json`);
  try { fs.copyFileSync(SETTINGS_FILE, broken); } catch { }
  const bak = readJson(SETTINGS_FILE + '.bak', null);
  settingsNotes.push(bak ? `settings.json was damaged - the good copy from the previous start was used (the damaged one is kept as ${path.basename(broken)})`
    : `settings.json was damaged and there is no copy - the damaged file is kept as ${path.basename(broken)}`);
  return bak && typeof bak === 'object' ? bak : {};
}
let G = { ...GLOBAL_DEFAULTS, ...loadSettings() };
const serverDir = id => path.join(DATA, 'servers', id);

// before 1.1 there was one server, with its settings at the top level
function migrateFlat() {
  if (Array.isArray(G.servers) && G.servers.length) return;
  const raw = readJson(SETTINGS_FILE, null) || readJson(SETTINGS_FILE + '.bak', null);
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
  const { connSecretEnc, tsTokenEnc, joinPassEnc, ...rest } = s;
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
      autoPublish: s.autoPublish, publishAddress: s.publishAddress, hasToken: !!s.tsTokenEnc,
      canRestart: !!(s.conn && (s.conn.type === 'ssh-docker' || s.conn.restartCmd)), dockerServer: s.conn?.type === 'ssh-docker',
      directJoin: s.directJoin !== false, joinAddress: s.joinAddress || '', hasJoinPass: !!s.joinPassEnc, joinTarget: joinTarget() } : {}),
  };
};

// =====================================================================================================
// WINDOW / TRAY / LOG
// =====================================================================================================
let win = null, tray = null, quitting = false;
// a window that is still loading gets its toasts once the page is up (state comes with 'init' anyway)
let winLoaded = false, pendingToasts = [];
function pageReady() { winLoaded = true; for (const t of pendingToasts.splice(0)) send('toast', t); }
const send = (ch, data) => {
  if (!win || win.isDestroyed()) return;
  if (!winLoaded) { if (ch === 'toast') pendingToasts.push(data); return; }
  win.webContents.send('event', ch, data);
};
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
// a window left hidden in the tray is closed for real after a while: its page and GPU process are ~200 MB, and the
// tray / a notification / a link opens a new one in a fraction of a second (unsaved config edits keep it)
let unloadTimer = null;
function scheduleUnload() {
  clearTimeout(unloadTimer);
  unloadTimer = setTimeout(async () => {
    if (!win || win.isDestroyed() || win.isVisible() || quitting) return;
    let dirty = false;
    try { dirty = await win.webContents.executeJavaScript('typeof cfgDirty === "function" && cfgDirty()'); } catch { }
    if (!win || win.isDestroyed() || win.isVisible()) return;
    if (dirty) { scheduleUnload(); return; }
    perf('hidden window closed');
    win.destroy(); win = null;
  }, PERF ? 15e3 : 5 * 60e3);
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
  winLoaded = false;
  win.webContents.on('did-start-loading', () => { winLoaded = false; });
  win.webContents.on('did-finish-load', () => pageReady());
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => { perf('window ready-to-show'); if (shotMode) win.showInactive(); else if (show) win.show(); });
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
    if (G.servers.some(s => s.role === 'admin') || G.startWithWindows) { e.preventDefault(); win.hide(); scheduleUnload(); perf('window hidden to the tray'); } else quitting = true;
  });
  win.on('show', () => { clearTimeout(unloadTimer); pollStatus(); checkGameProcess(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); });
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
  trayMenu();
  tray.on('click', showWindow);
  updateTray();
}
// (rebuilt when the language changes)
function trayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: tr('Deschide Bifrost'), click: showWindow },
    { label: tr('Joacă'), click: () => playerSync({ launch: true }) },
    { label: tr('Copiază join code'), click: () => { if (status.joinCode) clipboard.writeText(status.joinCode); } },
    { type: 'separator' },
    { label: tr('Ieșire'), click: () => { quitting = true; app.quit(); } },
  ]));
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
// Linux: one bifrost.desktop (same name as the .deb's, so it shadows it instead of showing twice) for the menu and the
// bifrost:// + nxm:// links, and a copy in ~/.config/autostart for "start at login"
const xdgDir = (env, ...def) => process.env[env] || path.join(require('os').homedir(), ...def);
function desktopEntry(extra) {
  const q = s => `"${String(s).replace(/(["\\`$])/g, '\\$1')}"`;
  const exec = app.isPackaged ? q(process.env.APPIMAGE || process.execPath) : `${q(process.execPath)} ${q(__dirname)}`;
  const icon = path.join(DATA, 'bifrost.png');
  try { fs.copyFileSync(ICON, icon); } catch { }
  return ['[Desktop Entry]', 'Type=Application', 'Name=Bifrost', 'Comment=Valheim mod manager', `Exec=${exec}${extra}`, `Icon=${icon}`,
    'Terminal=false', 'Categories=Game;', 'StartupWMClass=Bifrost', 'MimeType=x-scheme-handler/bifrost;x-scheme-handler/nxm;', ''].join('\n');
}
function applyStartupLinux() {
  const f = path.join(xdgDir('XDG_CONFIG_HOME', '.config'), 'autostart', 'bifrost.desktop');
  if (G.startWithWindows) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, desktopEntry(' --hidden')); }
  else if (fs.existsSync(f)) fs.unlinkSync(f);
}
function applyStartup() {
  if (LINUX) { try { applyStartupLinux(); } catch (e) { log(`autostart: ${e.message}`); } return; }
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
  if (LINUX) {
    const f = path.join(xdgDir('XDG_DATA_HOME', '.local', 'share'), 'applications', 'bifrost.desktop'), body = desktopEntry(' %U');
    try { if ((fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '') !== body) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); } } catch (e) { log(`bifrost.desktop: ${e.message}`); }
    return;
  }
  const target = app.isPackaged ? process.execPath : `${process.execPath}|${__dirname}`;
  if (G.shortcutTarget === target) return;
  for (const l of [path.join(startMenu(), 'Bifrost.lnk'), path.join(app.getPath('desktop'), 'Bifrost.lnk')]) {
    try { shell.writeShortcutLink(l, fs.existsSync(l) ? 'replace' : 'create', ownShortcut('')); } catch (e) { log(`shortcut ${l}: ${e.message}`); }
  }
  G.shortcutTarget = target; G.shortcutsV2 = true; saveSettings();
}
function registerProtocols() {
  if (LINUX) {
    for (const p of ['bifrost', ...(G.nexusKeyEnc ? ['nxm'] : [])]) execFile('xdg-mime', ['default', 'bifrost.desktop', `x-scheme-handler/${p}`], e => { if (e) log(`${p}://: ${e.message}`); });
    return;
  }
  for (const p of ['bifrost', ...(G.nexusKeyEnc ? ['nxm'] : [])]) {
    try { if (app.isPackaged) app.setAsDefaultProtocolClient(p); else app.setAsDefaultProtocolClient(p, process.execPath, [path.resolve(__dirname)]); }
    catch (e) { log(`${p}://: ${e.message}`); }
  }
}

const logTail = [];
function log(line, kind = 'info') {
  // (messages are English; errors from elsewhere are translated, "■ <error>" / "  <mod>: <error>" included)
  line = String(line).replace(/^(\s*[■▶]?\s*(?:[^:\s]+: )?)(.+)$/s, (m, head, rest) => head + i18n.t(rest));
  const t = new Date();
  const entry = { t: t.getTime(), line, kind };
  logTail.push(entry); if (logTail.length > 3000) logTail.splice(0, logTail.length - 3000);
  send('log', entry);
  try { fs.appendFileSync(LOG_FILE, `${t.toLocaleString('sv-SE')}  ${line}\n`); } catch { }
}
try { if (fs.statSync(LOG_FILE).size > 2e6) fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-5000).join('\n')); } catch { }

// ---------- download cache (cache/thunderstore, cache/nexus): reinstalls and new profiles come from here ----------
// old versions of a mod that every profile has replaced go after 14 days, mods no profile has any more after 30
const CACHE_DIRS = ['thunderstore', 'nexus', 'tmp'];
function cacheStats() {
  let bytes = 0, files = 0;
  for (const d of CACHE_DIRS) {
    try { for (const f of fs.readdirSync(path.join(DATA, 'cache', d))) { try { bytes += fs.statSync(path.join(DATA, 'cache', d, f)).size; files++; } catch { } } } catch { }
  }
  return { bytes, files };
}
function pruneCache() {
  const used = new Map(), nexusUsed = new Set();   // full -> Set(ver); "modId-fileId"
  for (const s of G.servers) {
    const dir = s.profileDir || path.join(DATA, 'profiles', s.id);
    const pk = readJson(path.join(dir, 'bifrost-profile.json'), {})?.packages || {};
    for (const [k, p] of Object.entries(pk)) {
      if (!used.has(k)) used.set(k, new Set());
      used.get(k).add(p.ver);
      if (p.source === 'nexus') nexusUsed.add(`${p.modId}-${p.fileId}`);
    }
  }
  const now = Date.now(), DAY = 864e5;
  let freed = 0, n = 0;
  const drop = f => { try { const st = fs.statSync(f); fs.rmSync(f, { recursive: true, force: true }); freed += st.size || 0; n++; } catch { } };
  const tsDir = path.join(DATA, 'cache', 'thunderstore');
  try {
    for (const f of fs.readdirSync(tsDir)) {
      const m = f.match(/^(.+)-(\d+\.\d+\.\d+)\.zip$/), p = path.join(tsDir, f);
      let age = 0; try { age = now - fs.statSync(p).mtimeMs; } catch { continue; }
      if (/\.part$/.test(f)) { if (age > DAY) drop(p); continue; }
      if (!m) continue;
      const vers = used.get(m[1]);
      if (vers ? !vers.has(m[2]) && age > 14 * DAY : age > 30 * DAY) drop(p);
    }
  } catch { }
  const nxDir = path.join(DATA, 'cache', 'nexus');
  try {
    for (const f of fs.readdirSync(nxDir)) {
      const m = f.match(/^(\d+-\d+)-/), p = path.join(nxDir, f);
      let age = 0; try { age = now - fs.statSync(p).mtimeMs; } catch { continue; }
      if (!(m && nexusUsed.has(m[1])) && age > 30 * DAY) drop(p);
    }
  } catch { }
  // leftovers of interrupted unpacks
  const tmp = path.join(DATA, 'cache', 'tmp');
  try { for (const f of fs.readdirSync(tmp)) { const p = path.join(tmp, f); try { if (now - fs.statSync(p).mtimeMs > DAY) drop(p); } catch { } } } catch { }
  if (n) log(`Cache: removed ${n} old downloads (${Math.round(freed / 1048576)} MB)`);
}

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
function setJob(j) { job = j; send('job', job); if (!j) setImmediate(pump); }

// ---------- the queue: installs / removals / updates clicked while Bifrost is busy wait their turn ----------
// (the auto-sync waits for the queue to empty, so many changes go to the server in one sync and one restart)
const queue = [];
let pumping = false;
const queueInfo = () => queue.map(q => ({ label: q.label, key: q.key || null }));
function enqueue(label, key, run) {
  if (key && queue.some(q => q.key === key)) return Promise.resolve({ ok: true, queued: true, already: true });
  return new Promise(resolve => {
    queue.push({ label, key, run, resolve });
    if (key) { installing[key] = { queued: true, at: Date.now() }; send('installing', installing); }
    log(`  queued: ${label} (${queue.length} waiting)`, 'out');
    send('queue', queueInfo());
    pump();
  });
}
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length && !job) {
      const q = queue.shift();
      send('queue', queueInfo());
      if (q.key && installing[q.key]?.queued) { delete installing[q.key]; send('installing', installing); }
      let r;
      try { r = await q.run(); } catch (e) { r = { ok: false, error: e.message }; }
      q.resolve(r);
    }
  } finally { pumping = false; send('queue', queueInfo()); }
}
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
      if (code === 0) { catalog = readJson(CATALOG_FILE, catalog); indexCatalog(); log(`Thunderstore catalog updated: ${out.trim()}`); }
      else log(`The Thunderstore catalog could not be downloaded: ${err.trim()}`, 'error');
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
// PLAY that stopped for Nexus files (free account: one click per file on the site) starts the game by itself once the
// last one is installed
let resumePlay = false;
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
    log(`  installed ${d.full} ${d.ver}`, 'out');
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
  if (!key) throw new Error('Put your Nexus key in Settings.');
  nexus.key = key;
  const url = await nexus.downloadUrl(entry.modId, entry.fileId, nxm);
  setProgress({ ...progress, text: `${entry.title} (Nexus)`, bytes: 0, totalBytes: 0 });
  // newer Nexus files have extension-less CDN names: the archive type is read from the file itself (lib/archive.js)
  const name = (decodeURIComponent(new URL(url).pathname.split('/').pop() || '').replace(/[^\w.\- ]+/g, '_') || 'file').slice(-80);
  const zip = await pr.download(url, path.join(pr.cacheDir, 'nexus', `${entry.modId}-${entry.fileId}-${name}`), (got, total) => setProgress({ ...progress, bytes: got, totalBytes: total }));
  const dllName = `${String(entry.title || entry.key).replace(/[^\w.\-]+/g, '_')}.dll`;
  await pr.installZip(entry.key, zip, { ver: entry.ver, role: entry.role, source: 'nexus', title: entry.title, modId: entry.modId, fileId: entry.fileId, size: fs.statSync(zip).size },
    Profile.nexusMap(entry.key), dllName);
  log(`  installed ${entry.title} (Nexus ${entry.modId})`, 'out');
}
const sideFromCats = p => { const c = p?.cats || []; return c.includes('Server-side') ? 'server' : c.includes('Client-side') ? 'client' : null; };
function hintSide(name, side) {
  if (!isAdmin() || !side) return;
  const st = readState();
  if (!st.mods[name]) { st.mods[name] = side; writeState(st); }
}

// a mod picked in Descoperă (players: their own extra; admins: goes to the server too)
async function installPackage(full, ver) {
  if (!srv()) return { ok: false, error: 'Add or create a server first.' };
  if (job || queue.length || pumping) return enqueue(`Install ${full}`, full, () => installPackageNow(full, ver));
  return installPackageNow(full, ver);
}
async function installPackageNow(full, ver) {
  if (!srv()) return { ok: false, error: 'Add or create a server first.' };
  const p = catalogIndex.get(full);
  ver = ver || p?.ver;
  if (!ver) return { ok: false, error: 'Nu găsesc pachetul în catalog.' };
  setJob({ kind: 'install', label: `Installing ${full}`, started: Date.now() });
  installing[full] = { ver, at: Date.now() }; send('installing', installing);
  try {
    setProgress({ phase: 'install', text: full, done: 0, total: 1 });
    const have = getProfile().packages[full];
    await installThunderstore({ key: full, full, ver, role: have && have.role !== 'dep' ? have.role : 'user', title: p ? p.name.replace(/_/g, ' ') : full }, new Set(desired().map(d => d.key)));
    hintSide(full, sideFromCats(p));
    log(`${full} ${ver} installed`, 'done');
    return { ok: true, via: 'bifrost', side: sideFromCats(p) };
  } catch (e) { log(`${full}: ${e.message}`, 'error'); return { ok: false, error: e.message }; }
  finally { delete installing[full]; send('installing', installing); setProgress(null); setJob(null); afterProfileChange(); }
}
function removePackage(key) {
  if (job || queue.length || pumping) return enqueue(`Remove ${key}`, null, async () => removePackageNow(key));
  return removePackageNow(key);
}
function removePackageNow(key) {
  const pr = getProfile(), p = pr.packages[key];
  if (!p) return { ok: false, error: 'Nu e instalat.' };
  if (p.role === 'required') return { ok: false, error: 'Serverul are nevoie de el.' };
  if (key === BEPINEX) return { ok: false, error: 'BepInEx e baza tuturor modurilor - nu se scoate.' };
  const users = Object.entries(pr.packages).filter(([k, x]) => k !== key && (x.deps || []).some(d => parseDep(d)?.full === key)).map(([k]) => k);
  if (users.length) return { ok: false, error: `Needed by: ${users.join(', ')}. Remove those first.` };
  if (p.role === 'recommended') { const s = srv(); delete s.recommended[key]; delete s.nexusChosen[key]; saveSettings(); }
  const configs = [...(cfgIndex.owners || [])].filter(([, k]) => k === key).map(([r]) => r);
  pr.remove(key);
  for (const k of pr.orphans()) pr.remove(k);
  log(`${key} uninstalled`);
  afterProfileChange();
  return { ok: true, configs };
}
async function updateAll() {
  if (job || queue.length || pumping) return enqueue('Update all mods', null, () => updateAllNow());
  return updateAllNow();
}
async function updateAllNow() {
  const pr = getProfile();
  const todo = Object.entries(pr.packages).filter(([k, x]) => x.source === 'thunderstore' && x.role !== 'required' && catalogIndex.get(k) && cmpVer(catalogIndex.get(k).ver, x.ver) > 0);
  if (!todo.length) return { ok: true, count: 0 };
  setJob({ kind: 'update', label: `Updating ${todo.length} mods`, started: Date.now() });
  log(`▶ ${job.label}`, 'start');
  try {
    setProgress({ phase: 'install', text: '', done: 0, total: todo.length });
    for (const [i, [k, x]] of todo.entries()) {
      setProgress({ ...progress, done: i });
      await installThunderstore({ key: k, full: k, ver: catalogIndex.get(k).ver, role: x.role, title: x.title }, new Set(todo.map(t => t[0])));
    }
    for (const k of pr.orphans()) pr.remove(k);
    log(`■ ${todo.length} mods updated`, 'done');
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
    nexusNeeded: (manifest?.nexus || []).filter(n => n.required && !pr.packages[`nexus-${n.modId}`]).map(n => n.title),
    installed: Object.keys(pr.packages).length, nexusWaiting: nexusWaiting.map(n => ({ key: n.key, title: n.title, modId: n.modId, fileId: n.fileId })),
    nexusUser: G.nexusUser, recommended: s.recommended, nexusChosen: s.nexusChosen,
    // icons of the admin's recommendations, so the Play page does not need the whole catalog
    icons: Object.fromEntries((manifest?.recommended || []).map(r => [r.full, catalogIndex.get(r.full)?.icon || null])),
  };
}
// is Valheim running? (one game at a time: a second PLAY must not start another copy)
const gameState = { running: false, launching: false };
function sendGame() { send('game', gameState); updateTray(); }
function checkGameProcess() {
  const [cmd, args, re] = LINUX
    ? ['ps', ['-eo', 'args'], /(^|[\\/\s])valheim\.(x86_64|exe)(\s|$)/im]       // native build or Proton (not valheim_server)
    : ['tasklist', ['/FI', 'IMAGENAME eq valheim.exe', '/NH', '/FO', 'CSV'], /"valheim\.exe"/i];
  return new Promise(resolve => execFile(cmd, args, { windowsHide: true }, (e, out) => {
    const running = !e && re.test(out || '');
    if (running !== gameState.running) { gameState.running = running; if (running) gameState.launching = false; sendGame(); }
    resolve(running);
  }));
}
// ---------- joining directly: Valheim's own command line (FejdStartup): +connect <ip:port> queues the server, the
// character screen's Start joins it (crossplay servers are found by their public IP through PlayFab) and -password
// answers the server's password prompt. (-joincode would skip the character screen but plays the developer test
// character, so it is not used.)
function joinTarget(s = srv()) {
  if (!s) return null;
  const withPort = a => { a = String(a || '').trim(); return !a ? null : /:\d+$/.test(a) ? a : `${a}:2456`; };
  return withPort(s.joinAddress) || withPort(s.role === 'player' ? manifest?.server?.address : status.publicIp);
}
// the admin's Docker server knows its own password (SERVER_PASS of the valheim-server image)
async function detectJoinPassword(s = srv()) {
  const tr = transport(s);
  if (!tr?.docker) throw new Error('Doar pentru servere Docker (valheim-server) - scrie parola de mână.');
  const pw = String(await tr.run('printf "%s" "$SERVER_PASS"', { timeout: 20000 }) || '').trim();
  s.joinPassEnc = pw ? enc(pw) : null; saveSettings(); send('settings', publicSettings());
  return pw ? { ok: true, found: true } : { ok: true, found: false };
}
async function joinArgs() {
  const s = srv();
  if (s.directJoin === false) return { args: [], target: null };
  const target = joinTarget(s);
  if (!target) return { args: [], target: null };
  if (!s.joinPassEnc && isAdmin() && transport()?.docker) { try { await detectJoinPassword(s); } catch (e) { log(`server password: ${e.message}`, 'error'); } }
  const pw = dec(s.joinPassEnc);
  return { args: ['+connect', target, ...(pw ? ['-password', pw] : [])], target, password: !!pw };
}
async function launchGame() {
  if (gameState.launching) throw new Error('Valheim pornește deja - așteaptă câteva secunde.');
  if (await checkGameProcess()) throw new Error('Valheim rulează deja.');
  game = await Profile.findGame();
  if (Profile.isGameDir(G.gameDir)) game.game = G.gameDir;
  if (!game.game) throw new Error('Nu găsesc Valheim (Steam). Alege folderul jocului în Setări.');
  gameState.launching = true; sendGame();
  try {
    try { getProfile().setConsole(G.bepConsoleMode || 'nowarn'); } catch (e) { log(`BepInEx.cfg: ${e.message}`, 'error'); }
    getProfile().prepareGame(game.game);
    var join = await joinArgs();
    await getProfile().launch(game, join.args);
  } catch (e) { gameState.launching = false; sendGame(); throw e; }
  log(`Starting Valheim with the "${srv().name}" profile (${game.game})${join.target ? ` - joining ${join.target} directly${join.password ? ' with the saved password' : ''}` : ''}`, 'done');
  if (join.target) toast(`Pick the character and press Start - you go straight to the server${join.password ? '' : ' (no saved password: type it in the game if the server has one)'}.`, 'ok');
  else if (srv().directJoin !== false && (status.joinCode || manifest?.server?.joinCode)) {
    const code = status.joinCode || manifest.server.joinCode;
    clipboard.writeText(code);
    toast(`The server's address is not known, so the join code ${code} was copied: in the game Join game → Add server → Ctrl+V.`, 'info');
  }
  // "launching" until the game process shows up (Steam can take a while), at most 2 minutes
  const until = Date.now() + 120e3;
  (async () => { while (gameState.launching && Date.now() < until) { await new Promise(r => setTimeout(r, 2000)); await checkGameProcess(); } if (gameState.launching) { gameState.launching = false; sendGame(); } })();
}
async function playerSync({ launch } = {}) {
  if (!srv()) return { ok: false, error: 'Add or create a server first.' };
  if (job) return { ok: false, error: 'Lucrez deja.' };
  // admins and personal profiles (no list): the profile is the source - just play
  if (isAdmin() || !srv().list) {
    try { if (launch) await launchGame(); return { ok: true }; } catch (e) { log(e.message, 'error'); return { ok: false, error: e.message }; }
  }
  setJob({ kind: 'play', label: launch ? 'Preparing the game' : 'Updating the mods', started: Date.now() });
  log(`▶ ${job.label}`, 'start');
  try {
    await refreshManifest();
    if (!manifest) throw new Error(`No server list (${manifestErr || 'unknown'}).`);
    const pr = getProfile();
    const want = desired();
    const wanted = new Set(want.map(d => d.key));
    const plan = pr.plan(want);
    const ts = plan.install.filter(d => d.source === 'thunderstore');
    const nx = plan.install.filter(d => d.source === 'nexus');
    setProgress({ phase: 'install', text: '', done: 0, total: plan.install.length });
    for (const [i, d] of ts.entries()) { setProgress({ ...progress, done: i }); await installThunderstore(d, wanted); }
    if (nx.length && !G.nexusKeyEnc) {
      setProgress(null);
      log(`■ ${nx.length} ${nx.length === 1 ? 'mod comes' : 'mods come'} from Nexus Mods - waiting for the player's Nexus API key`, 'out');
      return { ok: false, needNexusKey: true, mods: nx.map(d => d.title || d.key), error: null };
    }
    nexusWaiting = [];
    for (const d of nx) { if (G.nexusUser?.premium) await installNexus(d); else nexusWaiting.push(d); }
    for (const k of plan.remove) { pr.remove(k); log(`  removed ${k}`, 'out'); }
    for (const k of pr.orphans()) { pr.remove(k); log(`  removed ${k} (no longer needed)`, 'out'); }
    setProgress(null);
    if (nexusWaiting.length) {
      resumePlay = !!launch;
      send('player', playerInfo());
      shell.openExternal(Nexus.filesPage(nexusWaiting[0].modId, nexusWaiting[0].fileId));
      const missing = nexusWaiting.filter(n => n.role === 'required');
      if (missing.length) throw new Error(`Still needed from Nexus: ${missing.map(n => n.title).join(', ')} - press "Slow download" on the page that opened.`);
      toast('Pe pagina Nexus care s-a deschis apasă „Slow download” - Bifrost îl instalează singur.', 'info');
    }
    log(`■ Mods are up to date (${Object.keys(pr.packages).length} packages)`, 'done');
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
const modsPayload = () => {
  const p = !srv() ? { mods: [], profileFound: false } : isAdmin() ? adminMods() : playerMods();
  if (srv() && isAdmin()) { const c = configCounts(); for (const m of p.mods) m.configs = c[m.name] || 0; p.otherConfigs = c[''] || 0; }
  return p;
};
function setSide(name, side) {
  if (job) return { ok: false, error: 'A sync is running - try again when it is done.' };
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
  showWindow();
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Cancel', 'Remove them from the server'], defaultId: 0, cancelId: 0, title: 'Bifrost',
    message: `${list.length} mods would be removed from the server`, detail: `${list.join(', ')}\n\nAn empty or wrong profile looks exactly like this. Continue?`,
  });
  return r.response === 1;
}

async function syncNow(reason) {
  const s = srv();
  if (!isAdmin() || !s.conn) return;
  if (job) { toast('Something is already running - waiting for it to finish.'); return; }
  if (restarting) {
    syncAfterRestart = reason;
    if (reason === 'manual') toast('Serverul repornește acum - sincronizez imediat după.', 'info');
    return;
  }
  const manual = reason === 'manual', tr = transport();
  const sig = signature();
  changedAt = null; watch.retryAt = null;
  setJob({ kind: 'sync', label: `Sync (${reason})`, started: Date.now() });
  setWatch('syncing', 'sincronizez...');
  log(`▶ Sync (${reason}) → ${tr.label()}`, 'start');
  const st = readState();
  try {
    const r = await syncMods(st, {
      pluginsDir: pluginsDir(), transport: tr, builtin: new RegExp(s.builtin || 'BepInExPack', 'i'), allMods: s.syncAllMods,
      confirmMassRemoval: manual ? confirmMass : null, log: l => log(l, 'out'),
    });
    writeState(st);
    for (const n of r.newMods) log(`  ${n.name} -> ${n.side} (${n.why})`, 'out');
    const what = [r.copy.length && `Updated: ${r.copy.join(', ')}`, r.remove.length && `Removed: ${r.remove.join(', ')}`,
    r.newMods.length && `New mods (guessed): ${r.newMods.map(n => `${n.name} → ${n.side}`).join('; ')}`].filter(Boolean).join('\n');
    log(`■ Sync: ${r.copy.length} copied, ${r.remove.length} removed`, 'done');
    syncedSig = sig; failStreak = 0; watch.lastSync = Date.now();
    setJob(null);
    await maybeRestart({ manual, what });
  } catch (e) {
    setJob(null);
    if (e.code === 'MASS_REMOVAL') {
      watch.lastResult = { kind: 'warn', text: `Stopped: ${e.message}` }; syncedSig = sig;
      notify('Bifrost: sync stopped', e.message, 'warn'); setWatch('attention', 'needs attention');
    } else {
      failStreak++;
      watch.lastResult = { kind: 'error', text: `Error: ${e.message}` };
      watch.retryAt = Date.now() + 5 * 60e3;
      log(`■ Sync failed: ${e.message}`, 'error');
      if (failStreak === 1) notify('Bifrost: sync failed', `${e.message}\nRetrying in 5 minutes.`, 'warn');
      setWatch('error', 'eroare - reîncerc');
    }
  } finally { watch.dirty = signature() !== syncedSig; send('mods', modsPayload()); send('watch', watch); }
}

// restart only while nobody plays; afterwards configs + list
async function maybeRestart({ manual, what = '', force } = {}) {
  if (restarting) return { ok: true, already: true };
  const s = srv(), tr = transport(), st = readState();
  if (!st.restartPending && !force) {
    watch.lastResult = { kind: 'ok', text: 'The server is up to date', what };
    if (manual) toast('The server is up to date.', 'ok');
    setWatch('idle', 'la zi');
    schedulePublish('mods synced'); setTimeout(() => twoWay('after sync'), 1500);
    return { ok: true };
  }
  if (!tr.canRestart) {
    st.restartPending = false; writeState(st);
    watch.lastResult = { kind: 'wait', text: 'Mods copied - restart the server from the host\'s panel', what };
    notify('Mods copied to the server', `${what}\nRestart the server from the host's panel to load them.`.trim());
    setWatch('waiting', 'waiting for a manual restart');
    setTimeout(() => twoWay('after sync'), 1500);
    return { ok: true, manualRestart: true };
  }
  if (!force) {
    let idle = await tr.isIdle().catch(() => null);
    if (idle === null) idle = await steamPlayers().then(p => p === 0).catch(() => null);
    if (idle !== true) {
      watch.lastResult = { kind: 'wait', text: idle === false ? 'Mods copied - the restart waits for the players to leave' : 'Mods copied - it is unknown whether anyone is on, restart it yourself', what };
      watch.retryAt = idle === false ? Date.now() + s.retryMinutes * 60e3 : null;
      notify('Mods copied to the server', `${what}\n${idle === false ? 'Players are online - the server restarts when it is empty.' : 'Press Restart server when nobody is on.'}`.trim());
      setWatch('waiting', idle === false ? 'restart once players leave' : 'manual restart');
      setTimeout(() => twoWay('after sync'), 1500);
      return { ok: true, postponed: true };
    }
  }
  const r = await restartServer({ fast: !force });
  watch.lastResult = { kind: 'ok', text: r.joinCode ? `Server restarted - join code ${r.joinCode}` : 'Server restarted', what };
  notify('The Valheim server is updated', `${what}\nRestarted${r.joinCode ? ` - join code ${r.joinCode}` : ''}`.trim());
  setWatch('idle', 'la zi');
  pollStatus(); schedulePublish('restart'); setTimeout(() => twoWay('after restart'), 1500);
  return { ok: true, joinCode: r.joinCode };
}
// the server restart (2-3 minutes until a join code) runs in the background: mods can be installed meanwhile, and a
// sync asked for during it runs right after
let restarting = false, syncAfterRestart = null;
async function restartServer({ fast, recreate } = {}) {
  const tr = transport();
  restarting = true; watch.restarting = Date.now(); setWatch('restarting', 'repornesc serverul...');
  log(`▶ Restart server (${tr.label()})`, 'start');
  try {
    let since = Math.floor(Date.now() / 1000);
    // after a mod sync: only the game is restarted (the container restart + Steam update check took minutes);
    // anything unexpected -> the full container restart
    let quick = false;
    if (recreate) {
      const info = await tr.composeInfo();
      if (!info) throw new Error('The container was not started with docker compose.');
      log('  recreating the container with the new settings (docker compose up -d)', 'out');
      await tr.composeUp(info);
      quick = true;
    } else if (fast && tr.reloadModsAndRestartGame) {
      try { quick = await tr.reloadModsAndRestartGame(); } catch (e) { log(`  quick restart not possible (${e.message}) - restarting the container`, 'out'); }
      if (quick) log('  mods copied into the game, only the game process restarts', 'out');
    }
    if (!quick) await tr.restart();
    const st = readState(); st.restartPending = false; writeState(st);
    if (!tr.docker) { log('■ Server restarted', 'done'); return { ok: true }; }
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
      if (code) { log(`■ Server up - join code ${code}`, 'done'); return { ok: true, joinCode: code }; }
      if (!bad) { log('■ Server up (no join code - crossplay off?)', 'done'); return { ok: true }; }
      // restarting again at once kept failing (2026-10-11: 9 crashes in a row, every 2-3 minutes): the game is stopped
      // for a while first, longer each time, so PlayFab drops the stale lobbies with that join code
      const pause = [60, 180, 300][attempt - 1] || 300;
      log(`  the join code check crashed on the server (attempt ${attempt}) - stopping the game for ${pause / 60} min, then starting it again`, 'out');
      await tr.stopGame().catch(() => { });
      await new Promise(r => setTimeout(r, pause * 1000));
      since = Math.floor(Date.now() / 1000);
      await tr.startGame();
    }
    return { ok: true };
  } finally {
    restarting = false; watch.restarting = null; send('watch', watch);
    if (syncAfterRestart) { const why = syncAfterRestart; syncAfterRestart = null; setTimeout(() => syncNow(why), 1500); }
  }
}

function tick() {
  if (!isAdmin() || !srv().conn || job || queue.length || pumping || restarting) return;
  const s = srv(), sig = signature();
  if (sig !== seenSig) {
    const first = seenSig === null;
    seenSig = sig;
    if (!first) { changedAt = Date.now(); watch.dirty = true; send('mods', modsPayload()); setWatch('change', 'modurile s-au schimbat...'); }
    else if (syncedSig === null) syncedSig = sig;
    return;
  }
  if (changedAt && sig === syncedSig) { changedAt = null; watch.dirty = false; setWatch('idle', 'la zi'); }
  if (!s.autoSync) { if (watch.dirty && watch.state !== 'off') setWatch('off', 'auto-sync off - you have unsynced changes'); return; }
  if (changedAt && Date.now() - changedAt >= s.quietSeconds * 1000) { syncNow('mods changed'); return; }
  if (watch.retryAt && Date.now() >= watch.retryAt) { watch.retryAt = null; if (readState().restartPending) maybeRestart({}); else syncNow('retry'); }
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
        try { const i = await (async () => { const a = a2s.parseAddress((s.addresses || '').split(/[;\n]/).map(x => x.split('=')[1]).find(Boolean)); return a ? a2s.info(a.host, a.queryPort) : null; })(); if (i) { st.players = i.players; st.gameUp = true; st.idle = i.players === 0; } else st.unknown = true; }
        catch { st.unknown = true; }   // (crossplay servers do not answer the Steam query either)
      }
      status = st;
    } else if (s.role === 'player') {
      const sv = manifest?.server || {};
      status = { reachable: true, checkedAt: Date.now(), container: 'running', joinCode: sv.joinCode || null, publicIp: sv.address || null, fromList: true };
      if (!sv.joinCode && !sv.address) status.unknown = true;   // the list says nothing about the server right now
      if (sv.address) { const a = a2s.parseAddress(sv.address); try { const i = await a2s.info(a.host, a.queryPort); status.players = i.players; status.gameUp = true; } catch { } }
    }
  } catch (e) { status = { reachable: false, error: e.message, checkedAt: Date.now() }; }
  polling = false;
  send('status', status); updateTray();
  if (s.role === 'admin' && status.joinCode && prevCode !== undefined && status.joinCode !== prevCode && !status.codeBroken) schedulePublish('new join code');
}

// ---------- configs + mods put on the server by hand ----------
let twoWayBusy = false;
// which mod a config file belongs to: BepInEx names configs after the plugin GUID, and that GUID is a string inside
// the plugin's DLL; other mods may mention it too, so the package whose name matches best wins
// which mod a config file belongs to: the plugin GUID from a .cfg's header (else the file / folder name) is inside one
// of the mod's DLLs; with several candidates, the package whose name shares most words with it
async function configOwners(rels) {
  const pr = getProfile(), best = new Map();
  const names = rels.map(r => {
    if (/\.cfg$/i.test(r) && !r.includes('/')) {
      try { const g = (fs.readFileSync(path.join(configDir(), r), 'utf8').slice(0, 600).match(/^## Plugin GUID: (.+)$/m) || [])[1]; if (g && g.trim().length >= 4) return g.trim(); } catch { }
    }
    return r.split('/')[0].replace(/\.(cfg|ya?ml|json|txt)$/i, '');
  });
  const tokens = names.map(n => n.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3));
  for (const [k, p] of Object.entries(pr.packages)) {
    for (const f of (p.files || []).filter(x => /\.dll$/i.test(x))) {
      // only the assembly's metadata (names, attribute blobs): some mods embed 100+ MB of assets in their DLL
      const md = dllMetadata(path.join(pr.dir, ...f.split('/')));
      if (!md.length) continue;
      rels.forEach((r, i) => {
        if (names[i].length < 4 || md.indexOf(names[i], 0, 'latin1') < 0) return;
        const score = tokens[i].filter(t => k.toLowerCase().includes(t)).length;
        if (!best.has(r) || score > best.get(r).score) best.set(r, { key: k, score });
      });
      await new Promise(res => setImmediate(res));
    }
  }
  // not in any DLL: a file / folder named like exactly one package (shudnal.ConditionalConfigSync/ -> shudnal-ConditionalConfigSync)
  const norm = x => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const pk = Object.keys(pr.packages).map(k => ({ k, n: norm(k.slice(k.indexOf('-') + 1)) })).filter(x => x.n.length >= 6);
  rels.forEach((r, i) => {
    if (best.has(r)) return;
    const hit = pk.filter(x => norm(names[i]).includes(x.n));
    if (hit.length === 1) best.set(r, { key: hit[0].k, score: 0 });
  });
  return new Map([...best].map(([r, b]) => [r, b.key]));
}
async function configSides(rels) {
  const st = readState(), own = await configOwners(rels);
  return new Map([...own].map(([r, k]) => [r, st.mods[k] === 'client' ? 'client' : 'server']));
}

// ---------- config editor (Mods → ⚙): the profile's BepInEx/config, sent to the server by the config sync ----------
const cfgIndex = { sig: null, owners: null, building: null };
function configRels() {
  // .cfg files first (the mod's main settings), then the rest by name
  try { return walk(configDir()).filter(r => safeRel(r) && !CFG_SKIP.some(x => x.test(r))).sort((a, b) => (/\.cfg$/i.test(b) - /\.cfg$/i.test(a)) || a.localeCompare(b)); } catch { return []; }
}
function configSig(rels) { const pr = getProfile(); return JSON.stringify([srv()?.id, Object.entries(pr.packages).map(([k, p]) => `${k}@${p.ver}`).sort(), rels]); }
// kept on disk too: it only changes when mods or config files do
const cfgIndexFile = () => path.join(serverDir(srv().id), 'config-owners.json');
async function configIndex() {
  const rels = configRels(), sig = configSig(rels);
  if (cfgIndex.sig === sig && cfgIndex.owners) return cfgIndex;
  if (cfgIndex.building?.sig === sig) { await cfgIndex.building.p; return cfgIndex; }
  const saved = readJson(cfgIndexFile(), null);
  if (saved?.sig === sig && Array.isArray(saved.owners)) { cfgIndex.owners = new Map(saved.owners); cfgIndex.sig = sig; return cfgIndex; }
  const file = cfgIndexFile();
  const p = configOwners(rels).then(own => {
    cfgIndex.owners = new Map(rels.map(r => [r, own.get(r) || ''])); cfgIndex.sig = sig;
    try { writeJson(file, { sig, owners: [...cfgIndex.owners] }); } catch { }
  });
  cfgIndex.building = { sig, p };
  try { await p; } finally { if (cfgIndex.building?.sig === sig) cfgIndex.building = null; }
  return cfgIndex;
}
// { modKey: number of files, '': files nobody claims } - from the last index; a stale one is rebuilt in the background
function configCounts() {
  const rels = configRels();
  if (cfgIndex.sig !== configSig(rels) && !cfgIndex.building) configIndex().then(() => send('mods', modsPayload())).catch(e => log(`config index: ${e.message}`, 'error'));
  const out = {};
  for (const [, k] of cfgIndex.owners || []) out[k] = (out[k] || 0) + 1;
  return out;
}
const cfgPath = rel => {
  if (typeof rel !== 'string' || !safeRel(rel) || CFG_SKIP.some(x => x.test(rel))) throw new Error('Fișier de config invalid.');
  return path.join(configDir(), ...rel.split('/'));
};
const sha1 = t => crypto.createHash('sha1').update(t).digest('hex');
// config files of a removed mod: gone from the server first, then from the profile (the other way round the two-way
// sync would bring them back), and from the sync's memory
async function deleteConfigs(rels) {
  rels = (Array.isArray(rels) ? rels : [rels]).filter(r => { try { cfgPath(r); return true; } catch { return false; } });
  if (!rels.length) return { ok: false, error: 'Nothing to delete.' };
  for (let i = 0; i < 30 && twoWayBusy; i++) await new Promise(r => setTimeout(r, 500));
  const s = srv();
  let remote = false;
  if (isAdmin() && s.conn && s.syncConfigs) {
    const tr = transport();
    try { await tr.remove(tr.configDir, rels); remote = true; }
    catch (e) { return { ok: false, error: `Could not delete them on the server: ${e.message}` }; }
  }
  for (const r of rels) { try { fs.rmSync(cfgPath(r), { force: true }); } catch { } }
  const sf = path.join(serverDir(s.id), 'config-sync.json'), base = readJson(sf, {});
  for (const r of rels) delete base[r];
  writeJson(sf, base);
  log(`Config files deleted${remote ? ' (profile + server)' : ''}: ${rels.join(', ')}`, 'done');
  cfgIndex.sig = null; send('mods', modsPayload());
  return { ok: true, deleted: rels.length, remote };
}
// ---------- the server's own settings (valheim-server image: the compose env_file) ----------
async function serverEnvLocate() {
  const s = srv(), tr = transport();
  if (!isAdmin() || !tr?.docker) throw new Error('Only for Docker servers (valheim-server image) reached over SSH.');
  const info = await tr.composeInfo();
  if (!info) throw new Error('The container was not started with docker compose - its variables cannot be edited from here.');
  const composeTexts = [];
  for (const f of info.files) { try { composeTexts.push(await tr.hostRead(f)); } catch { } }
  const files = serverenv.envFiles(composeTexts, info.workdir, info.service);
  if (!files.length) throw new Error('The compose file has no env_file for this service - its variables are written inside docker-compose.yaml.');
  return { tr, info, file: files[files.length - 1] };
}
async function serverEnvRead() {
  const { tr, info, file } = await serverEnvLocate();
  const text = await tr.hostRead(file);
  return { ok: true, file, workdir: info.workdir, text, vars: serverenv.parse(text), known: serverenv.KNOWN, players: status.players ?? null };
}
async function serverEnvSave({ changes, text, expect }) {
  const { tr, file } = await serverEnvLocate();
  const cur = await tr.hostRead(file);
  if (expect !== undefined && cur !== expect) throw new Error('The file changed on the server meanwhile - it was reloaded, make the change again.');
  const next = typeof text === 'string' ? (text.endsWith('\n') ? text : text + '\n') : serverenv.apply(cur, changes || {});
  const why = serverenv.check(serverenv.parse(next));
  if (why) throw new Error(why);
  if (next === cur) return { ok: true, unchanged: true };
  await tr.hostWriteWithBackup(file, next);
  const before = Object.fromEntries(serverenv.parse(cur).map(v => [v.key, v.value]));
  const after = Object.fromEntries(serverenv.parse(next).map(v => [v.key, v.value]));
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]);
  log(`Server settings changed (${path.posix.basename(file)}, backup kept next to it): ${changed.map(k => /PASS|TOKEN|KEY|SECRET/i.test(k) ? `${k}=***` : `${k}=${after[k] ?? '(removed)'}`).join(', ')}`, 'done');
  // the password Bifrost uses for joining directly follows the server's
  if (changed.includes('SERVER_PASS')) { const s = srv(); s.joinPassEnc = after.SERVER_PASS ? enc(after.SERVER_PASS) : null; saveSettings(); send('settings', publicSettings()); }
  return { ok: true, changed };
}
// recreate the container in the background (the restart path waits for the join code as usual)
function serverEnvApply() {
  if (restarting) return { ok: false, error: 'The server is restarting already - wait for it to finish.' };
  if (job) return { ok: false, error: 'Already working - try again in a few seconds.' };
  restartServer({ recreate: true }).then(r => {
    watch.lastResult = { kind: 'ok', text: r.joinCode ? `Server settings applied - join code ${r.joinCode}` : 'Server settings applied', what: '' };
    notify('Bifrost', r.joinCode ? `Server settings applied - join code ${r.joinCode}` : 'Server settings applied');
    setWatch('idle', 'up to date'); pollStatus(); schedulePublish('server settings');
  }).catch(e => { log(`■ Applying the server settings failed: ${e.message}`, 'error'); toast(e.message, 'error'); setWatch('error', 'error'); });
  return { ok: true, started: true };
}

async function saveConfig({ rel, changes, text, expect }) {
  const p = cfgPath(rel);
  const cur = fs.readFileSync(p, 'utf8');
  if (expect && sha1(cur) !== expect) throw new Error('Fișierul s-a schimbat între timp (l-a adus sincronizarea de pe server) - l-am reîncărcat, fă modificarea din nou.');
  const next = typeof text === 'string' ? text : bepcfg.apply(cur, changes || []);
  if (next === cur) return { ok: true, unchanged: true };
  // the version that was edited becomes the sync's common base when there is none yet (a file never synced): then
  // the sync sees a local change and sends it, instead of treating it as a first contact where the server wins
  const s0 = srv();
  if (isAdmin() && s0?.conn && s0.syncConfigs) {
    const sf = path.join(serverDir(s0.id), 'config-sync.json'), base = readJson(sf, {});
    if (!base[rel]) { base[rel] = normSha(Buffer.from(cur)); writeJson(sf, base); }
  }
  fs.writeFileSync(p + '.tmp', next); fs.renameSync(p + '.tmp', p);
  log(`Config edited: ${rel}${changes ? ` (${changes.map(c => `${c.key} = ${c.value}`).join(', ').slice(0, 300)})` : ''}`, 'done');
  const s = srv();
  if (!isAdmin() || !s.conn || !s.syncConfigs) return { ok: true, pushed: false, local: true, hash: sha1(next) };
  // straight to the server (the config sync sees the local change); a job in progress -> it goes right after
  for (let i = 0; i < 30 && (twoWayBusy || job); i++) await new Promise(r => setTimeout(r, 500));
  if (twoWayBusy || job) return { ok: true, pushed: false, later: true, hash: sha1(next) };
  await twoWay('config edited');
  const tw = watch.twoWay || {};
  if (tw.error) return { ok: true, pushed: false, error: tw.error, hash: sha1(next) };
  // never report "sent" for something the sync replaced
  let now = null; try { now = fs.readFileSync(p, 'utf8'); } catch { }
  if (now !== next) return { ok: false, error: 'Sincronizarea a adus între timp altă versiune a fișierului de pe server - l-am reîncărcat, fă modificarea din nou.' };
  return { ok: true, pushed: true, canRestart: !!transport()?.canRestart, hash: sha1(next) };
}
async function twoWay(reason) {
  const s = srv();
  if (!isAdmin() || !s.conn || twoWayBusy || job || restarting || !(s.syncConfigs || s.pullServerMods)) return;
  twoWayBusy = true;
  const tr = transport(), pr = getProfile(), res = { at: Date.now(), push: 0, pull: 0, mods: [], error: null };
  try {
    if (s.pullServerMods) {
      const st = readState(), have = new Set(Object.keys(pr.packages)), builtin = new RegExp(s.builtin || 'BepInExPack', 'i');
      const extras = (await tr.list(tr.pluginsDir)).filter(n => !have.has(n) && !st.installed.includes(n) && !builtin.test(n));
      for (const e of extras) {
        if (job) break;
        const m = e.match(/^(.+?)-(\d+\.\d+\.\d+)$/), full = m ? m[1] : e, ver = m ? m[2] : null;
        setJob({ kind: 'pull', label: `Bringing from the server: ${e}`, started: Date.now() });
        try {
          if (pr.packages[full]) {
            await tr.remove(tr.pluginsDir, [e]);
            log(`The server also had ${e} (put there by hand) - replacing it with ${full} from the profile`);
          } else if (catalogIndex.get(full)) {
            try {
              await installThunderstore({ key: full, full, ver: ver || catalogIndex.get(full).ver, role: 'user', title: catalogIndex.get(full).name }, new Set());
              log(`Brought from the server: ${full} ${ver || ''} (from Thunderstore)`, 'done');
            } catch (err) {
              if (err.code !== 'DUPLICATE') throw err;
              log(`The server also had ${e}, but the profile already has the same mod (${err.twin}) - removing it from the server`);
            }
            await tr.remove(tr.pluginsDir, [e]);
          } else {
            const tmp = path.join(DATA, 'cache', 'tmp', `srv-${Date.now()}`);
            for (const f of await tr.pull(tr.pluginsDir, e)) { const p = path.join(tmp, ...f.name.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.data); }
            pr.importManual(e, path.join(tmp, e), { ver: '', role: 'user', source: 'manual', title: e });
            fs.rmSync(tmp, { recursive: true, force: true });
            log(`Brought from the server: ${e} (manual)`, 'done');
          }
          res.mods.push(full);
        } finally { setJob(null); }
      }
      if (res.mods.length) {
        const st2 = readState(); for (const n of res.mods) st2.mods[n] = 'server'; writeState(st2);
        notify('Mods brought from the server', res.mods.join(', '));
        send('mods', modsPayload());
      }
    }
    if (s.syncConfigs) {
      const cacheFile = path.join(serverDir(s.id), 'remote-cache.json'), cache = readJson(cacheFile, {});
      const r = await syncConfigs({ transport: tr, configDir: configDir(), stateFile: path.join(serverDir(s.id), 'config-sync.json'), sideOf: configSides, cache });
      if (tr.hashless) writeJson(cacheFile, cache);
      res.push = r.push.length; res.pull = r.pull.length;
      if (r.push.length) log(`Configs sent to the server (${reason}): ${r.push.join(', ')}`, 'done');
      if (r.pull.length) log(`Configs brought from the server (${reason}): ${r.pull.join(', ')}`, 'done');
    }
  } catch (e) { res.error = e.message; log(`Config sync: ${e.message}`, 'error'); }
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
  if (readState().restartPending) { listState.error = 'The server has not restarted with the new mods yet - the list is published after the restart.'; send('list', listState); return { ok: false, error: listState.error }; }
  const token = await githubToken();
  if (!token) { listState.error = 'Connect to GitHub (Settings → GitHub) to publish the list.'; send('list', listState); return { ok: false, error: listState.error }; }
  listState.busy = true; send('list', listState);
  try {
    const r = await listhost.publish(fetchN, token, s.list || { kind: 'gist' }, list, reason);
    if (!s.list || r.src.id !== s.list.id) { s.list = r.src; saveSettings(); send('settings', publicSettings()); }
    Object.assign(listState, { at: Date.now(), ok: true, error: null, changed: r.changed });
    if (r.changed) log(`List for friends published (${reason}): ${list.required.length} required, ${list.recommended.length} recommended`, 'done');
    return { ok: true, changed: r.changed, invite: listhost.inviteLink(s.list, JOIN_PAGE) };
  } catch (e) {
    Object.assign(listState, { at: Date.now(), ok: false, error: e.message });
    log(`The list for friends was not published: ${e.message}`, 'error');
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
  log(`Modpack ${s.modpackName} ${version}: ${deps.length} mods`, 'done');
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
  if (!token) return { ok: false, error: 'The Thunderstore token is missing (Settings).' };
  const b = await buildModpack();
  const zip = b.info.zip;
  if (!zip) return { ok: false, error: 'The built zip is not found.' };
  setJob({ kind: 'publish', label: `Publishing ${path.basename(zip)}`, started: Date.now() });
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
    log(`■ Published ${s.modpackName} ${v}`, 'done');
    updates[ownPack()] = { latest: v };
    return { ok: true, version: v };
  } catch (e) {
    if (uuid) { try { await tsApi(token, 'POST', `/api/experimental/usermedia/${uuid}/abort-upload/`, {}); } catch { } }
    log(`■ Publishing failed: ${e.message}`, 'error');
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
  if (!src) return { ok: false, error: 'This invite is not recognized - paste the link or code you got (e.g. g.1a2b3c...).' };
  const existing = G.servers.find(s => JSON.stringify(s.list) === JSON.stringify(src));
  if (existing) { activate(existing.id); return { ok: true, id: existing.id, existed: true }; }
  let m;
  try { m = await listhost.fetchList(fetchN, src); } catch (e) { return { ok: false, error: `The server list cannot be read: ${e.message}` }; }
  const name = m.server?.name || 'Server';
  const id = uniqueId(name);
  G.servers.push({ ...SERVER_DEFAULTS, id, name, role: 'player', list: src, profileDir: path.join(DATA, 'profiles', id), createdAt: Date.now() });
  writeJson(path.join(serverDir(id), 'list-cache.json'), m);
  saveSettings();
  log(`Server added: ${name} (${listhost.inviteCode(src)})`, 'done');
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
  log(`New server: ${s.name} (${s.conn ? s.conn.type : 'no connection'})`, 'done');
  const r = await importInto(cfg.source || { kind: 'empty' });
  activate(id);
  if (r.ok && s.conn) setTimeout(() => syncNow('new server'), 4000);
  return { ...r, id };
}
// fill the current profile: other mod managers, a profile code or what the server already runs
async function importInto(source) {
  if (source.kind === 'empty') {
    await installThunderstore({ key: BEPINEX, full: BEPINEX, ver: catalogIndex.get(BEPINEX)?.ver || '5.4.2351', role: 'user', title: 'BepInExPack Valheim' }, new Set()).catch(e => log(e.message, 'error'));
    return { ok: true, count: Object.keys(getProfile().packages).length };
  }
  setJob({ kind: 'import', label: 'Importing mods', started: Date.now() });
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
      // the valheim-server image brings ValheimPlus itself (VALHEIM_PLUS=true), so it is not in the plugins folder -
      // but every player needs it (the server enforces it): the Thunderstore package of the same fork goes in the profile
      const VPLUS = 'Grantapher-ValheimPlus_Grantapher_Temporary';
      if (builtin.test('ValheimPlus') && !mods.some(m => /ValheimPlus/i.test(m.full))) {
        mods.push({ full: VPLUS, ver: catalogIndex.get(VPLUS)?.ver || '10.2.0', title: 'ValheimPlus' });
        log('  + ValheimPlus (the server has it from its image, players need it)', 'out');
      }
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
      log(`  copied ${m.name} (manual)`, 'out');
    }
    if (configs?.dir && fs.existsSync(configs.dir)) fs.cpSync(configs.dir, configDir(), { recursive: true, force: true });
    if (configs?.files) for (const f of configs.files) { const p = path.join(configDir(), ...f.rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.data); }
    log(`■ Import done: ${Object.keys(pr.packages).length} packages`, 'done');
    return { ok: true, count: Object.keys(pr.packages).length };
  } catch (e) { log(`■ Import failed: ${e.message}`, 'error'); return { ok: false, error: e.message }; }
  finally { setProgress(null); setJob(null); afterProfileChange(); }
}
function removeServer(id) {
  const s = G.servers.find(x => x.id === id);
  if (!s) return { ok: false, error: 'not found' };
  if (job) return { ok: false, error: 'Lucrez deja.' };
  G.servers = G.servers.filter(x => x.id !== id);
  // its profile and data; the shared download cache stays
  for (const d of [s.profileDir, serverDir(id)]) { try { if (d && d.startsWith(DATA)) fs.rmSync(d, { recursive: true, force: true }); } catch { } }
  log(`Server removed: ${s.name}`);
  activate(G.activeServer === id ? (G.servers[0]?.id || null) : G.activeServer);
  return { ok: true };
}

// =====================================================================================================
// NEXUS (shared)
// =====================================================================================================
async function nexusInstallNow(e, nxm) {
  setJob({ kind: 'nexus', label: `Installing ${e.title} (Nexus)`, started: Date.now() });
  log(`▶ ${job.label}`, 'start');
  try {
    setProgress({ phase: 'install', text: e.title, done: 0, total: 1 });
    await installNexus({ key: `nexus-${e.modId}`, full: `nexus-${e.modId}`, ver: String(e.version || e.ver || e.fileId), role: e.role || 'user', title: e.title, modId: e.modId, fileId: e.fileId }, nxm);
    if (e.role === 'recommended') { srv().nexusChosen[`nexus-${e.modId}`] = true; saveSettings(); }
    delete nexusPending[e.modId];
    nexusWaiting = nexusWaiting.filter(n => n.modId !== e.modId);
    log(`■ ${e.title} installed`, 'done');
    notify('Installed from Nexus', e.title);
    return { ok: true };
  } catch (err) { log(`■ Nexus: ${err.message}`, 'error'); return { ok: false, error: err.message }; }
  finally { setProgress(null); setJob(null); send('nexusPending', nexusPending); afterProfileChange(); }
}
async function nexusInstall({ modId, fileId, title, version, fileName }) {
  if (!srv()) return { ok: false, error: 'Add or create a server first.' };
  if (!dec(G.nexusKeyEnc)) return { ok: false, error: 'Pune întâi cheia ta Nexus în Setări → Nexus Mods.', needKey: true };
  if (!fileId) {
    const f = Nexus.pickMain(await nexus.modFiles(modId));
    if (!f) return { ok: false, error: 'The mod has no files to download.' };
    fileId = f.fileId; version = version || f.version;
  }
  const e = { modId: +modId, fileId: +fileId, title, version, fileName };
  if (G.nexusUser?.premium) { if (job || queue.length || pumping) return enqueue(`Install ${e.title} (Nexus)`, `nexus-${e.modId}`, () => nexusInstallNow(e)); return nexusInstallNow(e); }
  nexusPending[e.modId] = { ...e, at: Date.now() };
  send('nexusPending', nexusPending);
  shell.openExternal(Nexus.filesPage(e.modId, e.fileId));
  return { ok: true, waiting: true };
}
async function handleLink(url) {
  showWindow();
  if (/^bifrost:\/\//i.test(url)) {
    const r = await addServer(url);
    toast(r.ok ? (r.existed ? 'The server was already added.' : `Server added: ${r.name}. Press PLAY.`) : r.error, r.ok ? 'ok' : 'error');
    return;
  }
  const x = Nexus.parseNxm(url);
  if (!x) return toast('Invalid Nexus link.', 'error');
  if (x.game !== 'valheim') return toast(`The link is for ${x.game}, not Valheim.`, 'error');
  if (job) return toast('Already working - press again when it is done.', 'error');
  if (!srv()) return toast('Add or create a server first.', 'error');
  const pend = nexusPending[x.modId];
  const want = nexusWaiting.find(n => n.modId === x.modId) || (manifest?.nexus || []).filter(n => n.modId === x.modId)
    .map(n => ({ modId: n.modId, title: n.title, version: n.version, role: n.required ? 'required' : 'recommended' }))[0];
  let e = pend ? { ...pend } : want ? { ...want } : null;
  if (!e) { const m = await nexus.modInfo(x.modId).catch(() => null); e = { modId: x.modId, title: m?.name || `Nexus ${x.modId}`, version: m?.version || '' }; }
  e.fileId = x.fileId;
  const r = await nexusInstallNow(e, x);
  if (!r.ok) { toast(r.error, 'error'); return; }
  if (nexusWaiting.length) {
    // next file: its page opens by itself, one click there each
    toast(`${e.title} installed. ${nexusWaiting.length} more from Nexus - press "Slow download" on the page that opens.`, 'ok');
    shell.openExternal(Nexus.filesPage(nexusWaiting[0].modId, nexusWaiting[0].fileId));
  } else if (resumePlay) {
    resumePlay = false;
    toast(`${e.title} installed - all Nexus mods are ready, starting Valheim.`, 'ok');
    setTimeout(() => playerSync({ launch: true }).then(res => { if (!res.ok && res.error) toast(res.error, 'error'); }), 800);
  } else toast(`${e.title} installed.`, 'ok');
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
    log(`Bifrost ${r.latest} downloaded - used from the next start`, 'done');
    notify('Bifrost', `Version ${r.latest} is ready - restart Bifrost to use it.`);
  } catch (e) { log(`update: ${e.message}`); appUpdate = { ...(appUpdate || {}), current: OWN_VERSION, error: e.message, checkedAt: Date.now() }; send('appUpdate', appUpdate); }
  finally { updateBusy = false; }
}

// =====================================================================================================
// IPC
// =====================================================================================================
ipcMain.handle('init', () => { const t = Date.now(); const r = initPayload(); setImmediate(pageReady); perf(`init built in ${Date.now() - t}ms, ${Math.round(JSON.stringify(r).length / 1024)} KB`); return r; });
const initPayload = () => ({
  settings: publicSettings(), profile: modsPayload(), status, job, watch, installing, queue: queueInfo(), catalogFetched: catalog?.fetched || null,
  log: logTail.slice(-400), updates, modpack: modpackInfo(), list: listState, player: playerInfo(), appUpdate, version: OWN_VERSION, game: gameState,
});
ipcMain.handle('action', async (_e, name, arg) => {
  if (!PERF) return action(name, arg);
  const t = Date.now(), r = await action(name, arg);
  perf(`action ${name} ${Date.now() - t}ms, ${Math.round((JSON.stringify(r) || '').length / 1024)} KB`);
  return r;
});
// (an AppImage's own path is gone once it quits - relaunch the .AppImage file)
ipcMain.handle('installUpdate', () => { quitting = true; app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE, args: process.argv.slice(1) } : undefined); app.quit(); });
const SERVER_SETTABLE = { directJoin: 'directJoin', joinAddress: 'joinAddress', serverName: 'name', serverWorld: 'world', addresses: 'addresses', autoSync: 'autoSync', quietSeconds: 'quietSeconds', retryMinutes: 'retryMinutes',
  syncConfigs: 'syncConfigs', syncAllMods: 'syncAllMods', pullServerMods: 'pullServerMods', autoPublish: 'autoPublish', publishAddress: 'publishAddress', builtin: 'builtin', modpackTeam: 'modpackTeam', modpackName: 'modpackName' };
const GLOBAL_SETTABLE = ['startWithWindows', 'notifications', 'gameDir', 'lang', 'bepConsoleMode'];
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
      if (!s?.conn) return { ok: false, error: 'The server has no connection.' };
      try {
        const st = readState();
        const r = await syncMods(st, { pluginsDir: pluginsDir(), transport: transport(), builtin: new RegExp(s.builtin || 'BepInExPack', 'i'), allMods: s.syncAllMods, dryRun: true });
        return { ok: true, toCopy: r.copy.join(', ') || '-', toRemove: r.remove.join(', ') || '-' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    case 'modConfigs': {
      const ix = await configIndex();
      const files = [...ix.owners].filter(([, k]) => k === (arg || '')).map(([rel]) => {
        let size = 0; try { size = fs.statSync(cfgPath(rel)).size; } catch { }
        return { rel, size, kind: /\.cfg$/i.test(rel) ? 'cfg' : 'text' };
      });
      return { ok: true, files, server: isAdmin() && !!srv().conn && !!srv().syncConfigs, side: readState().mods[arg] || null };
    }
    case 'readConfig': try {
      const p = cfgPath(arg);
      if (fs.statSync(p).size > 4 * 1024 * 1024) return { ok: false, error: 'Fișierul e prea mare pentru editor (peste 4 MB).' };
      const text = fs.readFileSync(p, 'utf8');
      return { ok: true, text, hash: sha1(text), parsed: /\.cfg$/i.test(arg) ? bepcfg.parse(text) : null };
    } catch (e) { return { ok: false, error: e.message }; }
    case 'serverEnvRead': try { return await serverEnvRead(); } catch (e) { return { ok: false, error: e.message }; }
    case 'serverEnvSave': try { return await serverEnvSave(arg || {}); } catch (e) { return { ok: false, error: e.message }; }
    case 'serverEnvApply': return serverEnvApply();
    case 'deleteConfigs': try { return await deleteConfigs(arg); } catch (e) { return { ok: false, error: e.message }; }
    case 'saveConfig': try { return await saveConfig(arg || {}); } catch (e) { return { ok: false, error: e.message }; }
    case 'restartIdle': try { const st = readState(); st.restartPending = true; writeState(st); return await maybeRestart({ manual: true, what: 'new configs' }); } catch (e) { return { ok: false, error: e.message }; }
    case 'restart': try { const st = readState(); st.restartPending = true; writeState(st); return await maybeRestart({ manual: true, force: true }); } catch (e) { return { ok: false, error: e.message }; }
    case 'fixcode': try {
      if (restarting) return { ok: false, error: 'Serverul repornește acum - așteaptă să termine.' };
      const tr = transport();
      if (typeof tr?.restartGame !== 'function') return { ok: false, error: 'Un join code nou se cere doar la serverele Docker (valheim-server); aici repornește serverul din panoul hostului.' };
      await tr.restartGame(); setTimeout(pollStatus, 20000); setTimeout(pollStatus, 60000); return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
    case 'startServer': try { await transport().ssh(`cd ~ && docker start ${s.conn.container}`); setTimeout(pollStatus, 5000); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
    case 'setSide': return setSide(arg.name, arg.side);
    case 'refresh': pollStatus(); send('mods', modsPayload()); return { ok: true };
    case 'publishList': return publishList('manual');
    case 'twoWay': await twoWay('manual'); return { ok: !watch.twoWay?.error, ...(watch.twoWay || {}) };
    case 'nexusLink': {
      if (!arg.url) { delete s.nexusLinks[arg.name]; saveSettings(); send('mods', modsPayload()); return { ok: true }; }
      const modId = Nexus.parseModUrl(arg.url);
      if (!modId) return { ok: false, error: 'Paste the link of the Nexus page (nexusmods.com/valheim/mods/...).' };
      try {
        const [m, files] = await Promise.all([nexus.modInfo(modId), nexus.modFiles(modId)]);
        const f = Nexus.pickMain(files);
        if (!f) return { ok: false, error: 'The mod has no files.' };
        s.nexusLinks[arg.name] = { modId, fileId: f.fileId, fileName: f.name, version: f.version || m?.version, title: m?.name || f.name };
        saveSettings(); send('mods', modsPayload()); schedulePublish('Nexus link');
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
      return { ok: !!catalog, fetched: catalog?.fetched || null, packages: catalog?.packages?.length ? catalog.packages : null };
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
      if (!GITHUB_CLIENT_ID) return { ok: false, error: 'GitHub login is not set up in this build - paste a token (scope "gist").' };
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
      if (GLOBAL_SETTABLE.includes(arg.key)) { G[arg.key] = arg.value; saveSettings(); if (arg.key === 'startWithWindows') applyStartup();
        if (arg.key === 'lang') trayMenu();
        if (arg.key === 'gameDir') { Profile.findGame().then(g => { game = g; if (Profile.isGameDir(G.gameDir)) game.game = G.gameDir; send('player', playerInfo()); }); } }
      else if (SERVER_SETTABLE[arg.key] && s) {
        s[SERVER_SETTABLE[arg.key]] = arg.value; saveSettings();
        if (arg.key === 'autoSync') { if (arg.value && watch.dirty) changedAt = Date.now() - s.quietSeconds * 1000; setWatch(arg.value ? 'idle' : 'off', arg.value ? 'pornit' : 'auto-sync oprit'); }
        if (arg.key === 'publishAddress' || arg.key === 'serverName' || arg.key === 'serverWorld') schedulePublish('settings');
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
    case 'cacheInfo': return { ok: true, ...cacheStats() };
    case 'clearCache': {
      if (job) return { ok: false, error: 'Lucrez deja - încearcă în câteva secunde.' };
      const before = cacheStats().bytes;
      for (const d of CACHE_DIRS) { try { fs.rmSync(path.join(DATA, 'cache', d), { recursive: true, force: true }); } catch { } }
      log(`Download cache emptied (${Math.round(before / 1048576)} MB)`);
      return { ok: true, freed: before };
    }
    case 'setJoinPassword': {
      if (!s) return { ok: false };
      s.joinPassEnc = arg ? enc(String(arg)) : null; saveSettings(); send('settings', publicSettings());
      return { ok: true };
    }
    case 'detectJoinPassword': try { return await detectJoinPassword(); } catch (e) { return { ok: false, error: e.message }; }
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
    case 'findGame': game = await Profile.findGame(); if (Profile.isGameDir(G.gameDir)) game.game = G.gameDir; send('player', playerInfo()); return { ok: !!game.game, game };
    case 'restoreLoader': {
      if (!game.game) return { ok: false, error: 'The game folder is not found.' };
      const ok = Profile.restoreGame(game.game);
      send('player', playerInfo());
      return ok ? { ok: true } : { ok: false, error: 'There is no backup (Bifrost has not replaced anything).' };
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
  perf('ready');
  // --perf-close=<s>: presses the window close button after <s> seconds (tray unload test)
  const pc = +((process.argv.find(x => x.startsWith("--perf-close=")) || "").slice(13));
  if (PERF && pc) setTimeout(() => { if (win && !win.isDestroyed()) win.close(); }, pc * 1000);
  if (PERF) {
    let last = process.cpuUsage();
    setInterval(() => {
      const m = app.getAppMetrics(), c = process.cpuUsage(last); last = process.cpuUsage();
      perf(`main cpu ${((c.user + c.system) / 1e4 / 10).toFixed(1)}% · ` + m.map(x => `${x.type} ${x.cpu.percentCPUUsage.toFixed(1)}% ${Math.round(x.memory.workingSetSize / 1024)}MB`).join(' · '));
    }, 10000);
  }
  protocol.handle('modicon', req => {
    const name = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''));
    if (!name || name.includes('..') || /[\\/]/.test(name)) return new Response('', { status: 404 });
    return net.fetch(pathToFileURL(path.join(pluginsDir(), name, 'icon.png')).toString());
  });
  if (!dataArg) ensureShortcuts();
  if (!dataArg) { applyStartup(); registerProtocols(); }
  createTray();
  if (!process.argv.includes('--hidden') || process.argv.some(x => x.startsWith('--shot='))) createWindow(true);
  for (const n of settingsNotes) { log(n, 'error'); toast(n, 'error'); }
  log(`Bifrost ${OWN_VERSION} started (${G.servers.length} ${G.servers.length === 1 ? 'server' : 'servers'}${srv() ? `, active: ${srv().name} - ${srv().role}` : ''})`);
  loadManifestCache();
  indexCatalog();
  setTimeout(() => checkUpdates(6 * 3600e3), 6000);
  setInterval(() => checkUpdates(6 * 3600e3), 3600e3);
  setTimeout(checkAppUpdate, 15000); setInterval(checkAppUpdate, 4 * 3600e3);
  game = await Profile.findGame();
  if (Profile.isGameDir(G.gameDir)) game.game = G.gameDir;
  send('player', playerInfo());
  // admin: watch the profile, sync, configs; everyone: status + the list
  setTimeout(() => { if (isAdmin() && srv().conn && srv().autoSync) syncNow('startup'); }, 4000);
  setInterval(tick, 3000);
  setTimeout(() => { if (!job) pruneCache(); }, 90e3);
  setInterval(() => { if (!job) pruneCache(); }, 24 * 3600e3);
  const gameCheck = () => setTimeout(async () => { await checkGameProcess(); gameCheck(); }, (win && !win.isDestroyed() && win.isVisible()) || gameState.launching ? 4000 : 20000);
  checkGameProcess(); gameCheck();
  setInterval(() => twoWay('periodic check'), 3 * 60e3);
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
