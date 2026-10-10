## Bifrost 1.2.2 - Linux

- **Linux version**: `Bifrost-1.2.2-linux-x86_64.AppImage` (any distro) and `Bifrost-1.2.2-linux-amd64.deb` (Debian / Ubuntu).
  - Finds Steam (native, Flatpak, Snap) and Valheim: the native Linux build is started with the profile BepInEx (`start_game_bepinex.sh`); the Windows build under Proton gets the doorstop plus the `winhttp` override in its Proton prefix - no Steam launch options needed.
  - Start at login, menu entry and `bifrost://` / `nxm://` links through `.desktop` files; updates itself from `bifrost-app-*-linux.tar.gz` like the Windows version.
- Windows: no change in behaviour.
- Linux .deb: also depends on libasound2 (Ubuntu 24.04: libasound2t64) - without it Bifrost did not start on minimal systems.
- The copy buttons use an icon instead of a font symbol (it was missing on some Linux systems).
- No console error on the Play page when no server is set up yet.
