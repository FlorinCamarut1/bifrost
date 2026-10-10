// Renders the app icon (Algiz rune on night blue) to ui/app.png + ui/app.ico.  Run: npx electron tools/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22305a"/><stop offset="1" stop-color="#0b1122"/></linearGradient>
  <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="56" x2="0" y2="204"><stop offset="0" stop-color="#fdedc0"/><stop offset="1" stop-color="#d6a84f"/></linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0.42" r="0.5"><stop offset="0" stop-color="#e6c477" stop-opacity=".28"/><stop offset="1" stop-color="#e6c477" stop-opacity="0"/></radialGradient>
</defs>
<rect x="6" y="6" width="244" height="244" rx="56" fill="url(#bg)"/>
<rect x="6" y="6" width="244" height="244" rx="56" fill="url(#glow)"/>
<rect x="8" y="8" width="240" height="240" rx="54" fill="none" stroke="#e6c477" stroke-opacity=".45" stroke-width="4"/>
<g stroke="url(#g)" stroke-width="24" stroke-linecap="round" stroke-linejoin="round" fill="none">
  <path d="M128 60 V200"/><path d="M128 132 L78 66"/><path d="M128 132 L178 66"/>
</g>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 256, height: 256, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  w.webContents.setFrameRate(5);
  let done = false;
  w.webContents.on('paint', (_e, _dirty, img) => {
    if (done) return; done = true;
    const ui = path.join(__dirname, '..', 'ui');
    fs.writeFileSync(path.join(ui, 'app.png'), img.toPNG());
    // ICO with embedded PNGs (supported since Vista)
    const sizes = [256, 64, 48, 32, 24, 16];
    const pngs = sizes.map(s => s === 256 ? img.toPNG() : img.resize({ width: s, height: s, quality: 'best' }).toPNG());
    const head = Buffer.alloc(6 + 16 * sizes.length);
    head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
    let off = head.length;
    sizes.forEach((s, i) => {
      const o = 6 + 16 * i;
      head.writeUInt8(s === 256 ? 0 : s, o); head.writeUInt8(s === 256 ? 0 : s, o + 1);
      head.writeUInt8(0, o + 2); head.writeUInt8(0, o + 3);
      head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
      head.writeUInt32LE(pngs[i].length, o + 8); head.writeUInt32LE(off, o + 12);
      off += pngs[i].length;
    });
    fs.writeFileSync(path.join(ui, 'app.ico'), Buffer.concat([head, ...pngs]));
    console.log('wrote ui/app.png + ui/app.ico');
    app.quit();
  });
  w.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:transparent">${SVG}</body></html>`));
});
