// Extracts zip / 7z archives with the bundled 7-Zip (7zip-bin). In a packaged app the exe lives in app.asar.unpacked.
const { spawn } = require('child_process');
const { path7za } = require('7zip-bin');

const exe = path7za.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function extract(file, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, ['x', file, `-o${dest}`, '-y', '-bso0', '-bsp0'], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`7-Zip: ${err.trim() || `exit ${code}`}`)));
  });
}

module.exports = { extract };
