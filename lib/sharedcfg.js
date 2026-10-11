// Settings the admin shares with players. Some mods keep settings that matter for everyone on the player's side (not
// synced by the server): a creature is simulated by the game of the player standing next to it, so e.g. OdinHorse's
// "Time to Tame" comes from THAT player's config. The admin marks a config file as shared; the server's list then
// carries the settings of that file that differ from the mod's defaults, and a player's Bifrost writes them into the
// player's own file at PLAY, before the game starts (a running game saves its settings over the file when it closes).
// Only those values are sent - the rest of the player's file (key binds, UI positions...) stays the player's.
const bepcfg = require('./bepcfg');

const norm = v => String(v ?? '').trim();
const id = (section, key) => `${section}\u0000${key}`;

// admin: { rel, guid, values: [{ section, key, value }] } - the settings of one config file that are not the default.
// A setting written without its "# Default value" line (BepInEx saved it before the mod registered it - OdinHorse's
// taming settings on the admin's PC, 2026-10-11) cannot be compared, so it is sent as it is.
function collect(rel, text) {
  const p = bepcfg.parse(text);
  const values = [];
  for (const s of p.sections) for (const e of s.entries) if (e.def === null || norm(e.value) !== norm(e.def)) values.push({ section: s.name, key: e.key, value: e.value });
  return { rel, guid: p.guid || null, values };
}

// player: writes the shared values into the player's text. prev = { id: value } applied last time from this file:
// a setting the admin no longer shares (put back to its default) goes back to the default here too.
// -> { text, changed, applied: { id: value }, skipped: [ids the player's file does not have], guidMismatch }
function applyShared(text, shared, prev = {}) {
  const p = bepcfg.parse(text);
  if (shared.guid && p.guid && shared.guid !== p.guid) return { text, changed: 0, applied: prev, skipped: [], guidMismatch: true };
  const idx = new Map();
  for (const s of p.sections) for (const e of s.entries) idx.set(id(s.name, e.key), { ...e, section: s.name });
  const want = new Map((shared.values || []).map(v => [id(v.section, v.key), String(v.value)]));
  const applied = {}, skipped = [], changes = [];
  for (const [k, v] of want) {
    const e = idx.get(k);
    if (!e) { skipped.push(k.replace('\u0000', ' / ')); continue; }
    applied[k] = v;
    if (norm(e.value) !== norm(v)) changes.push({ section: e.section, key: e.key, value: v, line: e.line });
  }
  for (const k of Object.keys(prev)) {
    if (want.has(k)) continue;
    const e = idx.get(k);
    // only when the player's file still holds what Bifrost put there (the player did not change it since)
    if (e && e.def !== null && norm(e.value) === norm(prev[k]) && norm(e.value) !== norm(e.def)) changes.push({ section: e.section, key: e.key, value: e.def, line: e.line });
  }
  return { text: changes.length ? bepcfg.apply(text, changes) : text, changed: changes.length, applied, skipped, guidMismatch: false };
}

module.exports = { collect, applyShared };
