## Bifrost 1.9.2

- **Players online, second fix**: a character gets a new id at every join, and the server does not always log when it drops one, so a player who left and came back counted twice ("2 online" with nobody on). Bifrost now follows the players by their Steam id through the ServerSync lines most server mods write ("Adding peer ... to validated list" / "Peer ... disconnected"), empties the list when the game restarts ("New session server"), and takes the names from the character each player brings in. A leave shows up about 90 seconds later (the server waits that long for a reconnect). Servers without ServerSync mods keep the previous method.
- Checked by replaying the day's real server log: the count matched who was on at every point.
