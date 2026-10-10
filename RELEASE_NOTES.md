## Bifrost 1.2.1 - Linux

- **Linux version**: `Bifrost-1.2.1-linux-x86_64.AppImage` (any distro) and `Bifrost-1.2.1-linux-amd64.deb` (Debian / Ubuntu).
  - Finds Steam (native, Flatpak, Snap) and Valheim: the native Linux build is started with the profile BepInEx (`start_game_bepinex.sh`); the Windows build under Proton gets the doorstop plus the `winhttp` override in its Proton prefix - no Steam launch options needed.
  - Start at login, menu entry and `bifrost://` / `nxm://` links through `.desktop` files; updates itself from `bifrost-app-*-linux.tar.gz` like the Windows version.
- Windows: unchanged.
