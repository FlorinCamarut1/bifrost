## Bifrost 1.6.0

**Same mod on both stores**
- Discover shows *Installed from Thunderstore* on the Nexus copy of a mod you have (and *Installed from Nexus* the other way round), by name and author; translations and patches of a mod stay installable.
- Installing a mod whose plugin DLL is already in the profile is refused ("already installed from Thunderstore as …"). A mod the server's list needs replaces your own copy from the other store.

**Fixes (found by a full test pass)**
- A config edit on a file that was never synced could be replaced by the server's copy while the editor said "saved and sent". The edit now always goes to the server, and "sent" is only shown when it really was.
- A damaged settings.json is no longer replaced with empty settings: the last good copy is used and the damaged one is kept.
- Switching the language to Romanian no longer freezes the window; early messages at startup are no longer lost.
- Players / personal profiles: "My mods" and the Discover buttons update after an install again.
- Servers Bifrost cannot restart (FTP, local, SSH without a restart command): the pending restart no longer blocks publishing the list; *Restart* / *New join code* are only shown where they work.
- Discover without internet on the first start says so instead of "0 mods".
- Personal profiles no longer wait for a server list; servers whose state cannot be read show "state unknown" instead of "starting...".
- Config editor: Text mode stays Text mode after saving; a key that appears twice in a section is edited on its own line; Escape on a question no longer opens a second one.
- Many texts translated (Settings, Discover, Server page, errors, notifications, tray menu after a language change); numbers and dates follow the language.

**Faster and lighter**
- Mod sync remembers file hashes: repeat syncs take ~60 ms instead of ~1 s, and the first one no longer freezes the window (hashing is streamed).
- Mod downloads are stored once (Chromium kept a second copy of every mod); old versions in the download cache are removed after 14 days, mods no profile uses after 30 days. Settings → General shows the cache size and can empty it.
