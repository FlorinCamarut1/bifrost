// XHL-Core's settings (in game: F10 → XHL Mod Settings), one JSON per module:
//   <game>/XHL/config/<module>.json            { version, module, values: {...}, worldDefaults: {...} }  the player's own
//   <server>/XHL/worlds/<world id>/<module>.json  { version, module, world, values: {...} }        the world's shared rules
// The world's rules are kept by the world's host - on a dedicated server, the server; the F10 menu does not offer every
// one of them to players. A mod's config.txt only gives a new world its first values: after that the world file wins
// (2026-11-04: Vein Mining's materialIds edited in config.txt never reached the world). Bifrost edits both files, the
// world's while the server is stopped (the server rewrites it while it runs), only the values that were changed.
// Vein Mining keeps its material list as a 128-bit mask in materials0..3 - shown as one list of ids.

const MASK = /^(.+?)([0-3])$/;

// [ro, en] descriptions of the settings whose meaning is known
const DESC = {
  'xhl-vein-mining': {
    materials: ['ID-urile materialelor care se sapă în lanț (1-127, separate prin virgulă). În joc ții apăsată tasta ` (sub Esc) cu ochii pe un bloc ca să-i vezi ID-ul.', 'Ids of the materials that chain-mine (1-127, comma separated). In game, hold the ` key (below Esc) while aiming at a block to see its id.'],
    miningXp: ['XP de minerit pentru blocurile săpate în lanț.', 'Mining XP for chain-mined blocks.'],
    enabled: ['Săpatul în lanț pornit (pentru tine).', 'Chain mining on (for you).'],
    radius: ['Raza în metri.', 'Radius in meters.'],
    showId: ['Arată ID-ul materialului la care te uiți.', 'Shows the id of the material you aim at.'],
    crosshair: ['Arată semnul de țintire.', 'Shows the crosshair hint.'],
  },
};

// the mask groups present in `values`: { materials: ['materials0', ..., 'materials3'] }
function masks(values) {
  const by = {};
  for (const [k, v] of Object.entries(values || {})) {
    const m = k.match(MASK);
    if (m && typeof v === 'number' && Number.isInteger(v) && v >= 0) (by[m[1]] ||= []).push(k);
  }
  for (const p of Object.keys(by)) if (by[p].length !== 4 || /\d$/.test(p) || p in values) delete by[p];
  for (const p of Object.keys(by)) by[p] = [0, 1, 2, 3].map(i => `${p}${i}`);
  return by;
}
const maskIds = ws => ws.flatMap((w, i) => [...Array(32).keys()].filter(b => (w >>> b) & 1).map(b => i * 32 + b));
function idsMask(text) {
  const ws = [0, 0, 0, 0];
  for (const t of String(text).split(/[\s,;]+/).filter(Boolean)) {
    if (!/^\d+$/.test(t) || +t > 127) throw new Error(`"${t}" is not a material id (1-127)`);
    ws[t >> 5] = (ws[t >> 5] | (1 << (t & 31))) >>> 0;
  }
  return ws;
}

function read(text) {
  let j; try { j = JSON.parse(text); } catch (e) { throw new Error(`not valid JSON: ${e.message}`); }
  if (!j || typeof j !== 'object' || !j.values || typeof j.values !== 'object') throw new Error('not an XHL settings file (no "values")');
  return j;
}

// -> the editor's form (lib/bepcfg.js shape): one unnamed section, a row per value; the masks as id lists
function parse(text, lang = 'en') {
  const j = read(text), mk = masks(j.values), inMask = new Set(Object.values(mk).flat());
  const d = DESC[j.module] || {}, desc = k => (d[k] ? d[k][lang === 'en' ? 1 : 0] : '');
  const entries = [];
  for (const [k, v] of Object.entries(j.values)) {
    if (inMask.has(k)) { const p = k.match(MASK)[1]; if (k.endsWith('0')) entries.push({ key: p, value: maskIds(mk[p].map(x => j.values[x])).join(','), kind: 'text', desc: desc(p), def: null, values: null, range: null }); continue; }
    if (v !== null && typeof v === 'object') continue;   // (nothing nested so far; left as it is)
    const kind = typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'float') : 'text';
    entries.push({ key: k, value: String(v), kind, desc: desc(k), def: null, values: null, range: null });
  }
  return { plugin: j.module || '', sections: [{ name: '', implicit: true, entries }] };
}

// changes: [{ key, value }] (value as the form has it) -> the file's new text; values typed like the ones they replace
function apply(text, changes) {
  const j = read(text), mk = masks(j.values);
  for (const { key, value } of changes || []) {
    if (mk[key]) { idsMask(value).forEach((w, i) => { j.values[mk[key][i]] = w; }); continue; }
    if (!(key in j.values)) throw new Error(`unknown setting: ${key}`);
    const old = j.values[key];
    if (typeof old === 'boolean') j.values[key] = /^true$/i.test(String(value));
    else if (typeof old === 'number') { const n = Number(String(value).trim()); if (!Number.isFinite(n) || String(value).trim() === '') throw new Error(`${key}: not a number`); j.values[key] = n; }
    else j.values[key] = String(value);
  }
  return JSON.stringify(j);
}

// the values that differ between two versions of a file: { key: value } (raw file keys, masks as their 4 words)
function diff(a, b) {
  const va = read(a).values, vb = read(b).values, out = {};
  for (const [k, v] of Object.entries(vb)) if (JSON.stringify(va[k]) !== JSON.stringify(v)) out[k] = v;
  return out;
}
// `values` written into a file's own text (the world's file as the server left it)
function merge(text, values) { const j = read(text); Object.assign(j.values, values); return JSON.stringify(j); }

module.exports = { parse, apply, diff, merge, masks, maskIds, idsMask };
