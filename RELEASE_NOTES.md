## Bifrost 1.9.4

- Restarting only the game (the quick restart after a mod sync, and *New join code*) now stops the game, waits 30 seconds and starts it again, instead of an instant restart. The instant restart left the previous PlayFab lobby with the same join code behind, and the new session's join code check then crashed. A restart takes about 30 seconds longer.
