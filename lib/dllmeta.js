// The CLI metadata of a .NET assembly (type / namespace names, attribute blobs such as [BepInPlugin("guid", ...)])
// without reading the whole file: mods like Therzie's embed 100+ MB of asset bundles as resources, while the metadata
// is about a megabyte. PE header -> CLI header (data directory 14) -> MetaData RVA/size -> that range of the file.
// Anything unexpected -> the whole file (the old, slow way), so callers never miss a match.
const fs = require('fs');

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return n === len ? b : b.subarray(0, n);
}

function metadata(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const dos = readAt(fd, 0, 64);
    if (dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) throw new Error('not MZ');
    const pe = dos.readUInt32LE(0x3c);
    const head = readAt(fd, pe, 24 + 240);
    if (head.readUInt32LE(0) !== 0x4550) throw new Error('not PE');
    const nSections = head.readUInt16LE(6), optSize = head.readUInt16LE(20), opt = 24;
    const magic = head.readUInt16LE(opt);
    const dirs = opt + (magic === 0x20b ? 112 : 96);                  // PE32+ / PE32
    const cliRva = head.readUInt32LE(dirs + 14 * 8);
    if (!cliRva) throw new Error('no CLI header');
    const sections = readAt(fd, pe + 24 + optSize, nSections * 40);
    const toOffset = rva => {
      for (let i = 0; i < nSections; i++) {
        const o = i * 40, va = sections.readUInt32LE(o + 12), vs = Math.max(sections.readUInt32LE(o + 8), sections.readUInt32LE(o + 16));
        if (rva >= va && rva < va + vs) return rva - va + sections.readUInt32LE(o + 20);
      }
      throw new Error('RVA outside the sections');
    };
    const cli = readAt(fd, toOffset(cliRva), 72);
    const mdRva = cli.readUInt32LE(8), mdSize = cli.readUInt32LE(12);
    const mdOff = toOffset(mdRva);
    if (!mdSize || mdOff + mdSize > size) throw new Error('bad metadata range');
    const md = readAt(fd, mdOff, mdSize);
    if (md.readUInt32LE(0) !== 0x424a5342) throw new Error('no BSJB');  // metadata signature
    return md;
  } catch {
    try { return fs.readFileSync(file); } catch { return Buffer.alloc(0); }
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { }
  }
}

module.exports = { metadata };
