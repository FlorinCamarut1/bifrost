// The server's own settings for the valheim-server Docker image: the variables in the compose file's env_file
// (e.g. valheim.env). Lines are changed in place - comments, order and unknown variables stay as they were.
const path = require('path').posix;
const yaml = require('js-yaml');

// the image's variables, grouped for the settings panel (unknown ones are shown under "Other")
const KNOWN = [
  ['Server', [
    ['SERVER_NAME', 'text', 'Server name', 'The name in the game\'s server list.'],
    ['SERVER_PASS', 'password', 'Password', 'At least 5 characters, and not part of the server name (Valheim refuses that).'],
    ['WORLD_NAME', 'text', 'World', 'Changing it loads (or creates) ANOTHER world - the current one stays on disk.'],
    ['SERVER_PUBLIC', 'bool', 'In the public server list', 'Shown under Join game → Community (still protected by the password).'],
    ['CROSSPLAY', 'bool', 'Crossplay', 'Join codes, and Xbox / Game Pass players can join.'],
    ['TZ', 'text', 'Time zone', 'For the times in the logs and the schedules below, e.g. Europe/Bucharest.'],
  ]],
  ['Players', [
    ['ADMINLIST_IDS', 'text', 'Admins', 'Steam IDs (SteamID64), separated by spaces.'],
    ['BANNEDLIST_IDS', 'text', 'Banned', 'Steam IDs, separated by spaces.'],
    ['PERMITTEDLIST_IDS', 'text', 'Allowed only', 'If set, only these Steam IDs can join.'],
  ]],
  ['Backups', [
    ['BACKUPS', 'bool', 'World backups', 'Made by the image inside the server (config/backups).'],
    ['BACKUPS_CRON', 'text', 'When', 'Cron schedule, e.g. "5 * * * *" = every hour at :05.'],
    ['BACKUPS_MAX_AGE', 'number', 'Keep for (days)', ''],
    ['BACKUPS_MAX_COUNT', 'number', 'Keep at most', '0 = no limit.'],
    ['BACKUPS_IF_IDLE', 'bool', 'Also when nobody plays', ''],
  ]],
  ['Updates and restarts', [
    ['UPDATE_CRON', 'text', 'Check for Valheim updates', 'Cron schedule, e.g. "*/15 * * * *" = every 15 minutes.'],
    ['UPDATE_IF_IDLE', 'bool', 'Update only when nobody plays', ''],
    ['RESTART_CRON', 'text', 'Scheduled restart', 'Cron schedule, e.g. "0 5 * * *" = every day at 05:00. Empty = none.'],
    ['RESTART_IF_IDLE', 'bool', 'Restart only when nobody plays', ''],
  ]],
  ['Advanced', [
    ['SERVER_ARGS', 'text', 'Extra server arguments', 'Passed to valheim_server as they are.'],
    ['SERVER_PORT', 'number', 'Port', 'Changing it also needs the ports in docker-compose.yaml and the router - Bifrost does not change those.'],
    ['VALHEIM_PLUS', 'bool', 'ValheimPlus', 'Turning it off changes where the server loads mods from - Bifrost\'s mod folder is the ValheimPlus one.'],
  ]],
];

function parse(text) {
  const vars = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s?(.*)$/);
    if (!m || /^\s*#/.test(line)) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1);
    vars.push({ key: m[1], value: v });
  }
  return vars;
}

const quote = v => (/[\s#"'$\\]/.test(v) ? `"${v.replace(/(["\\$])/g, '\\$1')}"` : v);

// changes: { KEY: 'value' | null (remove) } -> new text
function apply(text, changes) {
  const left = new Map(Object.entries(changes));
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = !/^\s*#/.test(line) && line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s?)(.*)$/);
    if (m && left.has(m[2])) {
      const v = left.get(m[2]); left.delete(m[2]);
      if (v === null) continue;
      out.push(m[1] + m[2] + m[3] + quote(String(v)));
    } else out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of left) if (v !== null) out.push(`${k}=${quote(String(v))}`);
  return out.join(eol) + eol;
}

// Valheim's own rules for the password
function check(vars) {
  const get = k => vars.find(v => v.key === k)?.value ?? '';
  const name = get('SERVER_NAME'), pass = get('SERVER_PASS');
  if (!name.trim()) return 'The server name cannot be empty.';
  if (pass && pass.length < 5) return 'The password needs at least 5 characters.';
  if (pass && name.toLowerCase().includes(pass.toLowerCase())) return 'The password must not be part of the server name.';
  return null;
}

// compose file(s) -> the env_file(s) of the service, as absolute paths on the host
function envFiles(composeTexts, workdir, service) {
  const files = [];
  for (const t of composeTexts) {
    let doc; try { doc = yaml.load(t); } catch { continue; }
    let ef = doc?.services?.[service]?.env_file;
    if (!ef) continue;
    if (!Array.isArray(ef)) ef = [ef];
    for (const e of ef) { const p = typeof e === 'string' ? e : e?.path; if (p) files.push(path.isAbsolute(p) ? p : path.join(workdir, p)); }
  }
  return files;
}

module.exports = { KNOWN, parse, apply, check, envFiles };
