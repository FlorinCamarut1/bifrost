## Bifrost 1.3.0 - config editor

- **Mods → ⚙**: every mod that has config files gets a settings panel - toggles, lists and numbers with the description, allowed range and default value from the file, search, reset to default, or the raw text. Mods with many files (EpicLoot, Seasonality) get a file list.
- **Save** writes the file into the profile and sends it to the server right away (two-way config sync); **Restart the server when empty** applies it for mods that read their config only at start. Only the changed lines are rewritten.
- Files that belong to no installed mod are under *Other configs* at the end of the list.
