## Bifrost 1.8.0 - install queue, background restart, faster sync

- **Install queue**: press *Install* / *Uninstall* / *Update* on as many mods as you like - while Bifrost is busy they show *Queued* and run one after another. The auto-sync waits until the queue is empty, so a batch of changes goes to the server in one sync and one restart.
- **The server restart runs in the background**: while it waits for the server to come back (join code), you can keep installing and removing mods; a sync asked for meanwhile runs right after the restart.
- **Faster restart after a sync** (valheim-server Docker image): Bifrost copies the mods into the game the way the container's start does and restarts only the game process - no container restart, no Steam update check. If that is not possible it falls back to the full restart. *Restart server* (the button) still restarts the whole container.
- **Faster comparison**: the server's files are only hashed when they changed (by size and date) - comparing 342 mod files went from ~3.4 s to ~0.5 s, configs from ~0.8 s to ~0.4 s, with identical results.
