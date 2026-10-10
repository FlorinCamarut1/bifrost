// The server's mod list for players, published by the admin's Bifrost as a JSON file in a public GitHub repo
// (through the GitHub CLI the admin is logged in with) and read by every player's Bifrost.
const { execFile } = require('child_process');

const FILE = 'server.json';

function gh(args, input) {
  return new Promise((resolve, reject) => {
    const p = execFile('gh', args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (e, out, err) => e ? reject(new Error((err || e.message).trim())) : resolve(out));
    if (input !== undefined) p.stdin.end(input);
  });
}

// what players need, from the admin's Thunderstore profile + server/client classification
function build({ mods, server, nexusLinks }) {
  const req = [], rec = [];
  for (const m of mods) {
    if (!m.enabled || m.manual || m.modpack || !m.name.includes('-')) continue;
    const e = { full: m.name, ver: m.version, title: m.displayName };
    if (m.builtin || m.side === 'server') req.push(e); else rec.push(e);
  }
  const nexus = [];
  for (const m of mods) {
    const l = m.nexus || nexusLinks[m.name];
    if (!m.manual || !l) continue;
    nexus.push({ key: `nexus-${l.modId}`, title: l.title || m.displayName, modId: l.modId, fileId: l.fileId, version: l.version, fileName: l.fileName, required: m.side === 'server' });
  }
  const by = (a, b) => a.full.localeCompare(b.full);
  return { schema: 1, app: 'bifrost', server, required: req.sort(by), recommended: rec.sort(by), nexus };
}

// the same content ignoring timestamps -> no commit
const fingerprint = m => JSON.stringify({ ...m, updatedAt: 0, server: { ...m.server, joinCodeAt: 0 } });

async function publish(repo, manifest, message) {
  let sha = null, current = null;
  try {
    const out = JSON.parse(await gh(['api', `repos/${repo}/contents/${FILE}`]));
    sha = out.sha; current = JSON.parse(Buffer.from(out.content, 'base64').toString('utf8'));
  } catch (e) { if (!/404|Not Found/i.test(e.message)) throw e; }
  if (current && fingerprint(current) === fingerprint(manifest)) return { changed: false };
  const body = { message, content: Buffer.from(JSON.stringify(manifest, null, 2) + '\n').toString('base64'), ...(sha ? { sha } : {}) };
  await gh(['api', '--method', 'PUT', `repos/${repo}/contents/${FILE}`, '--input', '-'], JSON.stringify(body));
  return { changed: true };
}

async function fetchManifest(fetch, repo) {
  // the contents API is not CDN-cached (raw.githubusercontent.com lags up to 5 minutes)
  const r = await fetch(`https://api.github.com/repos/${repo}/contents/${FILE}`, {
    headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'Bifrost' },
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const m = JSON.parse(await r.text());
  if (m.app !== 'bifrost' || !Array.isArray(m.required)) throw new Error('lista serverului nu e validă');
  return m;
}

module.exports = { build, publish, fetchManifest, FILE };
