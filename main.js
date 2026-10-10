// Bifrost - Valheim mod manager + server companion.
//   admin mode : watches the admin's Thunderstore Mod Manager profile, pushes server mods with sync-valheim-mods.ps1
//                -Auto, shows the server status over SSH, publishes the server's mod list (GitHub) and the modpack.
//   player mode: reads that list, installs exactly those mods into its own profile (Thunderstore + Nexus) and
//                starts Valheim with them.
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, shell, nativeImage, safeStorage, clipboard, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const yaml = require('js-yaml');
const { Profile, BEPINEX, cmpVer, parseDep } = require('./lib/profile');
const { Nexus } = require('./lib/nexus');
const serverList = require('./lib/manifest');
const { ServerSync } = require('./lib/serversync');

const APP_ID = 'io.github.florincamarut1.bifrost';
const REPO_DEFAULT = 'FlorinCamarut1/bifrost';
const ICON = path.join(__dirname, 'ui', 'app.png');
const BUILTIN = /ValheimPlus|BepInExPack/i;                       // provided by the server image itself
const TS = 'https://thunderstore.io';
const DEV_ADMIN_ROOT = path.resolve(__dirname, '..');             // ...\valheim when run from the source folder

app.setAppUserModelId(APP_ID);
// --data=<dir>: a separate Bifrost (own settings + profile), e.g. to try player mode next to the admin one
const dataArg = process.argv.find(a => a.startsWith('--data='));
if (dataArg) app.setPath('userData', path.resolve(dataArg.slice(7)));
const nxmArg = argv => argv.find(a => /^nxm:\/\//i.test(a));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
protocol.registerSchemesAsPrivileged([{ scheme: 'modicon', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// ---------- settings (+ migration from "Valheim Panel") ----------
const DATA = app.getPath('userData');                              // %APPDATA%\Bifrost
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return def; } };
const OLD_DATA = path.join(app.getPath('appData'), 'Valheim Panel');
let migrated = false;
if (!dataArg && !fs.existsSync(SETTINGS_FILE) && fs.existsSync(path.join(OLD_DATA, 'settings.json'))) {
  fs.mkdirSync(DATA, { recursive: true });
  for (const f of ['settings.json', 'catalog.json']) { try { fs.copyFileSync(path.join(OLD_DATA, f), path.join(DATA, f)); } catch { } }
  migrated = true;
}
const DEFAULTS = {
  role: null, adminFolder: null, adminSource: 'tmm', syncConfigs: true, syncAllMods: true, pullServerMods: true,
  autoSync: true, startWithWindows: null, notifications: true, quietSeconds: 45, retryMinutes: 5,
  server: '', container: 'valheim', profile: 'Default', tokenEnc: null,
  manifestRepo: REPO_DEFAULT, autoPublish: true, publishAddress: false, serverName: 'Server', serverWorld: '', addresses: '',
  modpackTeam: '', modpackName: '', nexusLinks: {},
  nexusKeyEnc: null, nexusUser: null, gameDir: null, recommended: {}, nexusChosen: {}, shortcutsV2: false,
};
let settings = { ...DEFAULTS, ...readJson(SETTINGS_FILE, {}) };
const saveSettings = () => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); };
if (settings.role === null) {
  // the old Valheim Panel was the admin's tool; a fresh install is a player
  if (migrated && fs.existsSync(path.join(DEV_ADMIN_ROOT, 'sync-valheim-mods.ps1'))) {
    Object.assign(settings, { role: 'admin', adminFolder: DEV_ADMIN_ROOT });
  } else settings.role = 'player';
}
if (settings.startWithWindows === null) settings.startWithWindows = settings.role === 'admin';
saveSettings();

const adminRoot = () => settings.adminFolder && fs.existsSync(path.join(settings.adminFolder, 'sync-valheim-mods.ps1')) ? settings.adminFolder : null;
const isAdmin = () => settings.role === 'admin' && !!adminRoot();
const SYNC = () => path.join(adminRoot(), 'sync-valheim-mods.ps1');
const STATE_FILE = () => path.join(adminRoot(), 'mods.json');
const MODPACK_DIR = () => path.join(adminRoot(), 'modpack');
const LOG_FILE = path.join(DATA, 'bifrost.log');
const enc = s => safeStorage.encryptString(String(s).trim()).toString('base64');
const dec = s => { try { return s ? safeStorage.decryptString(Buffer.from(s, 'base64')) : null; } catch { return null; } };
const publicSettings = () => {
  const { tokenEnc, nexusKeyEnc, ...s } = settings;
  return { ...s, hasToken: !!tokenEnc, hasNexusKey: !!nexusKeyEnc, isAdmin: isAdmin(), ownSource: ownSource(), adminRootOk: !!adminRoot(), packaged: app.isPackaged };
};

// ---------- window / tray / events ----------
let win = null, tray = null, quitting = false;
const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send('event', ch, data); };
function notify(title, body, kind) {
  if (!settings.notifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON, silent: kind !== 'warn' });
  n.on('click', showWindow);
  n.show();
}
function toast(text, kind = 'info') { send('toast', { text, kind }); }
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
  // test screenshots render off-screen, without taking focus
  win.once('ready-to-show', () => { if (shotMode) win.showInactive(); else if (show) win.show(); });
  // test hook: --shot=<dir> [--pages=a,b] saves a screenshot of every page once the data is in
  const shot = (process.argv.find(a => a.startsWith('--shot=')) || '').slice(7);
  if (shot) win.webContents.once('did-finish-load', () => setTimeout(async () => {
    const pages = ((process.argv.find(a => a.startsWith('--pages=')) || '').slice(8) || 'home,server,mods,pmods,browse,modpack,log,settings').split(',');
    for (const p of pages) {
      if (p.startsWith('drawer:')) await win.webContents.executeJavaScript(`openDrawer(${JSON.stringify(p.slice(7))})`);
      else if (p === 'nexus') await win.webContents.executeJavaScript("closeDrawer(); go('browse'); setSource('nx')");
      else if (p.startsWith('nxdrawer:')) await win.webContents.executeJavaScript(`openNexusDrawer(${+p.slice(9)})`);
      else await win.webContents.executeJavaScript(`closeDrawer(); go(${JSON.stringify(p)})`);
      await new Promise(r => setTimeout(r, p === 'browse' || p === 'nexus' ? 8000 : /drawer:/.test(p) ? 4000 : 900));
      fs.writeFileSync(path.join(shot, `${p.replace(/[:]/g, '-')}.png`), (await win.webContents.capturePage()).toPNG());
    }
  }, 12000));
  win.on('close', e => {
    if (quitting) return;
    // the admin keeps it running in the tray (auto-sync); a player who closes it is done
    if (isAdmin() || settings.startWithWindows) { e.preventDefault(); win.hide(); } else quitting = true;
  });
  win.on('show', () => { if (isAdmin()) pollStatus(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
}
function updateTray() {
  if (!tray) return;
  let lines = ['Bifrost'];
  if (isAdmin()) {
    const s = status;
    lines.push(s.reachable === false ? 'server: fără conexiune' : s.container !== 'running' ? `server: ${s.container || '...'}` :
      s.joinCode ? `join code ${s.joinCode} - ${s.players ?? 0} online` : 'serverul pornește...', watch.text);
  } else if (manifest) lines.push(settings.serverName === 'Server' ? manifest.server?.name || '' : '');
  tray.setToolTip(lines.filter(Boolean).join('\n').slice(0, 127));
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  const items = isAdmin()
    ? [{ label: 'Deschide Bifrost', click: showWindow }, { label: 'Sincronizează acum', click: () => syncNow('manual') },
    { label: 'Copiază join code', click: () => { if (status.joinCode) clipboard.writeText(status.joinCode); } }]
    : [{ label: 'Deschide Bifrost', click: showWindow }, { label: 'Joacă', click: () => playerSync({ launch: true }) }];
  tray.setContextMenu(Menu.buildFromTemplate([...items, { type: 'separator' }, { label: 'Ieșire', click: () => { quitting = true; app.quit(); } }]));
  tray.on('click', showWindow);
  updateTray();
}

// ---------- shortcuts / autostart ----------
const devShortcut = extraArgs => ({
  target: process.execPath, args: `"${__dirname}"${extraArgs ? ' ' + extraArgs : ''}`, cwd: __dirname,
  icon: path.join(__dirname, 'ui', 'app.ico'), iconIndex: 0, appUserModelId: APP_ID, description: 'Bifrost - Valheim',
});
const startMenu = () => path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
function applyStartup() {
  try {
    if (app.isPackaged) { app.setLoginItemSettings({ openAtLogin: !!settings.startWithWindows, args: ['--hidden'] }); return; }
    const lnk = path.join(startMenu(), 'Startup', 'Bifrost.lnk');
    if (settings.startWithWindows) shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'replace' : 'create', devShortcut('--hidden'));
    else if (fs.existsSync(lnk)) fs.unlinkSync(lnk);
  } catch (e) { log(`autostart: ${e.message}`); }
}
function devShortcuts() {
  // running from the source folder: our own Start menu + Desktop shortcuts (the Start menu one carries the
  // AppUserModelID Windows needs for notifications). The installer makes them for the packaged app.
  for (const old of [path.join(startMenu(), 'Valheim Panel.lnk'), path.join(app.getPath('desktop'), 'Valheim Panel.lnk'), path.join(startMenu(), 'Startup', 'Valheim Panel.lnk')]) {
    try { if (fs.existsSync(old)) fs.unlinkSync(old); } catch { }
  }
  for (const l of [path.join(startMenu(), 'Bifrost.lnk'), path.join(app.getPath('desktop'), 'Bifrost.lnk')]) {
    try { shell.writeShortcutLink(l, fs.existsSync(l) ? 'replace' : 'create', devShortcut('')); } catch (e) { log(`shortcut ${l}: ${e.message}`); }
  }
  settings.shortcutsV2 = true; saveSettings();
}

// ---------- log ----------
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
// ADMIN
// =====================================================================================================
const tmmProfileDir = () => path.join(app.getPath('appData'), 'Thunderstore Mod Manager', 'DataFolder', 'Valheim', 'profiles', settings.profile);
const tmmPluginsDir = () => path.join(tmmProfileDir(), 'BepInEx', 'plugins');
// the admin's mods live in Bifrost's own profile (after the one-time import from Thunderstore Mod Manager)
const ownSource = () => isAdmin() && settings.adminSource === 'bifrost';
const pluginsDir = () => ownSource() ? path.join(getProfile().dir, 'BepInEx', 'plugins') : tmmPluginsDir();
function readState() {
  const j = adminRoot() ? readJson(STATE_FILE(), {}) : {};
  return { raw: j, mods: j.mods || {}, installed: Array.isArray(j.installed) ? j.installed : (j.installed ? [j.installed] : []), restartPending: !!j.restartPending };
}
function readProfile() { return ownSource() ? ownAdminMods() : readTmmProfile(); }
function ownAdminMods() {
  const st = readState(), pr = getProfile();
  const mods = Object.entries(pr.packages).map(([k, x]) => {
    const c = catalogIndex.get(k);
    return {
      name: k, displayName: (c?.name || x.title || k).replace(/_/g, ' '),
      author: c?.owner || (x.source === 'nexus' ? 'Nexus' : x.source === 'manual' ? 'instalat manual' : k.split('-')[0]),
      description: c?.desc || (x.source === 'manual' ? 'Nu e din Thunderstore / Nexus (copiat la import).' : ''), version: x.ver, enabled: true,
      url: c?.url || (x.modId ? `https://www.nexusmods.com/valheim/mods/${x.modId}` : null), builtin: BUILTIN.test(k),
      modpack: !!settings.modpackName && k.endsWith(`-${settings.modpackName}`), side: st.mods[k] || null, onServer: st.installed.includes(k),
      icon: fs.existsSync(path.join(pluginsDir(), k, 'icon.png')) ? `modicon://icon/${encodeURIComponent(k)}` : (c?.icon || null),
      manual: x.source !== 'thunderstore', role: x.role, source: x.source, size: x.size || 0,
      nexus: x.source === 'nexus' ? { modId: x.modId, fileId: x.fileId, version: x.ver, title: x.title } : (settings.nexusLinks[k] || null),
    };
  });
  return { mods, restartPending: st.restartPending, profileFound: true, profile: 'Bifrost', source: 'bifrost' };
}
function readTmmProfile() {
  let list = [];
  try { list = yaml.load(fs.readFileSync(path.join(tmmProfileDir(), 'mods.yml'), 'utf8')) || []; } catch { }
  const st = readState();
  const seen = new Set();
  const iconUrl = n => fs.existsSync(path.join(tmmPluginsDir(), n, 'icon.png')) ? `modicon://icon/${encodeURIComponent(n)}` : null;
  const mods = list.filter(m => m && m.name).map(m => {
    seen.add(m.name);
    const v = m.versionNumber || {};
    return {
      name: m.name, displayName: (m.displayName || m.name).replace(/_/g, ' '), author: m.authorName || m.name.split('-')[0],
      description: (m.description || '').trim(), version: `${v.major ?? 0}.${v.minor ?? 0}.${v.patch ?? 0}`,
      enabled: m.enabled !== false, url: m.websiteUrl || null, builtin: BUILTIN.test(m.name),
      modpack: !!settings.modpackName && m.name.endsWith(`-${settings.modpackName}`), side: st.mods[m.name] || null, onServer: st.installed.includes(m.name),
      icon: iconUrl(m.name), installedAt: m.installedAtTime || 0,
    };
  });
  try {
    for (const e of fs.readdirSync(tmmPluginsDir(), { withFileTypes: true })) {
      if (seen.has(e.name) || !(e.isDirectory() || /\.dll$/i.test(e.name))) continue;
      mods.push({
        name: e.name, displayName: e.name.replace(/\.dll$/i, ''), author: 'instalat manual', description: 'Nu e din Thunderstore (ex. Nexus).',
        version: '', enabled: true, manual: true, builtin: BUILTIN.test(e.name), side: st.mods[e.name] || null,
        onServer: st.installed.includes(e.name), icon: iconUrl(e.name), nexus: settings.nexusLinks[e.name] || null,
      });
    }
  } catch { }
  return { mods, restartPending: st.restartPending, profileFound: fs.existsSync(tmmProfileDir()), profile: settings.profile, source: 'tmm' };
}
let sideTimer = null;
function setSide(name, side) {
  if (job) return { ok: false, error: 'O sincronizare rulează acum - încearcă după ce termină.' };
  const st = readState();
  st.raw.mods = { ...st.mods, [name]: side };
  if (!st.raw.installed) st.raw.installed = st.installed;
  fs.writeFileSync(STATE_FILE(), JSON.stringify(st.raw, null, 2));
  log(`${name} -> ${side} (marcat în app)`);
  send('mods', modsPayload());
  watch.dirty = true; setWatch();
  if (settings.autoSync) { clearTimeout(sideTimer); sideTimer = setTimeout(() => syncNow('schimbare server/client'), 4000); }
  return { ok: true };
}

// ---------- jobs (one at a time) ----------
let job = null;   // { kind, label, started }
function setJob(j) { job = j; send('job', job); }
function runProcess(kind, label, cmd, args, opts = {}) {
  return new Promise(resolve => {
    if (job) return resolve({ code: -1, busy: true, lines: [] });
    setJob({ kind, label, started: Date.now() }); log(`▶ ${label}`, 'start');
    const lines = [];
    let p;
    try { p = spawn(cmd, args, { windowsHide: true, cwd: adminRoot() || DATA, ...opts }); }
    catch (e) { setJob(null); log(e.message, 'error'); return resolve({ code: 1, lines: [e.message] }); }
    let buf = '';
    const onData = d => {
      buf += d.toString();
      const parts = buf.split(/\r?\n/); buf = parts.pop();
      for (const l of parts) { lines.push(l); if (l.trim()) log(`  ${l}`, 'out'); }
    };
    p.stdout.on('data', onData); p.stderr.on('data', onData);
    p.on('error', e => { lines.push(e.message); });
    p.on('close', code => {
      if (buf) { lines.push(buf); log(`  ${buf}`, 'out'); }
      log(`■ ${label}: exit ${code}`, code === 0 ? 'done' : 'error');
      setJob(null);
      applyHints();
      resolve({ code, lines });
    });
  });
}
const runSync = (kind, label, args) => runProcess(kind, label, 'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SYNC(), '-Profile', settings.profile, '-Server', settings.server, '-Container', settings.container,
    ...(ownSource() ? ['-ClientPlugins', pluginsDir(), '-SkipDoorstop'] : []), ...(ownSource() && settings.syncAllMods ? ['-AllMods'] : []), ...args]);

function summarize(lines) {
  const strip = s => s.replace(/^\s+(copied|removed)\s+/, '').trim();
  const r = {
    copied: lines.filter(l => /^\s+copied /.test(l)).map(strip),
    removed: lines.filter(l => /^\s+removed /.test(l)).map(strip),
    newMods: lines.filter(l => /^\s+\S+\s+-> (server|client)/.test(l)).map(l => l.trim().replace(/\s+/g, ' ')),
    joinCode: (lines.join('\n').match(/Join code: (\d+)/) || [])[1] || null,
    noCode: lines.some(l => /No join code/.test(l)),
    toCopy: ((lines.find(l => /^To copy\s+:/.test(l)) || '').split(':')[1] || '').trim(),
    toRemove: ((lines.find(l => /^To remove\s+:/.test(l)) || '').split(':')[1] || '').trim(),
    error: lines.filter(l => l.trim()).slice(-3).join(' '),
  };
  r.what = [r.copied.length && `Actualizat: ${r.copied.join(', ')}`, r.removed.length && `Scos: ${r.removed.join(', ')}`,
  r.newMods.length && `Moduri noi (ghicit): ${r.newMods.join('; ')}`].filter(Boolean).join('\n');
  return r;
}

// ---------- watcher ----------
const watch = { text: 'pornește...', state: 'idle', dirty: false, lastSync: null, lastResult: null, retryAt: null };
let seenSig = null, syncedSig = null, changedAt = null, failStreak = 0;
function setWatch(state, text) { if (state) watch.state = state; if (text) watch.text = text; send('watch', watch); updateTray(); }
function signature() {
  const parts = [];
  try { const s = fs.statSync(ownSource() ? getProfile().stateFile : path.join(tmmProfileDir(), 'mods.yml')); parts.push(`list|${s.mtimeMs}|${s.size}`); } catch { parts.push('list|none'); }
  try { for (const e of fs.readdirSync(pluginsDir()).sort()) { try { parts.push(`${e}|${fs.statSync(path.join(pluginsDir(), e)).mtimeMs}`); } catch { } } } catch { }
  return parts.join('\n');
}
async function syncNow(reason) {
  if (!isAdmin()) return;
  if (job) { toast('Rulează deja ceva - aștept să termine.'); return; }
  const manual = reason === 'manual';
  const sig = signature();
  changedAt = null; watch.retryAt = null;
  setWatch('syncing', 'sincronizez...');
  const { code, lines, busy } = await runSync('sync', `Sincronizare (${reason})`, ['-Auto']);
  if (busy) return;
  const r = summarize(lines);
  watch.lastSync = Date.now();
  send('mods', modsPayload());
  if (code === 0 || code === 10 || code === 3) { syncedSig = sig; failStreak = 0; }
  watch.dirty = signature() !== syncedSig;
  if (code === 0) {
    if (r.joinCode) {
      watch.lastResult = { kind: 'ok', text: `Server actualizat și repornit - join code ${r.joinCode}`, what: r.what };
      notify('Serverul Valheim e actualizat', `${r.what}\nRepornit - join code ${r.joinCode}`.trim());
      pollStatus();
    } else if (r.noCode) {
      watch.lastResult = { kind: 'ok', text: 'Server actualizat și repornit (fără join code - intră pe IP)', what: r.what };
      notify('Serverul Valheim e actualizat', `${r.what}\nRepornit, dar fără join code - intră pe IP.`.trim());
    } else {
      watch.lastResult = { kind: 'ok', text: 'Serverul e la zi', what: r.what };
      if (manual) toast('Serverul e deja la zi.', 'ok');
    }
    setWatch('idle', 'la zi');
    // the server runs these mods now -> players may get them
    schedulePublish('mods sincronizate');
    setTimeout(() => twoWay('după sincronizare'), 2000);
  } else if (code === 10) {
    setTimeout(() => twoWay('după sincronizare'), 2000);
    watch.lastResult = { kind: 'wait', text: 'Moduri copiate - restartul așteaptă să iasă jucătorii', what: r.what };
    watch.retryAt = Date.now() + settings.retryMinutes * 60e3;
    if (r.copied.length || r.removed.length || manual)
      notify('Moduri copiate pe server', `${r.what}\nSunt jucători online - serverul repornește când se golește.`.trim());
    setWatch('waiting', 'restart după ce iese lumea');
  } else if (code === 3) {
    watch.lastResult = { kind: 'warn', text: 'Oprit: s-ar șterge majoritatea modurilor de pe server (profil gol / greșit?). Nimic schimbat.' };
    notify('Bifrost: sincronizare oprită', 'S-ar șterge majoritatea modurilor de pe server - profil Thunderstore gol sau greșit? Nu am schimbat nimic.', 'warn');
    setWatch('attention', 'necesită atenție');
  } else {
    failStreak++;
    watch.lastResult = { kind: 'error', text: `Eroare: ${r.error}` };
    watch.retryAt = Date.now() + 5 * 60e3;
    if (failStreak === 1) notify('Bifrost: sincronizarea a eșuat', `${r.error}\nReîncerc în 5 minute.`, 'warn');
    setWatch('error', 'eroare - reîncerc');
  }
}
function tick() {
  if (!isAdmin() || job) return;
  const sig = signature();
  if (sig !== seenSig) {
    const first = seenSig === null;
    seenSig = sig;
    if (!first) {
      // a change made by Bifrost itself is complete -> sync after a few seconds instead of waiting for TMM to settle
      changedAt = ownSource() ? Date.now() - Math.max(0, settings.quietSeconds - 5) * 1000 : Date.now();
      watch.dirty = true; const pr = readProfile(); checkInstalling(pr.mods); send('mods', pr); setWatch('change', ownSource() ? 'modurile s-au schimbat...' : 'Thunderstore a schimbat modurile...');
    }
    return;
  }
  if (changedAt && sig === syncedSig) { changedAt = null; watch.dirty = false; setWatch('idle', 'la zi'); }
  if (!settings.autoSync) { if (watch.dirty && watch.state !== 'off') setWatch('off', 'auto-sync oprit - ai schimbări nesincronizate'); return; }
  if (changedAt && Date.now() - changedAt >= settings.quietSeconds * 1000) { syncNow('Thunderstore a schimbat modurile'); return; }
  if (watch.retryAt && Date.now() >= watch.retryAt) syncNow('reîncercare programată');
}

// ---------- server status (one ssh round trip) ----------
const STATUS_SH = c => `
C='${c}'
st=$(docker inspect -f '{{.State.Status}}|{{.State.StartedAt}}' "$C" 2>/dev/null || echo 'missing|')
echo "STATE|$st"
case "$st" in running*)
  docker logs --since "\${st#*|}" "$C" 2>&1 | grep -E 'is active with|now [0-9]+ player|Got character ZDOID from|Connections [0-9]+ ZDOS|OnCheckJoinCodeSuccess|Game server connected|registered with join code' | tail -400 | sed 's/^/LOG|/'
  if docker exec "$C" valheim-is-idle >/dev/null 2>&1; then echo 'IDLE|1'; else echo 'IDLE|0'; fi
;; esac
`;
function ssh(script, timeoutMs = 25000) {
  return new Promise(resolve => {
    const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', settings.server, 'sh -s'], { windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', e => { err += e.message; });
    p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
    p.stdin.end(script.replace(/\r/g, ''));
  });
}
let status = { reachable: null, container: null, checkedAt: null };
let polling = false;
async function pollStatus() {
  if (!isAdmin() || polling || !settings.server) return; polling = true;
  const prevCode = status.joinCode;
  try {
    const { code, out, err } = await ssh(STATUS_SH(settings.container));
    const s = { reachable: code === 0 || /STATE\|/.test(out), checkedAt: Date.now(), error: code === 0 ? null : err.trim().split('\n').pop() };
    const logLines = [];
    for (const l of out.split('\n')) {
      if (l.startsWith('STATE|')) { const [, st, at] = l.trim().split('|'); s.container = st; s.startedAt = at ? Date.parse(at) : null; }
      else if (l.startsWith('IDLE|')) s.idle = l.trim().endsWith('1');
      else if (l.startsWith('LOG|')) logLines.push(l.slice(4));
    }
    const when = l => { const m = l.match(/(\d\d)\/(\d\d)\/(\d{4}) (\d\d):(\d\d):(\d\d)/); return m ? new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]).getTime() : null; };
    let lastActive = -1, lastBad = -1;
    const seen = {};
    logLines.forEach((l, i) => {
      let m;
      if ((m = l.match(/with join code (\d+) and IP (\S+) is active with (\d+) player/))) { s.joinCode = m[1]; s.publicIp = m[2]; s.joinCodeAt = when(l); lastActive = i; }
      if ((m = l.match(/(?:now|with) (\d+) player\(s\)/)) || (m = l.match(/Connections (\d+) ZDOS/))) { s.players = +m[1]; s.playersAt = when(l); }
      if ((m = l.match(/Got character ZDOID from (.+?) : (-?\d+):(\d+)/)) && m[2] !== '0') seen[m[1]] = when(l);
      if (/Game server connected/.test(l)) s.gameUp = true;
      if (/OnCheckJoinCodeSuccess/.test(l)) lastBad = i;
    });
    s.codeBroken = lastBad > lastActive;
    s.recent = Object.entries(seen).map(([name, t]) => ({ name, t })).sort((a, b) => b.t - a.t);
    if (s.idle === true) s.players = 0;
    status = s;
  } catch (e) { status = { reachable: false, error: e.message, checkedAt: Date.now() }; }
  polling = false;
  send('status', status); updateTray();
  if (status.joinCode && status.joinCode !== prevCode && !status.codeBroken && prevCode !== undefined) schedulePublish('join code nou');
}

// ---------- two-way: configs + mods put on the server by hand ----------
let twoWayBusy = false;
// which mod a config file belongs to: BepInEx names configs after the plugin GUID (folders too, mostly), and that
// GUID is a string inside the plugin's DLL -> the mod's server/client choice from mods.json
async function configSides(rels) {
  const st = readState(), pr = getProfile(), best = new Map();   // rel -> { key, score }
  const names = rels.map(r => r.split('/')[0].replace(/\.(cfg|ya?ml|json|txt)$/i, ''));
  const tokens = names.map(n => n.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3));
  for (const [k, p] of Object.entries(pr.packages)) {
    for (const f of (p.files || []).filter(x => /\.dll$/i.test(x))) {
      let txt;
      try { txt = fs.readFileSync(path.join(pr.dir, ...f.split('/'))).toString('latin1'); } catch { continue; }
      rels.forEach((r, i) => {
        if (names[i].length < 4 || !txt.includes(names[i])) return;
        // other mods may mention a GUID (soft dependencies): prefer the package whose name matches it best
        const score = tokens[i].filter(t => k.toLowerCase().includes(t)).length;
        if (!best.has(r) || score > best.get(r).score) best.set(r, { key: k, score });
      });
      await new Promise(res => setImmediate(res));   // big DLLs: keep the UI responsive
    }
  }
  return new Map([...best].map(([r, b]) => [r, st.mods[b.key] === 'client' ? 'client' : 'server']));
}
const serverSync = () => new ServerSync({ server: settings.server, container: settings.container, profileDir: getProfile().dir, stateFile: path.join(DATA, 'config-sync.json'), log });
async function twoWay(reason) {
  if (!ownSource() || !settings.server || twoWayBusy || job || !(settings.syncConfigs || settings.pullServerMods)) return;
  twoWayBusy = true;
  const ss = serverSync(), pr = getProfile(), res = { at: Date.now(), push: 0, pull: 0, mods: [], error: null };
  try {
    if (settings.pullServerMods) {
      // mods on the server that the sync did not put there and the profile does not have
      const st = readState(), have = new Set(Object.keys(pr.packages));
      const extras = (await ss.remotePlugins()).filter(n => !have.has(n) && !st.installed.includes(n) && !BUILTIN.test(n));
      for (const e of extras) {
        if (job) break;
        const m = e.match(/^(.+?)-(\d+\.\d+\.\d+)$/), full = m ? m[1] : e, ver = m ? m[2] : null;
        setJob({ kind: 'pull', label: `Aduc de pe server: ${e}`, started: Date.now() });
        try {
          if (pr.packages[full]) {
            // the same mod under a hand-made folder name: keep ours, drop the duplicate
            await ss.removeRemotePlugin(e);
            log(`Pe server era și ${e} (pus de mână) - îl înlocuiesc cu ${full} din profil`);
          } else if (catalogIndex.get(full)) {
            await installThunderstore({ key: full, full, ver: ver || catalogIndex.get(full).ver, role: 'user', title: catalogIndex.get(full).name }, new Set());
            await ss.removeRemotePlugin(e);
            log(`Adus de pe server: ${full} ${ver || ''} (din Thunderstore)`, 'done');
          } else {
            const tmp = path.join(DATA, 'cache', 'tmp', `srv-${Date.now()}`);
            const src = await ss.fetchPlugin(e, tmp);
            pr.importManual(e, src, { ver: '', role: 'user', source: 'manual', title: e });
            fs.rmSync(tmp, { recursive: true, force: true });
            log(`Adus de pe server: ${e} (manual)`, 'done');
          }
          sideHints[full] = 'server';
          res.mods.push(full);
        } finally { setJob(null); }
      }
      if (res.mods.length) {
        // mods that live on the server are server mods; the next sync takes them over
        const st2 = readState();
        for (const n of res.mods) st2.mods[n] = 'server';
        for (const n of Object.keys(sideHints)) if (res.mods.includes(n)) delete sideHints[n];
        st2.raw.mods = st2.mods; if (!st2.raw.installed) st2.raw.installed = st2.installed;
        fs.writeFileSync(STATE_FILE(), JSON.stringify(st2.raw, null, 2));
        notify('Moduri aduse de pe server', res.mods.join(', '));
        send('mods', modsPayload());
      }
    }
    if (settings.syncConfigs) {
      const r = await ss.syncConfigs({ sideOf: configSides });
      res.push = r.push.length; res.pull = r.pull.length;
      if (r.push.length) log(`Configurări trimise pe server (${reason}): ${r.push.join(', ')}`, 'done');
      if (r.pull.length) log(`Configurări aduse de pe server (${reason}): ${r.pull.join(', ')}`, 'done');
    }
  } catch (e) { res.error = e.message; log(`Sincronizarea configurărilor: ${e.message}`, 'error'); }
  finally { twoWayBusy = false; watch.twoWay = res; send('watch', watch); }
}

// ---------- server list for players (GitHub) ----------
const listState = { at: null, ok: null, error: null, changed: null, busy: false };
let publishTimer = null;
function schedulePublish(reason) {
  if (!isAdmin() || !settings.autoPublish) return;
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => publishList(reason), 5000);
}
function buildList() {
  const mods = readProfile().mods;
  return serverList.build({
    mods, nexusLinks: settings.nexusLinks,
    server: {
      name: settings.serverName, world: settings.serverWorld, joinCode: status.codeBroken ? null : status.joinCode || null,
      // server.json is public: the home IP goes in only if the admin explicitly wants it (join codes work without it)
      joinCodeAt: status.joinCodeAt || null, address: settings.publishAddress ? status.publicIp || null : null,
    },
  });
}
async function publishList(reason) {
  if (!isAdmin() || listState.busy) return { ok: false, error: 'ocupat' };
  const list = { ...buildList(), updatedAt: Date.now() };
  if (list.required.length < 3) { listState.error = 'Profilul pare gol - nu public lista.'; send('list', listState); return { ok: false, error: listState.error }; }
  if (readState().restartPending) { listState.error = 'Serverul nu a repornit încă cu modurile noi - public după restart.'; send('list', listState); return { ok: false, error: listState.error }; }
  listState.busy = true; send('list', listState);
  try {
    const r = await serverList.publish(settings.manifestRepo, list, `server list: ${reason}`);
    Object.assign(listState, { at: Date.now(), ok: true, error: null, changed: r.changed });
    if (r.changed) log(`Lista pentru prieteni publicată (${reason}): ${list.required.length} obligatorii, ${list.recommended.length} recomandate`, 'done');
    return { ok: true, changed: r.changed };
  } catch (e) {
    Object.assign(listState, { at: Date.now(), ok: false, error: e.message });
    log(`Lista pentru prieteni nu s-a publicat: ${e.message}`, 'error');
    return { ok: false, error: e.message };
  } finally { listState.busy = false; send('list', listState); }
}

// ---------- Thunderstore catalog (browse + latest versions) ----------
const CATALOG_FILE = path.join(DATA, 'catalog.json');
let catalog = readJson(CATALOG_FILE, null);
let catalogIndex = new Map();
let catalogBusy = null;
let updates = {};   // name -> { latest, downloads }
const ownPack = () => `${settings.modpackTeam}-${settings.modpackName}`;
function indexCatalog() {
  catalogIndex = new Map((catalog?.packages || []).map(p => [p.full, p]));
  const out = {};
  for (const m of modsPayload().mods) { const p = catalogIndex.get(m.name); if (p) out[m.name] = { latest: p.ver, downloads: p.dl }; }
  const own = catalogIndex.get(ownPack());
  if (own) out[ownPack()] = { latest: own.ver, downloads: own.dl };
  const prev = updates[ownPack()];
  if (prev && (!out[ownPack()] || cmpVer(prev.latest, out[ownPack()].latest) > 0)) out[ownPack()] = prev;
  updates = out;
}
function refreshCatalog() {
  if (catalogBusy) return catalogBusy;
  send('catalogState', { busy: true });
  catalogBusy = new Promise(resolve => {
    // unpacked from app.asar in the installed build (see build.asarUnpack)
    const p = spawn(process.execPath, [path.join(__dirname.replace(/app.asar$/, 'app.asar.unpacked'), 'catalog-worker.js'), CATALOG_FILE],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', code => {
      catalogBusy = null;
      if (code === 0) { catalog = readJson(CATALOG_FILE, catalog); indexCatalog(); log(`Catalog Thunderstore actualizat: ${out.trim()}`); }
      else log(`Catalogul Thunderstore nu s-a putut descărca: ${err.trim()}`, 'error');
      send('updates', updates); if (isAdmin()) send('modpack', modpackInfo());
      send('catalogState', { busy: false, fetched: catalog?.fetched || null, error: code === 0 ? null : err.trim() });
      resolve(code === 0);
    });
  });
  return catalogBusy;
}
async function checkUpdates(maxAgeMs = 0) {
  if (!catalog || Date.now() - catalog.fetched > maxAgeMs) await refreshCatalog();
  else { indexCatalog(); send('updates', updates); if (isAdmin()) send('modpack', modpackInfo()); }
}

// ---------- admin: installing through Thunderstore Mod Manager ----------
const installing = {};   // full name -> { ver, at }
const sideHints = {};
function applyHints() {
  if (!isAdmin() || job || !Object.keys(sideHints).length) return;
  const st = readState();
  let changed = false;
  for (const [n, side] of Object.entries(sideHints)) { if (!st.mods[n]) { st.mods[n] = side; changed = true; } delete sideHints[n]; }
  if (!changed) return;
  st.raw.mods = st.mods; if (!st.raw.installed) st.raw.installed = st.installed;
  fs.writeFileSync(STATE_FILE(), JSON.stringify(st.raw, null, 2));
}
function installViaTmm(full, ver) {
  const p = catalogIndex.get(full);
  if (!p) return { ok: false, error: 'Nu găsesc pachetul în catalog.' };
  ver = ver || p.ver;
  const cats = p.cats || [];
  const side = cats.includes('Server-side') ? 'server' : cats.includes('Client-side') ? 'client' : null;
  if (side) { sideHints[full] = side; applyHints(); }
  installing[full] = { ver, at: Date.now() };
  send('installing', installing);
  log(`Instalez ${full} ${ver} prin Thunderstore Mod Manager${side ? ` (marcat ${side} după categoriile Thunderstore)` : ''}`);
  shell.openExternal(`ror2mm://v1/install/thunderstore.io/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.name)}/${ver}/`);
  return { ok: true, side, via: 'tmm' };
}
function checkInstalling(mods) {
  let changed = false;
  for (const [n, x] of Object.entries(installing)) {
    const m = mods.find(y => y.name === n);
    if (m && m.version === x.ver) { delete installing[n]; changed = true; log(`${n} ${x.ver} instalat`, 'done'); }
    else if (Date.now() - x.at > 5 * 60e3) { delete installing[n]; changed = true; }
  }
  if (changed) send('installing', installing);
}

// ---------- modpack ----------
function modpackInfo() {
  if (!isAdmin() || !settings.modpackName) return { configured: false };
  const man = readJson(path.join(MODPACK_DIR(), 'manifest.json'), null);
  const prof = readProfile().mods.filter(m => m.enabled && !m.manual && !m.modpack);
  const inPack = {};
  for (const d of (man?.dependencies || [])) { const m = parseDep(d); if (m) inPack[m.full] = m.ver; }
  const added = [], changed = [], removed = [];
  for (const m of prof) {
    if (!(m.name in inPack)) added.push({ name: m.name, to: m.version });
    else if (inPack[m.name] !== m.version) changed.push({ name: m.name, from: inPack[m.name], to: m.version });
  }
  const profNames = new Set(prof.map(m => m.name));
  for (const n of Object.keys(inPack)) if (!profNames.has(n)) removed.push({ name: n, from: inPack[n] });
  const local = man?.version_number || null;
  const zip = local && path.join(MODPACK_DIR(), `${settings.modpackName}-${local}.zip`);
  return {
    configured: true, name: ownPack(), local, published: updates[ownPack()]?.latest || null, count: Object.keys(inPack).length,
    added, changed, removed, hasToken: !!settings.tokenEnc, zip: zip && fs.existsSync(zip) ? zip : null,
    url: `${TS}/c/valheim/p/${settings.modpackTeam}/${settings.modpackName}/`,
  };
}
async function buildModpack() {
  const deps = readProfile().mods.filter(m => m.enabled && !m.manual && !m.modpack).map(m => `${m.name}-${m.version}`);
  const { code, lines } = await runProcess('build', 'Construiesc modpack-ul', process.execPath, [path.join(MODPACK_DIR(), 'build-modpack.mjs')],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(ownSource() ? { BIFROST_DEPS: JSON.stringify(deps) } : {}) }, cwd: MODPACK_DIR() });
  send('modpack', modpackInfo());
  return { ok: code === 0, info: modpackInfo(), error: code === 0 ? null : lines.filter(l => l.trim()).slice(-2).join(' ') };
}
async function tsApi(token, method, p, body) {
  const r = await net.fetch(`${TS}${p}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { }
  if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status} ${text.slice(0, 300)}`);
  return j;
}
async function publishModpack() {
  const token = dec(settings.tokenEnc);
  if (!token) return { ok: false, error: 'Lipsește tokenul Thunderstore (Setări).' };
  const b = await buildModpack();
  if (!b.ok) return b;
  const zip = b.info.zip;
  if (!zip) return { ok: false, error: 'Nu găsesc zip-ul construit.' };
  setJob({ kind: 'publish', label: `Public ${path.basename(zip)}`, started: Date.now() });
  log(`▶ Public ${path.basename(zip)} pe Thunderstore`, 'start');
  let uuid = null;
  try {
    const data = fs.readFileSync(zip);
    const init = await tsApi(token, 'POST', '/api/experimental/usermedia/initiate-upload/', { filename: path.basename(zip), file_size_bytes: data.length });
    uuid = init.user_media.uuid;
    const parts = [];
    for (const u of init.upload_urls) {
      const chunk = data.subarray(u.offset, u.offset + u.length);
      const r = await net.fetch(u.url, { method: 'PUT', body: chunk, headers: { 'Content-MD5': crypto.createHash('md5').update(chunk).digest('base64') } });
      const etag = r.headers.get('etag');
      if (!r.ok || !etag) throw new Error(`upload partea ${u.part_number}: HTTP ${r.status}`);
      parts.push({ ETag: etag, PartNumber: u.part_number });
    }
    await tsApi(token, 'POST', `/api/experimental/usermedia/${uuid}/finish-upload/`, { parts });
    let cats = [];
    try {
      const c = await tsApi(token, 'GET', '/api/experimental/community/valheim/category/');
      const hit = (c.results || []).find(x => /modpack/i.test(x.slug) || /modpack/i.test(x.name));
      if (hit) cats = [hit.slug];
    } catch { }
    const res = await tsApi(token, 'POST', '/api/experimental/submission/submit/', {
      author_name: settings.modpackTeam, communities: ['valheim'], community_categories: { valheim: cats }, categories: [], has_nsfw_content: false, upload_uuid: uuid,
    });
    const v = res?.package_version?.version_number || b.info.local;
    log(`■ Publicat ${settings.modpackName} ${v}`, 'done');
    notify('Modpack publicat', `${settings.modpackName} ${v} e pe Thunderstore.`);
    updates[ownPack()] = { ...(updates[ownPack()] || {}), latest: v };
    return { ok: true, version: v };
  } catch (e) {
    if (uuid) { try { await tsApi(token, 'POST', `/api/experimental/usermedia/${uuid}/abort-upload/`, {}); } catch { } }
    log(`■ Publicarea a eșuat: ${e.message}`, 'error');
    return { ok: false, error: e.message };
  } finally { setJob(null); send('modpack', modpackInfo()); }
}

// =====================================================================================================
// PLAYER
// =====================================================================================================
const nexus = new Nexus({ fetch: (...a) => net.fetch(...a), appName: 'Bifrost', appVersion: app.getVersion() });
let profile = null;
const getProfile = () => profile || (profile = new Profile({ dir: path.join(DATA, 'profile'), cacheDir: path.join(DATA, 'cache'), fetch: (...a) => net.fetch(...a), log }));
const MANIFEST_CACHE = path.join(DATA, 'server-list.json');
let manifest = readJson(MANIFEST_CACHE, null), manifestErr = null, manifestAt = null;
let game = { game: null, steam: null };
let progress = null;          // { phase, text, done, total, bytes, totalBytes }
let nexusWaiting = [];        // nexus entries waiting for a "Mod Manager Download" click (free accounts)

async function refreshManifest() {
  try {
    manifest = await serverList.fetchManifest((...a) => net.fetch(...a), settings.manifestRepo);
    fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(MANIFEST_CACHE, JSON.stringify(manifest));
    manifestErr = null;
  } catch (e) { manifestErr = e.message; }
  manifestAt = Date.now();
  send('player', playerInfo());
  return manifest;
}
function desired() {
  const out = [];
  if (!manifest || isAdmin()) return out;
  for (const m of manifest.required) out.push({ key: m.full, full: m.full, ver: m.ver, role: 'required', source: 'thunderstore', title: m.title });
  for (const m of manifest.recommended || []) if (settings.recommended[m.full]) out.push({ key: m.full, full: m.full, ver: m.ver, role: 'recommended', source: 'thunderstore', title: m.title });
  for (const n of manifest.nexus || []) if (n.required || settings.nexusChosen[n.key])
    out.push({ key: n.key, full: n.key, ver: String(n.version || n.fileId), role: n.required ? 'required' : 'recommended', source: 'nexus', title: n.title, modId: n.modId, fileId: n.fileId });
  // BepInEx first
  return out.sort((a, b) => (b.full === BEPINEX) - (a.full === BEPINEX));
}
function playerMods() {
  const p = getProfile().packages;
  return {
    mods: Object.entries(p).map(([k, x]) => ({ name: k, version: x.ver, role: x.role, source: x.source, title: x.title || k, size: x.size || 0, installedAt: x.installedAt })),
    profileFound: true, profile: 'Bifrost',
  };
}
const modsPayload = () => isAdmin() ? readProfile() : playerMods();
function playerInfo() {
  const pr = getProfile();
  const plan = manifest ? pr.plan(desired()) : { install: [], remove: [] };
  const bytes = plan.install.reduce((s, d) => s + (catalogIndex.get(d.full)?.size || 0), 0);
  return {
    manifest, error: manifestErr, at: manifestAt, game: { ...game, ...(game.game ? Profile.gameOwner(game.game) : {}), backup: !!(game.game && fs.existsSync(path.join(game.game, 'bifrost-backup'))) }, progress, busy: !!job,
    plan: { install: plan.install.map(d => ({ key: d.key, ver: d.ver, have: pr.packages[d.key]?.ver || null, source: d.source, title: d.title })), remove: plan.remove, bytes },
    required: manifest ? manifest.required.length + (manifest.nexus || []).filter(n => n.required).length : 0,
    installed: Object.keys(pr.packages).length, nexusWaiting: nexusWaiting.map(n => ({ key: n.key, title: n.title, modId: n.modId, fileId: n.fileId })),
    nexusUser: settings.nexusUser, recommended: settings.recommended, nexusChosen: settings.nexusChosen,
  };
}
function setProgress(p) { progress = p; send('progress', progress); }

// one Thunderstore package + its dependencies (pinned versions; an equal or newer installed one is fine)
async function installThunderstore(item, wanted) {
  const pr = getProfile();
  const queue = [item];
  while (queue.length) {
    const d = queue.shift();
    const have = pr.packages[d.key];
    if (have && have.ver === d.ver) continue;
    if (have && d.role === 'dep' && cmpVer(have.ver, d.ver) >= 0) continue;
    setProgress({ ...progress, text: `${d.title || d.full} ${d.ver}`, bytes: 0, totalBytes: 0 });
    const zip = await pr.thunderstoreZip(d.full, d.ver, (got, total) => setProgress({ ...progress, bytes: got, totalBytes: total }), undefined);
    const deps = await pr.installZip(d.key, zip, {
      ver: d.ver, role: have && have.role === 'required' && d.role === 'dep' ? 'required' : (have?.role === 'user' && d.role === 'dep' ? 'user' : d.role),
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
async function installNexus(entry, nxm, pr = getProfile()) {
  const key = dec(settings.nexusKeyEnc);
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

async function launchGame() {
  game = await Profile.findGame();
  if (settings.gameDir && fs.existsSync(path.join(settings.gameDir, 'valheim.exe'))) game.game = settings.gameDir;
  if (!game.game) throw new Error('Nu găsesc Valheim (Steam). Alege folderul jocului în Setări.');
  getProfile().prepareGame(game.game);
  getProfile().launch(game.steam);
  log(`Pornesc Valheim (${game.game})`, 'done');
}
async function playerSync({ launch } = {}) {
  if (job) return { ok: false, error: 'Lucrez deja.' };
  if (isAdmin()) {
    // the admin's profile is the source of the list - nothing to fetch, just play
    if (!ownSource()) return { ok: false, error: 'Importă întâi modurile din Thunderstore Mod Manager (Moduri → Importă).' };
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
    for (const [i, d] of ts.entries()) {
      setProgress({ ...progress, done: i });
      await installThunderstore(d, wanted);
    }
    // Nexus: premium downloads directly, free accounts need one click per file on the site
    nexusWaiting = [];
    for (const d of nx) {
      if (settings.nexusUser?.premium) { await installNexus(d); continue; }
      nexusWaiting.push(d);
    }
    for (const k of plan.remove) { pr.remove(k); log(`  scos ${k}`, 'out'); }
    for (const k of pr.orphans()) { pr.remove(k); log(`  scos ${k} (nu mai e nevoie de el)`, 'out'); }
    setProgress(null);
    const missingRequired = nexusWaiting.filter(n => n.role === 'required');
    if (nexusWaiting.length) {
      send('player', playerInfo());
      shell.openExternal(Nexus.filesPage(nexusWaiting[0].modId, nexusWaiting[0].fileId));
      if (missingRequired.length) throw new Error(`Mai trebuie de pe Nexus: ${missingRequired.map(n => n.title).join(', ')} - apasă „Mod Manager Download” pe pagina care s-a deschis.`);
      toast('Pe pagina Nexus care s-a deschis apasă „Mod Manager Download” - Bifrost îl instalează singur.', 'info');
    }
    log(`■ Modurile sunt la zi (${Object.keys(pr.packages).length} pachete)`, 'done');
    if (launch) await launchGame();
    return { ok: true };
  } catch (e) {
    setProgress(null);
    log(`■ ${e.message}`, 'error');
    return { ok: false, error: e.message };
  } finally { setJob(null); send('player', playerInfo()); send('mods', modsPayload()); }
}

// admin, once: bring the Thunderstore Mod Manager profile into Bifrost (same mods + versions, configs, manual mods)
async function importFromTmm() {
  if (!isAdmin()) return { ok: false, error: 'Doar în modul admin.' };
  if (job) return { ok: false, error: 'Lucrez deja.' };
  const tmm = readTmmProfile();
  const list = tmm.mods.filter(m => m.enabled && !m.manual && !m.modpack);
  if (list.length < 3) return { ok: false, error: 'Profilul Thunderstore Mod Manager pare gol.' };
  setJob({ kind: 'import', label: 'Import din Thunderstore Mod Manager', started: Date.now() });
  log(`▶ ${job.label}: ${list.length} moduri`, 'start');
  try {
    const pr = getProfile();
    const names = new Set(list.map(m => m.name));
    setProgress({ phase: 'install', text: '', done: 0, total: list.length });
    for (const [i, m] of list.sort((a, b) => (b.name === BEPINEX) - (a.name === BEPINEX)).entries()) {
      setProgress({ ...progress, done: i });
      await installThunderstore({ key: m.name, full: m.name, ver: m.version, role: 'user', title: m.displayName }, names);
    }
    for (const m of tmm.mods.filter(x => x.manual)) {
      pr.importManual(m.name, path.join(tmmPluginsDir(), m.name), { ver: '', role: 'user', source: 'manual', title: m.displayName });
      log(`  copiat ${m.name} (manual)`, 'out');
    }
    // the admin's own mod settings
    const cfg = path.join(tmmProfileDir(), 'BepInEx', 'config');
    if (fs.existsSync(cfg)) fs.cpSync(cfg, path.join(pr.dir, 'BepInEx', 'config'), { recursive: true, force: true });
    settings.adminSource = 'bifrost'; saveSettings();
    seenSig = signature(); syncedSig = seenSig;
    setTimeout(() => twoWay('după import'), 3000);
    log(`■ Import gata: ${Object.keys(pr.packages).length} pachete în profilul Bifrost (+ configurările tale)`, 'done');
    return { ok: true, count: Object.keys(pr.packages).length };
  } catch (e) { log(`■ Importul a eșuat: ${e.message}`, 'error'); return { ok: false, error: e.message }; }
  finally { setProgress(null); setJob(null); send('settings', publicSettings()); send('mods', modsPayload()); send('player', playerInfo()); }
}
// admin: every Thunderstore mod to its newest version (with new dependencies)
async function updateAll() {
  if (job) return { ok: false, error: 'Lucrez deja.' };
  const pr = getProfile();
  const todo = Object.entries(pr.packages).filter(([k, x]) => x.source === 'thunderstore' && catalogIndex.get(k) && cmpVer(catalogIndex.get(k).ver, x.ver) > 0);
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
  finally { setProgress(null); setJob(null); send('mods', modsPayload()); send('player', playerInfo()); }
}

// a mod the player picked in Descoperă
async function playerInstall(full, ver) {
  if (job) return { ok: false, error: 'Lucrez deja - încearcă în câteva secunde.' };
  const p = catalogIndex.get(full);
  ver = ver || p?.ver;
  if (!ver) return { ok: false, error: 'Nu găsesc pachetul în catalog.' };
  if (isAdmin() && p) { const cats = p.cats || []; const side = cats.includes('Server-side') ? 'server' : cats.includes('Client-side') ? 'client' : null; if (side) sideHints[full] = side; }
  setJob({ kind: 'install', label: `Instalez ${full}`, started: Date.now() });
  installing[full] = { ver, at: Date.now() }; send('installing', installing);
  try {
    setProgress({ phase: 'install', text: full, done: 0, total: 1 });
    const have = getProfile().packages[full];
    await installThunderstore({ key: full, full, ver, role: have && have.role !== 'dep' ? have.role : 'user', title: p ? p.name.replace(/_/g, ' ') : full }, new Set(desired().map(d => d.key)));
    log(`${full} ${ver} instalat`, 'done');
    return { ok: true, via: 'bifrost' };
  } catch (e) { log(`${full}: ${e.message}`, 'error'); return { ok: false, error: e.message }; }
  finally { delete installing[full]; send('installing', installing); setProgress(null); setJob(null); applyHints(); send('mods', modsPayload()); send('player', playerInfo()); }
}
function playerRemove(key) {
  if (job) return { ok: false, error: 'Lucrez deja.' };
  const pr = getProfile(), p = pr.packages[key];
  if (!p) return { ok: false, error: 'Nu e instalat.' };
  if (p.role === 'required') return { ok: false, error: 'Serverul are nevoie de el.' };
  if (p.role === 'dep' && isAdmin()) return { ok: false, error: 'E o dependență - se scoate singură când scoți modul care are nevoie de ea.' };
  if (key === BEPINEX) return { ok: false, error: 'BepInEx e baza tuturor modurilor - nu se scoate.' };
  const users = Object.entries(pr.packages).filter(([k, x]) => k !== key && (x.deps || []).some(d => parseDep(d)?.full === key)).map(([k]) => k);
  if (users.length) return { ok: false, error: `Au nevoie de el: ${users.join(', ')}. Scoate-le întâi pe acelea.` };
  if (p.role === 'recommended') { delete settings.recommended[key]; delete settings.nexusChosen[key]; saveSettings(); }
  pr.remove(key);
  for (const k of pr.orphans()) pr.remove(k);
  log(`${key} dezinstalat`);
  send('mods', modsPayload()); send('player', playerInfo());
  return { ok: true };
}
// Nexus installs started from Descoperă that wait for the "Mod Manager Download" click (free accounts)
const nexusPending = {};   // modId -> { fileId, title, version, at }
// admin: Nexus mods go into the Thunderstore Mod Manager profile as manual mods, linked to their Nexus page so the
// players' list carries them too
const adminNexusProfile = () => new Profile({ dir: tmmProfileDir(), cacheDir: path.join(DATA, 'cache'), fetch: (...a) => net.fetch(...a), stateFile: path.join(DATA, 'admin-nexus.json') });
const nexusFolder = (modId, title) => `Nexus-${modId}-${String(title || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'mod'}`;
async function nexusInstallNow(e, nxm) {
  setJob({ kind: 'nexus', label: `Instalez ${e.title} (Nexus)`, started: Date.now() });
  log(`▶ ${job.label}`, 'start');
  try {
    setProgress({ phase: 'install', text: e.title, done: 0, total: 1 });
    if (isAdmin() && !ownSource()) {
      const folder = nexusFolder(e.modId, e.title);
      await installNexus({ key: folder, ver: String(e.version || e.fileId), role: 'user', title: e.title, modId: e.modId, fileId: e.fileId }, nxm, adminNexusProfile());
      settings.nexusLinks[folder] = { modId: e.modId, fileId: e.fileId, version: e.version || '', title: e.title, fileName: e.fileName || '' };
      saveSettings();
      log(`■ ${e.title} instalat în profilul Thunderstore (${folder}) - alege Server/Client la Moduri`, 'done');
    } else {
      await installNexus({ key: `nexus-${e.modId}`, full: `nexus-${e.modId}`, ver: String(e.version || e.fileId), role: e.role || 'user', title: e.title, modId: e.modId, fileId: e.fileId }, nxm);
      log(`■ ${e.title} instalat`, 'done');
    }
    delete nexusPending[e.modId];
    notify('Instalat de pe Nexus', e.title);
    return { ok: true };
  } catch (err) { log(`■ Nexus: ${err.message}`, 'error'); return { ok: false, error: err.message }; }
  finally { setProgress(null); setJob(null); send('nexusPending', nexusPending); send('mods', modsPayload()); if (!isAdmin()) send('player', playerInfo()); }
}
async function nexusInstall({ modId, fileId, title, version, fileName }) {
  if (!dec(settings.nexusKeyEnc)) return { ok: false, error: 'Pune întâi cheia ta Nexus în Setări → Nexus Mods.', needKey: true };
  if (!fileId) {
    const f = Nexus.pickMain(await nexus.modFiles(modId));
    if (!f) return { ok: false, error: 'Modul nu are fișiere de descărcat.' };
    fileId = f.fileId; version = version || f.version;
  }
  const e = { modId: +modId, fileId: +fileId, title, version, fileName };
  if (settings.nexusUser?.premium) { if (job) return { ok: false, error: 'Lucrez deja.' }; return nexusInstallNow(e); }
  nexusPending[e.modId] = { ...e, at: Date.now() };
  send('nexusPending', nexusPending);
  shell.openExternal(Nexus.filesPage(e.modId, e.fileId));
  return { ok: true, waiting: true };
}

// nxm:// from the Nexus site ("Mod Manager Download")
async function handleNxm(url) {
  const x = Nexus.parseNxm(url);
  showWindow();
  if (!x) return toast('Link Nexus nevalid.', 'error');
  if (x.game !== 'valheim') return toast(`Linkul e pentru ${x.game}, nu Valheim.`, 'error');
  if (job) return toast('Lucrez deja - apasă din nou după ce termin.', 'error');
  const pend = nexusPending[x.modId];
  if (isAdmin() || (pend && !nexusWaiting.find(n => n.modId === x.modId))) {
    let e = pend ? { ...pend, fileId: x.fileId } : null;
    if (!e) { const m = await nexus.modInfo(x.modId).catch(() => null); e = { modId: x.modId, fileId: x.fileId, title: m?.name || `Nexus ${x.modId}`, version: m?.version || '' }; }
    const r = await nexusInstallNow(e, x);
    toast(r.ok ? `${e.title} instalat.` : r.error, r.ok ? 'ok' : 'error');
    return;
  }
  let entry = nexusWaiting.find(n => n.modId === x.modId) || (manifest?.nexus || []).filter(n => n.modId === x.modId).map(n => ({
    key: n.key, full: n.key, ver: String(n.version || n.fileId), role: n.required ? 'required' : 'recommended', title: n.title, modId: n.modId, fileId: n.fileId,
  }))[0];
  setJob({ kind: 'nexus', label: 'Instalez de pe Nexus', started: Date.now() });
  try {
    nexus.key = dec(settings.nexusKeyEnc);
    if (!nexus.key) throw new Error('Pune cheia Nexus în Setări, apoi apasă din nou pe site.');
    if (!entry) {
      const m = await nexus.mod(x.modId).catch(() => null);
      entry = { key: `nexus-${x.modId}`, full: `nexus-${x.modId}`, ver: String(x.fileId), role: 'user', title: m?.name || `Nexus ${x.modId}`, modId: x.modId, fileId: x.fileId };
    }
    entry = { ...entry, fileId: x.fileId };
    setProgress({ phase: 'install', text: entry.title, done: 0, total: 1 });
    await installNexus(entry, x);
    if (entry.role === 'recommended') { settings.nexusChosen[entry.key] = true; saveSettings(); }
    nexusWaiting = nexusWaiting.filter(n => n.modId !== x.modId);
    toast(`${entry.title} instalat.`, 'ok');
    if (nexusWaiting.length) shell.openExternal(Nexus.filesPage(nexusWaiting[0].modId, nexusWaiting[0].fileId));
  } catch (e) { toast(e.message, 'error'); log(`Nexus: ${e.message}`, 'error'); }
  finally { setProgress(null); setJob(null); send('mods', modsPayload()); send('player', playerInfo()); }
}
function registerNxm() {
  try {
    if (app.isPackaged) app.setAsDefaultProtocolClient('nxm');
    else app.setAsDefaultProtocolClient('nxm', process.execPath, [path.resolve(__dirname)]);
  } catch (e) { log(`nxm: ${e.message}`); }
}

// ---------- app updates (installed build only) ----------
let appUpdate = null;
function setupUpdater() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.on('update-available', i => { appUpdate = { version: i.version, ready: false }; send('appUpdate', appUpdate); });
  autoUpdater.on('update-downloaded', i => {
    appUpdate = { version: i.version, ready: true }; send('appUpdate', appUpdate);
    notify('Bifrost', `Versiunea ${i.version} e gata - se instalează la repornire.`);
  });
  autoUpdater.on('error', e => log(`update: ${e.message}`));
  const check = () => autoUpdater.checkForUpdates().catch(e => log(`update: ${e.message}`));
  setTimeout(check, 10000); setInterval(check, 4 * 3600e3);
  ipcMain.handle('installUpdate', () => { quitting = true; autoUpdater.quitAndInstall(); });
}

// ---------- IPC ----------
ipcMain.handle('init', () => ({
  settings: publicSettings(), profile: modsPayload(), status, job, watch, installing, catalogFetched: catalog?.fetched || null,
  log: logTail.slice(-400), updates, modpack: modpackInfo(), list: listState, player: playerInfo(), appUpdate,
  version: app.getVersion(),
}));
const SETTABLE = ['autoSync', 'startWithWindows', 'notifications', 'quietSeconds', 'retryMinutes', 'server', 'container', 'profile',
  'manifestRepo', 'autoPublish', 'publishAddress', 'syncConfigs', 'syncAllMods', 'pullServerMods', 'serverName', 'serverWorld', 'gameDir', 'adminFolder', 'addresses'];
ipcMain.handle('action', (_e, name, arg) => action(name, arg));
async function action(name, arg) {
  switch (name) {
    // ----- admin -----
    case 'sync': syncNow('manual'); return { ok: true };
    case 'dryrun': {
      const { code, lines, busy } = await runSync('dryrun', 'Verific diferențele (dry run)', ['-Auto', '-DryRun']);
      if (busy) return { ok: false, error: 'Rulează deja ceva.' };
      const r = summarize(lines);
      return { ok: code === 0, toCopy: r.toCopy, toRemove: r.toRemove, error: code === 0 ? null : r.error };
    }
    case 'restart': {
      const { code, lines, busy } = await runSync('restart', 'Restart server', ['-RestartOnly']);
      if (busy) return { ok: false, error: 'Rulează deja ceva.' };
      const r = summarize(lines); pollStatus(); send('mods', modsPayload());
      if (code === 0) { watch.retryAt = null; watch.lastResult = { kind: 'ok', text: r.joinCode ? `Server repornit - join code ${r.joinCode}` : 'Server repornit' }; setWatch('idle', 'la zi'); schedulePublish('restart'); }
      return { ok: code === 0, joinCode: r.joinCode, error: code === 0 ? null : r.error };
    }
    case 'fixcode': {
      const { code, lines } = await runProcess('fixcode', 'Repornesc doar jocul (join code nou)', 'ssh',
        ['-o', 'BatchMode=yes', settings.server, `docker exec ${settings.container} supervisorctl restart valheim-server`]);
      setTimeout(pollStatus, 20000); setTimeout(pollStatus, 60000);
      return { ok: code === 0, error: code === 0 ? null : lines.join(' ') };
    }
    case 'startServer': {
      const { code, lines } = await runProcess('start', 'Pornesc containerul Valheim', 'ssh',
        ['-o', 'BatchMode=yes', settings.server, 'cd ~/Games/valheim && docker compose up -d']);
      setTimeout(pollStatus, 5000);
      return { ok: code === 0, error: code === 0 ? null : lines.join(' ') };
    }
    case 'setSide': return setSide(arg.name, arg.side);
    case 'refresh': pollStatus(); send('mods', modsPayload()); return { ok: true };
    case 'publishList': return publishList('manual');
    case 'twoWay': await twoWay('manual'); return { ok: !watch.twoWay?.error, ...(watch.twoWay || {}) };
    case 'previewList': return { ok: true, list: buildList() };
    case 'nexusLink': {
      // admin: tie a manually installed mod to its Nexus page so players can get it
      if (!arg.url) { delete settings.nexusLinks[arg.name]; saveSettings(); send('mods', modsPayload()); return { ok: true }; }
      const modId = Nexus.parseModUrl(arg.url);
      if (!modId) return { ok: false, error: 'Lipește linkul paginii Nexus (nexusmods.com/valheim/mods/...).' };
      nexus.key = dec(settings.nexusKeyEnc);
      if (!nexus.key) return { ok: false, error: 'Pune întâi cheia ta Nexus în Setări.' };
      try {
        const [m, f] = await Promise.all([nexus.mod(modId), nexus.mainFile(modId)]);
        settings.nexusLinks[arg.name] = { modId, fileId: f.file_id, fileName: f.file_name, version: f.version || m.version, title: m.name };
        saveSettings(); send('mods', modsPayload()); schedulePublish('legătură Nexus');
        return { ok: true, link: settings.nexusLinks[arg.name] };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    // ----- shared -----
    case 'checkUpdates': await checkUpdates(10 * 60e3); return { ok: true };
    case 'catalog':
      if (!catalog) await refreshCatalog();
      else if (Date.now() - catalog.fetched > 6 * 3600e3) refreshCatalog();
      return { ok: !!catalog, fetched: catalog?.fetched || null, packages: catalog?.packages || [] };
    case 'refreshCatalog': { const ok = await refreshCatalog(); return { ok, fetched: catalog?.fetched || null, packages: ok ? catalog.packages : null }; }
    case 'install': return isAdmin() && !ownSource() ? installViaTmm(arg.full, arg.ver) : playerInstall(arg.full, arg.ver);
    case 'importTmm': return importFromTmm();
    case 'updateAll': return updateAll();
    case 'readme': {
      try {
        const r = await net.fetch(`${TS}/api/experimental/package/${encodeURIComponent(arg.owner)}/${encodeURIComponent(arg.name)}/${encodeURIComponent(arg.ver)}/readme/`);
        if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
        return { ok: true, markdown: (await r.json()).markdown || '' };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    case 'buildModpack': return buildModpack();
    case 'publishModpack': return publishModpack();
    case 'setToken': {
      if (arg && !safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Criptarea Windows nu e disponibilă.' };
      settings.tokenEnc = arg ? enc(arg) : null;
      saveSettings(); send('settings', publicSettings()); send('modpack', modpackInfo()); return { ok: true };
    }
    case 'setNexusKey': {
      if (!arg) { settings.nexusKeyEnc = null; settings.nexusUser = null; saveSettings(); send('settings', publicSettings()); return { ok: true }; }
      nexus.key = String(arg).trim();
      try {
        const u = await nexus.validate();
        settings.nexusKeyEnc = enc(arg); settings.nexusUser = { name: u.name, premium: !!u.is_premium };
        saveSettings(); registerNxm(); send('settings', publicSettings()); send('player', isAdmin() ? null : playerInfo());
        return { ok: true, user: settings.nexusUser };
      } catch (e) { return { ok: false, error: e.message }; }
    }
    case 'setSetting': {
      if (!SETTABLE.includes(arg.key)) return { ok: false };
      settings[arg.key] = arg.value; saveSettings();
      if (arg.key === 'startWithWindows') applyStartup();
      if (arg.key === 'profile') { seenSig = null; send('mods', modsPayload()); }
      if (arg.key === 'autoSync' && arg.value && watch.dirty) changedAt = Date.now() - settings.quietSeconds * 1000;
      if (arg.key === 'autoSync') setWatch(arg.value ? 'idle' : 'off', arg.value ? 'pornit' : 'auto-sync oprit');
      if (arg.key === 'manifestRepo' && !isAdmin()) refreshManifest();
      if (arg.key === 'publishAddress') schedulePublish('setare adresă');
      send('settings', publicSettings()); return { ok: true };
    }
    case 'setRole': {
      settings.role = arg === 'admin' ? 'admin' : 'player'; saveSettings();
      app.relaunch(); quitting = true; app.quit(); return { ok: true };
    }
    case 'copy': clipboard.writeText(String(arg)); return { ok: true };
    case 'open': {
      const targets = {
        log: LOG_FILE, folder: adminRoot() || DATA, modpackFolder: adminRoot() && MODPACK_DIR(), profile: isAdmin() ? tmmProfileDir() : getProfile().dir,
        game: game.game, thunderstoreApp: path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Thunderstore Mod Manager', 'Thunderstore Mod Manager.exe'),
      };
      if (targets[arg]) { const err = await shell.openPath(targets[arg]); return { ok: !err, error: err || null }; }
      if (/^https:\/\//.test(arg)) { shell.openExternal(arg); return { ok: true }; }
      return { ok: false };
    }
    case 'showZip': { const z = modpackInfo().zip; if (z) shell.showItemInFolder(z); return { ok: !!z }; }
    case 'quit': quitting = true; app.quit(); return { ok: true };
    // ----- player -----
    case 'play': return playerSync({ launch: true });
    case 'updateMods': return playerSync({ launch: false });
    case 'refreshList': await refreshManifest(); return { ok: !manifestErr, error: manifestErr };
    case 'setRecommended': {
      const bag = arg.nexus ? settings.nexusChosen : settings.recommended;
      if (arg.on) bag[arg.key] = true; else delete bag[arg.key];
      saveSettings(); send('player', playerInfo()); return { ok: true };
    }
    case 'remove': return playerRemove(arg);
    case 'nexusPage': shell.openExternal(Nexus.filesPage(arg.modId, arg.fileId)); return { ok: true };
    case 'nexusSearch': try { return { ok: true, ...(await nexus.search(arg)) }; } catch (e) { return { ok: false, error: e.message }; }
    case 'nexusFiles': try { return { ok: true, files: await nexus.modFiles(arg) }; } catch (e) { return { ok: false, error: e.message }; }
    case 'nexusInstall': try { return await nexusInstall(arg); } catch (e) { return { ok: false, error: e.message }; }
    case 'nexusInstalled': {
      // modId -> installed version, for the Nexus tab
      const out = {};
      if (isAdmin() && !ownSource()) { for (const [k, l] of Object.entries(settings.nexusLinks)) if (fs.existsSync(path.join(pluginsDir(), k))) out[l.modId] = l.version || 'instalat'; }
      else for (const p of Object.values(getProfile().packages)) if (p.source === 'nexus') out[p.modId] = p.ver;
      return { ok: true, installed: out, pending: nexusPending };
    }
    case 'findGame': game = await Profile.findGame(); send('player', playerInfo()); return { ok: !!game.game, game };
    case 'restoreLoader': {
      if (!game.game) return { ok: false, error: 'Nu găsesc folderul jocului.' };
      const ok = Profile.restoreGame(game.game);
      log(ok ? `Încărcătorul anterior de moduri e pus înapoi în ${game.game}` : 'Nu există backup de restaurat.');
      send('player', playerInfo());
      return ok ? { ok: true } : { ok: false, error: 'Nu există backup (Bifrost nu a înlocuit nimic).' };
    }
  }
  return { ok: false, error: `unknown action ${name}` };
}

// ---------- start ----------
app.on('second-instance', (_e, argv) => { const n = nxmArg(argv); if (n) handleNxm(n); else showWindow(); });
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (quitting) app.quit(); });

app.whenReady().then(async () => {
  protocol.handle('modicon', req => {
    const name = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''));
    if (!name || name.includes('..') || /[\\/]/.test(name)) return new Response('', { status: 404 });
    return net.fetch(pathToFileURL(path.join(pluginsDir(), name, 'icon.png')).toString());
  });
  if (!app.isPackaged && !settings.shortcutsV2) devShortcuts();
  applyStartup();
  setupUpdater();
  createTray();
  createWindow(!process.argv.includes('--hidden'));
  log(`Bifrost ${app.getVersion()} pornit (${isAdmin() ? `admin, profil ${settings.profile}` : 'jucător'})`);
  indexCatalog();
  setTimeout(() => checkUpdates(6 * 3600e3), 6000);
  setInterval(() => checkUpdates(6 * 3600e3), 3600e3);
  if (isAdmin()) {
    seenSig = signature();
    if (settings.autoSync) setTimeout(() => syncNow('pornire'), 4000); else setWatch('off', 'auto-sync oprit');
    setInterval(tick, 5000);
    setInterval(() => twoWay('verificare periodică'), 3 * 60e3);
    pollStatus();
    setInterval(() => { if (win && win.isVisible()) pollStatus(); }, 20000);
    setInterval(() => { if (!win || !win.isVisible()) pollStatus(); }, 120000);
  }
  if (settings.nexusKeyEnc) registerNxm();
  game = await Profile.findGame();
  if (settings.gameDir) game.game = settings.gameDir;
  const nx0 = nxmArg(process.argv); if (nx0 && isAdmin()) setTimeout(() => handleNxm(nx0), 2000);
  refreshManifest();
  if (!isAdmin()) {
    setInterval(() => { if (!job) refreshManifest(); }, 10 * 60e3);
    const n = nxmArg(process.argv); if (n) setTimeout(() => handleNxm(n), 2000);
  }
  // test hook: --run=<action> runs an action once the window is up and logs the result
  const run = (process.argv.find(a => a.startsWith('--run=')) || '').slice(6);
  if (run) setTimeout(async () => log(`--run ${run}: ${JSON.stringify(await action(run))}`), 8000);
});
