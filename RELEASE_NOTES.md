## Bifrost 1.1

- **Several servers**, each with its own mod profile - switch in the sidebar. Personal profiles without a server too.
- **Invites**: admins share a link / code, friends open it and press PLAY. The list is a secret Gist on the admin's GitHub.
- **Create server** for anyone: Linux over SSH (Docker or plain folders), this PC, or FTP/FTPS. The mod sync now lives
  in the app (no extra scripts): copies only what changed, refuses mass removals, restarts only when nobody plays.
- **Two-way config sync** with the server, and mods put on the server by hand come back into the profile.
- **Import** from Thunderstore Mod Manager / r2modman, from a Thunderstore profile code, or from what the server runs.
  **Export** a Thunderstore profile code for people without Bifrost.
- **English** by default (Romanian in Settings).
- **Self-updates without new executables** (works with Windows Smart App Control); portable zip available.
- Fixed: Server/Client buttons breaking onto a second line on the Mods page.

Upgrading from 1.0: it updates itself (or run the installer); your server becomes the first entry, nothing to redo.
