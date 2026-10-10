// Where a server's list (server.json) lives, how players read it and how its admin publishes it.
//   { kind: 'gist', id }                    a GitHub Gist (default for new servers; published with the admin's GitHub login)
//   { kind: 'github', repo, path }          a file in a GitHub repo (the Litenari list: FlorinCamarut1/bifrost/server.json)
//   { kind: 'url', url }                    anything else that serves the JSON (read only)
// Invite codes: "g.<gistId>", "r.<owner>/<repo>[/path]", "u.<base64url(url)>" - inside bifrost://join/<code> links.
const FILE = 'server.json';
const UA = { 'User-Agent': 'Bifrost', Accept: 'application/vnd.github+json' };

function inviteCode(src) {
  if (src.kind === 'gist') return `g.${src.id}`;
  if (src.kind === 'github') return `r.${src.repo}${src.path && src.path !== FILE ? '/' + src.path : ''}`;
  return `u.${Buffer.from(src.url).toString('base64url')}`;
}
function parseInvite(text) {
  let s = String(text || '').trim();
  const link = s.match(/(?:bifrost:\/\/join\/|[#?&](?:join=)?)([gru]\.[^\s#&]+)/i);
  if (link) s = link[1];
  s = decodeURIComponent(s);
  let m;
  if ((m = s.match(/^g\.([0-9a-f]{20,40})$/i))) return { kind: 'gist', id: m[1] };
  if ((m = s.match(/^r\.([\w.-]+\/[\w.-]+)(?:\/(.+))?$/))) return { kind: 'github', repo: m[1], path: m[2] || FILE };
  if ((m = s.match(/^u\.([\w-]+)$/))) return { kind: 'url', url: Buffer.from(m[1], 'base64url').toString() };
  if ((m = s.match(/gist\.github(?:usercontent)?\.com\/(?:[\w-]+\/)?([0-9a-f]{20,40})/i))) return { kind: 'gist', id: m[1] };
  if (/^https:\/\//.test(s)) return { kind: 'url', url: s };
  return null;
}
const inviteLink = (src, page) => `${page}#${inviteCode(src)}`;

function validate(m) {
  if (!m || m.app !== 'bifrost' || !Array.isArray(m.required)) throw new Error('lista serverului nu e validă');
  return m;
}

async function fetchList(fetch, src) {
  let r;
  if (src.kind === 'gist') {
    // the API is not CDN-cached (gist raw URLs lag a few minutes)
    r = await fetch(`https://api.github.com/gists/${src.id}`, { headers: UA, cache: 'no-store' });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    const g = await r.json();
    const f = g.files[FILE] || Object.values(g.files)[0];
    if (!f) throw new Error('gist gol');
    const text = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
    return validate(JSON.parse(text));
  }
  if (src.kind === 'github') {
    r = await fetch(`https://api.github.com/repos/${src.repo}/contents/${src.path || FILE}`, { headers: { ...UA, Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    return validate(JSON.parse(await r.text()));
  }
  r = await fetch(src.url, { headers: { 'User-Agent': 'Bifrost' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return validate(JSON.parse(await r.text()));
}

// the same content ignoring timestamps -> nothing to publish
const fingerprint = m => JSON.stringify({ ...m, updatedAt: 0, server: { ...(m.server || {}), joinCodeAt: 0 } });

async function gh(fetch, token, method, p, body) {
  // no HTTP cache: the same contents URL is also read raw (fetchList), and a cached raw answer has no "content"
  const r = await fetch(`https://api.github.com${p}${method === 'GET' ? (p.includes('?') ? '&' : '?') + 'api=1' : ''}`, {
    cache: 'no-store', method, headers: { ...UA, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { }
  if (!r.ok) { const e = new Error(`GitHub ${r.status}: ${(j && j.message) || text.slice(0, 200)}`); e.status = r.status; throw e; }
  return j;
}

// -> { changed, src } (src gets an id when a gist was created)
async function publish(fetch, token, src, manifest, message) {
  const content = JSON.stringify(manifest, null, 2) + '\n';
  if (src.kind === 'gist') {
    if (!src.id) {
      const g = await gh(fetch, token, 'POST', '/gists', { description: `Bifrost - ${manifest.server?.name || 'Valheim server'}`, public: false, files: { [FILE]: { content } } });
      return { changed: true, src: { kind: 'gist', id: g.id } };
    }
    try { if (fingerprint(await fetchList(fetch, src)) === fingerprint(manifest)) return { changed: false, src }; } catch { }
    await gh(fetch, token, 'PATCH', `/gists/${src.id}`, { files: { [FILE]: { content } } });
    return { changed: true, src };
  }
  if (src.kind === 'github') {
    const p = `/repos/${src.repo}/contents/${src.path || FILE}`;
    let sha = null;
    try { const cur = await gh(fetch, token, 'GET', p); sha = cur.sha; if (fingerprint(JSON.parse(Buffer.from(cur.content, 'base64').toString())) === fingerprint(manifest)) return { changed: false, src }; }
    catch (e) { if (e.status !== 404) throw e; }
    await gh(fetch, token, 'PUT', p, { message: `server list: ${message}`, content: Buffer.from(content).toString('base64'), ...(sha ? { sha } : {}) });
    return { changed: true, src };
  }
  throw new Error('lista de la un URL oarecare nu se poate publica din Bifrost');
}

// ---------- GitHub login (device flow) ----------
async function deviceStart(fetch, clientId) {
  const r = await fetch('https://github.com/login/device/code', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: clientId, scope: 'gist' }) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(`GitHub: ${j.error_description || j.error || r.status}`);
  return j;   // { device_code, user_code, verification_uri, interval, expires_in }
}
async function devicePoll(fetch, clientId, start, cancelled = () => false) {
  let wait = (start.interval || 5) * 1000;
  const until = Date.now() + (start.expires_in || 900) * 1000;
  while (Date.now() < until && !cancelled()) {
    await new Promise(r => setTimeout(r, wait));
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, device_code: start.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    const j = await r.json();
    if (j.access_token) return j.access_token;
    if (j.error === 'slow_down') wait += 5000;
    else if (j.error !== 'authorization_pending') throw new Error(`GitHub: ${j.error_description || j.error}`);
  }
  throw new Error('login GitHub expirat');
}
async function whoami(fetch, token) { return gh(fetch, token, 'GET', '/user'); }

module.exports = { FILE, inviteCode, parseInvite, inviteLink, fetchList, publish, deviceStart, devicePoll, whoami };
