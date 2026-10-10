// Minimal ustar writer/reader: enough to stream mod folders to and from a server over `ssh ... tar`.
const pad = (s, n) => { const b = Buffer.alloc(n); b.write(s, 0, Math.min(Buffer.byteLength(s), n), 'utf8'); return b; };
const oct = (v, n) => pad(v.toString(8).padStart(n - 1, '0') + '\0', n);

function header(name, size, mtime, type = '0') {
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {           // ustar: long paths go as prefix + '/' + name, split at a '/'
    let at = -1;
    for (let i = name.indexOf('/'); i > 0; i = name.indexOf('/', i + 1)) if (Buffer.byteLength(name.slice(i + 1)) <= 100) { at = i; break; }
    if (at < 0 || Buffer.byteLength(name.slice(0, at)) > 155) throw new Error(`cale prea lungă pentru tar: ${name}`);
    prefix = name.slice(0, at); name = name.slice(at + 1);
  }
  const h = Buffer.concat([pad(name, 100), oct(0o644, 8), oct(0, 8), oct(0, 8), oct(size, 12), oct(Math.floor(mtime / 1000), 12),
    Buffer.from('        '), pad(type, 1), pad('', 100), pad('ustar\0', 6), pad('00', 2), pad('', 32), pad('', 32), oct(0, 8), oct(0, 8),
    pad(prefix, 155), pad('', 12)]);
  let sum = 0; for (const c of h) sum += c;
  oct(sum, 7).copy(h, 148); h[155] = 0x20;
  return h;
}

// files: [{ name: 'Mod/plugin.dll', data: Buffer, mtime? }]
function pack(files) {
  const parts = [];
  for (const f of files) {
    parts.push(header(f.name, f.data.length, f.mtime || Date.now()), f.data);
    const rest = f.data.length % 512; if (rest) parts.push(Buffer.alloc(512 - rest));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// -> [{ name, data }] (regular files only)
function unpack(buf) {
  const out = [];
  let o = 0;
  while (o + 512 <= buf.length) {
    const h = buf.subarray(o, o + 512);
    if (h.every(b => b === 0)) break;
    const str = (a, n) => h.subarray(a, a + n).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 155);
    const name = (prefix ? prefix + '/' : '') + str(0, 100);
    o += 512;
    if (type === '0' || type === '\0') out.push({ name: name.replace(/^\.\//, ''), data: Buffer.from(buf.subarray(o, o + size)) });
    o += Math.ceil(size / 512) * 512;
  }
  return out;
}

module.exports = { pack, unpack };
