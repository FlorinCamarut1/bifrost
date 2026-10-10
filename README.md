# Bifrost

A Valheim mod manager for playing on one modded dedicated server with friends.

- **Players** install Bifrost once and press **JOACĂ** (Play). Bifrost reads the server's mod list, installs exactly the
  mods and versions the server runs (from Thunderstore, plus Nexus Mods with your own account), keeps them up to date,
  and starts Valheim through Steam with them. It also has a Thunderstore browser for extra client mods.
- **Admin** mode is for whoever runs the server. It watches a Thunderstore Mod Manager profile, pushes the server-side
  mods to the server over SSH (`sync-valheim-mods.ps1`), shows the server status and join code, and publishes the mod
  list (`server.json` in this repo) that the players' Bifrost reads.

The UI is in Romanian.

## Install (players)

Download `Bifrost-Setup-x.y.z.exe` from [Releases](../../releases/latest) and run it. Windows SmartScreen may warn
because the app is not code-signed: *More info → Run anyway*. Bifrost updates itself.

Mods go into Bifrost's own profile (`%APPDATA%\Bifrost\profile`). To load it, Bifrost puts the BepInEx doorstop
(`winhttp.dll`, `doorstop_config.ini`, `doorstop_libs`) next to `valheim.exe`. Whatever was there before is copied to
`bifrost-backup` in the game folder first.

### Nexus Mods

Put your personal API key in *Setări → Nexus Mods* (nexusmods.com → Settings → API Keys). Free accounts click
*Mod Manager Download* on the Nexus page once per file and Bifrost installs it; Premium accounts get it automatically.
Only `.zip` and `.7z` archives are supported.

## Development

```
npm install
npm start            # run from source
npm run dist         # build the installer into dist/
npm run release      # build + publish a GitHub release (needs GH_TOKEN)
```

`server.json` schema: `{ schema, app: "bifrost", server: { name, world, joinCode, address }, required: [{ full, ver }],
recommended: [{ full, ver }], nexus: [{ key, title, modId, fileId, version, required }] }`.

## License

MIT
