## Bifrost 1.8.4

- **Fixed: a Nexus mod installed with "Slow download" was asked for again and again.** The install saved the Nexus file id (e.g. 23850) as the version instead of the real one (1.10), so the next check found "23850 -> 1.10" and wanted it once more. The right version is saved now, and profiles that already have the wrong one are corrected by themselves (the same Nexus file counts as installed) - no new click needed.
- A server list that is no longer where the invite points says so ("ask the admin for the current invite link") instead of "GitHub 404".
