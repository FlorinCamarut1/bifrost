// Downloads the Thunderstore package list for Valheim (~175 MB of JSON, ~14 MB gzipped) and writes a compact index
// (latest version only, no NSFW packages; deprecated ones are kept and marked - Discover shows them only when searched,
// and a server list may require one, e.g. AzuExtendedPlayerInventory). Runs as its own process (ELECTRON_RUN_AS_NODE) so the big
// parse never stays in the app's memory.   node catalog-worker.js <out.json>
const fs = require('fs');
const out = process.argv[2];

(async () => {
  const r = await fetch('https://thunderstore.io/c/valheim/api/v1/package/', { headers: { 'Accept-Encoding': 'gzip' } });
  if (!r.ok) throw new Error(`Thunderstore: HTTP ${r.status}`);
  const all = JSON.parse(await r.text());
  const packages = [];
  for (const p of all) {
    if (p.has_nsfw_content || !p.versions || !p.versions.length) continue;
    if (/^ebkr-r2modman/.test(p.full_name)) continue;   // the mod manager itself, not a mod
    const v = p.versions[0];   // newest first
    let downloads = 0;
    for (const x of p.versions) downloads += x.downloads || 0;
    packages.push({
      full: p.full_name, owner: p.owner, name: p.name, desc: v.description, icon: v.icon, ver: v.version_number,
      deps: v.dependencies, dl: downloads, rating: p.rating_score, updated: Date.parse(p.date_updated),
      created: Date.parse(p.date_created), cats: p.categories, url: p.package_url, size: v.file_size, pinned: p.is_pinned,
      ...(p.is_deprecated ? { deprecated: true } : {}),
    });
  }
  fs.writeFileSync(out + '.tmp', JSON.stringify({ v: 2, fetched: Date.now(), packages }));
  fs.renameSync(out + '.tmp', out);
  process.stdout.write(`ok ${packages.length} of ${all.length}`);
})().catch(e => { process.stderr.write(String(e && e.message || e)); process.exit(1); });
