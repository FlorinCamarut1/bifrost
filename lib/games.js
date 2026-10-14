// The games Bifrost manages. Every server entry has a `game` (default valheim); the rest of the app asks this table
// what that game uses: where mods come from, how they are loaded, how the game is started and found.
//   valheim    : BepInEx (doorstop proxy winhttp.dll), Thunderstore + Nexus, configs in BepInEx/config
//   enshrouded : EML - Enshrouded Mod Loader (proxy dbghelp.dll next to the exe, mods in <game>/mods), Nexus only
const GAMES = {
  valheim: {
    id: 'valheim', name: 'Valheim', appId: '892970', folder: 'Valheim', exe: ['valheim.exe', 'valheim.x86_64'], process: 'valheim.exe',
    loader: 'bepinex', thunderstore: true, configs: true, modsDir: 'BepInEx/plugins',
    // Ashlands (Valheim 0.218, 2024-05-14) changed the game enough that most mods older than it no longer work
    nexus: { domain: 'valheim', id: '3667', outdatedBefore: Date.UTC(2024, 4, 14) / 1000 },
    gamePort: 2456, queryOffset: 1,
  },
  enshrouded: {
    id: 'enshrouded', name: 'Enshrouded', appId: '1203620', folder: 'Enshrouded', exe: ['enshrouded.exe'], process: 'enshrouded.exe',
    loader: 'eml', thunderstore: false, configs: false, modsDir: 'mods',
    // (no Outdated filter: every mod there predates 1.0, 2026-10-15)
    nexus: { domain: 'enshrouded', id: '5811', outdatedBefore: null },
    // one UDP port for the game and the Steam query (enshrouded_server.json queryPort, default 15637)
    gamePort: 15637, queryOffset: 0,
    server: { exe: 'enshrouded_server.exe', appId: '2278520' },
  },
};
const game = id => GAMES[id] || GAMES.valheim;
module.exports = { GAMES, game };
