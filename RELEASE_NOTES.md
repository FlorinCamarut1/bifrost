## Bifrost 1.5.0 - faster and lighter

Measured on a real admin profile (36 mods, 711 MB of mod DLLs, ~240 config files):

- **Startup**: the first 20 seconds no longer use a full CPU core and 800 MB of RAM (now ~5% CPU, ~130 MB). The config editor index reads only the metadata of each mod DLL (6.6 MB instead of 711 MB, 42 ms instead of 3.7 s, same results) and is kept on disk.
- **Window ready in ~0.35 s instead of ~1.3 s**: the Thunderstore catalog (~8 MB) is loaded only when Discover is opened, not at every start.
- **Server status in ~0.5 s instead of ~3.6 s**: the status check no longer runs the image's valheim-is-idle (it watches network traffic for 3 s); the player count comes from the logs, the restart decision still asks valheim-is-idle.
- **Less RAM in the tray**: started at login, Bifrost creates no window until it is opened; a window closed to the tray is released after 5 minutes (~100 MB), the tray opens a new one instantly. Unsaved config edits keep it open.
- The Valheim process check runs every 20 s from the tray (4 s while the window is open or the game is starting).
