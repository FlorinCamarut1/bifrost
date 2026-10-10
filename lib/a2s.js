// Steam server query (A2S_INFO) over UDP: name, players, max players, version - works for any Valheim server that
// answers Steam queries (query port = game port + 1). Servers answer with a challenge first since 2020.
const dgram = require('dgram');

function info(host, port, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const base = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from('Source Engine Query\0', 'latin1')]);
    const t = setTimeout(() => { sock.close(); reject(new Error('serverul nu răspunde la interogarea Steam')); }, timeout);
    sock.on('error', e => { clearTimeout(t); sock.close(); reject(e); });
    sock.on('message', msg => {
      if (msg.readInt32LE(0) !== -1) return;
      const type = msg[4];
      if (type === 0x41) { sock.send(Buffer.concat([base, msg.subarray(5, 9)]), port, host); return; }   // challenge
      if (type !== 0x49) return;
      clearTimeout(t); sock.close();
      let o = 6;
      const str = () => { const e = msg.indexOf(0, o); const s = msg.toString('utf8', o, e); o = e + 1; return s; };
      const name = str(), map = str(), folder = str(), game = str();
      o += 2;                                                     // app id
      const players = msg[o++], max = msg[o++], bots = msg[o++];
      o += 3;                                                     // type, os, visibility
      o += 1;                                                     // VAC
      const version = o < msg.length ? str() : '';
      resolve({ name, map, folder, game, players, max, bots, version });
    });
    sock.send(base, port, host);
  });
}

// "host:port" (game port) -> query port game+1
function parseAddress(addr) {
  const m = String(addr || '').trim().match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
  if (!m) return null;
  return { host: m[1], gamePort: +(m[2] || 2456), queryPort: +(m[2] || 2456) + 1 };
}

module.exports = { info, parseAddress };
