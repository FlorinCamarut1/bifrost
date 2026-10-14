'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
// a text with variables or inline HTML in both languages (English by default); fixed texts go through ui/i18n.js
const L = (ro, en) => ((S.settings?.lang || 'en') === 'en' ? en : ro);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const S = { settings: {}, profile: { mods: [] }, status: {}, job: null, watch: {}, updates: {}, modpack: {}, filter: 'all', search: '',
  player: null, list: {}, appUpdate: null,
  src: 'ts', nx: { list: [], total: 0, loading: false, error: null, installed: {}, pending: {}, seq: 0, cat: null, cats: null, old: false, eml: true },
  installing: {}, catalog: null, catalogBusy: false, catalogFetched: null, bq: '', bsort: 'dl', bcat: null, bpacks: false, bdep: false, blimit: 60, drawer: null };

// ---------- helpers ----------
const ago = t => {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return L('acum câteva secunde', 'a few seconds ago');
  if (s < 3600) return L(`acum ${Math.round(s / 60)} min`, `${Math.round(s / 60)} min ago`);
  if (s < 86400) return L(`acum ${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`, `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min ago`);
  return L(`acum ${Math.round(s / 86400)} zile`, `${Math.round(s / 86400)} days ago`);
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
  $('#srv-world').textContent = [S.settings.serverWorld, S.settings.game?.id === 'enshrouded' ? 'Enshrouded' : 'crossplay'].filter(Boolean).join(' · ');
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
    // the ones on the server right now first, with a green dot
    ? [...s.recent].sort((x, y) => ((s.online || []).includes(y.name) - (s.online || []).includes(x.name))).map(r => `<span class="tag ${(s.online || []).includes(r.name) ? 'on' : ''}" title="${esc((s.online || []).includes(r.name) ? L('pe server acum', 'on the server now') : L(`ultima intrare ${r.t ? clock(r.t) : ''}`, `last joined ${r.t ? clock(r.t) : ''}`))}">${esc(r.name)}</span>`).join('')
    : `<span class="muted small">${L('nimeni încă', 'nobody yet')}</span>`;
  $('#srv-codebroken').hidden = !(s.reachable && s.container === 'running' && s.codeBroken);
  const down = $('#srv-down');
  if (s.reachable === false) { down.hidden = false; down.innerHTML = `<b>Nu ajung la server prin SSH.</b> <span class="muted">${esc(s.error || '')}</span>`; }
  else if (s.reachable && s.container && s.container !== 'running') { down.hidden = false; down.innerHTML = `<b>${L(`Containerul ${gameName()} nu rulează.`, `The ${gameName()} container is not running.`)}</b> <button class="btn small" data-act="startServer">Pornește serverul</button>`; }
  else down.hidden = true;
  $('#btn-start').hidden = !(s.reachable && s.container && s.container !== 'running');

  // (a personal profile has no server; a server whose state is unknown shows nothing rather than "starting")
  const personal = !S.settings.isAdmin && !S.settings.server?.list;
  if (personal || s.unknown) tb = '';
  else if (s.reachable && s.container === 'running') tb = `<span>${s.joinCode ? `${L('cod', 'code')} <b>${esc(s.joinCode)}</b>` : L('pornește...', 'starting...')}</span><span><b>${esc(pl)}</b> online</span>`;
  else if (s.reachable === false) tb = '<span>server: fără conexiune</span>';
  $('#tb-status').innerHTML = tb;
}

// ---------- sync / watch ----------
function renderWatch() {
  const w = S.watch, j = S.job, auto = S.settings.autoSync;
  let ring = 'ok', title = 'Serverul e la zi', sub = '';
  const q = S.queue || [];
  if (j) { ring = 'busy'; title = j.label; sub = L(`a început ${ago(j.started)}`, `started ${ago(j.started)}`) + (q.length ? L(` · ${q.length} în coadă`, ` · ${q.length} queued`) : ''); }
  else if (w.restarting) { ring = 'busy'; title = 'Repornesc serverul...'; sub = 'Poți instala în continuare - sincronizez după restart.'; }
  else if (!auto) { ring = 'off'; title = w.dirty ? 'Ai schimbări nesincronizate' : 'Auto-sync oprit'; sub = 'Apasă „Sincronizează acum” când vrei.'; }
  else if (w.state === 'change') { ring = 'busy'; title = 'Thunderstore schimbă modurile...'; sub = L(`sincronizez după ${S.settings.quietSeconds}s de liniște`, `syncing after ${S.settings.quietSeconds}s without changes`); }
  else if (w.state === 'waiting') { ring = 'wait'; title = 'Restart amânat - sunt jucători online'; sub = w.retryAt ? L(`reîncerc la ${clock(w.retryAt)} (serverul repornește când e gol)`, `retrying at ${clock(w.retryAt)} (the server restarts when it is empty)`) : ''; }
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
    : tw.error ? `<span style="color:var(--red)">${L('Configurări', 'Configs')}: ${esc(tw.error)}</span>`
      : L(`Configurări ${tw.push || tw.pull ? `sincronizate (↑ ${tw.push} trimise, ↓ ${tw.pull} aduse)` : 'la zi'}`, `Configs ${tw.push || tw.pull ? `synced (↑ ${tw.push} sent, ↓ ${tw.pull} pulled)` : 'up to date'}`) + ` · ${ago(tw.at)}${tw.mods && tw.mods.length ? L(` · aduse de pe server: ${esc(tw.mods.join(', '))}`, ` · brought from the server: ${esc(tw.mods.join(', '))}`) : ''} · <a href="#" data-act="twoWay">${L('verifică acum', 'check now')}</a>`;

  const side = $('#side-sync'), dot = side.querySelector('.dot');
  dot.className = `dot ${j ? 'busy' : !auto ? '' : ring === 'ok' ? 'ok' : ring === 'wait' ? 'warn' : ring === 'err' ? 'err' : 'busy'}`;
  $('#side-sync-text').textContent = j ? (q.length ? `lucrez · ${q.length} în coadă` : 'lucrez...') : w.restarting ? 'repornesc serverul...' : !auto ? 'oprit' : (w.text || '');
  $$('[data-act="sync"]').forEach(b => b.disabled = !!j);
  $$('[data-act="restart"],[data-act="fixcode"]').forEach(b => b.disabled = !!j || !!w.restarting);
  $$('[data-act="dryrun"],[data-act="publishModpack"],[data-act="buildModpack"]').forEach(b => b.disabled = !!j);
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
  $('#mods-sub').textContent = L(`${own ? 'Profilul Bifrost' : `Profilul Thunderstore „${S.profile.profile || 'Default'}”`} · ${mods.length} moduri · ${counts.server} pe server`, `${own ? 'Bifrost profile' : `Thunderstore profile "${S.profile.profile || 'Default'}"`} · ${mods.length} ${mods.length === 1 ? 'mod' : 'mods'} · ${counts.server} on the server`);
  $('#btn-update-all').hidden = !own || !counts.updates;
  $('#btn-update-all').textContent = L(`Actualizează tot (${counts.updates})`, `Update all (${counts.updates})`);

  const list = mods.filter(m => {
    const sd = modSide(m);
    if (S.filter === 'server' && !(sd === 'server' || sd === 'builtin')) return false;
    if (S.filter === 'client' && (sd === 'server' || sd === 'builtin')) return false;
    if (S.filter === 'updates' && !hasUpdate(m)) return false;
    if (S.filter === 'disabled' && m.enabled) return false;
    if (q && !`${m.displayName} ${m.name} ${m.author} ${m.description}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => (hasUpdate(b) - hasUpdate(a)) || (a.displayName || a.name).localeCompare(b.displayName || b.name));

  if (!S.profile.profileFound) { $('#mod-list').innerHTML = `<div class="empty card">${L(`Nu găsesc profilul Thunderstore „${esc(S.profile.profile)}”.`, `The Thunderstore profile "${esc(S.profile.profile)}" is not found.`)}</div>`; return; }
  if (!list.length) { $('#mod-list').innerHTML = '<div class="empty">Niciun mod aici.</div>'; return; }
  const busy = !!S.job;
  $('#mod-list').innerHTML = list.map(m => {
    const sd = modSide(m), u = S.updates[m.name];
    const icon = m.icon ? `<img class="mod-icon" src="${esc(m.icon)}" alt="" loading="lazy">` : `<div class="mod-icon">${esc((m.displayName || '?')[0])}</div>`;
    const badges = [
      hasUpdate(m) ? (S.installing[m.name] ? `<span class="badge pending">${S.installing[m.name].queued ? 'în coadă' : 'se actualizează...'}</span>` : `<button class="badge update" data-update="${esc(m.name)}" data-ver="${esc(u.latest)}" title="${L('Actualizează la ultima versiune', 'Update to the latest version')}">update ${esc(u.latest)} ↻</button>`) : '',
      !m.enabled ? '<span class="badge off">dezactivat</span>' : '',
      m.manual && m.source !== 'github' ? (m.nexus ? `<button class="badge onsrv" data-nexus="${esc(m.name)}" title="Prietenii îl iau de pe Nexus (${esc(m.nexus.title)} ${esc(m.nexus.version || '')})">nexus ${esc(m.nexus.modId)}</button>`
        : `<button class="badge off" data-nexus="${esc(m.name)}" title="Leagă-l de pagina lui de pe Nexus ca prietenii să-l poată instala">manual · leagă de Nexus</button>`) : '',
      m.modpack ? '<span class="badge lock">modpack-ul tău</span>' : '',
      sd === 'server' && m.onServer ? '<span class="badge onsrv">pe server</span>' : '',
      sd === 'server' && !m.onServer ? '<span class="badge pending">urmează pe server</span>' : '',
      sd === 'new' ? '<span class="badge pending">nou - se ghicește la sync</span>' : '',
    ].join('');
    const seg = m.name === 'eml-loader'
      ? `<span class="badge lock" title="${esc(L('Bifrost îl pune lângă enshrouded_server.exe pe server și lângă enshrouded.exe la jucători', 'Bifrost puts it next to enshrouded_server.exe on the server and next to enshrouded.exe for players'))}">${L('server + jucători', 'server + players')}</span>`
      : sd === 'builtin'
      ? '<span class="badge lock" title="Vine din imaginea serverului (VALHEIM_PLUS=true)">inclus în server</span>'
      : m.modpack ? '' :
        `<div class="seg" data-name="${esc(m.name)}"><button class="server ${sd === 'server' ? 'on' : ''}" data-side="server" ${busy ? 'disabled' : ''}>Server</button><button class="client ${sd === 'client' ? 'on' : ''}" data-side="client" ${busy ? 'disabled' : ''}>Client</button></div>`;
    // one grid cell for all the actions, so they stay on the right of the row
    const uninstall = m.builtin || m.name === 'denikson-BepInExPack_Valheim' ? '' : `<button class="icon-btn" data-uninstall="${esc(m.name)}" title="Dezinstalează">✕</button>`;
    return `<div class="mod ${m.enabled ? '' : 'disabled'}">
      ${icon}
      <div class="mod-body">
        <div class="mod-title">${m.url ? `<a data-url="${esc(m.url)}">${esc(m.displayName)}</a>` : `<a>${esc(m.displayName)}</a>`}
          <span class="mod-author">de ${esc(m.author)}</span><span class="mod-ver">${esc(m.version)}</span>${badges}</div>
        <div class="mod-desc" title="${esc(m.description)}">${esc(m.description)}</div>
      </div>
      <div class="mod-actions">${m.configs ? `<button class="icon-btn" data-config="${esc(m.name)}" data-title="${esc(m.displayName)}" title="Configurare (${m.configs} ${m.configs === 1 ? 'fișier' : 'fișiere'})">${GEAR}</button>` : ''}${seg}${uninstall}</div>
    </div>`;
  }).join('') + (S.profile.otherConfigs ? `<div class="mod-other"><button class="btn ghost small" data-config="" data-title="Alte configurări">${GEAR} ${L(`Alte configurări (${S.profile.otherConfigs} fără un mod recunoscut)`, `Other configs (${S.profile.otherConfigs} without a known mod)`)}</button></div>` : '');
}
$('#mod-list').addEventListener('click', async e => {
  const cf = e.target.closest('[data-config]'); if (cf) { openConfigDrawer(cf.dataset.config, cf.dataset.title); return; }
  const up = e.target.closest('[data-update]'); if (up) { installPkg(up.dataset.update, up.dataset.ver); return; }
  const un = e.target.closest('[data-uninstall]');
  if (un) {
    if (!await confirmBox(L('Dezinstalezi?', 'Uninstall?'), un.dataset.uninstall + L('\nDacă e mod de server, îl scot și de pe server (la următorul restart) și din lista prietenilor.', '\nIf it is a server mod, it is also removed from the server (at the next restart) and from the friends\' list.'), L('Dezinstalează', 'Uninstall'))) return;
    if (S.job || S.queue?.length) toast(L(`${un.dataset.uninstall}: în coadă - se dezinstalează după ce termin ce fac acum.`, `${un.dataset.uninstall}: queued - uninstalled after the current job.`), 'info');
    const r = await window.vp.act('remove', un.dataset.uninstall);
    toast(r.ok ? (S.settings.autoSync ? 'Dezinstalat - serverul se sincronizează după ce termin tot ce e în coadă.' : 'Dezinstalat. Apasă „Sincronizează acum” când ai terminat.') : r.error, r.ok ? 'ok' : 'error');
    if (r.ok && r.configs?.length && await confirmBox(L('Ștergi și configurările lui?', 'Delete its configs too?'),
      L(`${r.configs.join(', ')}\nDacă le păstrezi, o reinstalare le găsește la loc. Șterse, dispar și de pe server.`, `${r.configs.join(', ')}\nKept, a reinstall finds them again. Deleted, they are gone from the server too.`), L('Șterge-le', 'Delete them'))) {
      const d = await window.vp.act('deleteConfigs', r.configs);
      toast(d.ok ? L(`${d.deleted} fișiere de config șterse${d.remote ? ' (și de pe server)' : ''}.`, `${d.deleted} config ${d.deleted === 1 ? 'file' : 'files'} deleted${d.remote ? ' (from the server too)' : ''}.`) : d.error, d.ok ? 'ok' : 'error');
    }
    return;
  }
  const nx = e.target.closest('[data-nexus]');
  if (nx) {
    const m = (S.profile.mods || []).find(x => x.name === nx.dataset.nexus);
    const url = await confirmBox(L(`${nx.dataset.nexus} pe Nexus`, `${nx.dataset.nexus} on Nexus`), L(`Lipește linkul paginii modului de pe Nexus (ex. https://www.nexusmods.com/${nxDomain()}/mods/1234). Bifrost ia fișierul principal, cel mai nou. Gol = scoate legătura.`, `Paste the link of the mod's Nexus page (e.g. https://www.nexusmods.com/${nxDomain()}/mods/1234). Bifrost takes the newest main file. Empty = remove the link.`), L('Salvează', 'Save'), m?.nexus ? `https://www.nexusmods.com/${nxDomain()}/mods/${m.nexus.modId}` : '');
    if (url === null) return;
    const r = await window.vp.act('nexusLink', { name: nx.dataset.nexus, url });
    toast(r.ok ? (r.link ? L(`Legat de „${r.link.title}” ${r.link.version || ''} (fișierul ${r.link.fileName}).`, `Linked to "${r.link.title}" ${r.link.version || ''} (file ${r.link.fileName}).`) : L('Legătură scoasă.', 'Link removed.')) : r.error, r.ok ? 'ok' : 'error');
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
  if (p.name) $('#mp-sub').textContent = L(`${p.name} pe Thunderstore: pentru cine folosește un mod manager (prietenii cu Bifrost nu au nevoie de el).`, `${p.name} on Thunderstore: for people using a mod manager (friends with Bifrost don't need it).`);
  $('#mp-published').textContent = p.published || '–';
  $('#mp-local').textContent = p.local || '–';
  $('#mp-count').textContent = p.count ?? '–';
  $('#mp-url').dataset.url = p.url || '';
  const n = (p.added?.length || 0) + (p.changed?.length || 0) + (p.removed?.length || 0);
  const pill = $('#mp-pill');
  pill.className = `status-pill ${n ? 'warn' : 'ok'}`;
  $('#mp-pill-text').textContent = n ? L(`${n} schimbări nepublicate`, `${n} unpublished ${n === 1 ? 'change' : 'changes'}`) : L('la zi', 'up to date');
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
  const exe = S.settings.game?.exe || 'valheim.exe';
  if (g) $('#game-detected').textContent = g.game ? L(`Acum: ${g.game}`, `Now: ${g.game}`) : exe === 'valheim.exe' ? L('Nu l-am găsit prin Steam - scrie aici folderul care conține valheim.exe.', 'Not found through Steam - type the folder that contains valheim.exe here.') : L(`Nu l-am găsit prin Steam - scrie aici folderul care conține ${exe}.`, `Not found through Steam - type the folder that contains ${exe} here.`);
  if (g && S.settings.game?.loader === 'eml') {
    // Enshrouded: EML (dbghelp.dll) + the mods folder linked to the server's profile
    $('#btn-restore-loader').disabled = !g.game || g.owner !== 'bifrost';
    $('#loader-state').textContent = { bifrost: L('Acum încarcă modurile Bifrost: EML (dbghelp.dll) lângă enshrouded.exe, iar folderul mods e legat de profilul serverului ales. „Pune înapoi” scoate EML și pune la loc fișierul original al jocului.', 'Bifrost loads the mods now: EML (dbghelp.dll) next to enshrouded.exe, and the mods folder is linked to the chosen server\'s profile. "Put back" removes EML and restores the game\'s original data file.'),
      other: L('Acum e alt încărcător (dbghelp.dll / winmm.dll) - la JOACĂ preia Bifrost (păstrez un backup).', 'Another loader is in place (dbghelp.dll / winmm.dll) - PLAY makes Bifrost take over (a backup is kept).'),
      none: L('Enshrouded e fără moduri acum. La JOACĂ, Bifrost pune EML lângă joc.', 'Enshrouded has no mods right now. PLAY puts EML next to the game.') }[g.owner] || '';
    return;
  }
  if (g) {
    $('#btn-restore-loader').disabled = !g.backup;
    const who = { bifrost: L('Acum încarcă modurile Bifrost.', 'Bifrost loads the mods now.'), tmm: L('Acum încarcă modurile Thunderstore Mod Manager / r2modman - la JOACĂ preia Bifrost (păstrez un backup).', 'Thunderstore Mod Manager / r2modman loads the mods now - PLAY makes Bifrost take over (a backup is kept).'), other: L('Acum e alt încărcător BepInEx - la JOACĂ preia Bifrost (păstrez un backup).', 'Another BepInEx loader is in place - PLAY makes Bifrost take over (a backup is kept).'), none: L('Valheim e fără moduri acum.', 'Valheim has no mods right now.'), native: L('Linux: Bifrost pornește Valheim direct cu BepInEx-ul din profil, folderul jocului rămâne neatins.', 'Linux: Bifrost starts Valheim directly with the profile\'s BepInEx; the game folder stays untouched.') }[g.owner];
    if (who) $('#loader-state').textContent = who + (g.backup ? L(' Backup-ul anterior există.', ' The previous backup exists.') : '');
  }
}
function renderSettings() {
  const s = S.settings;
  $$('[data-set]').forEach(el => {
    if (document.activeElement === el) return;
    if (el.type === 'checkbox') el.checked = !!s[el.dataset.set]; else el.value = s[el.dataset.set] ?? '';
  });
  $('#token-state').innerHTML = s.hasToken ? `<span style="color:var(--green)">${L('✓ Token salvat.', '✓ Token saved.')}</span>` : `<span class="muted">${L('Niciun token salvat.', 'No token saved.')}</span>`;
  $('#nexus-state').innerHTML = s.hasNexusKey && s.nexusUser ? `<span style="color:var(--green)">${L(`✓ Conectat ca <b>${esc(s.nexusUser.name)}</b> · ${s.nexusUser.premium ? 'Premium: descărcări automate' : 'cont gratuit: un click pe „Slow download” per fișier'}`, `✓ Connected as <b>${esc(s.nexusUser.name)}</b> · ${s.nexusUser.premium ? 'Premium: automatic downloads' : 'free account: one click on "Slow download" per file'}`)}</span>` : '<span class="muted">Nicio cheie salvată.</span>';
  // direct join: what PLAY will connect to
  if ($('#dj-state')) {
    $('#dj-state').textContent = !s.directJoin ? 'Oprit: intri din joc, cu join code-ul.'
      : s.joinTarget ? L(`Acum: ${s.joinTarget}${s.hasJoinPass ? ' cu parola salvată' : ''}. Alegi caracterul, apeși Start și ești pe server.`, `Now: ${s.joinTarget}${s.hasJoinPass ? ' with the saved password' : ''}. Pick the character, press Start and you are on the server.`)
        : s.isAdmin ? 'Încă nu știu IP-ul public al serverului (apare după ce pornește) - sau scrie adresa mai jos.'
          : 'Lista serverului nu are IP-ul: scrie adresa mai jos (o ai de la admin) sau adminul bifează „Pune și IP-ul în listă”.';
    // (attributes set from code are not seen by the translator)
    $('#dj-addr').placeholder = s.joinAddress ? '' : (s.joinTarget || ((s.lang || 'en') === 'en' ? window.bifrostI18n.t('automat') : 'automat'));
    $('#jp-state').innerHTML = s.joinPassBroken ? `<span style="color:var(--red)">${L('Parola salvată nu se poate citi pe PC-ul ăsta (cheia de criptare s-a schimbat) - scrie-o din nou și apasă Salvează.', 'The saved password cannot be read on this PC (the encryption key changed) - type it again and press Save.')}</span>`
      : s.hasJoinPass ? `<span style="color:var(--green)">${L('✓ Parolă salvată (criptat, doar pe PC-ul tău).', '✓ Password saved (encrypted, only on your PC).')}</span>`
      : s.listPassword ? `<span style="color:var(--green)">${L('✓ Parola vine din lista serverului - nu trebuie să scrii nimic.', '✓ The password comes from the server\'s list - nothing to type.')}</span>`
      : `<span class="muted">${L('Nicio parolă salvată. Dacă serverul are parolă, scrie-o o dată aici.', 'No password saved. If the server has one, type it here once.')}</span>`;
    $('#btn-jp-clear').hidden = !s.hasJoinPass && !s.joinPassBroken;
  }
  // restart / new join code only where Bifrost can do them
  $$('[data-act="fixcode"]').forEach(b => { b.hidden = !s.dockerServer; });
  $('#btn-server-env').hidden = !(s.isAdmin && s.dockerServer);
  $$('[data-act="restart"]').forEach(b => { b.hidden = !s.canRestart; });
  renderServers();
  document.body.classList.toggle('role-admin', !!s.isAdmin); document.body.classList.toggle('role-player', !s.isAdmin);
  $('#brand-sub').textContent = s.server?.name || gameName();
  renderGame();
}
// the open server's game: body.g-<id> hides what only Valheim has (.vh-only); Discover is Nexus-only without Thunderstore
const gameName = () => S.settings?.game?.name || 'Valheim';
const nxDomain = () => S.settings?.game?.nexusDomain || 'valheim';
function renderGame() {
  const g = S.settings.game || { id: 'valheim', name: 'Valheim', thunderstore: true, outdated: true, exe: 'valheim.exe' };
  for (const c of [...document.body.classList]) if (c.startsWith('g-')) document.body.classList.remove(c);
  document.body.classList.add(`g-${g.id}`);
  $('#game-dir-label').textContent = L(`Folderul ${g.name}`, `${g.name} folder`);
  if (!g.thunderstore && S.src !== 'nx') setSource('nx');
  $('#br-old-wrap').hidden = S.src !== 'nx' || !g.outdated;
  $('#br-eml-wrap').hidden = g.loader !== 'eml';
}
$('#btn-nexus').onclick = async () => {
  const v = $('#nexus-input').value.trim(); if (!v) return;
  $('#btn-nexus').disabled = true;
  const r = await window.vp.act('setNexusKey', v); $('#btn-nexus').disabled = false;
  if (r.ok) $('#nexus-input').value = '';
  toast(r.ok ? L(`Conectat la Nexus ca ${r.user.name}${r.user.premium ? ' (Premium)' : ''}.`, `Connected to Nexus as ${r.user.name}${r.user.premium ? ' (Premium)' : ''}.`) : L(`Cheia nu merge: ${r.error}`, `The key does not work: ${r.error}`), r.ok ? 'ok' : 'error');
};
// download cache: size shown on the Settings page, "Empty" deletes it (mods get downloaded again when needed)
const fmtSize = b => b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`;
async function renderCache() {
  const r = await window.vp.act('cacheInfo');
  if (r.ok) $('#cache-state').textContent = L(`${fmtSize(r.bytes)} în ${r.files} fișiere. Versiunile vechi se șterg singure; „Golește” le scoate pe toate (se descarcă din nou la nevoie).`, `${fmtSize(r.bytes)} in ${r.files} ${r.files === 1 ? 'file' : 'files'}. Old versions are removed by themselves; "Empty" removes them all (downloaded again when needed).`);
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
    const ok = await confirmBox('Restart server?', p ? L(`Sunt ${p} jucători online - vor fi deconectați.\nServerul revine în ~2-3 minute, cu join code.`, `${p} ${p === 1 ? 'player is' : 'players are'} online - they will be disconnected.\nThe server is back in ~2-3 minutes, with a join code.`) : L('Serverul revine în ~2-3 minute, cu join code.', 'The server is back in ~2-3 minutes, with a join code.'), 'Restart');
    if (!ok) return;
  }
  if (act === 'fixcode') {
    if (!await confirmBox('Join code nou?', 'Repornește doar procesul jocului (~2 minute). Jucătorii conectați sunt deconectați.', 'Repornește jocul')) return;
  }
  if (act === 'publishModpack') {
    const p = S.modpack;
    if (!await confirmBox(L('Publici modpack-ul?', 'Publish the modpack?'), L(`Construiesc o versiune nouă din profilul tău și o urc pe Thunderstore ca ${p.name}.\nAcum publicat: ${p.published || '?'}.`, `A new version is built from your profile and uploaded to Thunderstore as ${p.name}.\nPublished now: ${p.published || '?'}.`), L('Publică', 'Publish'))) return;
  }
  if (act === 'importTmm' && !await confirmBox('Import din Thunderstore Mod Manager?', 'Copiez în profilul Bifrost aceleași moduri și versiuni (din cache-ul Thunderstore), configurările din BepInEx/config și modurile manuale. Profilul TMM rămâne neatins. Serverul nu se schimbă - fișierele sunt identice.', 'Importă')) return;
  if (act === 'updateAll' && !await confirmBox('Actualizezi tot?', 'Aduc ultima versiune pentru fiecare mod cu update. Serverul se actualizează singur (repornește când e gol) și prietenii primesc versiunile noi la JOACĂ.', 'Actualizează')) return;
  if (act === 'quit') { if (!await confirmBox('Închizi complet?', S.settings.isAdmin ? 'Auto-sync-ul se oprește până pornești din nou Bifrost.' : 'Bifrost se închide.', 'Închide')) return; }
  if (act === 'dryrun') $('#dry-result').hidden = true;
  if (act === 'checkUpdates') { b.disabled = true; b.textContent = 'Caut...'; }
  const r = await window.vp.act(act, arg);
  if (act === 'checkUpdates') { b.disabled = false; b.textContent = 'Caută update-uri'; const n = (S.profile.mods || []).filter(hasUpdate).length; toast(n ? L(`${n} moduri au update în Thunderstore.`, `${n} ${n === 1 ? 'mod has an update' : 'mods have updates'} on Thunderstore.`) : L('Toate modurile sunt la ultima versiune.', 'All mods are on the latest version.'), 'ok'); return; }
  if (act === 'dryrun' && r.ok) { const d = $('#dry-result'); d.hidden = false; d.innerHTML = `${L('De copiat', 'To copy')}: <b>${esc(r.toCopy || '-')}</b><br>${L('De scos', 'To remove')}: <b>${esc(r.toRemove || '-')}</b>`; return; }
  if (r && r.ok === false && r.error) toast(r.error, 'error');
  else if (act === 'restart' && r.ok) toast(r.manualRestart ? 'Bifrost nu poate reporni serverul ăsta - repornește-l din panoul hostului.' : r.postponed ? 'Sunt jucători online - serverul repornește când se golește.' : r.joinCode ? `Server repornit. Join code: ${r.joinCode}` : 'Server repornit.', r.manualRestart ? 'info' : 'ok');
  else if (act === 'buildModpack' && r.ok) toast(`Zip construit: versiunea ${r.info.local}.`, 'ok');
  else if (act === 'publishModpack' && r.ok) toast(`Publicat ${r.version} pe Thunderstore.`, 'ok');
  else if (act === 'fixcode' && r.ok) toast('Jocul repornește - codul nou apare în ~2 minute.', 'ok');
  else if (act === 'publishList' && r.ok) toast(r.changed ? 'Lista pentru prieteni e publicată.' : 'Lista era deja la zi.', 'ok');
  else if (act === 'updateMods' && r.ok) toast('Modurile sunt la zi.', 'ok');
  else if (act === 'play' && r.ok) toast(L(`Pornesc ${gameName()} prin Steam...`, `Starting ${gameName()} through Steam...`), 'ok');
  else if (act === 'refreshList' && r.ok) toast('Lista serverului e actualizată.', 'ok');
  else if (act === 'importTmm' && r.ok) toast(L(`Import gata: ${r.count} pachete în profilul Bifrost. De acum pornește Valheim cu JOACĂ.`, `Import done: ${r.count} packages in the Bifrost profile. From now on start Valheim with PLAY.`), 'ok');
  else if (act === 'updateAll' && r.ok) toast(r.count ? L(`${r.count} moduri actualizate - sincronizez serverul.`, `${r.count} ${r.count === 1 ? 'mod' : 'mods'} updated - syncing the server.`) : L('Totul e la zi.', 'Everything is up to date.'), 'ok');
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
    // "Jotunn the Valheim Library" = Jotunn: the name goes on with a plain description - not "German", "RUS 0.10", "Patch"
    if (mn.length >= 6 && n.startsWith(mn) && /^(the|by|library|reborn|redux|continued|updated|remastered)/.test(n.slice(mn.length))) return true;
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
  if (S.installing[p.full]?.queued) return `<button class="${cls} working" disabled>În coadă</button>`;
  if (S.installing[p.full]) return `<button class="${cls} working" disabled>Se instalează</button>`;
  if (have && cmpVer(p.ver, have) > 0) return `<button class="${cls} update" data-install="${esc(p.full)}">Update la ${esc(p.ver)}</button>`;
  if (have) return `<button class="${cls} installed" disabled>✓ Instalat</button>`;
  const nxTwin = crossInstalled(p.name.replace(/_/g, ' '), p.owner, 'nexus');
  if (nxTwin) return crossLabel(nxTwin, 'Nexus').replace('btn small', cls);
  return `<button class="${cls} primary" data-install="${esc(p.full)}">Instalează</button>`;
}
function sideTags(p) {
  const c = p.cats || [];
  return [c.includes('Server-side') ? '<span class="side-tag srv">server</span>' : '', c.includes('Client-side') ? '<span class="side-tag">client</span>' : '',
    p.deprecated ? '<span class="side-tag dep" title="Marked deprecated on Thunderstore - shown while the Deprecated switch is on">deprecated</span>' : ''].join('');
}

async function loadCatalog(force) {
  if (S.catalog && !force) { renderBrowse(true); return; }
  if (!S.catalog) $('#br-grid').innerHTML = Array.from({ length: 9 }, () => '<div class="skeleton"></div>').join('');
  $('#br-more').textContent = S.catalog ? '' : L('Descarc catalogul Thunderstore (~14 MB, câteva secunde)...', 'Downloading the Thunderstore catalog (~14 MB, a few seconds)...');
  const r = await window.vp.act(force ? 'refreshCatalog' : 'catalog');
  // (no catalog yet and no internet: nothing is cached, the next visit to Discover tries again)
  if (r.packages?.length) {
    S.catalog = r.packages.filter(p => !/^ebkr-r2modman/.test(p.full)).map(p => ({ ...p, hay: `${p.full} ${p.name.replace(/_/g, ' ')} ${p.owner} ${p.desc}`.toLowerCase() }));
    S.catalogFetched = r.fetched;
    buildCats();
  } else if (!S.catalog) { $('#br-grid').innerHTML = ''; $('#br-more').textContent = L('Nu am putut descărca catalogul. Verifică internetul și apasă „Reîmprospătează”.', 'Could not download the catalog. Check the internet connection and press Refresh.'); return; }
  if (force) toast('Catalog actualizat.', 'ok');
  renderBrowse(true);
}
function buildCats() {
  if (S.src === 'nx') return;   // Nexus shows its own categories (buildNexusCats)
  const count = {};
  for (const p of S.catalog) if (!isPack(p) && (!p.deprecated || S.bdep)) for (const c of p.cats || []) count[c] = (count[c] || 0) + 1;
  const cats = Object.entries(count).filter(([c]) => !/Update$|^Mods$|^Modpacks$/.test(c)).sort((a, b) => b[1] - a[1]).slice(0, 18);
  $('#br-cats').innerHTML = `<button class="chip ${S.bcat ? '' : 'active'}" data-cat="">Toate</button>` +
    cats.map(([c, n]) => `<button class="chip ${S.bcat === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)} <b>${n}</b></button>`).join('');
}
function renderBrowseSub() {
  const n = S.catalog ? S.catalog.filter(p => !isPack(p) && !p.deprecated).length : 0;
  $('#br-sub').textContent = S.catalog
    ? L(`Catalogul Thunderstore pentru Valheim · ${n.toLocaleString(LOC())} moduri · actualizat ${ago(S.catalogFetched)}${S.catalogBusy ? ' · se reîmprospătează...' : ''}`, `The Thunderstore catalog for Valheim · ${n.toLocaleString(LOC())} mods · updated ${ago(S.catalogFetched)}${S.catalogBusy ? ' · refreshing...' : ''}`)
    : 'Catalogul Thunderstore pentru Valheim';
}
function browseList() {
  const q = S.bq.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let list = S.catalog.filter(p => (S.bpacks || !isPack(p)) && (!S.bcat || (p.cats || []).includes(S.bcat)) && (!p.deprecated || S.bdep) && q.every(w => p.hay.includes(w)));
  const key = { dl: p => p.dl, rating: p => p.rating, updated: p => p.updated, created: p => p.created }[S.bsort];
  list.sort((a, b) => !!a.deprecated - !!b.deprecated || key(b) - key(a));   // deprecated ones after the rest
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
  $('#br-more').textContent = !list.length ? 'Nimic găsit.' : list.length > shown.length ? L(`${shown.length} din ${list.length.toLocaleString(LOC())} - derulează pentru mai multe`, `${shown.length} of ${list.length.toLocaleString(LOC())} - scroll for more`) : L(`${list.length} moduri`, `${list.length} ${list.length === 1 ? 'mod' : 'mods'}`);
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
$('#br-dep').addEventListener('change', e => { S.bdep = e.target.checked; buildCats(); renderBrowse(true); });
$('#br-old').addEventListener('change', e => { S.nx.old = e.target.checked; nexusSearch(true); });
$('#br-eml').addEventListener('change', e => { S.nx.eml = e.target.checked; nexusSearch(true); });
$('#br-cats').addEventListener('click', e => {
  const c = e.target.closest('[data-cat]'); if (!c) return;
  if (S.src === 'nx') { S.nx.cat = c.dataset.cat || null; buildNexusCats(); nexusSearch(true); return; }
  S.bcat = c.dataset.cat || null; buildCats(); renderBrowse(true);
});
$('#btn-catalog').onclick = () => S.src === 'nx' ? nexusSearch(true) : loadCatalog(true);

// ---------- browse: Nexus Mods ----------
const NX_OUTDATED = Date.UTC(2024, 4, 14);   // = lib/nexus.js OUTDATED_BEFORE
const NX_SORT = { dl: 'downloads', rating: 'endorsements', updated: 'updatedAt', created: 'createdAt' };
function setSource(src) {
  S.src = src;
  $$('#br-source button').forEach(b => b.classList.toggle('on', b.dataset.src === src));
  if (src === 'nx') buildNexusCats(); else if (S.catalog) buildCats();
  $('#br-packs-wrap').hidden = src === 'nx'; $('#br-dep-wrap').hidden = src === 'nx'; $('#br-old-wrap').hidden = src !== 'nx' || S.settings.game?.outdated === false;
  $('#br-search').placeholder = src === 'nx' ? L('Caută pe Nexus Mods...', 'Search Nexus Mods...') : L('Caută în Thunderstore...', 'Search Thunderstore...');
  const note = $('#br-nexus-note');
  note.hidden = src !== 'nx';
  const u = S.settings.nexusUser;
  note.innerHTML = '<span>' + (!S.settings.hasNexusKey ? 'Pentru instalare de pe Nexus pune-ți cheia în <a href="#" data-page-link="settings">Setări → Nexus Mods</a>. Căutarea merge și fără.'
    : u && u.premium ? L(`Conectat ca <b>${esc(u.name)}</b> (Premium): <b>Instalează</b> descarcă direct.`, `Connected as <b>${esc(u.name)}</b> (Premium): <b>Install</b> downloads directly.`)
      : L(`Conectat ca <b>${esc(u ? u.name : '?')}</b> (cont gratuit): <b>Instalează</b> deschide pagina fișierului pe Nexus - apasă acolo <b>„Slow download”</b> și Bifrost îl instalează singur.${S.settings.isAdmin ? ' Modul intră în profilul tău ca mod manual, legat de Nexus, deci ajunge și în lista prietenilor.' : ''}`, `Connected as <b>${esc(u ? u.name : '?')}</b> (free account): <b>Install</b> opens the file's page on Nexus - press <b>"Slow download"</b> there and Bifrost installs it by itself.${S.settings.isAdmin ? ' The mod goes into your profile as a manual mod linked to Nexus, so it reaches the friends\' list too.' : ''}`)) + '</span>';
  renderHowto();
  renderBrowse(true);
}
$('#br-source').addEventListener('click', e => { const b = e.target.closest('[data-src]'); if (b && b.dataset.src !== S.src) setSource(b.dataset.src); });
async function nexusSearch(reset) {
  const nx = S.nx, seq = ++nx.seq;
  if (reset) { nx.list = []; nx.total = 0; $('#br-grid').innerHTML = Array.from({ length: 9 }, () => '<div class="skeleton"></div>').join(''); }
  nx.loading = true; $('#br-more').textContent = 'Caut pe Nexus...';
  const [r, inst] = await Promise.all([window.vp.act('nexusSearch', { q: S.bq, sort: NX_SORT[S.bsort] || 'downloads', offset: nx.list.length, count: 30, cat: nx.cat, old: nx.old, need: S.settings.game?.loader === 'eml' && nx.eml ? 'EML' : null }), reset ? window.vp.act('nexusInstalled') : null]);
  if (seq !== nx.seq) return;
  nx.loading = false;
  if (inst) { nx.installed = inst.installed; nx.pending = inst.pending; }
  if (!r.ok) { nx.error = r.error; $('#br-more').textContent = L(`Nexus nu răspunde: ${r.error}`, `Nexus does not answer: ${r.error}`); if (reset) $('#br-grid').innerHTML = ''; return; }
  nx.error = null; nx.total = r.total; nx.list.push(...r.mods);
  if (r.cats) { nx.cats = r.cats; buildNexusCats(); }
  renderNexus();
}
// Nexus's own categories (Gameplay, Construction, Utilities...), counted for the search text
function buildNexusCats() {
  const nx = S.nx, cats = Object.entries(nx.cats || {}).filter(([c, n]) => n > 0 || c === nx.cat);
  $('#br-cats').innerHTML = !cats.length ? '' : `<button class="chip ${nx.cat ? '' : 'active'}" data-cat="">Toate</button>` +
    cats.map(([c, n]) => `<button class="chip ${nx.cat === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)} <b>${n}</b></button>`).join('');
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
  $('#br-sub').textContent = L(`Nexus Mods pentru ${gameName()} · ${nx.total.toLocaleString(LOC())} moduri`, `Nexus Mods for ${gameName()} · ${nx.total.toLocaleString(LOC())} mods`);
  $('#br-grid').innerHTML = nx.list.map(m => `
    <div class="pk" data-nxpk="${m.modId}">
      ${m.thumbnailUrl ? `<img src="${esc(m.thumbnailUrl)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
      <div><div class="pk-name">${esc(m.name)}</div><div class="pk-owner">de ${esc(m.author || m.uploader?.name || '?')} · v${esc(m.version || '?')}</div><div class="pk-desc">${esc(m.summary)}</div></div>
      <div class="pk-foot"><span class="pk-stat" title="descărcări">${ICON_DL}${fmtNum(m.downloads)}</span><span class="pk-stat" title="endorsements">${ICON_STAR}${fmtNum(m.endorsements)}</span>${m.modCategory ? `<span class="nx-cat">${esc(m.modCategory.name)}</span>` : ''}${Date.parse(m.updatedAt) < NX_OUTDATED && S.settings.game?.outdated !== false ? '<span class="side-tag dep" title="Not updated since Ashlands (May 2024) - it may not work">outdated</span>' : ''}${nxButton(m)}</div>
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
  const page = `https://www.nexusmods.com/${S.settings.game?.nexusDomain || 'valheim'}/mods/${modId}`;
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
    : L(`<b>Cum se instalează:</b> apeși <b>Instalează</b> și Bifrost pune modul (cu dependențele) în profilul serverului. ${admin ? 'Modurile de server ajung și pe server, iar prietenii le primesc prin listă.' : 'Modurile cerute de server nu trebuie căutate aici - se instalează singure când apeși <b>JOACĂ</b>.'}`, `<b>How to install:</b> press <b>Install</b> and Bifrost puts the mod (with its dependencies) into this server's profile. ${admin ? 'Server mods go to the server too, and your friends get them through the list.' : 'The mods the server needs don\'t have to be found here - they install by themselves when you press <b>PLAY</b>.'}`);
}
$('#br-howto-x').onclick = () => { $('#br-howto').hidden = true; try { localStorage.setItem('howtoSeen', '1'); } catch { } };

async function installPkg(full, ver) {
  const p = S.catalog?.find(x => x.full === full);
  const tmm = L('Se deschide Thunderstore Mod Manager și instalează modul în profilul tău (dacă cere, confirmă acolo).', 'Thunderstore Mod Manager opens and installs the mod into your profile (confirm there if it asks).');
  if (!S.settings.isAdmin) toast(L(`Instalez ${full}...`, `Installing ${full}...`));
  if (S.job || S.queue?.length) toast(L(`${full}: în coadă - se instalează după ce termin ce fac acum.`, `${full}: queued - installed after the current job.`), 'info');
  const r = await window.vp.act('install', { full, ver: ver || p?.ver });
  if (!r.ok) { toast(r.error, 'error'); return; }
  if (r.already) return;
  if (r.via === 'tmm') toast(`${full}: ${tmm}${r.side ? L(` Marcat „${r.side}” după categoriile Thunderstore.`, ` Marked "${r.side}" from its Thunderstore categories.`) : ''}`, 'ok');
  else toast(L(`${full} instalat. Pornește-l cu JOACĂ.`, `${full} installed. Start it with PLAY.`), 'ok');
}
$('#br-grid').addEventListener('click', e => {
  const b = e.target.closest('[data-install]'); if (b) { e.stopPropagation(); installPkg(b.dataset.install); return; }
  const c = e.target.closest('[data-pk]'); if (c) openDrawer(c.dataset.pk);
});

// detail drawer
async function closeDrawer() {
  if (S.drawer === 'env:' && envDirty() && !await confirmBox(L('Renunți la modificări?', 'Discard the changes?'), L('Ai setări de server nesalvate.', 'There are unsaved server settings.'), L('Renunță la ele', 'Discard them'))) return;
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
    return `<div class="dep ${have ? 'have' : ''}"><span>${esc(d.full)}</span><span>${have ? L(`✓ ai ${esc(have)}`, `✓ you have ${esc(have)}`) : `${esc(d.ver)}`}</span></div>`;
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
function refreshDrawer() { if (!S.drawer || !S.catalog || /^(nx|cfg|env):/.test(String(S.drawer))) return; const p = S.catalog.find(x => x.full === S.drawer); const top = $('#dr-top'); if (p && top) top.innerHTML = drawerHead(p); }
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
    ${S.settings?.isAdmin && CFG.rel && /\.cfg$/i.test(CFG.rel) && !CFG.err ? `<label class="cfg-share"><div><b>${L('Și prietenii primesc setările din fișierul ăsta', 'Players get the settings of this file too')}</b><small>${L('Ce ai schimbat față de valorile implicite ajunge și în configul lor, la JOACĂ. Pentru setările pe care serverul nu le trimite (de ex. timpul de îmblânzire: îl calculează jocul jucătorului de lângă animal).', 'What you changed from the defaults reaches their config too, on PLAY. For settings the server does not send (e.g. taming time: the game of the player next to the animal works it out).')}</small></div><span class="switch"><input type="checkbox" id="cfg-share" ${(S.settings.server?.sharedConfigs || []).includes(CFG.rel) ? 'checked' : ''}><span></span></span></label>` : ''}
    ${CFG.key === '' && CFG.rel ? `<div class="cfg-orphan"><span class="muted small">${L('Niciun mod instalat nu folosește fișierul ăsta (rămas de la un mod dezinstalat?).', 'No installed mod uses this file (left from an uninstalled mod?).')}</span><div class="row gap"><button class="btn small danger" id="cfg-delete">${L('Șterge fișierul', 'Delete the file')}</button>${CFG.files.length > 1 ? `<button class="btn small danger" id="cfg-delete-all">${L(`Șterge toate (${CFG.files.length})`, `Delete all (${CFG.files.length})`)}</button>` : ''}</div></div>` : ''}
    <div class="cfg-tools">${f?.parsed && !CFG.raw ? `<input class="txt" id="cfg-q" placeholder="Caută o setare..." value="${esc(CFG.q)}">` : `<span class="muted small no-i18n">${esc(CFG.rel || '')}</span>`}
      ${f?.parsed && !CFG.raw ? `<button class="btn small ghost" id="cfg-defaults" title="${L('Pune toate setările din fișierul ăsta la valorile implicite ale modului. Se aplică după Salvează.', 'Set every setting in this file to its default value. Applied when you press Save.')}">${L('Valori implicite', 'Restore defaults')}</button>` : ''}
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
  // (inside the message's own span: the restart button stays next to it)
  if (!r.unchanged && r.gameRunning) CFG.after = CFG.after.replace('</span>', `<br><small class="muted">${L('Valheim e pornit pe PC: jocul tău folosește noile valori după ce îl repornești. Când îl închizi își scrie setările vechi peste fișier - Bifrost îți pune modificarea la loc.', 'Valheim is running on this PC: your game uses the new values after you restart it. When it closes it writes its old settings over the file - Bifrost puts your edit back.')}</small></span>`);
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
$('#drawer-body').addEventListener('change', async e => {
  if (e.target.id === 'cfg-share' && String(S.drawer).startsWith('cfg:')) {
    const on = e.target.checked, r = await window.vp.act('shareConfig', { rel: CFG.rel, on });
    if (!r.ok) { e.target.checked = !on; toast(r.error || L('Nu s-a putut.', 'Could not change it.'), 'error'); return; }
    if (S.settings.server) S.settings.server.sharedConfigs = r.shared;
    toast(on ? L('Prietenii primesc setările la următorul JOACĂ (după ce se publică lista).', 'Players get the settings on their next PLAY (once the list is published).') : L('Prietenii nu mai primesc setările din fișierul ăsta; ce le-a pus Bifrost revine la implicit.', 'Players no longer get this file\'s settings; what Bifrost put there goes back to the defaults.'), 'ok');
    return;
  }
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
  if (e.target.closest('#cfg-defaults')) {
    const todo = [], bare = [];
    CFG.file.parsed.sections.forEach((sec, si) => sec.entries.forEach((en, ei) => {
      const id = `${si}.${ei}`, v = CFG.changes.has(id) ? CFG.changes.get(id) : en.value;
      if (en.def === null) bare.push(en.key); else if (en.def !== v) todo.push([id, en.def]);
    }));
    const note = bare.length ? L(` ${bare.length} setări nu au valoare implicită în fișier și rămân cum sunt.`, ` ${bare.length} ${bare.length === 1 ? 'setting has' : 'settings have'} no default in the file and stay as they are.`) : '';
    if (!todo.length) { toast(L('Toate setările sunt deja la valorile implicite.', 'Every setting is already at its default.') + note); return; }
    if (!await confirmBox(L('Pui valorile implicite?', 'Restore the defaults?'), L(`${todo.length} setări din ${CFG.rel} revin la valorile implicite ale modului. Le vezi marcate și se aplică doar după Salvează.`, `${todo.length} ${todo.length === 1 ? 'setting' : 'settings'} in ${CFG.rel} go back to the mod's defaults. They are marked below and only applied when you press Save.`) + note, L('Pune valorile implicite', 'Restore defaults'))) return;
    const keepQ = CFG.q, open = $$('#cfg-body .cfg-sec').filter(d => d.open).map(d => d.dataset.sec);
    for (const [id, v] of todo) cfgSet(id, v);
    renderConfig();
    CFG.q = keepQ; const qi = $('#cfg-q'); if (qi) { qi.value = keepQ; filterConfig(); }
    $$('#cfg-body .cfg-sec').forEach(d => { if (open.includes(d.dataset.sec) || d.querySelector('.cfg-row.changed')) d.open = true; });
    return;
  }
  if (e.target.closest('#cfg-discard')) { Object.assign(CFG, { rawText: null, changes: new Map() }); renderConfig(); return; }
  if (e.target.closest('#cfg-save')) { saveConfig(); return; }
  if (e.target.closest('#cfg-delete-all')) {
    const rels = CFG.files.map(f => f.rel), list = rels.slice(0, 8).join('\n') + (rels.length > 8 ? L(`\n... și încă ${rels.length - 8}`, `\n... and ${rels.length - 8} more`) : '');
    if (!await confirmBox(L(`Ștergi toate cele ${rels.length} fișiere?`, `Delete all ${rels.length} files?`), L(`${list}\nDispar din profil și de pe server. Niciun mod instalat nu le folosește; un mod care totuși are nevoie de unul îl scrie din nou cu valorile implicite.`, `${list}\nThey are removed from the profile and from the server. No installed mod uses them; a mod that still needs one writes it again with its defaults.`), L('Șterge toate', 'Delete all'))) return;
    const d = await window.vp.act('deleteConfigs', rels);
    toast(d.ok ? L(`${d.deleted} fișiere șterse${d.remote ? ' (și de pe server)' : ''}.`, `${d.deleted} files deleted${d.remote ? ' (from the server too)' : ''}.`) : d.error, d.ok ? 'ok' : 'error');
    if (d.ok) { CFG.changes = new Map(); CFG.rawText = null; openConfigDrawer('', CFG.title); }
    return;
  }
  if (e.target.closest('#cfg-delete')) {
    const rel = CFG.rel;
    if (!await confirmBox(L('Ștergi fișierul?', 'Delete the file?'), L(`${rel}\nDispare din profil și de pe server. Unele fișiere de aici (de ex. traducerile Therzie) sunt totuși folosite de moduri - șterge doar ce știi că e rămas.`, `${rel}\nIt is removed from the profile and from the server. Some files here (e.g. Therzie's translations) are still used by mods - delete only what you know is left over.`), L('Șterge', 'Delete'))) return;
    const d = await window.vp.act('deleteConfigs', [rel]);
    toast(d.ok ? L(`${rel} șters${d.remote ? ' (și de pe server)' : ''}.`, `${rel} deleted${d.remote ? ' (from the server too)' : ''}.`) : d.error, d.ok ? 'ok' : 'error');
    if (d.ok) { CFG.changes = new Map(); CFG.rawText = null; openConfigDrawer('', CFG.title); }
    return;
  }
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

// ---------- the server's settings (valheim.env of the valheim-server image) ----------
const ENV = { file: null, text: null, vars: [], known: [], changes: {}, raw: false, rawText: null, busy: false, players: null };
const envVal = k => (k in ENV.changes ? ENV.changes[k] : ENV.vars.find(v => v.key === k)?.value);
const envDirty = () => ENV.raw ? ENV.rawText !== null && ENV.rawText !== ENV.text : Object.keys(ENV.changes).length > 0;
async function openServerEnv() {
  S.drawer = 'env:';
  $('#drawer').hidden = false; $('#drawer-bg').hidden = false; $('#drawer').scrollTop = 0;
  $('#drawer-body').innerHTML = `<div class="empty">${L('se încarcă...', 'loading...')}</div>`;
  const r = await window.vp.act('serverEnvRead');
  if (S.drawer !== 'env:') return;
  if (!r.ok) { $('#drawer-body').innerHTML = `<div class="empty">${esc(r.error)}</div>`; return; }
  Object.assign(ENV, { file: r.file, text: r.text, vars: r.vars, known: r.known, changes: {}, raw: false, rawText: null, busy: false, players: r.players });
  renderServerEnv();
}
function envRow(k, type, label, hint) {
  const v = envVal(k), set = v !== undefined && v !== null, changed = k in ENV.changes;
  let ctl;
  if (type === 'bool') ctl = `<select class="select" data-env="${k}"><option value="" ${!set ? 'selected' : ''}>${L('(implicitul imaginii)', '(image default)')}</option><option value="true" ${set && /^true$/i.test(v) ? 'selected' : ''}>${L('da', 'yes')}</option><option value="false" ${set && /^false$/i.test(v) ? 'selected' : ''}>${L('nu', 'no')}</option></select>`;
  else ctl = `<input class="txt" data-env="${k}" type="${type === 'password' ? 'password' : 'text'}" ${type === 'number' ? 'inputmode="numeric"' : ''} value="${esc(set ? v : '')}" placeholder="${L('nesetat', 'not set')}" spellcheck="false" autocomplete="off">`;
  return `<div class="cfg-row ${changed ? 'changed' : ''}" data-envrow="${k}"><div class="cfg-l"><b>${esc(label)}</b><small><code>${k}</code>${hint ? ' - ' + esc(hint) : ''}</small></div><div class="cfg-c">${ctl}</div></div>`;
}
function renderServerEnv() {
  const knownKeys = new Set(ENV.known.flatMap(([, rows]) => rows.map(r => r[0])));
  const other = ENV.vars.filter(v => !knownKeys.has(v.key));
  const body = ENV.raw ? `<textarea class="cfg-raw no-i18n" id="env-raw" spellcheck="false">${esc(ENV.rawText ?? ENV.text)}</textarea>`
    : ENV.known.map(([g, rows]) => `<details class="cfg-sec" open><summary class="no-i18n">${esc(g)}</summary><div class="no-i18n">${rows.map(r => envRow(...r)).join('')}</div></details>`).join('')
      + (other.length ? `<details class="cfg-sec" open><summary class="no-i18n">${L('Altele din fișier', 'Other variables in the file')}</summary><div class="no-i18n">${other.map(v => envRow(v.key, /PASS|TOKEN|KEY|SECRET/i.test(v.key) ? 'password' : 'text', v.key, '')).join('')}</div></details>` : '');
  const n = ENV.raw ? (envDirty() ? 1 : 0) : Object.keys(ENV.changes).length;
  $('#drawer-body').innerHTML = `
    <div class="cfg-head"><h2>${L('Setări server', 'Server settings')}</h2><div class="muted"><span class="no-i18n">${esc(ENV.file)}</span> · ${L('se aplică la recrearea containerului (serverul repornește)', 'applied when the container is recreated (the server restarts)')}</div></div>
    <div class="cfg-tools"><span class="muted small">${L('Gol = nesetat (imaginea folosește valoarea ei implicită).', 'Empty = not set (the image uses its default).')}</span>
      <div class="seg" id="env-mode"><button class="${ENV.raw ? '' : 'on server'}" data-mode="form">${L('Setări', 'Settings')}</button><button class="${ENV.raw ? 'on server' : ''}" data-mode="raw">Text</button></div></div>
    <div id="cfg-body">${body}</div>
    <div class="cfg-bar" id="env-bar"><span class="${n ? '' : 'muted'}">${n ? L(`${n} modificări nesalvate`, `${n} unsaved ${n === 1 ? 'change' : 'changes'}`) : L('Nicio modificare', 'No changes')}</span>
      <div class="row gap"><button class="btn ghost small" id="env-discard" ${n ? '' : 'disabled'}>${L('Renunță', 'Discard')}</button><button class="btn primary ${ENV.busy ? 'working' : ''}" id="env-save" ${n && !ENV.busy ? '' : 'disabled'}>${ENV.busy ? L('Salvez...', 'Saving...') : L('Salvează', 'Save')}</button></div></div>`;
}
async function saveServerEnv() {
  if (ENV.busy) return;
  ENV.busy = true; renderServerEnv();
  const r = await window.vp.act('serverEnvSave', ENV.raw ? { text: ENV.rawText, expect: ENV.text } : { changes: ENV.changes, expect: ENV.text });
  ENV.busy = false;
  if (!r.ok) { toast(r.error, 'error'); if (/changed on the server/.test(r.error)) openServerEnv(); else renderServerEnv(); return; }
  if (r.unchanged) { toast(L('Nimic de salvat.', 'Nothing to save.')); openServerEnv(); return; }
  const p = ENV.players;
  const now = await confirmBox(L('Aplici acum?', 'Apply now?'),
    L(`Salvat (${r.changed.join(', ')}). Ca să se aplice, containerul se recreează și serverul repornește (~2-3 minute)${p ? ` - ${p} jucători online vor fi deconectați` : ''}. Poți aplica și mai târziu, de aici.`,
      `Saved (${r.changed.join(', ')}). To apply it, the container is recreated and the server restarts (~2-3 minutes)${p ? ` - ${p} ${p === 1 ? 'player' : 'players'} online will be disconnected` : ''}. You can also apply it later from here.`),
    L('Aplică acum', 'Apply now'));
  if (now) { const a = await window.vp.act('serverEnvApply'); toast(a.ok ? L('Se aplică - serverul repornește în fundal.', 'Applying - the server restarts in the background.') : a.error, a.ok ? 'ok' : 'error'); }
  else toast(L('Salvat. Se aplică la următoarea recreare a containerului.', 'Saved. It applies at the next container recreate.'), 'ok');
  openServerEnv();
}
$('#btn-server-env').onclick = () => openServerEnv();
$('#drawer-body').addEventListener('input', e => {
  if (S.drawer !== 'env:') return;
  if (e.target.id === 'env-raw') { ENV.rawText = e.target.value; const bar = $('#env-bar'); if (bar) renderServerEnvBar(); return; }
  const k = e.target.dataset?.env; if (!k) return;
  const orig = ENV.vars.find(v => v.key === k)?.value, v = e.target.value === '' ? null : e.target.value;
  if ((v ?? null) === (orig ?? null)) delete ENV.changes[k]; else ENV.changes[k] = v;
  $(`#cfg-body [data-envrow="${k}"]`)?.classList.toggle('changed', k in ENV.changes);
  renderServerEnvBar();
});
function renderServerEnvBar() {
  const bar = $('#env-bar'); if (!bar) return;
  const n = ENV.raw ? (envDirty() ? 1 : 0) : Object.keys(ENV.changes).length;
  bar.querySelector('span').textContent = n ? L(`${n} modificări nesalvate`, `${n} unsaved ${n === 1 ? 'change' : 'changes'}`) : L('Nicio modificare', 'No changes');
  bar.querySelector('span').className = n ? '' : 'muted';
  $('#env-discard').disabled = !n; $('#env-save').disabled = !n || ENV.busy;
}
$('#drawer-body').addEventListener('click', async e => {
  if (S.drawer !== 'env:') return;
  const md = e.target.closest('#env-mode button');
  if (md) {
    const raw = md.dataset.mode === 'raw'; if (raw === ENV.raw) return;
    if (envDirty() && !await confirmBox(L('Renunți la modificări?', 'Discard the changes?'), L('Ca să schimbi modul de editare, salvează sau renunță la modificări.', 'To switch the editing mode, save or discard the changes.'), L('Renunță la ele', 'Discard them'))) return;
    Object.assign(ENV, { raw, rawText: null, changes: {} }); renderServerEnv(); return;
  }
  if (e.target.closest('#env-discard')) { Object.assign(ENV, { rawText: null, changes: {} }); renderServerEnv(); return; }
  if (e.target.closest('#env-save')) saveServerEnv();
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
  const vh = (S.settings.game?.id || 'valheim') === 'valheim';
  if (!vh) $('#pl-addr').textContent = srv.address || (S.settings.addresses || '').split(/[;\n]/).map(x => x.split('=')[1]).find(Boolean)?.trim() || L('cere-l adminului', 'ask the admin');
  const direct = vh && S.settings.directJoin && !!S.settings.joinTarget;
  $('#pl-howto-direct').hidden = !direct; $('#pl-howto-manual').hidden = direct || !vh;
  $('#pl-howto-other').hidden = vh;
  if (!vh) $('#pl-howto-other').innerHTML = L(`În joc: <b>Join</b> și caută serverul după nume (sau adresa de mai sus). Bifrost pornește ${esc(gameName())} prin Steam, cu EML și modurile serverului.`, `In game: <b>Join</b> and look the server up by name (or the address above). Bifrost starts ${esc(gameName())} through Steam with EML and the server's mods.`);
  $('#pl-game-label').textContent = gameName();
  $('#pl-game').innerHTML = P.game?.game ? esc(P.game.game) : '<span style="color:var(--red)">negăsit</span> · <a href="#" data-page-link="settings">alege folderul</a>';

  const btn = $('#btn-play'), g = S.game || {};
  // pressed -> spinner and locked until the game is up; while it runs no second copy can be started
  const starting = S.playPressed || g.launching || (S.job && S.job.kind === 'play');
  btn.disabled = !!S.job || starting || g.running || (!m && !own);
  btn.classList.toggle('working', !!(S.job || starting));
  btn.classList.toggle('running', !!g.running && !starting);
  btn.textContent = g.running && !starting ? L(`${gameName()} rulează`, `${gameName()} is running`) : starting ? (S.job?.kind === 'play' ? 'Se pregătește...' : 'Pornește...') : S.job ? 'Lucrez...' : 'JOACĂ';
  $('#pl-play-note').textContent = !m ? '' : need ? L(`întâi: ${P.plan.install.length} de instalat${P.plan.remove.length ? `, ${P.plan.remove.length} de scos` : ''}`, `first: ${P.plan.install.length} to install${P.plan.remove.length ? `, ${P.plan.remove.length} to remove` : ''}`) + (P.plan.bytes ? ` (~${fmtMB(P.plan.bytes)})` : '') : L('modurile sunt la zi', 'mods are up to date');

  // mods summary
  const ring = $('#pl-ring');
  const personal = !S.settings.isAdmin && !S.settings.server?.list;
  $$('#page-home [data-act="updateMods"], #page-home [data-act="refreshList"]').forEach(b => { b.hidden = personal; });
  $('#pl-code-box').hidden = personal;
  // (no server: no address / join code rows, no joining hints)
  for (const id of ['#pl-addr', '#pl-code2']) $(id).closest('.kv').hidden = personal;
  if (personal) { $('#pl-howto-manual').hidden = true; $('#pl-howto-direct').hidden = true; $('#pl-howto-other').hidden = true; }
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
  if (!P.nexusWaiting?.length && P.nexusNeeded?.length && !S.settings.hasNexusKey) {
    nw.hidden = false;
    nw.innerHTML = `<span><b>Serverul are ${P.nexusNeeded.length} ${P.nexusNeeded.length === 1 ? 'mod' : 'moduri'} de pe Nexus Mods</b> <span>(${P.nexusNeeded.map(esc).join(', ')})</span>. <span>Pune-ți cheia Nexus și Bifrost le descarcă singur.</span></span>
      <button class="btn small primary" id="btn-nexus-key-now">Adaugă cheia Nexus</button>`;
  } else if (P.nexusWaiting?.length) {
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
// the server needs mods from Nexus and this player has no key yet: ask for it (Nexus' API key page opens beside)
async function askNexusKey(mods) {
  window.vp.act('open', 'https://next.nexusmods.com/settings/api-keys');
  const list = (mods || []).slice(0, 6).join(', ') + ((mods || []).length > 6 ? ` și încă ${mods.length - 6}` : '');
  const v = await confirmBox('Cheia ta Nexus Mods',
    `Serverul folosește moduri de pe Nexus Mods (${list}). Ca să le descarc am nevoie de cheia ta personală: s-a deschis pagina nexusmods.com → Settings → API Keys - copiază de acolo „Personal API Key” și lipește-o aici. Premium: totul se descarcă singur. Cont gratuit: deschid pagina fiecărui fișier și apeși acolo „Slow download”, restul fac eu.`,
    'Salvează și continuă', '');
  if (!v) return false;
  const r = await window.vp.act('setNexusKey', v);
  if (!r.ok) { toast(`Cheia nu merge: ${r.error}`, 'error'); return false; }
  toast(`Conectat la Nexus ca ${r.user.name}${r.user.premium ? ' (Premium)' : ''}.`, 'ok');
  return true;
}
$('#btn-play').onclick = async () => {
  if (S.playPressed) return;
  // lock the button right away, before main answers
  S.playPressed = true; S.lastPlayError = null; renderPlayer();
  let again = false;
  try {
    const r = await window.vp.act('play');
    if (r.needNexusKey) again = await askNexusKey(r.mods);
    else if (!r.ok) { S.lastPlayError = r.error; toast(r.error, 'error'); }
  } finally { S.playPressed = false; renderPlayer(); }
  if (again) $('#btn-play').click();
};
document.addEventListener('click', async e => { if (e.target.closest('#btn-nexus-key-now')) { if (await askNexusKey(S.player?.nexusNeeded)) renderPlayer(); } });
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
  $('#list-sub').textContent = l.error || (srv.list ? L(`Prietenii deschid invitația în Bifrost și primesc exact modurile serverului${S.settings.autoPublish ? ' - lista se publică singură după fiecare sincronizare și la join code nou.' : '.'}`, `Friends open the invite in Bifrost and get exactly the server's mods${S.settings.autoPublish ? ' - the list publishes itself after every sync and on a new join code.' : '.'}`)
    : 'Lista se creează la prima publicare (un Gist privat pe contul tău GitHub) - apoi primești linkul de invitație.');
  $('#invite-box').hidden = !srv.list;
  if (srv.list) { $('#inv-link').textContent = srv.inviteLink; $('#inv-code').textContent = srv.invite; }
  $('#btn-publish-list').disabled = !!l.busy;
}
const listUrl = l => !l ? null : l.kind === 'gist' ? `https://gist.github.com/${l.id}` : l.kind === 'github' ? `https://github.com/${l.repo}/blob/main/${l.path || 'server.json'}` : l.url;
$('#btn-list-open').onclick = () => { const u = listUrl(S.settings.server?.list); if (u) window.vp.act('open', u); else toast('Lista nu e publicată încă.'); };
const shareText = () => { const v = S.settings.server; return L(`Hai pe serverul nostru de ${gameName()} „${v.name}”!\n1. Instalează Bifrost: https://github.com/FlorinCamarut1/bifrost/releases/latest\n2. Deschide invitația: ${v.inviteLink}\n   (sau în Bifrost: Adaugă server → codul ${v.invite})\n3. Apasă JOACĂ - modurile se instalează singure.`, `Join our ${gameName()} server "${v.name}"!\n1. Install Bifrost: https://github.com/FlorinCamarut1/bifrost/releases/latest\n2. Open the invite: ${v.inviteLink}\n   (or in Bifrost: Add server → the code ${v.invite})\n3. Press PLAY - the mods install by themselves.`); };
$('#btn-share-text').onclick = async () => { await window.vp.act('copy', shareText()); toast('Mesajul e copiat - lipește-l pe Discord.', 'ok'); };
$('#btn-copy-invite').onclick = async () => { const v = S.settings.server; if (!v?.inviteLink) return toast('Serverul nu are încă o listă publicată.', 'error'); await window.vp.act('copy', shareText()); toast('Invitația e copiată.', 'ok'); };
$('#btn-export-code').onclick = async () => {
  const withCfg = await confirmBox('Cod de profil Thunderstore', 'Pun în cod și configurările modurilor? (De obicei da, ca prietenii să aibă aceleași setări.)', 'Da, cu configurări');
  toast('Generez codul...');
  const r = await window.vp.act('exportCode', { configs: withCfg });
  if (!r.ok) return toast(r.error, 'error');
  await window.vp.act('copy', r.code);
  toast(L(`Cod copiat: ${r.code} - în r2modman / TMM: Import / update → From code.`, `Code copied: ${r.code} - in r2modman / TMM: Import / update → From code.`), 'ok');
};
$('#btn-remove-server').onclick = async () => {
  const v = S.settings.server; if (!v) return;
  if (!await confirmBox(L(`Ștergi „${v.name}” din Bifrost?`, `Remove "${v.name}" from Bifrost?`), L('Profilul lui de moduri și setările lui dispar de pe PC-ul tău. Serverul în sine și lista publicată rămân neatinse.', 'Its mod profile and settings are removed from your PC. The server itself and the published list stay untouched.'), L('Șterge', 'Remove'))) return;
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
  $('#srv-menu').innerHTML = list.map(x => `<button class="srv-item ${cur && x.id === cur.id ? 'on' : ''}" data-switch="${esc(x.id)}"><span class="srv-badge">${esc((x.name || '?')[0].toUpperCase())}</span>${esc(x.name)}${x.game && x.game !== 'valheim' ? `<span class="game-tag">${esc(x.game)}</span>` : ''}<small>${roleName(x.role)}</small></button>`).join('')
    + `${list.length ? '<hr>' : ''}<button class="srv-item" data-menu="join">＋ Am o invitație</button><button class="srv-item" data-menu="create">＋ Creează server</button><button class="srv-item" data-menu="local">＋ Profil personal</button>`;
  if (cur) {
    const c = cur.conn;
    $('#set-conn').textContent = !c ? 'fără conexiune - doar lista' : c.type === 'ssh-docker' ? `${c.host}, Docker „${c.container}”` : c.type === 'ssh' ? `SSH ${c.host}: ${c.serverDir || c.pluginsDir}` : c.type === 'local' ? `acest PC: ${c.serverDir || c.pluginsDir}` : `FTP ${c.host}: ${c.serverDir || c.pluginsDir}`;
    $('#set-invite').textContent = cur.inviteLink ? `${cur.invite}` : 'lista nu e publicată încă';
    $('#set-srv-title').textContent = L(`Serverul acesta: ${cur.name}`, `This server: ${cur.name}`);
  }
  const gh = $('#gh-state');
  if (gh) gh.innerHTML = st.githubUser ? L(`<span style="color:var(--green)">✓ Conectat ca <b>${esc(st.githubUser)}</b></span> - lista e un Gist privat pe contul tău.`, `<span style="color:var(--green)">✓ Connected as <b>${esc(st.githubUser)}</b></span> - the list is a secret Gist on your account.`) : L('Pentru publicarea listei (un Gist privat pe contul tău). Merge și GitHub CLI (<code>gh</code>), dacă e logat.', 'To publish the list (a secret Gist on your account). The GitHub CLI (<code>gh</code>) works too, if it is logged in.');
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
  toast(r.ok ? (r.existed ? L('Serverul era deja adăugat - l-am deschis.', 'The server was already added - it is open now.') : L(`Server adăugat: ${r.name} (${r.required} moduri). Apasă JOACĂ.`, `Server added: ${r.name} (${r.required} ${r.required === 1 ? 'mod' : 'mods'}). Press PLAY.`)) : r.error, r.ok ? 'ok' : 'error');
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
  $('#wiz-note').textContent = mode === 'create' ? (S.settings.githubUser || S.settings.hasGithubToken ? '' : L('Lista pentru prieteni se publică după ce te conectezi la GitHub (Setări → Conturi) sau dacă ai GitHub CLI logat.', 'The list for friends is published once you connect GitHub (Settings → Accounts) or have the GitHub CLI logged in.')) : '';
  $('#wz-test-res').textContent = '';
  // a new server picks its game; the connection / import of an existing one follows its game
  const fresh = mode === 'create' || mode === 'local';
  $('#wz-game').closest('.field').hidden = !fresh;
  $('#wz-game').value = fresh ? 'valheim' : S.settings.game?.id || 'valheim';
  if (mode === 'conn' && cur?.conn) {
    const c = cur.conn;
    $('#wz-type').value = c.type; $('#wz-host').value = c.host || ''; $('#wz-port').value = c.port || ''; $('#wz-container').value = c.container || '';
    $('#wz-fhost').value = c.host || ''; $('#wz-fport').value = c.port || ''; $('#wz-fuser').value = c.user || ''; $('#wz-fsecure').checked = !!c.secure;
    $('#wz-plugins').value = c.pluginsDir || ''; $('#wz-config').value = c.configDir || ''; $('#wz-restart').value = c.restartCmd || ''; $('#wz-serverdir').value = c.serverDir || '';
  }
  wizType();
  window.vp.act('localProfiles').then(r => {
    $('#wz-local').innerHTML = (r.profiles || []).map(p => `<option value="${esc(p.dir)}">${esc(p.manager)} - ${esc(p.name)} (${L(`${p.mods} moduri${p.manual ? `, ${p.manual} manuale` : ''}`, `${p.mods} mods${p.manual ? `, ${p.manual} manual` : ''}`)})</option>`).join('') || `<option value="">${L('(niciun profil găsit)', '(no profile found)')}</option>`;
  });
  w.hidden = false;
  setTimeout(() => $(mode === 'create' || mode === 'local' ? '#wz-name' : '#wz-type').focus(), 50);
}
function wizType() {
  const t = $('#wz-type').value, game = $('#wz-game').value, vh = game === 'valheim';
  $$('#wiz [data-for]').forEach(el => { el.hidden = !el.dataset.for.split(' ').includes(t) || (!!el.dataset.game && el.dataset.game !== game); });
  $$('#wiz .radio[data-game]').forEach(el => { el.hidden = el.dataset.game !== game; if (el.hidden && el.querySelector('input').checked) $('#wiz input[name="wz-src"][value="empty"]').checked = true; });
  $('#wz-local').hidden = !vh || $('#wiz input[name="wz-src"]:checked').value !== 'local'; $('#wz-code').hidden = !vh || $('#wiz input[name="wz-src"]:checked').value !== 'code';
  $('#wz-type option[value="ssh-docker"]').textContent = vh ? 'Linux prin SSH, în Docker (imaginea valheim-server)' : L('Linux prin SSH, în Docker', 'Linux over SSH, in Docker');
  $('#wz-container').placeholder = vh ? 'valheim' : 'enshrouded';
  // (the empty profile: BepInEx for Valheim, the EML loader for Enshrouded)
  $('#wiz input[name="wz-src"][value="empty"]').closest('.radio').querySelector('small').textContent = vh ? 'Doar BepInEx; adaugi tu din Descoperă.' : L('Doar EML (încărcătorul de moduri); adaugi tu din Descoperă (Nexus).', 'Only EML (the mod loader); add mods from Discover (Nexus).');
  $('#wiz input[name="wz-src"][value="server"]').closest('.radio').querySelector('small').textContent = vh ? 'Citesc pluginurile de pe server și le iau din Thunderstore; restul vin ca moduri manuale.' : L('Copiez modurile din folderul mods al serverului.', "Copies the mods from the server's mods folder.");
  const note = $('#wz-game-note');
  note.hidden = vh;
  if (!vh) note.innerHTML = L('Enshrouded: modurile vin de pe Nexus și le încarcă <b>EML</b> (dbghelp.dll lângă joc și lângă server). Serverul Docker are nevoie de <code>WINEDLLOVERRIDES=dbghelp=native,builtin</code> în environment (imaginea mornedhels/enshrouded-server merge; sknnr pornește din alt folder și EML nu se încarcă). Modurile de dinainte de 1.0 pot să nu meargă pe 1.0.',
    'Enshrouded: mods come from Nexus and <b>EML</b> loads them (dbghelp.dll next to the game and the server). A Docker server needs <code>WINEDLLOVERRIDES=dbghelp=native,builtin</code> in its environment (the mornedhels/enshrouded-server image works; sknnr starts from another folder, so EML does not load). Mods made before 1.0 may not work on 1.0.');
  const ph = { 'ssh-docker': ['/config/valheimplus/plugins', '/config/valheimplus'], ssh: ['/home/steam/valheim/BepInEx/plugins', '/home/steam/valheim/BepInEx/config'], local: ['C:\\valheim-server\\BepInEx\\plugins', 'C:\\valheim-server\\BepInEx\\config'], ftp: ['/BepInEx/plugins', '/BepInEx/config'] }[t];
  if (ph) { $('#wz-plugins').placeholder = ph[0]; $('#wz-config').placeholder = ph[1]; }
  $('#wz-serverdir').placeholder = { 'ssh-docker': '/opt/enshrouded/server', ssh: '/home/steam/enshrouded', local: 'C:\\enshrouded-server', ftp: '/' }[t] || '';
}
$('#wz-type').addEventListener('change', wizType);
$('#wz-game').addEventListener('change', wizType);
$$('#wiz input[name="wz-src"]').forEach(r => r.addEventListener('change', () => { const v = $('#wiz input[name="wz-src"]:checked').value; $('#wz-local').hidden = v !== 'local'; $('#wz-code').hidden = v !== 'code'; }));
function wizConn() {
  const t = $('#wz-type').value;
  if (t === 'none') return null;
  const c = { type: t };
  if (t === 'ssh-docker' || t === 'ssh') { c.host = $('#wz-host').value.trim(); if ($('#wz-port').value.trim()) c.port = +$('#wz-port').value; }
  const vh = $('#wz-game').value === 'valheim';
  if (t === 'ssh-docker') c.container = $('#wz-container').value.trim() || (vh ? 'valheim' : 'enshrouded');
  if (t === 'ftp') { c.host = $('#wz-fhost').value.trim(); c.user = $('#wz-fuser').value.trim(); c.secure = $('#wz-fsecure').checked; if ($('#wz-fport').value.trim()) c.port = +$('#wz-fport').value; }
  const pl = $('#wz-plugins').value.trim(), cf = $('#wz-config').value.trim(), rs = $('#wz-restart').value.trim();
  if (rs && (t === 'ssh' || t === 'local')) c.restartCmd = rs;
  if (!vh) {
    // Enshrouded: the server's folder; its mods/ folder is next to enshrouded_server.exe
    c.serverDir = $('#wz-serverdir').value.trim() || (t === 'ssh-docker' ? '/opt/enshrouded/server' : '');
    if (!c.serverDir) throw new Error(L('Completează folderul serverului (unde e enshrouded_server.exe).', 'Fill in the server folder (where enshrouded_server.exe is).'));
  } else {
    if (pl) c.pluginsDir = pl; if (cf) c.configDir = cf;
    if (t !== 'ssh-docker' && (!c.pluginsDir || !c.configDir)) throw new Error('Completează folderele de pluginuri și de configurări.');
  }
  if ((t === 'ssh-docker' || t === 'ssh' || t === 'ftp') && !c.host) throw new Error('Completează hostul.');
  return c;
}
$('#wz-test').onclick = async () => {
  let c; try { c = wizConn(); } catch (e) { $('#wz-test-res').textContent = e.message; return; }
  if (!c) return;
  $('#wz-test-res').textContent = 'testez...';
  const r = await window.vp.act('testConnection', { conn: c, secret: $('#wz-fpass').value || undefined, game: $('#wz-game').value });
  $('#wz-test-res').innerHTML = !r.ok ? `<span style="color:var(--red)">${esc(r.error)}</span>`
    : L(`<span style="color:var(--green)">✓ conectat</span> · pluginuri: ${r.plugins ? `da${r.mods != null ? ` (${r.mods})` : ''}` : '<b>nu găsesc folderul</b>'} · configurări: ${r.config ? 'da' : '<b>nu găsesc folderul</b>'}`, `<span style="color:var(--green)">✓ connected</span> · plugins: ${r.plugins ? `yes${r.mods != null ? ` (${r.mods})` : ''}` : '<b>folder not found</b>'} · configs: ${r.config ? 'yes' : '<b>folder not found</b>'}`);
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
      const r = await window.vp.act('createServer', { name, game: $('#wz-game').value, world: $('#wz-world').value.trim(), conn: wizMode === 'create' ? conn : null, secret, source, personal: wizMode === 'local' });
      toast(r.ok ? L(`Gata: ${r.count} pachete în profil.${wizMode === 'create' && conn ? ' Pun modurile pe server...' : ''}`, `Done: ${r.count} packages in the profile.${wizMode === 'create' && conn ? ' Putting the mods on the server...' : ''}`) : r.error, r.ok ? 'ok' : 'error');
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
  confirmBox(L('Conectare la GitHub', 'Connect to GitHub'), L(`S-a deschis ${r.uri}. Introdu codul ${r.code} (e deja copiat) și apasă Authorize. Bifrost află singur când ai terminat.`, `${r.uri} has opened. Enter the code ${r.code} (already copied) and press Authorize. Bifrost notices by itself when you are done.`), 'OK');
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
  $('#upd-state').textContent = !u ? L('se verifică...', 'checking...') : u.error ? L(`nu am putut verifica: ${u.error}`, `could not check: ${u.error}`)
    : u.ready ? L(`Versiunea ${u.version} e descărcată - repornește ca s-o folosești.`, `Version ${u.version} is downloaded - restart to use it.`)
      : u.downloading ? L(`Se descarcă versiunea ${u.version}...`, `Downloading version ${u.version}...`)
        : u.installer ? (u.source ? L(`Versiunea ${u.version} e disponibilă. Rulezi din sursă: ia varianta portabilă de pe GitHub ca să primești update-uri automate.`, `Version ${u.version} is available. You run from source: get the portable build from GitHub to receive automatic updates.`) : L(`Versiunea ${u.version} are nevoie de installer-ul nou.`, `Version ${u.version} needs the new installer.`))
          : `Ai ultima versiune · verificat ${ago(u.checkedAt)}`;
  $('#btn-upd-go').hidden = !u?.ready;
  $('#btn-upd-dl').hidden = !u?.installer;
  if (!u || u.upToDate || u.error) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = u.installer ? `<b>Bifrost ${esc(u.version)}</b> e disponibil.<button class="btn small primary" id="btn-app-dl">Descarcă</button>`
    : u.ready ? `<b>Bifrost ${esc(u.version)}</b> ${L('e gata.', 'is ready.')}<button class="btn small primary" id="btn-app-update">${L('Repornește și actualizează', 'Restart and update')}</button>` : L(`Se descarcă Bifrost ${esc(u.version)}...`, `Downloading Bifrost ${esc(u.version)}...`);
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
  else if (ch === 'queue') { S.queue = d; renderWatch(); }
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
  Object.assign(S, { settings: d.settings, profile: d.profile, status: d.status, job: d.job, watch: d.watch, updates: d.updates, modpack: d.modpack, game: d.game || {}, queue: d.queue || [], installing: d.installing || {}, catalogFetched: d.catalogFetched, player: d.player, list: d.list || {}, appUpdate: d.appUpdate });
  logEntries = d.log; $('#log').innerHTML = d.log.map(logLine).join('\n') + '\n';
  $('#about').textContent = `Bifrost ${d.version}${d.settings.packaged ? '' : ' (din sursă)'} · ${(d.settings.servers || []).length} servere`;
  applyLang();
  renderSettings();
  renderHowto();
  go(!d.settings.server ? 'welcome' : d.settings.isAdmin ? 'server' : 'home');
  renderStatus(); renderWatch(); renderMods(); renderModpack(); renderMiniLog(); renderPlayer(); renderPlayerMods(); renderList(); renderAppUpdate(); renderSettingsGame();
  setInterval(() => { renderWatch(); renderStatus(); }, 30000);
})();
