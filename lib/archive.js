// Archives: zip / 7z / tar.gz with the bundled 7-Zip (7zip-bin; in a packaged app the exe lives in app.asar.unpacked),
// RAR with node-unrar-js (WebAssembly, 7za cannot read RAR). The type comes from the file's first bytes, because
// Nexus serves files under extension-less names.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { path7za } = require('7zip-bin');

let exe = path7za.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
// Linux: 7za must be executable; if the package lost the bit (or sits on a read-only AppImage mount without it), use a copy
if (process.platform !== 'win32') {
  try { fs.accessSync(exe, fs.constants.X_OK); } catch {
    try { const c = path.join(require('os').tmpdir(), 'bifrost-7za'); fs.copyFileSync(exe, c); fs.chmodSync(c, 0o755); exe = c; } catch { }
  }
}

function sniff(file) {
  const b = Buffer.alloc(512);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, b, 0, 512, 0); } finally { fs.closeSync(fd); }
  if (b[0] === 0x50 && b[1] === 0x4b) return 'zip';                                       // PK
  if (b.slice(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
  if (b.slice(0, 4).toString('latin1') === 'Rar!') return 'rar';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gz';
  if (b.slice(257, 262).toString('latin1') === 'ustar') return 'tar';
  if (b[0] === 0x4d && b[1] === 0x5a) return 'dll';                                       // MZ: a bare .dll
  return 'unknown';
}

function extract7z(file, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, ['x', file, `-o${dest}`, '-y', '-bso0', '-bsp0'], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`7-Zip: ${err.trim() || `exit ${code}`}`)));
  });
}

async function extractRar(file, dest) {
  const { createExtractorFromFile } = require('node-unrar-js');
  const ex = await createExtractorFromFile({ filepath: file, targetPath: dest });
  // the iterator does the extracting
  for (const f of ex.extract().files) void f;
}

// dllName: file name for a bare DLL download
async function extract(file, dest, dllName) {
  const kind = sniff(file);
  fs.mkdirSync(dest, { recursive: true });
  if (kind === 'zip' || kind === '7z' || kind === 'gz' || kind === 'tar') return extract7z(file, dest);
  if (kind === 'rar') return extractRar(file, dest);
  if (kind === 'dll') { fs.copyFileSync(file, path.join(dest, dllName || 'plugin.dll')); return; }
  throw new Error('fișierul descărcat nu e o arhivă cunoscută (zip, 7z, rar) și nici un .dll');
}

// 7-Zip with any arguments (e.g. building a zip), run in cwd
function run7z(args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, [...args, "-bso0", "-bsp0"], { windowsHide: true, cwd });
    let err = "";
    p.stderr.on("data", d => err += d);
    p.on("error", reject);
    p.on("close", code => code === 0 ? resolve() : reject(new Error(`7-Zip: ${err.trim() || `exit ${code}`}`)));
  });
}

module.exports = { extract, sniff, run7z };
