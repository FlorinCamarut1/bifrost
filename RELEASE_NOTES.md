## Bifrost 1.4.0 - join directly

- **PLAY puts you on the server**: Bifrost starts Valheim with the server address and password (`+connect` / `-password`, read from the game code), so after picking the character and pressing *Start* you are in - no join code, no password prompt. Works for crossplay servers too (they are found by their public IP).
- Settings → this server: **Join the server directly on PLAY**, **Server address** (empty = automatic: from the list, or for admins from the server logs) and **Server password** (typed once, stored encrypted; admins of a Docker server: *Get it from the server*, or it is picked up on the first PLAY).
- Friends get the address when the admin turns on *Put the IP in the list*; otherwise they type it once, or Bifrost copies the join code to the clipboard.
