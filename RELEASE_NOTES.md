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
