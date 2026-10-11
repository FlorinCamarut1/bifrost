## Bifrost 1.9.1

- **Players online are counted right**: Bifrost used the server session's own counter ("now N player(s)"), which Valheim does not always update - after the last player left it never said 0, and once it said 2 right after a leave. Bifrost now follows each character: online from "Got character ZDOID from <name>" until the server drops that character (within about a minute of leaving), cross-checked with the server's "Connections N" line. This also makes "restart only when nobody plays" more reliable.
- The Server page shows who is on right now (green dot) in *Seen since start*.
