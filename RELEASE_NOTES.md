## Bifrost 2.5.0

- **Enshrouded Patcher** (Nexus mod 91: stack sizes, skill points, build limits, crafting...) can be used instead of EML on an Enshrouded server: Settings → Mods or patcher → Enshrouded Patcher, or "Use as patcher" on its Discover card. Its author says it does not work together with EML, so the server then runs without EML.
  - Bifrost downloads the patcher from Nexus (a free account clicks "Slow download" once) and builds the options page from the patcher's own config (Server → Enshrouded Patcher → Options).
  - The server's archive (enshrouded_server.kfc) is patched through your PC and uploaded back; the original stays next to it as .bifrost-orig, a game update is noticed and patched again, and switching back to EML puts the original back.
  - Friends get the options through the server's list: at PLAY their Bifrost patches their game with them (again after a Steam update).
  - The patcher is a menu in a console: Bifrost answers it by itself, and when it cannot it opens the patcher's own window with everything filled in - pick the option it names there.
- Discover's "EML only" filter no longer shows patchers (their description mentions EML because they do not work with it).

## Bifrost 2.4.2

- **The taskbar shows the new logo too.** After 2.4.1 the taskbar button and the Start menu / desktop shortcuts kept the old icon: Windows took it from the installer's copy, which an in-app update never replaced. Bifrost now keeps its current icon next to its settings and points the shortcuts (and a Bifrost pinned to the taskbar) at it, so the icon follows every update. If Windows still shows the old one for a moment, it refreshes after the next sign-in.

## Bifrost 2.4.1

- **New logo** to match the 2.4.0 look: the Algiz rune is now red, with a soft glow, on a black tile with two cut corners. The update changes it inside the app; the desktop shortcut and taskbar icon change with a new install (Bifrost-Setup or the portable zip).

## Bifrost 2.4.0

- **A new layout, in the style of AMD Software: Adrenalin.** The sidebar is gone. Pages are now tabs along the top (Start, Play, Server, Mods), and the open tab is underlined in red. The server selector sits on the right of the header, and Log and Settings are the two icons next to it.
- Inside Mods, a second row of tabs switches between Library (My mods for players), Discover and Modpack.
- Play and Server open with a large banner: the join code and players online in big numbers, and a large red PLAY button.
- Discover shows mods as cards with their artwork. Each setting is a row of its own with a red switch. Mod details open in a full-height panel on the right.
- A status bar along the bottom shows Sir Bodo, Auto-sync, the join code, players online and app updates.
- In English, the update notice said "Bifrost x.y.z e disponibil.": it now says "is available."

## Bifrost 2.3.0

- **New look.** The window is a dark desktop shell: the title bar and sidebar are the frame, and each page sits in a rounded panel. Text uses one modern font, and colours are calmer, with a periwinkle accent. A soft aurora (teal to violet) marks the Bifrost name, the open page, the join code, PLAY and the progress bars.
- Mod lists are one panel with a row per mod. Mod details open in a floating sheet, dialogs blur what is behind them, and notifications slide in and fade out.
- On/off switches can be reached with the keyboard (Tab, Space), and every control shows a focus ring. With Windows animations turned off, Bifrost turns off its own animations too.
- New screenshots in the README.

## Bifrost 2.2.2

- **Enshrouded 1.0:** EML 0.1.2 cannot read 1.0's data files (KFC4) and stopped the game ("Fatal error ... Failed to create AppState") and the dedicated server at every start. Bifrost now checks the game's data file first: when the installed EML cannot read it, it looks for a newer EML on GitHub (at most once an hour), and if there is none yet the game starts **without mods** (with a message) and the server sync takes EML off the server instead of putting it there. Mods come back by themselves once EML supports 1.0.
- Settings → Mod loader → Put back no longer copies an EML backup of the game's data file from an older game version over the new one.

## Bifrost 2.2.1

- The first mod sync to a server whose mods folder did not exist yet failed ("can't cd to .../mods"): clearing a folder that is not there now counts as done, and the copy creates it.
- Sir Bodo no longer says "delivered" when a sync failed.

## Bifrost 2.2.0

- **Enshrouded server settings** (Server → Server settings): name, players, chat, the difficulty preset and every game setting (player, survival, world, progression, enemies, day and night), and user groups with their own passwords and rights (e.g. an Admin group that can kick/ban). Changing a game setting switches the preset to Custom, the only one where they count. A JSON mode edits the file as text. A copy of enshrouded_server.json is kept next to it at every save; applying restarts the server and then checks the game kept the values.
- Docker images that write the name, password or player count from their environment at every start (indifferentbroccoli, mornedhels) get the same values in the compose env file, so a restart does not undo them.
- **Docker server folder fix**: a server folder given as the host path (the volume's source) made the sync send EML into a folder that only existed inside the container. Bifrost now translates it through the container's volumes (or finds enshrouded_server.exe in them) and fixes the setting by itself.
- The "EML is not loaded on the server" warning looked only at the container's environment, so images that set WINEDLLOVERRIDES in their start script got a false alarm. It now reads the running server process's environment.

## Bifrost 2.1.3

- An Enshrouded invite added by a Bifrost older than 2.0 was saved as a Valheim server (Valheim folder on Play, "BepInEx is not installed" on PLAY). A player's server now follows the game written in the server's list and switches by itself.
- Play → How to join for Enshrouded says what to do in the game: Join → T → Ctrl+V (PLAY copies the address), and to keep Tailscale connected when the server is reached through it.

## Bifrost 2.1.2

- Server menu: the game tag (ENSHROUDED) ran over the role. Each server now shows its name, with "role · game" under it; long names end in "...".
- Discover for Enshrouded said "The Thunderstore catalog for Valheim" above the Nexus list after the catalog refreshed.

## Bifrost 2.1.1

- Discover (Nexus) for Enshrouded stopped at the first 30 mods: scrolling down did not load the rest (it waited for the Thunderstore catalog, which Enshrouded never loads). A tall window that still shows the end of the list after a page now loads the next one too.

## Bifrost 2.1.0

- **Enshrouded without a port forward: Tailscale.** If the server's machine has Tailscale, Bifrost finds its address by itself and puts it in the server's list. Friends install Tailscale, accept the admin's share invite (Tailscale console → Machines → the server → Share) and press PLAY.
- Enshrouded **PLAY copies the server's address**: in the game Join → press T → Ctrl+V. If this PC cannot reach the server, Bifrost says why: Tailscale missing, not connected, server not shared with you yet, server offline.
- Settings → **Address for friends** (empty = the server's Tailscale address) and **Tailscale** → Check.
- The invite page shows the Tailscale steps for servers reached through it.
- **Enshrouded players online**: the Server page counted nobody (the Steam query was never asked without Settings → Addresses). Now the query goes to the friends' address or the SSH host, and the names come from the server's log ("Seen since start", online ones first).
- **Sir Bodo**, a squire with a bucket helmet too big for him, now lives at the bottom of the sidebar. Click him. He also has opinions about syncs, PLAY and errors. Settings → Sir Bodo hides him.

## Bifrost 2.0.0

- **Enshrouded support.** When you create a server (or a personal profile) you pick the game: Valheim or Enshrouded. Everything else works the same way: mods in Discover, sync to the server, restart when nobody plays, the list + invite for friends, PLAY.
- Enshrouded mods come from **Nexus Mods** and are loaded by **EML** (Enshrouded Mod Loader, github.com/Brabb3l/kfc-parser). Bifrost downloads EML itself and puts its dbghelp.dll next to enshrouded.exe on your PC and next to enshrouded_server.exe on the server; the game's mods folder points at the chosen server's profile, so every server keeps its own mods.
- Discover → **EML only** (on by default): most of Enshrouded's top downloads on Nexus are Cheat Engine tables and saves, which no mod manager can install.
- A mod whose mod.json is wrong (or has the same id as one you have) is refused at install - EML would otherwise stop the game with a Fatal error.
- Enshrouded server: tell Bifrost the server's folder (where enshrouded_server.exe is; /opt/enshrouded/server in the mornedhels/enshrouded-server image). Docker servers need WINEDLLOVERRIDES=dbghelp=native,builtin in the container's environment - Bifrost warns when it is missing.
- Settings → Mod loader → Put back removes EML from the game folder and restores the game's original data file.
- Valheim works exactly as before.

## Bifrost 1.9.16

- **Direct join diagnostics** (for a friend whose PLAY still asked for the password): on PLAY the Log now says where the password came from (or why there is none), the arguments sent to Steam (password hidden), Valheim's Launch Options in Steam, a warning for passwords with spaces or special characters, and - a minute or two later - whether the game really received the server address (Valheim logs "JOIN <address>" when it does).
- Settings → Server password says when a saved password cannot be read on this PC (instead of "Password saved"), so it can be saved again.
- 1.9.15: English fixes: Server → Check differences ("To copy / To remove"), the catalog download messages in Discover and the GitHub note in the add-server wizard were still in Romanian.
- 1.9.14: Discover → Nexus Mods has an **Outdated** switch (Nexus has no "deprecated" mark): mods not updated since Ashlands (May 2024) - most of them no longer work - are hidden unless it is on, and marked "outdated" when shown.
- 1.9.13: Discover → **Nexus Mods has categories** (Gameplay, Construction, Utilities, User Interface...), with the number of mods in each for what you searched.
- The search box placeholder follows the app language when switching between Thunderstore and Nexus.
- 1.9.12: **Delete all** in Mods → Other configs: removes every config file no installed mod uses (profile + server), after a confirmation.
- Discover has a **Deprecated** switch: mods marked deprecated on Thunderstore are hidden unless it is on (they used to show up in every search).
- Therzie's translation files (TherzieTranslations/...) now belong to their mod (Armory, Monstrum, Warfare, Wizardry) instead of showing up as left over.
- 1.9.11: **settings edited while Valheim runs on this PC are no longer lost.** When the game closes, mods write their old settings over the config files - and the sync then sent those old values to the server too. Bifrost now remembers what you changed and puts it back after the game closes (until the game has been started again with it). The config editor also tells you when the game is running.
- Saving a config during a server restart no longer claims it was sent: it goes to the server right after the restart.
- 1.9.10: a mod's settings (⚙) now go to the mod that **declares** the plugin, not to another mod that merely mentions it. Example: the CraftFromContainers settings (Nexus 40) were shown under PlanBuild, so Craft From Containers had no ⚙.
- 1.9.9: **Restore defaults** button in a mod's settings.
- 1.9.8: mods marked deprecated on Thunderstore (e.g. AzuExtendedPlayerInventory) can be installed - in Discover only when searched, with a "deprecated" tag. 1.9.7: share a mod's settings with players.
