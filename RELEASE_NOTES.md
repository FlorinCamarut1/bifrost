## Bifrost 1.9.14

- Discover → Nexus Mods has an **Outdated** switch (Nexus has no "deprecated" mark): mods not updated since Ashlands (May 2024) - most of them no longer work - are hidden unless it is on, and marked "outdated" when shown.
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
