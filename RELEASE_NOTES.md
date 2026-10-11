## Bifrost 1.9.3

- When Valheim's join code check crashes after a restart (the PlayFab bug that leaves a code nobody can use), Bifrost no longer restarts the game again at once - that kept failing (nine crashes in a row on 2026-10-11). It stops the game for 1, then 3, then 5 minutes before starting it again, so the stale lobbies with that code expire. The server came back with a new join code after such a pause.
