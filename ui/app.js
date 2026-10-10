'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const S = { settings: {}, profile: { mods: [] }, status: {}, job: null, watch: {}, updates: {}, modpack: {}, filter: 'all', search: '',
  player: null, list: {}, appUpdate: null,
  src: 'ts', nx: { list: [], total: 0, loading: false, error: null, installed: {}, pending: {}, seq: 0 },
  installing: {}, catalog: null, catalogBusy: false, catalogFetched: null, bq: '', bsort: 'dl', bcat: null, bpacks: false, blimit: 60, drawer: null };

// ---------- helpers ----------
const ago = t => {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'acum câteva secunde';
  if (s < 3600) return `acum ${Math.round(s / 60)} min`;
  if (s < 86400) return `acum ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  return `acum ${Math.round(s / 86400)} zile`;
};
const dur = t => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
const LOC = () => ((S.settings?.lang || 'en') === 'en' ? 'en-GB' : 'ro-RO');
const clock = t => new Date(t).toLocaleTimeString(LOC(), { hour: '2-digit', minute: '2-digit' });
const cmpVer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const hasUpdate = m => { const u = S.updates[m.name]; return !!(u && u.latest && m.version && cmpVer(u.latest, m.version) > 0); };

function toast(text, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 6000);
}
function confirmBox(title, text, yes = 'Da', input) {
  return new Promise(res => {
    $('#modal-title').textContent = title; $('#modal-text').textContent = text; $('#modal-yes').textContent = yes;
    const inp = $('#modal-input'); inp.hidden = input === undefined; inp.value = input || '';
    $('#modal').hidden = false;
    if (!inp.hidden) setTimeout(() => inp.focus(), 50);
    const done = v => { $('#modal').hidden = true; $('#modal-yes').onclick = $('#modal-no').onclick = inp.onkeydown = null; res(v); };
    $('#modal-yes').onclick = () => done(input === undefined ? true : inp.value.trim());
    $('#modal-no').onclick = () => done(input === undefined ? false : null);
    inp.onkeydown = e => { if (e.key === 'Enter') $('#modal-yes').click(); };
  });
}

// ---------- navigation ----------
function go(page) {
  $$('.nav').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${page}`));
  if (page === 'log') { const l = $('#log'); l.scrollTop = l.scrollHeight; }
  if (page === 'settings') renderCache();
  if (page === 'browse') { if (S.src === 'nx') { if (!S.nx.list.length) nexusSearch(true); } else loadCatalog(); }
}
$$('.nav').forEach(b => b.onclick = () => go(b.dataset.page));
document.addEventListener('click', e => { const l = e.target.closest('[data-page-link]'); if (l) go(l.dataset.pageLink); });

// ---------- server ----------
function renderStatus() {
  const s = S.status;
  $('#srv-name').textContent = S.settings.serverName || 'Server';
  $('#srv-world').textContent = [S.settings.serverWorld, 'crossplay'].filter(Boolean).join(' · ');
  const pill = $('#srv-pill'), st = $('#srv-state');
  pill.className = 'status-pill';
  let tb = '';
  if (S.settings.isAdmin && S.settings.server && !S.settings.server.conn) { st.textContent = 'fără conexiune la server'; }
  else if (s.reachable === null || s.reachable === undefined) { st.textContent = 'se verifică...'; pill.classList.add('busy'); }
  else if (!s.reachable) { st.textContent = 'fără conexiune'; pill.classList.add('err'); }
  else if (s.container !== 'running') { st.textContent = s.container === 'missing' ? 'container lipsă' : `oprit (${s.container})`; pill.classList.add('err'); }
  else if (s.unknown) { st.textContent = 'stare necunoscută'; }
  else if (!s.joinCode && !s.gameUp) { st.textContent = 'pornește...'; pill.classList.add('busy'); }
  else if (s.codeBroken) { st.textContent = 'online · join code stricat?'; pill.classList.add('warn'); }
  else { st.textContent = 'online'; pill.classList.add('ok'); }

  $('#srv-uptime').textContent = s.container === 'running' && s.startedAt ? `pornit de ${dur(s.startedAt)}` : '';
  $('#srv-code').textContent = s.joinCode || '——————';
  $('#srv-code-box').classList.toggle('off', !s.joinCode || s.container !== 'running');
  const pl = s.container === 'running' ? (s.players ?? '–') : '–';
  $('#srv-players').textContent = pl;
  $('#srv-players-note').textContent = s.idle === true ? 'server gol' : s.idle === false ? 'trafic de jucători' : '';
  const addrs = (S.settings.addresses || '').split(/[;\n]/).map(x => x.split('=')).filter(x => x[1]).map(([k, v]) => [k.trim(), v.trim()]);
  if (s.publicIp) addrs.push(['Public (prieteni)', s.publicIp]);
  $('#srv-addresses').innerHTML = addrs.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><code>${esc(v)}</code><button class="icon-btn" data-copy="${esc(v)}" title="Copiază"><svg class="ico" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg></button></div>`).join('');
  $('#srv-recent').innerHTML = (s.recent || []).length
    ? s.recent.map(r => `<span class="tag" title="ultima intrare ${esc(r.t ? clock(r.t) : '')}">${esc(r.name)}</span>`).join('')
    : '<span class="muted small">nimeni încă</span>';
  $('#srv-codebroken').hidden = !(s.reachable && s.container === 'running' && s.codeBroken);
  const down = $('#srv-down');
  if (s.reachable === false) { down.hidden = false; down.innerHTML = `<b>Nu ajung la server prin SSH.</b> <span class="muted">${esc(s.error || '')}</span>`; }
  else if (s.reachable && s.container && s.container !== 'running') { down.hidden = false; down.innerHTML = `<b>Containerul Valheim nu rulează.</b> <button class="btn small" data-act="startServer">Pornește serverul</button>`; }
  else down.hidden = true;
  $('#btn-start').hidden = !(s.reachable && s.container && s.container !== 'running');

  // (a personal profile has no server; a server whose state is unknown shows nothing rather than "starting")
  const personal = !S.settings.isAdmin && !S.settings.server?.list;
  if (personal || s.unknown) tb = '';
  else if (s.reachable && s.container === 'running') tb = `<span>${s.joinCode ? `cod <b>${esc(s.joinCode)}</b>` : 'pornește...'}</span><span><b>${esc(pl)}</b> online</span>`;
  else if (s.reachable === false) tb = '<span>server: fără conexiune</span>';
  $('#tb-status').innerHTML = tb;
}

// ---------- sync / watch ----------
function renderWatch() {
  const w = S.watch, j = S.job, auto = S.settings.autoSync;
  let ring = 'ok', title = 'Serverul e la zi', sub = '';
  if (j) { ring = 'busy'; title = j.label; sub = `a început ${ago(j.started)}`; }
  else if (!auto) { ring = 'off'; title = w.dirty ? 'Ai schimbări nesincronizate' : 'Auto-sync oprit'; sub = 'Apasă „Sincronizează acum” când vrei.'; }
  else if (w.state === 'change') { ring = 'busy'; title = 'Thunderstore schimbă modurile...'; sub = `sincronizez după ${S.settings.quietSeconds}s de liniște`; }
  else if (w.state === 'waiting') { ring = 'wait'; title = 'Restart amânat - sunt jucători online'; sub = w.retryAt ? `reîncerc la ${clock(w.retryAt)} (serverul repornește când e gol)` : ''; }
  else if (w.state === 'error') { ring = 'err'; title = 'Sincronizarea a eșuat'; sub = w.retryAt ? `reîncerc la ${clock(w.retryAt)}` : ''; }
  else if (w.state === 'attention') { ring = 'err'; title = 'Necesită atenție'; }
  else if (w.lastResult) { title = w.lastResult.text; }
  if (!j && w.lastSync && !sub) sub = `ultima verificare ${ago(w.lastSync)}`;
  if (!j && w.lastResult && ['error', 'warn'].includes(w.lastResult.kind) && w.state !== 'waiting') sub = w.lastResult.text + (sub ? ` · ${sub}` : '');
  $('#sync-ring').className = `ring ${ring}`;
  $('#sync-title').textContent = title;
  $('#sync-sub').textContent = sub;
  const what = w.lastResult && w.lastResult.what;
  $('#sync-what').hidden = !what || !!j; $('#sync-what').textContent = what || '';
  $('#tg-autosync').checked = !!auto;
  const tw = w.twoWay;
  $('#twoway-line').innerHTML = !S.settings.ownSource ? '' : !tw ? 'Configurări: se verifică...'
    : tw.error ? `<span style="color:var(--red)">Configurări: ${esc(tw.error)}</span>`
      : `Configurări ${tw.push || tw.pull ? `sincronizate (↑ ${tw.push} trimise, ↓ ${tw.pull} aduse)` : 'la zi'} · ${ago(tw.at)}${tw.mods && tw.mods.length ? ` · aduse de pe server: ${esc(tw.mods.join(', '))}` : ''} · <a href="#" data-act="twoWay">verifică acum</a>`;

  const side = $('#side-sync'), dot = side.querySelector('.dot');
  dot.className = `dot ${j ? 'busy' : !auto ? '' : ring === 'ok' ? 'ok' : ring === 'wait' ? 'warn' : ring === 'err' ? 'err' : 'busy'}`;
  $('#side-sync-text').textContent = j ? 'lucrez...' : !auto ? 'oprit' : (w.text || '');
  $$('[data-act="sync"]').forEach(b => b.disabled = !!j);
  $$('[data-act="restart"],[data-act="dryrun"],[data-act="publishModpack"],[data-act="buildModpack"],[data-act="fixcode"]').forEach(b => b.disabled = !!j);
  $$('.seg[data-name] button').forEach(b => { if (!b.dataset.lock) b.disabled = !!j; });

  const pend = $('#mods-pending');
  if (S.profile.restartPending && !j) { pend.hidden = false; pend.innerHTML = '<b>Modurile sunt deja copiate pe server, dar serverul nu a repornit încă.</b> <span class="muted">Repornește singur când nu e nimeni online.</span>'; }
  else if (w.dirty && !auto && !j) { pend.hidden = false; pend.innerHTML = '<b>Ai schimbări care nu sunt pe server.</b> <button class="btn small" data-act="sync">Sincronizează</button>'; }
  else pend.hidden = true;
}

// ---------- mods ----------
function modSide(m) { return m.builtin ? 'builtin' : m.side || 'new'; }
function renderMods() {
  // the Mods page is the admin's; a player's profile is listed on Play → My mods (renderPlayerMods)
  if (!S.settings.isAdmin) return;
  const mods = S.profile.mods || [];
  const q = S.search.trim().toLowerCase();
  const counts = { all: mods.length, server: 0, client: 0, updates: 0, disabled: 0 };
  for (const m of mods) {
    const sd = modSide(m);
    if (sd === 'server' || sd === 'builtin') counts.server++; else counts.client++;
    if (hasUpdate(m)) counts.updates++;
    if (!m.enabled) counts.disabled++;
  }
  $$('#mod-filters .chip').forEach(c => { c.querySelector('b').textContent = counts[c.dataset.f]; c.classList.toggle('active', c.dataset.f === S.filter); });
  const nu = $('#nav-updates'); nu.hidden = !counts.updates; nu.textContent = counts.updates;
  const own = S.profile.source === 'bifrost';
  $('#mods-sub').textContent = `${own ? 'Profilul Bifrost' : `Profilul Thunderstore „${S.profile.profile || 'Default'}”`} · ${mods.length} moduri · ${counts.server} pe server`;
  $('#btn-update-all').hidden = !own || !counts.updates;
  $('#btn-update-all').textContent = `Actualizează tot (${counts.updates})`;

  const list = mods.filter(m => {
    const sd = modSide(m);
    if (S.filter === 'server' && !(sd === 'server' || sd === 'builtin')) return false;
    if (S.filter === 'client' && (sd === 'server' || sd === 'builtin')) return false;
    if (S.filter === 'updates' && !hasUpdate(m)) return false;
    if (S.filter === 'disabled' && m.enabled) return false;
    if (q && !`${m.displayName} ${m.name} ${m.author} ${m.description}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => (hasUpdate(b) - hasUpdate(a)) || (a.displayName || a.name).localeCompare(b.displayName || b.name));

  if (!S.profile.profileFound) { $('#mod-list').innerHTML = `<div class="empty card">Nu găsesc profilul Thunderstore „${esc(S.profile.profile)}”.</div>`; return; }
  if (!list.length) { $('#mod-list').innerHTML = '<div class="empty">Niciun mod aici.</div>'; return; }
  const busy = !!S.job;
  $('#mod-list').innerHTML = list.map(m => {
    const sd = modSide(m), u = S.updates[m.name];
    const icon = m.icon ? `<img class="mod-icon" src="${esc(m.icon)}" alt="" loading="lazy">` : `<div class="mod-icon">${esc((m.displayName || '?')[0])}</div>`;
    const badges = [
      hasUpdate(m) ? (S.installing[m.name] ? `<span class="badge pending">se actualizează...</span>` : `<button class="badge update" data-update="${esc(m.name)}" data-ver="${esc(u.latest)}" title="Actualizează prin Thunderstore Mod Manager">update ${esc(u.latest)} ↻</button>`) : '',
      !m.enabled ? '<span class="badge off">dezactivat</span>' : '',
      m.manual ? (m.nexus ? `<button class="badge onsrv" data-nexus="${esc(m.name)}" title="Prietenii îl iau de pe Nexus (${esc(m.nexus.title)} ${esc(m.nexus.version || '')})">nexus ${esc(m.nexus.modId)}</button>`
        : `<button class="badge off" data-nexus="${esc(m.name)}" title="Leagă-l de pagina lui de pe Nexus ca prietenii să-l poată instala">manual · leagă de Nexus</button>`) : '',
      m.modpack ? '<span class="badge lock">modpack-ul tău</span>' : '',
      sd === 'server' && m.onServer ? '<span class="badge onsrv">pe server</span>' : '',
      sd === 'server' && !m.onServer ? '<span class="badge pending">urmează pe server</span>' : '',
      sd === 'new' ? '<span class="badge pending">nou - se ghicește la sync</span>' : '',
    ].join('');
    const seg = sd === 'builtin'
      ? '<span class="badge lock" title="Vine din imaginea serverului (VALHEIM_PLUS=true)">inclus în server</span>'
      : m.modpack ? '' :
        `<div class="seg" data-name="${esc(m.name)}"><button class="server ${sd === 'server' ? 'on' : ''}" data-side="server" ${busy ? 'disabled' : ''}>Server</button><button class="client ${sd === 'client' ? 'on' : ''}" data-side="client" ${busy ? 'disabled' : ''}>Client</button></div>`;
    // one grid cell for all the actions, so they stay on the right of the row
    const uninstall = m.builtin || m.name === 'denikson-BepInExPack_Valheim' ? '' : `<button class="icon-btn" data-uninstall="${esc(m.name)}" title="Dezinstalează" ${busy ? 'disabled' : ''}>✕</button>`;
    return `<div class="mod ${m.enabled ? '' : 'disabled'}">
      ${icon}
      <div class="mod-body">
        <div class="mod-title">${m.url ? `<a data-url="${esc(m.url)}">${esc(m.displayName)}</a>` : `<a>${esc(m.displayName)}</a>`}
          <span class="mod-author">de ${esc(m.author)}</span><span class="mod-ver">${esc(m.version)}</span>${badges}</div>
        <div class="mod-desc" title="${esc(m.description)}">${esc(m.description)}</div>
      </div>
      <div class="mod-actions">${m.configs ? `<button class="icon-btn" data-config="${esc(m.name)}" data-title="${esc(m.displayName)}" title="Configurare (${m.configs} ${m.configs === 1 ? 'fișier' : 'fișiere'})">${GEAR}</button>` : ''}${seg}${uninstall}</div>
    </div>`;
  }).join('') + (S.profile.otherConfigs ? `<div class="mod-other"><button class="btn ghost small" data-config="" data-title="Alte configurări">${GEAR} Alte configurări (${S.profile.otherConfigs} fără un mod recunoscut)</button></div>` : '');
}
$('#mod-list').addEventListener('click', async e => {
  const cf = e.target.closest('[data-config]'); if (cf) { openConfigDrawer(cf.dataset.config, cf.dataset.title); return; }
  const up = e.target.closest('[data-update]'); if (up) { installPkg(up.dataset.update, up.dataset.ver); return; }
  const un = e.target.closest('[data-uninstall]');
  if (un) {
    if (!await confirmBox('Dezinstalezi?', `${un.dataset.uninstall}\nDacă e mod de server, îl scot și de pe server (la următorul restart) și din lista prietenilor.`, 'Dezinstalează')) return;
    const r = await window.vp.act('remove', un.dataset.uninstall);
    toast(r.ok ? 'Dezinstalat - sincronizez serverul.' : r.error, r.ok ? 'ok' : 'error');
    return;
  }
  const nx = e.target.closest('[data-nexus]');
  if (nx) {
    const m = (S.profile.mods || []).find(x => x.name === nx.dataset.nexus);
    const url = await confirmBox(`${nx.dataset.nexus} pe Nexus`, 'Lipește linkul paginii modului de pe Nexus (ex. https://www.nexusmods.com/valheim/mods/1234). Bifrost ia fișierul principal, cel mai nou. Gol = scoate legătura.', 'Salvează', m?.nexus ? `https://www.nexusmods.com/valheim/mods/${m.nexus.modId}` : '');
    if (url === null) return;
    const r = await window.vp.act('nexusLink', { name: nx.dataset.nexus, url });
    toast(r.ok ? (r.link ? `Legat de „${r.link.title}” ${r.link.version || ''} (fișierul ${r.link.fileName}).` : 'Legătură scoasă.') : r.error, r.ok ? 'ok' : 'error');
    return;
  }
  const a = e.target.closest('a[data-url]'); if (a) { window.vp.act('open', a.dataset.url); return; }
  const b = e.target.closest('.seg button'); if (!b || b.disabled || b.classList.contains('on')) return;
  const name = b.parentElement.dataset.name, side = b.dataset.side;
  const r = await window.vp.act('setSide', { name, side });
  if (!r.ok) toast(r.error, 'error');
  else toast(side === 'server' ? `${name} → server${S.settings.autoSync ? ' (sincronizez imediat)' : ''}` : `${name} → doar client${S.settings.autoSync ? ' (îl scot de pe server)' : ''}`, 'ok');
});
$('#mod-search').addEventListener('input', e => { S.search = e.target.value; renderMods(); });
$$('#mod-filters .chip').forEach(c => c.onclick = () => { S.filter = c.dataset.f; renderMods(); });

// ---------- modpack ----------
function renderModpack() {
  const p = S.modpack || {};
  if (p.name) $('#mp-sub').textContent = `${p.name} pe Thunderstore: pentru cine folosește un mod manager (prietenii cu Bifrost nu au nevoie de el).`;
  $('#mp-published').textContent = p.published || '–';
  $('#mp-local').textContent = p.local || '–';
  $('#mp-count').textContent = p.count ?? '–';
  $('#mp-url').dataset.url = p.url || '';
  const n = (p.added?.length || 0) + (p.changed?.length || 0) + (p.removed?.length || 0);
  const pill = $('#mp-pill');
  pill.className = `status-pill ${n ? 'warn' : 'ok'}`;
  $('#mp-pill-text').textContent = n ? `${n} schimbări nepublicate` : 'la zi';
  const nm = $('#nav-modpack'); nm.hidden = !n; nm.textContent = n;
  const rows = [
    ...(p.changed || []).map(x => `<div class="diff-row chg"><span class="sym">↑</span><span>${esc(x.name)}</span><code>${esc(x.from)} → ${esc(x.to)}</code></div>`),
    ...(p.added || []).map(x => `<div class="diff-row add"><span class="sym">+</span><span>${esc(x.name)}</span><code>${esc(x.to)}</code></div>`),
    ...(p.removed || []).map(x => `<div class="diff-row rem"><span class="sym">−</span><span>${esc(x.name)}</span><code>${esc(x.from)}</code></div>`),
  ];
  $('#mp-diff').innerHTML = rows.length ? rows.join('') : '<div class="muted">Modpack-ul are exact modurile și versiunile din profilul tău.</div>';
  $('#btn-publish').hidden = !p.hasToken;
  $('#btn-showzip').disabled = !p.zip;
  $('#mp-token-note').innerHTML = p.hasToken
    ? 'Publicarea urcă o versiune nouă (patch +1). Apare în mod manager la prieteni în cam o oră.'
    : 'Ca să public direct din app, pune un token de echipă Thunderstore în <a href="#" data-page-link="settings">Setări</a>. Fără token: construiește zip-ul și urcă-l pe thunderstore.io/c/valheim/create.';
}

// ---------- log ----------
const logLine = e => `<span class="l-time">${esc(new Date(e.t).toLocaleTimeString(LOC()))}</span>  <span class="l-${esc(e.kind)}">${esc(e.line)}</span>`;
let logEntries = [];
function addLog(e) {
  logEntries.push(e); if (logEntries.length > 3000) logEntries.shift();
  const l = $('#log'), atBottom = l.scrollHeight - l.scrollTop - l.clientHeight < 40;
  l.insertAdjacentHTML('beforeend', logLine(e) + '\n');
  if (atBottom) l.scrollTop = l.scrollHeight;
  renderMiniLog();
}
function renderMiniLog() {
  const m = $('#mini-log');
  m.innerHTML = logEntries.filter(e => e.kind !== 'out' || /copied|removed|Join code|RESTART|ERROR|failed|->/i.test(e.line)).slice(-12).map(logLine).join('\n') || '<span class="muted">Nimic încă.</span>';
  m.scrollTop = m.scrollHeight;
}

// ---------- settings ----------
function renderSettingsGame() {
  const g = S.player?.game;
  if (g) $('#game-detected').textContent = g.game ? `Acum: ${g.game}` : 'Nu l-am găsit prin Steam - scrie aici folderul care conține valheim.exe.';
  if (g) {
    $('#btn-restore-loader').disabled = !g.backup;
    const who = { bifrost: 'Acum încarcă modurile Bifrost.', tmm: 'Acum încarcă modurile Thunderstore Mod Manager / r2modman - la JOACĂ preia Bifrost (păstrez un backup).', other: 'Acum e alt încărcător BepInEx - la JOACĂ preia Bifrost (păstrez un backup).', none: 'Valheim e fără moduri acum.', native: 'Linux: Bifrost pornește Valheim direct cu BepInEx-ul din profil, folderul jocului rămâne neatins.' }[g.owner];
    if (who) $('#loader-state').textContent = who + (g.backup ? ' Backup-ul anterior există.' : '');
  }
}
function renderSettings() {
  const s = S.settings;
  $$('[data-set]').forEach(el => {
    if (document.activeElement === el) return;
    if (el.type === 'checkbox') el.checked = !!s[el.dataset.set]; else el.value = s[el.dataset.set] ?? '';
  });
  $('#token-state').innerHTML = s.hasToken ? '<span style="color:var(--green)">✓ Token salvat.</span>' : '<span class="muted">Niciun token salvat.</span>';
  $('#nexus-state').innerHTML = s.hasNexusKey && s.nexusUser ? `<span style="color:var(--green)">✓ Conectat ca <b>${esc(s.nexusUser.name)}</b> · ${s.nexusUser.premium ? 'Premium: descărcări automate' : 'cont gratuit: un click pe „Mod Manager Download” per fișier'}</span>` : '<span class="muted">Nicio cheie salvată.</span>';
  // direct join: what PLAY will connect to
  if ($('#dj-state')) {
    $('#dj-state').textContent = !s.directJoin ? 'Oprit: intri din joc, cu join code-ul.'
      : s.joinTarget ? `Acum: ${s.joinTarget}${s.hasJoinPass ? ' cu parola salvată' : ''}. Alegi caracterul, apeși Start și ești pe server.`
        : s.isAdmin ? 'Încă nu știu IP-ul public al serverului (apare după ce pornește) - sau scrie adresa mai jos.'
          : 'Lista serverului nu are IP-ul: scrie adresa mai jos (o ai de la admin) sau adminul bifează „Pune și IP-ul în listă”.';
    // (attributes set from code are not seen by the translator)
    $('#dj-addr').placeholder = s.joinAddress ? '' : (s.joinTarget || ((s.lang || 'en') === 'en' ? window.bifrostI18n.t('automat') : 'automat'));
    $('#jp-state').innerHTML = s.hasJoinPass ? '<span style="color:var(--green)">✓ Parolă salvată (criptat, doar pe PC-ul tău).</span>' : '<span class="muted">Nicio parolă salvată. Dacă serverul are parolă, scrie-o o dată aici.</span>';
    $('#btn-jp-clear').hidden = !s.hasJoinPass;
  }
  // restart / new join code only where Bifrost can do them
  $$('[data-act="fixcode"]').forEach(b => { b.hidden = !s.dockerServer; });
  $$('[data-act="restart"]').forEach(b => { b.hidden = !s.canRestart; });
  renderServers();
  document.body.classList.toggle('role-admin', !!s.isAdmin); document.body.classList.toggle('role-player', !s.isAdmin);
  $('#brand-sub').textContent = s.server?.name || 'Valheim';
}
$('#btn-nexus').onclick = async () => {
  const v = $('#nexus-input').value.trim(); if (!v) return;
  $('#btn-nexus').disabled = true;
  const r = await window.vp.act('setNexusKey', v); $('#btn-nexus').disabled = false;
  if (r.ok) $('#nexus-input').value = '';
  toast(r.ok ? `Conectat la Nexus ca ${r.user.name}${r.user.premium ? ' (Premium)' : ''}.` : `Cheia nu merge: ${r.error}`, r.ok ? 'ok' : 'error');
};
// download cache: size shown on the Settings page, "Empty" deletes it (mods get downloaded again when needed)
const fmtSize = b => b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`;
async function renderCache() {
  const r = await window.vp.act('cacheInfo');
  if (r.ok) $('#cache-state').textContent = `${fmtSize(r.bytes)} în ${r.files} fișiere. Versiunile vechi se șterg singure; „Golește” le scoate pe toate (se descarcă din nou la nevoie).`;
}
$('#btn-cache-clear').onclick = async () => {
  if (!await confirmBox('Golești cache-ul?', 'Modurile instalate rămân. Doar fișierele descărcate se șterg - la o reinstalare se descarcă din nou.', 'Golește')) return;
  const r = await window.vp.act('clearCache');
  toast(r.ok ? `Cache golit (${fmtSize(r.freed)}).` : r.error, r.ok ? 'ok' : 'error');
  renderCache();
};
$('#btn-jp-save').onclick = async () => {
  const v = $('#jp-input').value; if (!v) return;
  const r = await window.vp.act('setJoinPassword', v); $('#jp-input').value = '';
  toast(r.ok ? 'Parola serverului e salvată (criptat).' : 'N-am putut salva parola.', r.ok ? 'ok' : 'error');
};
$('#jp-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-jp-save').click(); });
$('#btn-jp-clear').onclick = async () => { await window.vp.act('setJoinPassword', null); toast('Parola ștearsă.'); };
$('#btn-jp-detect').onclick = async () => {
  const b = $('#btn-jp-detect'); b.disabled = true;
  const r = await window.vp.act('detectJoinPassword'); b.disabled = false;
  toast(!r.ok ? r.error : r.found ? 'Am luat parola de pe server (salvată criptat).' : 'Serverul nu are parolă.', r.ok ? 'ok' : 'error');
};
$('#btn-nexus-clear').onclick = async () => { await window.vp.act('setNexusKey', null); toast('Cheia Nexus ștearsă.'); };
document.addEventListener('click', e => { const o = e.target.closest('a[data-open]'); if (o && !o.closest('#drawer')) { e.preventDefault(); window.vp.act('open', o.dataset.open); } });
$$('[data-set]').forEach(el => el.addEventListener('change', async () => {
  let v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Math.max(+el.min || 0, Math.min(+el.max || 1e9, +el.value || 0)) : el.value.trim();
  await window.vp.act('setSetting', { key: el.dataset.set, value: v });
  toast('Salvat.', 'ok');
}));
$('#tg-autosync').addEventListener('change', e => window.vp.act('setSetting', { key: 'autoSync', value: e.target.checked }));
$('#btn-token').onclick = async () => {
  const v = $('#token-input').value.trim(); if (!v) return;
  const r = await window.vp.act('setToken', v); $('#token-input').value = '';
  toast(r.ok ? 'Token salvat (criptat).' : r.error, r.ok ? 'ok' : 'error');
};
$('#btn-token-clear').onclick = async () => { await window.vp.act('setToken', null); toast('Token șters.'); };

// ---------- actions ----------
document.addEventListener('click', async e => {
  const cp = e.target.closest('[data-copy],[data-copy-id]');
  if (cp) { const v = cp.dataset.copy || $('#' + cp.dataset.copyId).textContent; await window.vp.act('copy', v); toast(`Copiat: ${v}`, 'ok'); return; }
  const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
  const act = b.dataset.act;
  let arg = b.dataset.arg;
  if (b.dataset.argId) arg = $('#' + b.dataset.argId).dataset.url;
  if (act === 'restart') {
    const p = S.status.players;
    const ok = await confirmBox('Restart server?', p ? `Sunt ${p} jucători online - vor fi deconectați.\nServerul revine în ~2-3 minute, cu join code.` : 'Serverul revine în ~2-3 minute, cu join code.', 'Restart');
    if (!ok) return;
  }
  if (act === 'fixcode') {
    if (!await confirmBox('Join code nou?', 'Repornește doar procesul jocului (~1 minut). Jucătorii conectați sunt deconectați.', 'Repornește jocul')) return;
  }
  if (act === 'publishModpack') {
    const p = S.modpack;
    if (!await confirmBox('Publici modpack-ul?', `Construiesc o versiune nouă din profilul tău și o urc pe Thunderstore ca ${p.name}.\nAcum publicat: ${p.published || '?'}.`, 'Publică')) return;
  }
  if (act === 'importTmm' && !await confirmBox('Import din Thunderstore Mod Manager?', 'Copiez în profilul Bifrost aceleași moduri și versiuni (din cache-ul Thunderstore), configurările din BepInEx/config și modurile manuale. Profilul TMM rămâne neatins. Serverul nu se schimbă - fișierele sunt identice.', 'Importă')) return;
  if (act === 'updateAll' && !await confirmBox('Actualizezi tot?', 'Aduc ultima versiune pentru fiecare mod cu update. Serverul se actualizează singur (repornește când e gol) și prietenii primesc versiunile noi la JOACĂ.', 'Actualizează')) return;
  if (act === 'quit') { if (!await confirmBox('Închizi complet?', S.settings.isAdmin ? 'Auto-sync-ul se oprește până pornești din nou Bifrost.' : 'Bifrost se închide.', 'Închide')) return; }
  if (act === 'dryrun') $('#dry-result').hidden = true;
  if (act === 'checkUpdates') { b.disabled = true; b.textContent = 'Caut...'; }
  const r = await window.vp.act(act, arg);
  if (act === 'checkUpdates') { b.disabled = false; b.textContent = 'Caută update-uri'; const n = (S.profile.mods || []).filter(hasUpdate).length; toast(n ? `${n} moduri au update în Thunderstore.` : 'Toate modurile sunt la ultima versiune.', 'ok'); return; }
  if (act === 'dryrun' && r.ok) { const d = $('#dry-result'); d.hidden = false; d.innerHTML = `De copiat: <b>${esc(r.toCopy || '-')}</b><br>De scos: <b>${esc(r.toRemove || '-')}</b>`; return; }
  if (r && r.ok === false && r.error) toast(r.error, 'error');
  else if (act === 'restart' && r.ok) toast(r.manualRestart ? 'Bifrost nu poate reporni serverul ăsta - repornește-l din panoul hostului.' : r.postponed ? 'Sunt jucători online - serverul repornește când se golește.' : r.joinCode ? `Server repornit. Join code: ${r.joinCode}` : 'Server repornit.', r.manualRestart ? 'info' : 'ok');
  else if (act === 'buildModpack' && r.ok) toast(`Zip construit: versiunea ${r.info.local}.`, 'ok');
  else if (act === 'publishModpack' && r.ok) toast(`Publicat ${r.version} pe Thunderstore.`, 'ok');
  else if (act === 'fixcode' && r.ok) toast('Jocul repornește - codul nou apare în ~1 minut.', 'ok');
  else if (act === 'publishList' && r.ok) toast(r.changed ? 'Lista pentru prieteni e publicată.' : 'Lista era deja la zi.', 'ok');
  else if (act === 'updateMods' && r.ok) toast('Modurile sunt la zi.', 'ok');
  else if (act === 'play' && r.ok) toast('Pornesc Valheim prin Steam...', 'ok');
  else if (act === 'refreshList' && r.ok) toast('Lista serverului e actualizată.', 'ok');
  else if (act === 'importTmm' && r.ok) toast(`Import gata: ${r.count} pachete în profilul Bifrost. De acum pornește Valheim cu JOACĂ.`, 'ok');
  else if (act === 'updateAll' && r.ok) toast(r.count ? `${r.count} moduri actualizate - sincronizez serverul.` : 'Totul e la zi.', 'ok');
  else if (act === 'restoreLoader' && r.ok) toast('Încărcătorul anterior e pus înapoi. Valheim pornit din Steam folosește iar vechiul mod manager.', 'ok');
});
$('#btn-copy-code').onclick = async () => { if (!S.status.joinCode) return; await window.vp.act('copy', S.status.joinCode); toast(`Join code copiat: ${S.status.joinCode}`, 'ok'); };

// ---------- browse (Thunderstore catalog) ----------
const fmtNum = n => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0);
const pkTitle = p => (p.name || '').replace(/_/g, ' ');
const ICON_DL = '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>';
const ICON_STAR = '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1-4.5-4.2 6.1-.8L12 3Z"/></svg>';
const isPack = p => (p.cats || []).includes('Modpacks');
const installedVer = full => (S.profile.mods || []).find(m => m.name === full)?.version || null;
// the same mod is often on both stores: a Thunderstore card knows about the Nexus copy and the other way around
// (same name; or same author and one name containing the other). The install itself is guarded by the DLLs in main.
// names compared as letters+digits, without "(by X)" / "[tags]", and also without the word "valheim"
// ("Valheim Armory" = "Armory", "Valheim Plus" = "ValheimPlus")
const normName = s => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');
const noValheim = s => s.replace(/valheim/g, '');
function crossInstalled(name, author, from) {
  const n = normName(name), n2 = noValheim(n), a = normName(author);
  if (n.length < 4) return null;
  return (S.profile.mods || []).find(m => {
    const src = m.source || (m.manual ? 'manual' : 'thunderstore');
    if (src !== from) return false;
    const mn = from === 'thunderstore' ? normName(m.name.slice(m.name.indexOf('-') + 1)) : normName(m.displayName || m.title);
    if (!mn) return false;
    // the very same name is enough (authors often use other handles on the other store: RustyMods / RustyNoodles)
    if (mn === n) return true;
    // looser matches only by the same author ("Valheim Armory" by MidnightsFX is not Therzie's Armory)
    const ma = from === 'thunderstore' ? normName(m.name.split('-')[0]) : normName(m.author);
    const sameAuthor = !!a && !!ma && (a === ma || (Math.min(a.length, ma.length) >= 5 && (a.includes(ma) || ma.includes(a))));
    if (!sameAuthor) return false;
    return (n2.length >= 4 && noValheim(mn) === n2) || (mn.length >= 5 && n.length >= 5 && (mn.includes(n) || n.includes(mn)));
  }) || null;
}
const crossLabel = (m, store) => `<button class="btn small installed" disabled title="${esc(`Instalat din ${store}: ${m.displayName || m.title || m.name}`)}">✓ Instalat din ${store}</button>`;

function pkButton(p, big) {
  const cls = big ? 'btn' : 'btn small';
  const have = installedVer(p.full);
  if (S.installing[p.full]) return `<button class="${cls} working" disabled>Se instalează</button>`;
  if (have && cmpVer(p.ver, have) > 0) return `<button class="${cls} update" data-install="${esc(p.full)}">Update la ${esc(p.ver)}</button>`;
  if (have) return `<button class="${cls} installed" disabled>✓ Instalat</button>`;
  const nxTwin = crossInstalled(p.name.replace(/_/g, ' '), p.owner, 'nexus');
  if (nxTwin) return crossLabel(nxTwin, 'Nexus').replace('btn small', cls);
  return `<button class="${cls} primary" data-install="${esc(p.full)}">Instalează</button>`;
}
function sideTags(p) {
  const c = p.cats || [];
  return [c.includes('Server-side') ? '<span class="side-tag srv">server</span>' : '', c.includes('Client-side') ? '<span class="side-tag">client</span>' : ''].join('');
}

async function loadCatalog(force) {
  if (S.catalog && !force) { renderBrowse(true); return; }
  if (!S.catalog) $('#br-grid').innerHTML = Array.from({ length: 9 }, () => '<div class="skeleton"></div>').join('');
  $('#br-more').textContent = S.catalog ? '' : 'Descarc catalogul Thunderstore (~14 MB, câteva secunde)...';
  const r = await window.vp.act(force ? 'refreshCatalog' : 'catalog');
  // (no catalog yet and no internet: nothing is cached, the next visit to Discover tries again)
  if (r.packages?.length) {
    S.catalog = r.packages.filter(p => !/^ebkr-r2modman/.test(p.full)).map(p => ({ ...p, hay: `${p.full} ${p.name.replace(/_/g, ' ')} ${p.owner} ${p.desc}`.toLowerCase() }));
    S.catalogFetched = r.fetched;
    buildCats();
  } else if (!S.catalog) { $('#br-grid').innerHTML = ''; $('#br-more').textContent = 'Nu am putut descărca catalogul. Verifică internetul și apasă „Reîmprospătează catalogul”.'; return; }
  if (force) toast('Catalog actualizat.', 'ok');
  renderBrowse(true);
}
function buildCats() {
  const count = {};
  for (const p of S.catalog) if (!isPack(p)) for (const c of p.cats || []) count[c] = (count[c] || 0) + 1;
  const cats = Object.entries(count).filter(([c]) => !/Update$|^Mods$|^Modpacks$/.test(c)).sort((a, b) => b[1] - a[1]).slice(0, 18);
  $('#br-cats').innerHTML = `<button class="chip ${S.bcat ? '' : 'active'}" data-cat="">Toate</button>` +
    cats.map(([c, n]) => `<button class="chip ${S.bcat === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)} <b>${n}</b></button>`).join('');
}
function renderBrowseSub() {
  const n = S.catalog ? S.catalog.filter(p => !isPack(p)).length : 0;
  $('#br-sub').textContent = S.catalog
    ? `Catalogul Thunderstore pentru Valheim · ${n.toLocaleString(LOC())} moduri · actualizat ${ago(S.catalogFetched)}${S.catalogBusy ? ' · se reîmprospătează...' : ''}`
    : 'Catalogul Thunderstore pentru Valheim';
}
function browseList() {
  const q = S.bq.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let list = S.catalog.filter(p => (S.bpacks || !isPack(p)) && (!S.bcat || (p.cats || []).includes(S.bcat)) && q.every(w => p.hay.includes(w)));
  const key = { dl: p => p.dl, rating: p => p.rating, updated: p => p.updated, created: p => p.created }[S.bsort];
  list.sort((a, b) => key(b) - key(a));
  if (q.length) {   // exact name hits first
    const qs = q.join(' ');
    list.sort((a, b) => (pkTitle(b).toLowerCase() === qs) - (pkTitle(a).toLowerCase() === qs) || (pkTitle(b).toLowerCase().includes(qs)) - (pkTitle(a).toLowerCase().includes(qs)));
  }
  return list;
}
function renderBrowse(reset) {
  if (S.src === 'nx') { if (reset) nexusSearch(true); else renderNexus(); return; }
  if (!S.catalog || !$('#page-browse').classList.contains('active') && !reset) return;
  if (!S.catalog) return;
  if (reset) S.blimit = 60;
  renderBrowseSub();
  const list = browseList();
  const shown = list.slice(0, S.blimit);
  $('#br-grid').innerHTML = shown.map(p => `
    <div class="pk" data-pk="${esc(p.full)}">
      ${p.icon ? `<img src="${esc(p.icon)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
      <div><div class="pk-name">${esc(pkTitle(p))}</div><div class="pk-owner">de ${esc(p.owner)}</div><div class="pk-desc">${esc(p.desc)}</div></div>
      <div class="pk-foot"><span class="pk-stat" title="descărcări">${ICON_DL}${fmtNum(p.dl)}</span><span class="pk-stat" title="aprecieri">${ICON_STAR}${fmtNum(p.rating)}</span>${sideTags(p)}${pkButton(p)}</div>
    </div>`).join('');
  $('#br-more').textContent = !list.length ? 'Nimic găsit.' : list.length > shown.length ? `${shown.length} din ${list.length.toLocaleString(LOC())} - derulează pentru mai multe` : `${list.length} moduri`;
}
const moreObs = new IntersectionObserver(es => {
  if (es.some(e => e.isIntersecting) && S.catalog && $('#page-browse').classList.contains('active')) {
    const total = browseList().length;
    if (S.src === 'nx') { if (!S.nx.loading && S.nx.list.length < S.nx.total) nexusSearch(false); return; }
    if (S.blimit < total) { S.blimit += 60; renderBrowse(false); }
  }
}, { root: document.querySelector('main'), rootMargin: '600px' });
moreObs.observe($('#br-more'));

let bTimer = null;
$('#br-search').addEventListener('input', e => { S.bq = e.target.value; clearTimeout(bTimer); bTimer = setTimeout(() => renderBrowse(true), S.src === 'nx' ? 400 : 150); });
$('#br-sort').addEventListener('change', e => { S.bsort = e.target.value; renderBrowse(true); });
$('#br-packs').addEventListener('change', e => { S.bpacks = e.target.checked; renderBrowse(true); });
$('#br-cats').addEventListener('click', e => { const c = e.target.closest('[data-cat]'); if (!c) return; S.bcat = c.dataset.cat || null; buildCats(); renderBrowse(true); });
$('#btn-catalog').onclick = () => S.src === 'nx' ? nexusSearch(true) : loadCatalog(true);

// ---------- browse: Nexus Mods ----------
const NX_SORT = { dl: 'downloads', rating: 'endorsements', updated: 'updatedAt', created: 'createdAt' };
function setSource(src) {
  S.src = src;
  $$('#br-source button').forEach(b => b.classList.toggle('on', b.dataset.src === src));
  $('#br-cats').hidden = src === 'nx'; $('#br-packs-wrap').hidden = src === 'nx';
  $('#br-search').placeholder = src === 'nx' ? 'Caută pe Nexus Mods...' : 'Caută în Thunderstore...';
  const note = $('#br-nexus-note');
  note.hidden = src !== 'nx';
  const u = S.settings.nexusUser;
  note.innerHTML = '<span>' + (!S.settings.hasNexusKey ? 'Pentru instalare de pe Nexus pune-ți cheia în <a href="#" data-page-link="settings">Setări → Nexus Mods</a>. Căutarea merge și fără.'
    : u && u.premium ? `Conectat ca <b>${esc(u.name)}</b> (Premium): <b>Instalează</b> descarcă direct.`
      : `Conectat ca <b>${esc(u ? u.name : '?')}</b> (cont gratuit): <b>Instalează</b> deschide pagina fișierului pe Nexus - apasă acolo <b>„Slow download”</b> și Bifrost îl instalează singur.${S.settings.isAdmin ? ' Modul intră în profilul tău Thunderstore ca mod manual, legat de Nexus, deci ajunge și în lista prietenilor.' : ''}`) + '</span>';
  renderHowto();
  renderBrowse(true);
}
$('#br-source').addEventListener('click', e => { const b = e.target.closest('[data-src]'); if (b && b.dataset.src !== S.src) setSource(b.dataset.src); });
async function nexusSearch(reset) {
  const nx = S.nx, seq = ++nx.seq;
  if (reset) { nx.list = []; nx.total = 0; $('#br-grid').innerHTML = Array.from({ length: 9 }, () => '<div class="skeleton"></div>').join(''); }
  nx.loading = true; $('#br-more').textContent = 'Caut pe Nexus...';
  const [r, inst] = await Promise.all([window.vp.act('nexusSearch', { q: S.bq, sort: NX_SORT[S.bsort] || 'downloads', offset: nx.list.length, count: 30 }), reset ? window.vp.act('nexusInstalled') : null]);
  if (seq !== nx.seq) return;
  nx.loading = false;
  if (inst) { nx.installed = inst.installed; nx.pending = inst.pending; }
  if (!r.ok) { nx.error = r.error; $('#br-more').textContent = `Nexus nu răspunde: ${r.error}`; if (reset) $('#br-grid').innerHTML = ''; return; }
  nx.error = null; nx.total = r.total; nx.list.push(...r.mods);
  renderNexus();
}
function nxButton(m, big) {
  const cls = big ? 'btn' : 'btn small', nx = S.nx;
  if (nx.installed[m.modId]) return `<button class="${cls} installed" disabled>✓ Instalat</button>`;
  const tsTwin = crossInstalled(m.name, m.author || m.uploader?.name, 'thunderstore');
  if (tsTwin) return crossLabel(tsTwin, 'Thunderstore').replace('btn small', cls);
  if (S.job && S.job.kind === 'nexus') return `<button class="${cls} working" disabled>Se instalează</button>`;
  if (nx.pending[m.modId]) return `<button class="${cls} working" data-nxinstall="${m.modId}">Aștept click pe Nexus</button>`;
  return `<button class="${cls} primary" data-nxinstall="${m.modId}">Instalează</button>`;
}
function renderNexus() {
  const nx = S.nx;
  $('#br-sub').textContent = `Nexus Mods pentru Valheim · ${nx.total.toLocaleString(LOC())} moduri`;
  $('#br-grid').innerHTML = nx.list.map(m => `
    <div class="pk" data-nxpk="${m.modId}">
      ${m.thumbnailUrl ? `<img src="${esc(m.thumbnailUrl)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
      <div><div class="pk-name">${esc(m.name)}</div><div class="pk-owner">de ${esc(m.author || m.uploader?.name || '?')} · v${esc(m.version || '?')}</div><div class="pk-desc">${esc(m.summary)}</div></div>
      <div class="pk-foot"><span class="pk-stat" title="descărcări">${ICON_DL}${fmtNum(m.downloads)}</span><span class="pk-stat" title="endorsements">${ICON_STAR}${fmtNum(m.endorsements)}</span>${m.modCategory ? `<span class="nx-cat">${esc(m.modCategory.name)}</span>` : ''}${nxButton(m)}</div>
    </div>`).join('');
  $('#br-more').textContent = !nx.list.length ? 'Nimic găsit.' : nx.list.length < nx.total ? `${nx.list.length} din ${nx.total.toLocaleString(LOC())} - derulează pentru mai multe` : `${nx.total} moduri`;
}
async function nxInstall(modId, fileId) {
  const m = S.nx.list.find(x => x.modId === +modId) || S.nxDrawer;
  if (!S.settings.hasNexusKey) { toast('Pune întâi cheia Nexus în Setări → Nexus Mods.', 'error'); go('settings'); return; }
  const r = await window.vp.act('nexusInstall', { modId: +modId, fileId: fileId ? +fileId : null, title: m?.name || `Nexus ${modId}`, version: m?.version });
  if (!r.ok) { toast(r.error, 'error'); return; }
  if (r.waiting) { S.nx.pending[+modId] = { fileId }; toast('Pe pagina Nexus care s-a deschis apasă „Slow download” (Mod Manager Download) - Bifrost îl instalează singur.', 'info'); }
  else { S.nx.installed[+modId] = m?.version || 'instalat'; toast(`${m?.name || modId} instalat.`, 'ok'); }
  renderNexus(); if (S.nxDrawer) openNexusDrawer(S.nxDrawer.modId, true);
}
$('#br-grid').addEventListener('click', e => {
  const b = e.target.closest('[data-nxinstall]'); if (b) { e.stopPropagation(); nxInstall(b.dataset.nxinstall); return; }
  const c = e.target.closest('[data-nxpk]'); if (c) openNexusDrawer(+c.dataset.nxpk);
}, true);
async function openNexusDrawer(modId, keepScroll) {
  const m = S.nx.list.find(x => x.modId === modId) || S.nxDrawer; if (!m) return;
  S.drawer = `nx:${modId}`; S.nxDrawer = m;
  $('#drawer').hidden = false; $('#drawer-bg').hidden = false; if (!keepScroll) $('#drawer').scrollTop = 0;
  const page = `https://www.nexusmods.com/valheim/mods/${modId}`;
  $('#drawer-body').innerHTML = `
    <div class="dr-head">${m.pictureUrl || m.thumbnailUrl ? `<img src="${esc(m.thumbnailUrl || m.pictureUrl)}" alt="" style="object-fit:cover">` : '<div class="ph"></div>'}
      <div><h2>${esc(m.name)}</h2><div class="muted">de ${esc(m.author || m.uploader?.name || '?')} · v${esc(m.version || '?')} · Nexus ${modId}</div>
        <div class="row gap" style="margin-top:12px">${nxButton(m, true)}<button class="btn ghost" data-open="${page}">Pe Nexus ↗</button></div></div></div>
    <div class="muted">${esc(m.summary)}</div>
    <div class="dr-stats"><span><b>${fmtNum(m.downloads)}</b> descărcări</span><span><b>${fmtNum(m.endorsements)}</b> endorsements</span>
      <span>actualizat <b>${esc(new Date(m.updatedAt).toLocaleDateString(LOC()))}</b></span>${m.modCategory ? `<span><b>${esc(m.modCategory.name)}</b></span>` : ''}</div>
    <div class="where"><span>Nexus nu spune dacă un mod e de server sau de client - citește descrierea de pe Nexus.</span>${S.settings.isAdmin ? ' <span>După instalare îl marchezi la <b>Moduri</b> (Server / Client).</span>' : ''} <span>Se instalează zip, 7z, rar și DLL-uri simple.</span></div>
    <div class="dr-section"><h3>Fișiere</h3><div id="nx-files"><span class="muted">se încarcă...</span></div></div>`;
  const r = await window.vp.act('nexusFiles', modId);
  if (S.drawer !== `nx:${modId}`) return;
  const el = $('#nx-files');
  if (!r.ok) { el.innerHTML = `<span class="muted">${esc(r.error)}</span>`; return; }
  const order = { MAIN: 0, UPDATE: 1, OPTIONAL: 2, MISCELLANEOUS: 3 };
  const files = r.files.filter(f => !/OLD_VERSION|ARCHIVED|REMOVED|DELETED/.test(f.category)).sort((a, b) => (order[a.category] ?? 9) - (order[b.category] ?? 9) || b.date - a.date);
  el.innerHTML = files.length ? files.map(f => `<div class="nx-file"><div><b>${esc(f.name)}</b><small>${esc(f.category)} · v${esc(f.version || '?')} · ${fmtMB(+f.sizeInBytes || 0)} · ${esc(new Date(f.date * 1000).toLocaleDateString(LOC()))}</small></div>
    ${S.nx.installed[modId] || crossInstalled(S.nxDrawer?.name, S.nxDrawer?.author || S.nxDrawer?.uploader?.name, 'thunderstore') ? '' : `<button class="btn small" data-nxinstall="${modId}" data-file="${f.fileId}">Instalează</button>`}</div>`).join('') : '<span class="muted">Niciun fișier activ.</span>';
}
$('#drawer').addEventListener('click', e => { const b = e.target.closest('[data-nxinstall]'); if (b) { e.stopPropagation(); nxInstall(b.dataset.nxinstall, b.dataset.file); } }, true);
function renderHowto() {
  let seen = false; try { seen = !!localStorage.getItem('howtoSeen'); } catch { }
  const h = $('#br-howto');
  h.hidden = seen || S.src === 'nx';
  const en = (S.settings.lang || 'en') === 'en', admin = S.settings.isAdmin;
  h.querySelector('span').innerHTML = en
    ? `<b>How to install:</b> press <b>Install</b> and Bifrost puts the mod (with its dependencies) into this server's profile. ${admin ? 'Server mods go to the server too, and your friends get them through the list.' : 'The mods the server needs are not searched here - they install by themselves when you press <b>PLAY</b>.'}`
    : `<b>Cum se instalează:</b> apeși <b>Instalează</b> și Bifrost pune modul (cu dependențele) în profilul serverului. ${admin ? 'Modurile de server ajung și pe server, iar prietenii le primesc prin listă.' : 'Modurile cerute de server nu trebuie căutate aici - se instalează singure când apeși <b>JOACĂ</b>.'}`;
}
$('#br-howto-x').onclick = () => { $('#br-howto').hidden = true; try { localStorage.setItem('howtoSeen', '1'); } catch { } };

async function installPkg(full, ver) {
  const p = S.catalog?.find(x => x.full === full);
  const tmm = 'Se deschide Thunderstore Mod Manager și instalează modul în profilul tău (dacă cere, confirmă acolo).';
  if (!S.settings.isAdmin) toast(`Instalez ${full}...`);
  const r = await window.vp.act('install', { full, ver: ver || p?.ver });
  if (!r.ok) { toast(r.error, 'error'); return; }
  if (r.via === 'tmm') toast(`${full}: ${tmm}${r.side ? ` Marcat „${r.side}” după categoriile Thunderstore.` : ''}`, 'ok');
  else toast(`${full} instalat. Pornește-l cu JOACĂ.`, 'ok');
}
$('#br-grid').addEventListener('click', e => {
  const b = e.target.closest('[data-install]'); if (b) { e.stopPropagation(); installPkg(b.dataset.install); return; }
  const c = e.target.closest('[data-pk]'); if (c) openDrawer(c.dataset.pk);
});

// detail drawer
async function closeDrawer() {
  if (String(S.drawer).startsWith('cfg:') && cfgDirty() && !await confirmBox('Renunți la modificări?', 'Ai modificări nesalvate în configurare.', 'Renunță la ele')) return;
  S.drawer = null; $('#drawer').hidden = true; $('#drawer-bg').hidden = true;
}
$('#drawer-x').onclick = closeDrawer; $('#drawer-bg').onclick = closeDrawer;
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#modal').hidden) { $('#modal-no').click(); return; }
  if (S.drawer) closeDrawer();
});
function drawerHead(p) {
  const deps = (p.deps || []).map(d => { const m = d.match(/^(.+)-(\d+\.\d+\.\d+)$/); return m ? { full: m[1], ver: m[2] } : { full: d, ver: '' }; });
  const c = p.cats || [];
  const where = c.includes('Server-side') ? '<b>Mod de server:</b> îl primește și serverul, iar toți jucătorii trebuie să-l aibă (îl primesc prin lista serverului).'
    : c.includes('Client-side') ? '<b>Mod de client:</b> rămâne doar pe PC-ul tău.'
      : 'Thunderstore nu spune unde rulează. Bifrost ghicește la sync (README / DLL), iar tu poți schimba la Moduri.';
  return `
    <div class="dr-head">${p.icon ? `<img src="${esc(p.icon)}" alt="">` : '<div class="ph"></div>'}
      <div><h2>${esc(pkTitle(p))}</h2><div class="muted">de ${esc(p.owner)} · v${esc(p.ver)}</div>
        <div class="row gap" style="margin-top:12px">${pkButton(p, true)}<button class="btn ghost" data-open="${esc(p.url)}">Pe Thunderstore ↗</button></div></div></div>
    <div class="muted">${esc(p.desc)}</div>
    <div class="dr-stats"><span><b>${fmtNum(p.dl)}</b> descărcări</span><span><b>${fmtNum(p.rating)}</b> aprecieri</span>
      <span>actualizat <b>${esc(new Date(p.updated).toLocaleDateString(LOC()))}</b></span><span><b>${p.size ? (p.size / 1048576).toFixed(1) : '?'} MB</b></span></div>
    <div class="where">${where}</div>
    ${deps.length ? `<div class="dr-section"><h3>Dependențe (${deps.length}) - se instalează automat</h3>${deps.map(d => {
    const have = installedVer(d.full);
    return `<div class="dep ${have ? 'have' : ''}"><span>${esc(d.full)}</span><span>${have ? `✓ ai ${esc(have)}` : `${esc(d.ver)}`}</span></div>`;
  }).join('')}</div>` : ''}
    ${c.length ? `<div class="dr-section"><h3>Categorii</h3><div class="row gap wrap">${c.map(x => `<span class="tag">${esc(x)}</span>`).join('')}</div></div>` : ''}`;
}
async function openDrawer(full) {
  const p = S.catalog?.find(x => x.full === full); if (!p) return;
  S.drawer = full;
  $('#drawer').hidden = false; $('#drawer-bg').hidden = false; $('#drawer').scrollTop = 0;
  $('#drawer-body').innerHTML = `<div id="dr-top">${drawerHead(p)}</div><div class="dr-section"><h3>Descriere</h3><div class="readme" id="dr-readme"><span class="muted">se încarcă...</span></div></div>`;
  const r = await window.vp.act('readme', { owner: p.owner, name: p.name, ver: p.ver });
  if (S.drawer !== full) return;
  const el = $('#dr-readme');
  if (!r.ok) { el.innerHTML = `<span class="muted">README indisponibil (${esc(r.error)}).</span>`; return; }
  el.innerHTML = DOMPurify.sanitize(marked.parse(r.markdown || ''), { FORBID_TAGS: ['style', 'form', 'input', 'iframe'] });
  el.querySelectorAll('a[href]').forEach(a => { a.dataset.open = a.href; a.removeAttribute('href'); a.style.cursor = 'pointer'; });
}
function refreshDrawer() { if (!S.drawer || !S.catalog || /^(nx|cfg):/.test(String(S.drawer))) return; const p = S.catalog.find(x => x.full === S.drawer); const top = $('#dr-top'); if (p && top) top.innerHTML = drawerHead(p); }
$('#drawer').addEventListener('click', e => {
  const b = e.target.closest('[data-install]'); if (b) { installPkg(b.dataset.install); return; }
  const o = e.target.closest('[data-open]'); if (o && /^https:\/\//.test(o.dataset.open)) window.vp.act('open', o.dataset.open);
});

// ---------- config editor (Mods → ⚙): the mod's files in the profile's BepInEx/config, sent to the server ----------
const GEAR = '<svg class="ico" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>';
const CFG = { key: null, title: '', files: [], rel: null, file: null, err: null, changes: new Map(), raw: false, rawText: null, q: '', server: false, side: null, after: null, busy: false };
const cfgDirty = () => CFG.raw ? CFG.rawText !== null && CFG.rawText !== CFG.file?.text : CFG.changes.size > 0;
const cfgEntry = id => { const [si, ei] = id.split('.').map(Number); const sec = CFG.file.parsed.sections[si]; return { sec, e: sec.entries[ei] }; };
async function openConfigDrawer(key, title) {
  S.drawer = `cfg:${key}`;
  Object.assign(CFG, { key, title, files: [], rel: null, file: null, err: null, changes: new Map(), raw: false, rawText: null, q: '', after: null, busy: false });
  $('#drawer').hidden = false; $('#drawer-bg').hidden = false; $('#drawer').scrollTop = 0;
  $('#drawer-body').innerHTML = '<div class="empty">se încarcă...</div>';
  const r = await window.vp.act('modConfigs', key);
  if (S.drawer !== `cfg:${key}`) return;
  if (!r.ok || !r.files.length) { $('#drawer-body').innerHTML = `<div class="empty">${esc(r.error || 'Modul nu are fișiere de configurare (le scrie la prima pornire a jocului).')}</div>`; return; }
  Object.assign(CFG, { files: r.files, server: r.server, side: r.side });
  await loadConfigFile((r.files.find(f => f.kind === 'cfg') || r.files[0]).rel, true);
}
async function loadConfigFile(rel, force) {
  if (!force && cfgDirty() && !await confirmBox('Renunți la modificări?', `Ai modificări nesalvate în ${CFG.rel}.`, 'Renunță la ele')) return;
  const key = S.drawer;
  const r = await window.vp.act('readConfig', rel);
  if (S.drawer !== key) return;
  Object.assign(CFG, { rel, file: r.ok ? r : null, err: r.ok ? null : r.error, changes: new Map(), raw: !(r.ok && r.parsed), rawText: null });
  renderConfig();
}
function cfgRow(si, ei, sec, e) {
  const id = `${si}.${ei}`, v = CFG.changes.has(id) ? CFG.changes.get(id) : e.value;
  let ctl;
  if (e.kind === 'bool') ctl = `<label class="switch"><input type="checkbox" data-cfg="${id}" ${/^true$/i.test(v) ? 'checked' : ''}><span></span></label>`;
  else if (e.kind === 'enum') ctl = `<select class="select" data-cfg="${id}">${[...new Set([...e.values, v])].map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  else ctl = `<input class="txt" data-cfg="${id}" value="${esc(v)}" ${e.kind === 'text' ? '' : 'inputmode="decimal"'} spellcheck="false">`;
  const meta = [e.range ? `<span>${esc(e.range[0])} – ${esc(e.range[1])}</span>` : '',
    e.def !== null && e.def !== v ? `<button class="cfg-def" data-cfg-reset="${id}" title="Pune valoarea implicită">implicit: ${esc(e.def === '' ? '(gol)' : e.def)}</button>` : ''].join('');
  return `<div class="cfg-row ${CFG.changes.has(id) ? 'changed' : ''}" data-row="${id}" data-hay="${esc(`${e.key} ${e.desc} ${sec.name}`.toLowerCase())}">
    <div class="cfg-l"><b>${esc(e.key)}</b>${e.desc ? `<small>${esc(e.desc)}</small>` : ''}</div>
    <div class="cfg-c">${ctl}${meta ? `<div class="cfg-meta">${meta}</div>` : ''}</div></div>`;
}
function renderConfig() {
  const f = CFG.file;
  const dest = !CFG.server ? 'Se salvează în profilul tău.' : CFG.side === 'client'
    ? 'Mod de client: se salvează în profil (și ajunge pe server odată cu celelalte configurări).'
    : 'Se salvează în profil și se trimite imediat pe server.';
  // a few files: buttons; many (EpicLoot, Seasonality...): a list
  const files = CFG.files.length <= 1 ? ''
    : CFG.files.length <= 5 ? `<div class="chips cfg-files no-i18n">${CFG.files.map(x => `<button class="chip ${x.rel === CFG.rel ? 'active' : ''}" data-cfg-file="${esc(x.rel)}">${esc(x.rel)}</button>`).join('')}</div>`
      : `<div class="cfg-files"><select class="select no-i18n" id="cfg-file">${CFG.files.map(x => `<option value="${esc(x.rel)}" ${x.rel === CFG.rel ? 'selected' : ''}>${esc(x.rel)}</option>`).join('')}</select><span class="muted small">${CFG.files.length} fișiere</span></div>`;
  let body;
  if (CFG.err) body = `<div class="empty">${esc(CFG.err)}</div>`;
  else if (CFG.raw) body = `<textarea class="cfg-raw no-i18n" id="cfg-raw" spellcheck="false">${esc(CFG.rawText ?? f.text)}</textarea>`;
  else {
    const secs = f.parsed.sections, open = secs.length <= 4 || !!CFG.q;
    body = secs.map((sec, si) => `<details class="cfg-sec" data-sec="${si}" ${open ? 'open' : ''}><summary class="no-i18n">${esc(sec.name)} <span class="muted">${sec.entries.length}</span></summary>
      <div class="no-i18n">${sec.entries.map((e, ei) => cfgRow(si, ei, sec, e)).join('')}</div></details>`).join('') || '<div class="empty">Fișierul nu are setări.</div>';
  }
  $('#drawer-body').innerHTML = `
    <div class="cfg-head"><h2>${esc(CFG.title)}</h2><div class="muted">${f?.parsed?.plugin ? `<span class="no-i18n">${esc(f.parsed.plugin)}</span> · ` : ''}<span>${dest}</span></div></div>
    ${files}
    <div class="cfg-tools">${f?.parsed && !CFG.raw ? `<input class="txt" id="cfg-q" placeholder="Caută o setare..." value="${esc(CFG.q)}">` : `<span class="muted small no-i18n">${esc(CFG.rel || '')}</span>`}
      ${f?.parsed ? `<div class="seg" id="cfg-mode"><button class="${CFG.raw ? '' : 'on server'}" data-mode="form">Setări</button><button class="${CFG.raw ? 'on server' : ''}" data-mode="raw">Text</button></div>` : ''}</div>
    <div id="cfg-body">${body}</div>
    <div class="cfg-bar" id="cfg-bar"></div>`;
  filterConfig(); renderConfigBar();
}
function filterConfig() {
  if (CFG.raw || !CFG.file?.parsed) return;
  const q = CFG.q.trim().toLowerCase();
  $$('#cfg-body .cfg-sec').forEach(d => {
    let n = 0;
    d.querySelectorAll('.cfg-row').forEach(r => { const hit = !q || r.dataset.hay.includes(q); r.hidden = !hit; n += hit; });
    d.hidden = !n; if (q && n) d.open = true;
    const c = d.querySelector('summary .muted'); if (c) c.textContent = q ? `${n} / ${d.querySelectorAll('.cfg-row').length}` : d.querySelectorAll('.cfg-row').length;
  });
}
function renderConfigBar() {
  const bar = $('#cfg-bar'); if (!bar) return;
  const n = CFG.raw ? (cfgDirty() ? 1 : 0) : CFG.changes.size;
  if (!n && CFG.after) { bar.innerHTML = CFG.after; bar.classList.add('done'); return; }
  bar.classList.remove('done');
  bar.innerHTML = `<span class="${n ? '' : 'muted'}">${n ? (CFG.raw ? 'Text modificat' : `${n} ${n === 1 ? 'modificare nesalvată' : 'modificări nesalvate'}`) : 'Nicio modificare'}</span>
    <div class="row gap"><button class="btn ghost small" id="cfg-discard" ${n ? '' : 'disabled'}>Renunță</button><button class="btn primary ${CFG.busy ? 'working' : ''}" id="cfg-save" ${n && !CFG.busy ? '' : 'disabled'}>${CFG.busy ? 'Salvez...' : 'Salvează'}</button></div>`;
}
function cfgInvalid(e, v) {
  if (e.kind === 'int' && !/^-?\d+$/.test(v.trim())) return 'număr întreg';
  if (e.kind === 'float' && !/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v.trim())) return 'număr (cu punct, ex. 1.5)';
  if (e.range && (e.kind === 'int' || e.kind === 'float') && (Number(v) < e.range[0] || Number(v) > e.range[1])) return `între ${e.range[0]} și ${e.range[1]}`;
  return null;
}
async function saveConfig() {
  if (CFG.busy) return;
  const arg = { rel: CFG.rel, expect: CFG.file.hash };
  if (CFG.raw) arg.text = CFG.rawText;
  else {
    const bad = [];
    arg.changes = [...CFG.changes].map(([id, v]) => {
      const { sec, e } = cfgEntry(id), why = cfgInvalid(e, v);
      $(`#cfg-body [data-row="${id}"]`)?.classList.toggle('invalid', !!why);
      if (why) bad.push(`${e.key}: ${why}`);
      return { section: sec.name, key: e.key, line: e.line, value: e.kind === 'int' || e.kind === 'float' ? v.trim() : v };
    });
    if (bad.length) { toast(`Valori greșite - ${bad.join('; ')}`, 'error'); return; }
  }
  CFG.busy = true; renderConfigBar();
  const r = await window.vp.act('saveConfig', arg);
  CFG.busy = false;
  if (!r.ok) { toast(r.error, 'error'); if (/s-a schimbat|altă versiune/.test(r.error)) await loadConfigFile(CFG.rel, true); else renderConfigBar(); return; }
  CFG.after = r.pushed
    ? `<span>Salvat și trimis pe server. Modurile cu sincronizare de configurări îl aplică imediat; restul, la restart.</span>${r.canRestart ? '<button class="btn small" id="cfg-restart">Repornește serverul când e gol</button>' : ''}`
    : r.later ? '<span>Salvat. Ajunge pe server imediat ce termin ce lucrez acum.</span>'
      : r.error ? `<span>Salvat în profil, dar nu l-am putut trimite pe server: ${esc(r.error)}</span>`
        : r.unchanged ? '<span class="muted">Nimic de salvat.</span>' : '<span>Salvat în profil.</span>';
  const keepQ = CFG.q, open = $$('#cfg-body .cfg-sec').filter(d => d.open).map(d => d.dataset.sec), wasRaw = CFG.raw;
  await loadConfigFile(CFG.rel, true);
  if (wasRaw && CFG.file?.parsed && !CFG.raw) { CFG.raw = true; renderConfig(); }
  CFG.q = keepQ; const qi = $('#cfg-q'); if (qi) qi.value = keepQ;
  $$('#cfg-body .cfg-sec').forEach(d => { if (open.includes(d.dataset.sec)) d.open = true; });
  filterConfig();
}
function cfgSet(id, v) {
  const { e } = cfgEntry(id);
  if (v === e.value) CFG.changes.delete(id); else CFG.changes.set(id, v);
  CFG.after = null;
  $(`#cfg-body [data-row="${id}"]`)?.classList.toggle('changed', CFG.changes.has(id));
  renderConfigBar();
}
$('#drawer-body').addEventListener('change', e => {
  if (e.target.id !== 'cfg-file' || !String(S.drawer).startsWith('cfg:')) return;
  const rel = e.target.value; e.target.value = CFG.rel; CFG.after = null; loadConfigFile(rel);
});
$('#drawer-body').addEventListener('input', e => {
  if (!String(S.drawer).startsWith('cfg:') || e.target.id === 'cfg-file') return;
  if (e.target.id === 'cfg-q') { CFG.q = e.target.value; filterConfig(); return; }
  if (e.target.id === 'cfg-raw') { CFG.rawText = e.target.value; CFG.after = null; renderConfigBar(); return; }
  const id = e.target.dataset?.cfg; if (!id) return;
  cfgSet(id, e.target.type === 'checkbox' ? String(e.target.checked) : e.target.value);
});
$('#drawer-body').addEventListener('click', async e => {
  if (!String(S.drawer).startsWith('cfg:')) return;
  const f = e.target.closest('[data-cfg-file]'); if (f) { if (f.dataset.cfgFile !== CFG.rel) { CFG.after = null; loadConfigFile(f.dataset.cfgFile); } return; }
  const rs = e.target.closest('[data-cfg-reset]');
  if (rs) {
    const id = rs.dataset.cfgReset, { sec, e: en } = cfgEntry(id);
    cfgSet(id, en.def);
    const [si, ei] = id.split('.').map(Number), row = $(`#cfg-body [data-row="${id}"]`);
    if (row) { const tmp = document.createElement('div'); tmp.innerHTML = cfgRow(si, ei, sec, en); row.replaceWith(tmp.firstElementChild); }
    return;
  }
  const md = e.target.closest('#cfg-mode button');
  if (md) {
    const raw = md.dataset.mode === 'raw'; if (raw === CFG.raw) return;
    if (cfgDirty() && !await confirmBox('Renunți la modificări?', 'Ca să schimbi modul de editare, salvează sau renunță la modificări.', 'Renunță la ele')) return;
    Object.assign(CFG, { raw, rawText: null, changes: new Map() }); renderConfig(); return;
  }
  if (e.target.closest('#cfg-discard')) { Object.assign(CFG, { rawText: null, changes: new Map() }); renderConfig(); return; }
  if (e.target.closest('#cfg-save')) { saveConfig(); return; }
  const rb = e.target.closest('#cfg-restart');
  if (rb) {
    rb.disabled = true; rb.classList.add('working'); rb.textContent = 'Repornesc...';
    const r = await window.vp.act('restartIdle');
    toast(!r.ok ? r.error : r.postponed ? 'Sunt jucători online - serverul repornește când se golește.' : r.manualRestart ? 'Repornește serverul din panoul hostului.' : r.joinCode ? `Server repornit - join code ${r.joinCode}` : 'Server repornit.', r.ok ? 'ok' : 'error');
    if (rb.isConnected) { rb.classList.remove('working'); rb.textContent = r.ok && !r.postponed ? 'Repornit' : 'Repornește serverul când e gol'; rb.disabled = r.ok && !r.postponed; }
  }
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && String(S.drawer).startsWith('cfg:') && cfgDirty()) { e.preventDefault(); saveConfig(); }
});

// ---------- player: home ----------
const fmtMB = b => b >= 1048576 ? `${(b / 1048576).toFixed(b >= 1e8 ? 0 : 1)} MB` : `${Math.round(b / 1024)} KB`;
function renderPlayer() {
  const P = S.player; if (!P) return;
  const m = P.manifest, srv = m?.server || {};
  // admins and personal profiles play their own profile: no list needed
  const own = S.settings.isAdmin || !S.settings.server?.list;
  if (own) { srv.name = S.settings.server?.name; srv.joinCode = S.status?.joinCode || srv.joinCode; }
  $('#pl-name').textContent = srv.name || S.settings.server?.name || 'Server';
  $('#pl-world').textContent = [srv.world, m?.updatedAt ? `lista actualizată ${ago(m.updatedAt)}` : ''].filter(Boolean).join(' · ');
  $('#brand-sub').textContent = S.settings.server?.name || srv.name || 'Valheim';
  const pill = $('#pl-pill'); pill.className = 'status-pill';
  const need = (P.plan?.install.length || 0) + (P.plan?.remove.length || 0);
  if (own && !S.job) { $('#pl-state').textContent = 'gata de joc'; pill.classList.add('ok'); }
  else if (!m) { $('#pl-state').textContent = P.error ? 'fără listă' : 'se încarcă...'; pill.classList.add(P.error ? 'err' : 'busy'); }
  else if (S.job) { $('#pl-state').textContent = 'lucrez...'; pill.classList.add('busy'); }
  else if (need) { $('#pl-state').textContent = 'are nevoie de update'; pill.classList.add('warn'); }
  else { $('#pl-state').textContent = 'gata de joc'; pill.classList.add('ok'); }
  $('#pl-sub').textContent = P.error && m ? `(listă din cache: ${P.error})` : '';
  const code = srv.joinCode || null;
  $('#pl-code').textContent = code || '——————';
  $('#pl-code-box').classList.toggle('off', !code);
  $('#pl-code2').textContent = code || '–';
  $('#pl-addr').textContent = srv.address || S.settings.joinTarget || (S.settings.isAdmin ? 'necunoscută încă (apare după ce pornește serverul)' : 'cere-l adminului (sau intră cu join code)');
  const direct = S.settings.directJoin && !!S.settings.joinTarget;
  $('#pl-howto-direct').hidden = !direct; $('#pl-howto-manual').hidden = direct;
  $('#pl-game').innerHTML = P.game?.game ? esc(P.game.game) : '<span style="color:var(--red)">negăsit</span> · <a href="#" data-page-link="settings">alege folderul</a>';

  const btn = $('#btn-play'), g = S.game || {};
  // pressed -> spinner and locked until the game is up; while it runs no second copy can be started
  const starting = S.playPressed || g.launching || (S.job && S.job.kind === 'play');
  btn.disabled = !!S.job || starting || g.running || (!m && !own);
  btn.classList.toggle('working', !!(S.job || starting));
  btn.classList.toggle('running', !!g.running && !starting);
  btn.textContent = g.running && !starting ? 'Valheim rulează' : starting ? (S.job?.kind === 'play' ? 'Se pregătește...' : 'Pornește...') : S.job ? 'Lucrez...' : 'JOACĂ';
  $('#pl-play-note').textContent = !m ? '' : need ? `întâi: ${P.plan.install.length} de instalat${P.plan.remove.length ? `, ${P.plan.remove.length} de scos` : ''}${P.plan.bytes ? ` (~${fmtMB(P.plan.bytes)})` : ''}` : 'modurile sunt la zi';

  // mods summary
  const ring = $('#pl-ring');
  const personal = !S.settings.isAdmin && !S.settings.server?.list;
  $$('#page-home [data-act="updateMods"], #page-home [data-act="refreshList"]').forEach(b => { b.hidden = personal; });
  $('#pl-code-box').hidden = personal;
  if (personal) { ring.className = 'ring ok'; $('#pl-mods-title').textContent = `Profil personal: ${P.installed} ${P.installed === 1 ? 'pachet' : 'pachete'}`; $('#pl-mods-sub').textContent = 'Modurile le alegi tu, din Descoperă.'; }
  else if (!m) { ring.className = 'ring busy'; $('#pl-mods-title').textContent = P.error ? 'Nu am putut lua lista serverului' : 'Iau lista serverului...'; $('#pl-mods-sub').textContent = P.error || ''; }
  else if (need) { ring.className = 'ring wait'; $('#pl-mods-title').textContent = `${P.plan.install.length} moduri de instalat / actualizat`; $('#pl-mods-sub').textContent = 'Se fac singure când apeși JOACĂ.'; }
  else { ring.className = 'ring ok'; $('#pl-mods-title').textContent = `Toate cele ${P.required} moduri ale serverului sunt instalate`; $('#pl-mods-sub').textContent = `${P.installed} pachete în profil`; }
  const plan = $('#pl-plan');
  plan.hidden = !need || !!S.job;
  if (P.plan) plan.textContent = [...P.plan.install.slice(0, 12).map(x => `${x.have ? '↑' : '+'} ${x.title || x.key} ${x.have ? `${x.have} → ` : ''}${x.ver}`),
    ...(P.plan.install.length > 12 ? [`... și încă ${P.plan.install.length - 12}`] : []), ...P.plan.remove.map(k => `− ${k}`)].join('\n');

  // recommended
  const rec = m?.recommended || [], nx = (m?.nexus || []).filter(n => !n.required);
  $('#pl-rec-card').hidden = !rec.length && !nx.length;
  const iconOf = full => P.icons?.[full] || S.catalog?.find(p => p.full === full)?.icon;
  $('#pl-rec').innerHTML = [...rec.map(r => ({ key: r.full, title: r.title || r.full, sub: r.full.split('-')[0] + ' · ' + r.ver, on: !!P.recommended[r.full], icon: iconOf(r.full) })),
  ...nx.map(n => ({ key: n.key, title: n.title, sub: `Nexus · ${n.version || ''}`, on: !!P.nexusChosen[n.key], nexus: true }))].map(r => `
    <div class="rec">${r.icon ? `<img src="${esc(r.icon)}" alt="" loading="lazy">` : '<div class="ph"></div>'}<div><b>${esc(r.title)}</b><small>${esc(r.sub)}</small></div>
      <label class="switch"><input type="checkbox" data-rec="${esc(r.key)}" ${r.nexus ? 'data-nx="1"' : ''} ${r.on ? 'checked' : ''}><span></span></label></div>`).join('');

  // Nexus files waiting for a click on the site
  const nw = $('#pl-nexus');
  if (P.nexusWaiting?.length) {
    nw.hidden = false;
    nw.innerHTML = `<span><b>De pe Nexus:</b> pe pagina care s-a deschis apasă <b>„Mod Manager Download”</b> (sau „Slow download”) pentru: ${P.nexusWaiting.map(n => esc(n.title)).join(', ')}. Bifrost îl instalează singur.</span>
      <button class="btn small" data-nxpage="${P.nexusWaiting[0].modId}" data-file="${P.nexusWaiting[0].fileId}">Deschide pagina</button>`;
  } else nw.hidden = true;
  const er = $('#pl-error');
  er.hidden = !S.lastPlayError; er.textContent = S.lastPlayError || '';
}
function renderProgress(p) {
  const c = $('#pl-progress');
  if (!p) { c.hidden = true; return; }
  c.hidden = false;
  $('#pg-count').textContent = p.total ? `${Math.min(p.done + 1, p.total)} / ${p.total}` : '';
  const frac = p.total ? (p.done + (p.totalBytes ? p.bytes / p.totalBytes : 0)) / p.total : 0;
  $('#pg-bar').style.width = `${Math.round(Math.min(1, frac) * 100)}%`;
  $('#pg-text').textContent = `${p.text || ''}${p.totalBytes ? ` · ${fmtMB(p.bytes)} / ${fmtMB(p.totalBytes)}` : ''}`;
}
$('#btn-play').onclick = async () => {
  if (S.playPressed) return;
  // lock the button right away, before main answers
  S.playPressed = true; S.lastPlayError = null; renderPlayer();
  try {
    const r = await window.vp.act('play');
    if (!r.ok) { S.lastPlayError = r.error; toast(r.error, 'error'); }
  } finally { S.playPressed = false; renderPlayer(); }
};
$('#pl-copy-code').onclick = async () => { const c = S.player?.manifest?.server?.joinCode; if (!c) return; await window.vp.act('copy', c); toast(`Join code copiat: ${c}`, 'ok'); };
$('#pl-rec').addEventListener('change', e => { const i = e.target.closest('[data-rec]'); if (i) window.vp.act('setRecommended', { key: i.dataset.rec, on: i.checked, nexus: !!i.dataset.nx }); });
document.addEventListener('click', e => { const b = e.target.closest('[data-nxpage]'); if (b) window.vp.act('nexusPage', { modId: +b.dataset.nxpage, fileId: +b.dataset.file }); });

// ---------- player: my mods ----------
function renderPlayerMods() {
  if (S.settings.isAdmin) return;
  const mods = S.profile.mods || [];
  const groups = [['required', 'Pentru server', 'Le cere serverul - se instalează și se actualizează singure.'], ['recommended', 'Recomandate', 'Alese de tine din recomandările adminului.'],
    ['user', 'Adăugate de tine', 'Din Descoperă sau de pe Nexus.'], ['dep', 'Dependențe', 'Cerute de alte moduri - se scot singure când nu mai e nevoie de ele.']];
  $('#pm-sub').textContent = `Profilul Bifrost · ${mods.length} pachete`;
  const iconOf = full => S.catalog?.find(p => p.full === full)?.icon;
  $('#pm-list').innerHTML = groups.map(([role, title, sub]) => {
    const list = mods.filter(m => m.role === role).sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
    if (!list.length) return '';
    return `<div class="pm-group"><h2>${title} <span class="muted small" style="text-transform:none;letter-spacing:0">${list.length} · ${sub}</span></h2><div class="mod-list">${list.map(m => {
      const icon = m.icon || iconOf(m.name);
      return `<div class="mod">${icon ? `<img class="mod-icon" src="${esc(icon)}" alt="" loading="lazy">` : `<div class="mod-icon">${esc((m.title || '?')[0])}</div>`}
        <div class="mod-body"><div class="mod-title"><a>${esc((m.title || m.name).replace(/_/g, ' '))}</a><span class="mod-author">${esc(m.source === 'nexus' ? 'Nexus' : m.name.split('-')[0])}</span><span class="mod-ver">${esc(m.version)}</span>${hasUpdate(m) && role !== 'required' ? `<button class="badge update" data-update="${esc(m.name)}" data-ver="${esc(S.updates[m.name].latest)}">update ${esc(S.updates[m.name].latest)} ↻</button>` : ''}</div>
        <div class="mod-desc">${m.size ? fmtMB(m.size) : ''}</div></div>
        ${role === 'required' ? '<span class="badge lock">cerut de server</span>' : role === 'dep' ? '' : `<button class="btn small danger" data-remove="${esc(m.name)}">Dezinstalează</button>`}</div>`;
    }).join('')}</div></div>`;
  }).join('') || '<div class="empty card">Niciun mod încă - apasă JOACĂ și Bifrost instalează modurile serverului.</div>';
}
$('#pm-list').addEventListener('click', async e => {
  const up = e.target.closest('[data-update]'); if (up) { installPkg(up.dataset.update, up.dataset.ver); return; }
  const b = e.target.closest('[data-remove]'); if (!b) return;
  if (!await confirmBox('Dezinstalezi?', b.dataset.remove, 'Dezinstalează')) return;
  const r = await window.vp.act('remove', b.dataset.remove);
  toast(r.ok ? 'Dezinstalat.' : r.error, r.ok ? 'ok' : 'error');
});

// ---------- admin: list for players ----------
function renderList() {
  const l = S.list || {}, pill = $('#list-pill');
  pill.className = `status-pill ${l.busy ? 'busy' : l.ok === false || l.error ? 'warn' : l.ok ? 'ok' : ''}`;
  $('#list-pill-text').textContent = l.busy ? 'public...' : l.error ? 'nepublicată' : l.ok ? `publicată ${ago(l.at)}` : 'încă nepublicată';
  const srv = S.settings.server || {};
  $('#list-sub').textContent = l.error || (srv.list ? `Prietenii deschid invitația în Bifrost și primesc exact modurile serverului${S.settings.autoPublish ? ' - lista se publică singură după fiecare sincronizare și la join code nou.' : '.'}`
    : 'Lista se creează la prima publicare (un Gist privat pe contul tău GitHub) - apoi primești linkul de invitație.');
  $('#invite-box').hidden = !srv.list;
  if (srv.list) { $('#inv-link').textContent = srv.inviteLink; $('#inv-code').textContent = srv.invite; }
  $('#btn-publish-list').disabled = !!l.busy;
}
const listUrl = l => !l ? null : l.kind === 'gist' ? `https://gist.github.com/${l.id}` : l.kind === 'github' ? `https://github.com/${l.repo}/blob/main/${l.path || 'server.json'}` : l.url;
$('#btn-list-open').onclick = () => { const u = listUrl(S.settings.server?.list); if (u) window.vp.act('open', u); else toast('Lista nu e publicată încă.'); };
const shareText = () => { const v = S.settings.server; return `Hai pe serverul nostru de Valheim „${v.name}”!\n1. Instalează Bifrost: https://github.com/FlorinCamarut1/bifrost/releases/latest\n2. Deschide invitația: ${v.inviteLink}\n   (sau în Bifrost: Adaugă server → codul ${v.invite})\n3. Apasă JOACĂ - modurile se instalează singure.`; };
$('#btn-share-text').onclick = async () => { await window.vp.act('copy', shareText()); toast('Mesajul e copiat - lipește-l pe Discord.', 'ok'); };
$('#btn-copy-invite').onclick = async () => { const v = S.settings.server; if (!v?.inviteLink) return toast('Serverul nu are încă o listă publicată.', 'error'); await window.vp.act('copy', shareText()); toast('Invitația e copiată.', 'ok'); };
$('#btn-export-code').onclick = async () => {
  const withCfg = await confirmBox('Cod de profil Thunderstore', 'Pun în cod și configurările modurilor? (De obicei da, ca prietenii să aibă aceleași setări.)', 'Da, cu configurări');
  toast('Generez codul...');
  const r = await window.vp.act('exportCode', { configs: withCfg });
  if (!r.ok) return toast(r.error, 'error');
  await window.vp.act('copy', r.code);
  toast(`Cod copiat: ${r.code} - în r2modman / TMM: Import / update → From code.`, 'ok');
};
$('#btn-remove-server').onclick = async () => {
  const v = S.settings.server; if (!v) return;
  if (!await confirmBox(`Ștergi „${v.name}” din Bifrost?`, 'Profilul lui de moduri și setările lui dispar de pe PC-ul tău. Serverul în sine și lista publicată rămân neatinse.', 'Șterge')) return;
  const r = await window.vp.act('removeServer', v.id);
  if (!r.ok) toast(r.error, 'error');
};

// ---------- servers: switcher, welcome, wizard ----------
const roleName = r => r === 'admin' ? 'admin' : 'jucător';
function renderServers() {
  const st = S.settings, list = st.servers || [], cur = st.server;
  document.body.classList.toggle('no-server', !cur);
  $('#srv-cur-badge').textContent = cur ? (cur.name || '?')[0].toUpperCase() : '+';
  $('#srv-cur-name').textContent = cur ? cur.name : 'Niciun server';
  $('#srv-cur-role').textContent = cur ? (cur.role === 'admin' ? 'admin' : cur.list ? 'jucător' : 'profil personal') : 'adaugă unul';
  $('#srv-menu').innerHTML = list.map(x => `<button class="srv-item ${cur && x.id === cur.id ? 'on' : ''}" data-switch="${esc(x.id)}"><span class="srv-badge">${esc((x.name || '?')[0].toUpperCase())}</span>${esc(x.name)}<small>${roleName(x.role)}</small></button>`).join('')
    + `${list.length ? '<hr>' : ''}<button class="srv-item" data-menu="join">＋ Am o invitație</button><button class="srv-item" data-menu="create">＋ Creează server</button><button class="srv-item" data-menu="local">＋ Profil personal</button>`;
  if (cur) {
    const c = cur.conn;
    $('#set-conn').textContent = !c ? 'fără conexiune - doar lista' : c.type === 'ssh-docker' ? `${c.host}, Docker „${c.container}”` : c.type === 'ssh' ? `SSH ${c.host}: ${c.pluginsDir}` : c.type === 'local' ? `acest PC: ${c.pluginsDir}` : `FTP ${c.host}: ${c.pluginsDir}`;
    $('#set-invite').textContent = cur.inviteLink ? `${cur.invite}` : 'lista nu e publicată încă';
    $('#set-srv-title').textContent = `Serverul acesta: ${cur.name}`;
  }
  const gh = $('#gh-state');
  if (gh) gh.innerHTML = st.githubUser ? `<span style="color:var(--green)">✓ Conectat ca <b>${esc(st.githubUser)}</b></span> - lista e un Gist privat pe contul tău.` : 'Pentru publicarea listei (un Gist privat pe contul tău). Merge și GitHub CLI (<code>gh</code>), dacă e logat.';
  $('#btn-gh-clear').hidden = !st.githubUser; $('#btn-gh-login').hidden = !!st.githubUser || !st.githubLogin;
}
$('#srv-current').onclick = e => { e.stopPropagation(); $('#srv-menu').hidden = !$('#srv-menu').hidden; };
document.addEventListener('click', e => { if (!e.target.closest('#srv-switch')) $('#srv-menu').hidden = true; });
$('#srv-menu').addEventListener('click', async e => {
  const sw = e.target.closest('[data-switch]'), m = e.target.closest('[data-menu]');
  $('#srv-menu').hidden = true;
  if (sw && sw.dataset.switch !== S.settings.server?.id) await window.vp.act('switchServer', sw.dataset.switch);
  if (m?.dataset.menu === 'join') { const code = await confirmBox('Adaugă server', 'Lipește linkul sau codul de invitație primit de la adminul serverului.', 'Adaugă', ''); if (code) joinServer(code); }
  if (m?.dataset.menu === 'create') openWizard('create');
  if (m?.dataset.menu === 'local') openWizard('local');
});
async function joinServer(code) {
  toast('Citesc lista serverului...');
  const r = await window.vp.act('addServer', code);
  toast(r.ok ? (r.existed ? 'Serverul era deja adăugat - l-am deschis.' : `Server adăugat: ${r.name} (${r.required} moduri). Apasă JOACĂ.`) : r.error, r.ok ? 'ok' : 'error');
}
$('#wl-join').onclick = () => { const v = $('#wl-invite').value.trim(); if (v) joinServer(v); };
$('#wl-invite').addEventListener('keydown', e => { if (e.key === 'Enter') $('#wl-join').click(); });

let wizMode = 'create';
function openWizard(mode) {
  wizMode = mode;
  const w = $('#wiz'), cur = S.settings.server;
  $('#wiz-title').textContent = { create: 'Creează server', local: 'Profil personal', import: 'Importă moduri în profil', conn: 'Conexiunea la server' }[mode];
  $('#wiz-ok').textContent = { create: 'Creează', local: 'Creează', import: 'Importă', conn: 'Salvează' }[mode];
  w.querySelector('[data-sec="name"]').hidden = !(mode === 'create' || mode === 'local');
  w.querySelector('[data-sec="world"]').hidden = mode !== 'create';
  w.querySelector('[data-sec="conn"]').hidden = !(mode === 'create' || mode === 'conn');
  w.querySelector('[data-sec="source"]').hidden = mode === 'conn';
  w.querySelector('[data-src="server"]').hidden = mode === 'local' || (mode === 'import' && !cur?.conn);
  $('#wiz-note').textContent = mode === 'create' ? (S.settings.githubUser || S.settings.hasGithubToken ? '' : 'Lista pentru prieteni se publică după ce te conectezi la GitHub (Setări → Conturi) sau dacă ai GitHub CLI logat.') : '';
  $('#wz-test-res').textContent = '';
  if (mode === 'conn' && cur?.conn) {
    const c = cur.conn;
    $('#wz-type').value = c.type; $('#wz-host').value = c.host || ''; $('#wz-port').value = c.port || ''; $('#wz-container').value = c.container || '';
    $('#wz-fhost').value = c.host || ''; $('#wz-fport').value = c.port || ''; $('#wz-fuser').value = c.user || ''; $('#wz-fsecure').checked = !!c.secure;
    $('#wz-plugins').value = c.pluginsDir || ''; $('#wz-config').value = c.configDir || ''; $('#wz-restart').value = c.restartCmd || '';
  }
  wizType();
  window.vp.act('localProfiles').then(r => {
    $('#wz-local').innerHTML = (r.profiles || []).map(p => `<option value="${esc(p.dir)}">${esc(p.manager)} - ${esc(p.name)} (${p.mods} moduri${p.manual ? `, ${p.manual} manuale` : ''})</option>`).join('') || '<option value="">(niciun profil găsit)</option>';
  });
  w.hidden = false;
  setTimeout(() => $(mode === 'create' || mode === 'local' ? '#wz-name' : '#wz-type').focus(), 50);
}
function wizType() {
  const t = $('#wz-type').value;
  $$('#wiz [data-for]').forEach(el => { el.hidden = !el.dataset.for.split(' ').includes(t); });
  const ph = { 'ssh-docker': ['/config/valheimplus/plugins', '/config/valheimplus'], ssh: ['/home/steam/valheim/BepInEx/plugins', '/home/steam/valheim/BepInEx/config'], local: ['C:\\valheim-server\\BepInEx\\plugins', 'C:\\valheim-server\\BepInEx\\config'], ftp: ['/BepInEx/plugins', '/BepInEx/config'] }[t];
  if (ph) { $('#wz-plugins').placeholder = ph[0]; $('#wz-config').placeholder = ph[1]; }
}
$('#wz-type').addEventListener('change', wizType);
$$('#wiz input[name="wz-src"]').forEach(r => r.addEventListener('change', () => { const v = $('#wiz input[name="wz-src"]:checked').value; $('#wz-local').hidden = v !== 'local'; $('#wz-code').hidden = v !== 'code'; }));
function wizConn() {
  const t = $('#wz-type').value;
  if (t === 'none') return null;
  const c = { type: t };
  if (t === 'ssh-docker' || t === 'ssh') { c.host = $('#wz-host').value.trim(); if ($('#wz-port').value.trim()) c.port = +$('#wz-port').value; }
  if (t === 'ssh-docker') c.container = $('#wz-container').value.trim() || 'valheim';
  if (t === 'ftp') { c.host = $('#wz-fhost').value.trim(); c.user = $('#wz-fuser').value.trim(); c.secure = $('#wz-fsecure').checked; if ($('#wz-fport').value.trim()) c.port = +$('#wz-fport').value; }
  const pl = $('#wz-plugins').value.trim(), cf = $('#wz-config').value.trim(), rs = $('#wz-restart').value.trim();
  if (pl) c.pluginsDir = pl; if (cf) c.configDir = cf; if (rs && (t === 'ssh' || t === 'local')) c.restartCmd = rs;
  if (t !== 'ssh-docker' && (!c.pluginsDir || !c.configDir)) throw new Error('Completează folderele de pluginuri și de configurări.');
  if ((t === 'ssh-docker' || t === 'ssh' || t === 'ftp') && !c.host) throw new Error('Completează hostul.');
  return c;
}
$('#wz-test').onclick = async () => {
  let c; try { c = wizConn(); } catch (e) { $('#wz-test-res').textContent = e.message; return; }
  if (!c) return;
  $('#wz-test-res').textContent = 'testez...';
  const r = await window.vp.act('testConnection', { conn: c, secret: $('#wz-fpass').value || undefined });
  $('#wz-test-res').innerHTML = !r.ok ? `<span style="color:var(--red)">${esc(r.error)}</span>`
    : `<span style="color:var(--green)">✓ conectat</span> · pluginuri: ${r.plugins ? `da${r.mods != null ? ` (${r.mods})` : ''}` : '<b>nu găsesc folderul</b>'} · configurări: ${r.config ? 'da' : '<b>nu găsesc folderul</b>'}`;
};
$('#wiz-cancel').onclick = () => { $('#wiz').hidden = true; };
$('#wiz-ok').onclick = async () => {
  const srcKind = $('#wiz input[name="wz-src"]:checked').value;
  const source = srcKind === 'local' ? { kind: 'local', dir: $('#wz-local').value } : srcKind === 'code' ? { kind: 'code', code: $('#wz-code').value.trim() } : { kind: srcKind };
  if (source.kind === 'local' && !source.dir) return toast('Alege un profil.', 'error');
  if (source.kind === 'code' && !source.code) return toast('Lipește codul de profil.', 'error');
  let conn = null;
  try { if (wizMode === 'create' || wizMode === 'conn') conn = wizConn(); } catch (e) { return toast(e.message, 'error'); }
  const secret = $('#wz-fpass').value || undefined;
  $('#wiz-ok').disabled = true;
  try {
    if (wizMode === 'conn') { await window.vp.act('setConnection', { conn, secret }); toast('Conexiunea e salvată.', 'ok'); }
    else if (wizMode === 'import') { $('#wiz').hidden = true; toast('Import...'); const r = await window.vp.act('importInto', source); toast(r.ok ? `Import gata: ${r.count} pachete.` : r.error, r.ok ? 'ok' : 'error'); }
    else {
      const name = $('#wz-name').value.trim();
      if (!name) return toast('Dă-i un nume.', 'error');
      $('#wiz').hidden = true; toast(wizMode === 'create' ? 'Creez serverul și import modurile...' : 'Creez profilul...');
      const r = await window.vp.act('createServer', { name, world: $('#wz-world').value.trim(), conn: wizMode === 'create' ? conn : null, secret, source, personal: wizMode === 'local' });
      toast(r.ok ? `Gata: ${r.count} pachete în profil.${wizMode === 'create' && conn ? ' Pun modurile pe server...' : ''}` : r.error, r.ok ? 'ok' : 'error');
    }
    $('#wiz').hidden = true;
  } finally { $('#wiz-ok').disabled = false; }
};
document.addEventListener('click', e => { const w = e.target.closest('[data-wizard]'); if (w) openWizard(w.dataset.wizard); });

// ---------- GitHub account ----------
$('#btn-gh-login').onclick = async () => {
  const r = await window.vp.act('githubLogin');
  if (!r.ok) return toast(r.error, 'error');
  await window.vp.act('copy', r.code);
  confirmBox('Conectare la GitHub', `S-a deschis ${r.uri}. Introdu codul ${r.code} (e deja copiat) și apasă Authorize. Bifrost află singur când ai terminat.`, 'OK');
};
$('#btn-gh-token').onclick = async () => {
  const t = await confirmBox('Token GitHub', 'Un token „classic” cu permisiunea „gist” (github.com → Settings → Developer settings → Personal access tokens). E salvat criptat.', 'Salvează', '');
  if (!t) return;
  const r = await window.vp.act('setGithubToken', t);
  toast(r.ok ? `Conectat la GitHub ca ${r.user}.` : r.error, r.ok ? 'ok' : 'error');
};
$('#btn-gh-clear').onclick = async () => { await window.vp.act('setGithubToken', null); toast('Deconectat de la GitHub.'); };

// ---------- app update ----------
function renderAppUpdate() {
  const u = S.appUpdate, el = $('#app-update');
  // the Update card in Settings
  $('#upd-title').textContent = `Bifrost ${u?.current || S.settings.version || ''}`;
  $('#upd-state').textContent = !u ? 'se verifică...' : u.error ? `nu am putut verifica: ${u.error}`
    : u.ready ? `Versiunea ${u.version} e descărcată - repornește ca s-o folosești.`
      : u.downloading ? `Se descarcă versiunea ${u.version}...`
        : u.installer ? (u.source ? `Versiunea ${u.version} e disponibilă. Rulezi din sursă: ia varianta portabilă de pe GitHub ca să primești update-uri automate.` : `Versiunea ${u.version} are nevoie de installer-ul nou.`)
          : `Ai ultima versiune · verificat ${ago(u.checkedAt)}`;
  $('#btn-upd-go').hidden = !u?.ready;
  $('#btn-upd-dl').hidden = !u?.installer;
  if (!u || u.upToDate || u.error) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = u.installer ? `<b>Bifrost ${esc(u.version)}</b> e disponibil.<button class="btn small primary" id="btn-app-dl">Descarcă</button>`
    : u.ready ? `<b>Bifrost ${esc(u.version)}</b> e gata.<button class="btn small primary" id="btn-app-update">Repornește și actualizează</button>` : `Se descarcă Bifrost ${esc(u.version)}...`;
  const dl = $('#btn-app-dl'); if (dl) dl.onclick = () => window.vp.act('open', u.page);
  const b = $('#btn-app-update'); if (b) b.onclick = () => window.vp.installUpdate();
}

// ---------- language: the UI is written in Romanian; English (the default) is applied to whatever reaches the screen ----------
let i18nObs = null;
function applyLang() {
  if (window.vp.platform === 'linux') $('#lbl-autostart').textContent = 'Pornește la login';
  const en = (S.settings.lang || 'en') === 'en', t = window.bifrostI18n.t;
  document.documentElement.lang = en ? 'en' : 'ro';
  if (!en) { if (i18nObs) { i18nObs.disconnect(); i18nObs = null; location.reload(); } return; }
  const fix = node => {
    if (node.nodeType === 3) { const v = t(node.nodeValue); if (v !== node.nodeValue) node.nodeValue = v; return; }
    if (node.nodeType !== 1 || node.tagName === 'SCRIPT' || node.tagName === 'STYLE' || node.id === 'log' || node.id === 'mini-log' || node.classList?.contains('readme') || node.classList?.contains('no-i18n')) return;
    for (const at of ['placeholder', 'title']) { const v = node.getAttribute(at); if (v) { const n = t(v); if (n !== v) node.setAttribute(at, n); } }
    for (const c of node.childNodes) fix(c);
  };
  fix(document.body);
  if (!i18nObs) {
    i18nObs = new MutationObserver(list => { for (const m of list) { if (m.type === 'characterData') fix(m.target); else m.addedNodes.forEach(fix); } });
    i18nObs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
}

$('#btn-upd-check').onclick = async () => { $('#btn-upd-check').disabled = true; $('#upd-state').textContent = 'se verifică...'; await window.vp.act('checkAppUpdate'); $('#btn-upd-check').disabled = false; };
$('#btn-upd-go').onclick = () => window.vp.installUpdate();
$('#btn-upd-dl').onclick = () => window.vp.act('open', S.appUpdate?.page || 'https://github.com/FlorinCamarut1/bifrost/releases/latest');

// ---------- events from main ----------
window.vp.on((ch, d) => {
  if (ch === 'status') { S.status = d; renderStatus(); }
  else if (ch === 'mods') { S.profile = d; renderMods(); renderWatch(); renderBrowse(false); refreshDrawer(); renderPlayerMods(); }
  else if (ch === 'player') { S.player = d; renderPlayer(); renderSettingsGame(); }
  else if (ch === 'progress') renderProgress(d);
  else if (ch === 'game') { S.game = d; renderPlayer(); }
  else if (ch === 'nexusPending') { S.nx.pending = d; window.vp.act('nexusInstalled').then(r => { S.nx.installed = r.installed; if (S.src === 'nx') renderNexus(); if (S.drawer && S.drawer.startsWith('nx:')) openNexusDrawer(S.nxDrawer.modId, true); }); }
  else if (ch === 'list') { S.list = d; renderList(); }
  else if (ch === 'appUpdate') { S.appUpdate = d; renderAppUpdate(); }
  else if (ch === 'job') { S.job = d; renderWatch(); renderMods(); renderPlayer(); }
  else if (ch === 'watch') { S.watch = d; renderWatch(); }
  else if (ch === 'log') addLog(d);
  else if (ch === 'updates') { S.updates = d; renderMods(); }
  else if (ch === 'modpack') { S.modpack = d; renderModpack(); }
  else if (ch === 'settings') { S.settings = d; applyLang(); renderSettings(); renderWatch(); renderModpack(); renderStatus(); renderList(); renderPlayer(); }
  else if (ch === 'toast') toast(d.text, d.kind);
  else if (ch === 'installing') { S.installing = d; renderMods(); renderBrowse(false); refreshDrawer(); }
  else if (ch === 'catalogState') { S.catalogBusy = d.busy; if (d.fetched) S.catalogFetched = d.fetched; renderBrowseSub(); }
});

(async () => {
  const d = await window.vp.init();
  Object.assign(S, { settings: d.settings, profile: d.profile, status: d.status, job: d.job, watch: d.watch, updates: d.updates, modpack: d.modpack, game: d.game || {}, installing: d.installing || {}, catalogFetched: d.catalogFetched, player: d.player, list: d.list || {}, appUpdate: d.appUpdate });
  logEntries = d.log; $('#log').innerHTML = d.log.map(logLine).join('\n') + '\n';
  $('#about').textContent = `Bifrost ${d.version}${d.settings.packaged ? '' : ' (din sursă)'} · ${(d.settings.servers || []).length} servere`;
  applyLang();
  renderSettings();
  renderHowto();
  go(!d.settings.server ? 'welcome' : d.settings.isAdmin ? 'server' : 'home');
  renderStatus(); renderWatch(); renderMods(); renderModpack(); renderMiniLog(); renderPlayer(); renderPlayerMods(); renderList(); renderAppUpdate(); renderSettingsGame();
  setInterval(() => { renderWatch(); renderStatus(); }, 30000);
})();
