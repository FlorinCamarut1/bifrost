## Bifrost 1.9.0 - server settings

- **Server → Server settings** (Docker servers with the valheim-server image, started with docker compose): edit the server's variables from Bifrost - name, password, world, public list, crossplay, time zone, admins / banned / allowed players, backups, update and restart schedules, advanced ones and any other variable in the file, or the whole file as text.
- Bifrost finds the file through the container's compose labels (the service's env_file), keeps a copy next to it (`valheim.env.bak-<date>`) before writing, and changes only the edited lines.
- **Apply now** recreates the container in the background (`docker compose up -d`) - new variables only reach the server that way - and waits for the join code; you can keep using Bifrost meanwhile. Valheim's password rules are checked first (5+ characters, not part of the name), and a new password also becomes the one Bifrost uses for joining directly.
