// BepInEx .cfg files: read them into sections/entries (with the description, type, default and allowed values BepInEx
// writes above every setting) and change single values in place, keeping every other line exactly as it was.
//
//   ## Settings file was created by plugin Foo v1.2.3
//   ## Plugin GUID: author.foo
//
//   [General]
//
//   ## What the setting does
//   # Setting type: Boolean
//   # Default value: true
//   # Acceptable values: A, B          (enums)   /   # Acceptable value range: From 0 to 10
//   Enabled = true

function parse(text) {
  const lines = String(text).split(/\r?\n/);
  const out = { plugin: null, guid: null, sections: [] };
  let sec = null, meta = { desc: [] };
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    let m;
    if ((m = line.match(/^## Settings file was created by plugin (.+)$/))) { out.plugin = m[1]; continue; }
    if ((m = line.match(/^## Plugin GUID: (.+)$/))) { out.guid = m[1].trim(); continue; }
    if ((m = line.match(/^\[(.+)\]$/))) { sec = { name: m[1], entries: [] }; out.sections.push(sec); meta = { desc: [] }; continue; }
    if (!line) continue;
    if (line.startsWith('##')) { meta.desc.push(line.replace(/^##\s?/, '')); continue; }
    if (line.startsWith('#')) {
      const c = line.replace(/^#\s?/, '');
      if ((m = c.match(/^Setting type: (.+)$/))) meta.type = m[1].trim();
      else if ((m = c.match(/^Default value: ?(.*)$/))) meta.def = m[1];
      else if ((m = c.match(/^Acceptable values: (.+)$/))) meta.values = m[1].split(',').map(s => s.trim()).filter(Boolean);
      else if ((m = c.match(/^Acceptable value range: From (\S+) to (\S+)$/))) meta.range = [Number(m[1]), Number(m[2])];
      else if (/^Multiple values can be set/.test(c)) meta.flags = true;
      continue;
    }
    if ((m = raw.match(/^\s*([^=]+?)\s*=\s?(.*)$/)) && sec) {
      sec.entries.push({ key: m[1], value: m[2], line: i, desc: meta.desc.join('\n'), type: meta.type || null, def: meta.def ?? null,
        values: meta.values || null, range: meta.range || null, flags: !!meta.flags, kind: kindOf(meta, m[2]) });
    }
    meta = { desc: [] };
  }
  return out;
}

function kindOf(meta, value) {
  const t = (meta.type || '').toLowerCase();
  if (t === 'boolean' || (!t && /^(true|false)$/i.test(value))) return 'bool';
  if (meta.values && !meta.flags) return 'enum';
  if (/^(int|byte|sbyte|short|ushort|uint|long|ulong)(16|32|64)?$/.test(t)) return 'int';
  if (/^(single|double|decimal|float)$/.test(t)) return 'float';
  return 'text';
}

// changes: [{ section, key, value, line? }] -> new text (only those lines are rewritten). With line (from parse) exactly
// that line changes - a key can appear twice in a section
function apply(text, changes) {
  // [line, eol, line, eol, ...]: every line keeps its own line ending (some mods write mixed CRLF / LF)
  const parts = String(text).split(/(\r?\n)/);
  const lines = parts.filter((_, i) => i % 2 === 0);
  const clean = v => String(v).replace(/[\r\n]+/g, ' ');
  const byLine = new Map(changes.filter(c => Number.isInteger(c.line)).map(c => [c.line, c]));
  const want = new Map(changes.filter(c => !Number.isInteger(c.line)).map(c => [`${c.section}\u0000${c.key}`, clean(c.value)]));
  const done = new Set();
  let sec = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    let m;
    if ((m = t.match(/^\[(.+)\]$/))) { sec = m[1]; continue; }
    if (!t || t.startsWith('#') || sec === null) continue;
    if ((m = lines[i].match(/^(\s*)([^=]+?)(\s*=\s?)(.*)$/))) {
      const c = byLine.get(i);
      if (c && c.key === m[2] && c.section === sec) { lines[i] = m[1] + m[2] + m[3] + clean(c.value); byLine.delete(i); continue; }
      const id = `${sec}\u0000${m[2]}`;
      if (want.has(id)) { lines[i] = m[1] + m[2] + m[3] + want.get(id); done.add(id); }
    }
  }
  const missing = [...want.keys()].filter(k => !done.has(k)).concat([...byLine.values()].map(c => `${c.section}\u0000${c.key}`));
  if (missing.length) throw new Error(`Nu găsesc în fișier: ${missing.map(k => k.replace('\u0000', ' / ')).join(', ')}`);
  return parts.map((p, i) => i % 2 === 0 ? lines[i / 2] : p).join('');
}

module.exports = { parse, apply };
