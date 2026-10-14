// Nexus Mods API v1 with the player's own personal API key (nexusmods.com -> Site preferences -> API keys).
// Free accounts can only download through the site's "Mod Manager Download" button: it opens an nxm:// link
// carrying a one-time key + expiry, which download_link.json accepts. Premium accounts can ask for links directly.
// The game (domain, numeric id, "outdated before" date) comes from lib/games.js: setGame() when the server changes.
const API = 'https://api.nexusmods.com/v1';
const { GAMES } = require('./games');
const GQL = 'https://api.nexusmods.com/v2/graphql';

class Nexus {
  constructor({ fetch, appName, appVersion, game = GAMES.valheim.nexus }) { this.fetch = fetch; this.appName = appName; this.appVersion = appVersion; this.key = null; this.setGame(game); }
  // (the static helpers follow the last setGame: one game is active at a time)
  setGame(g) { this.game = g; Nexus.domain = g.domain; }
  async api(p, query) {
    if (!this.key) throw new Error('Lipsește cheia Nexus (Setări).');
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const r = await this.fetch(`${API}${p}${qs}`, {
      headers: { apikey: this.key, accept: 'application/json', 'Application-Name': this.appName, 'Application-Version': this.appVersion },
    });
    const text = await r.text();
    let j = null; try { j = JSON.parse(text); } catch { }
    if (!r.ok) throw new Error(`Nexus ${r.status}: ${(j && (j.message || j.error)) || text.slice(0, 200)}`);
    return j;
  }
  validate() { return this.api('/users/validate.json'); }                      // { name, is_premium, ... }
  mod(modId) { return this.api(`/games/${this.game.domain}/mods/${modId}.json`); }
  files(modId) { return this.api(`/games/${this.game.domain}/mods/${modId}/files.json`); }  // { files: [{ file_id, name, version, category_name, file_name, size_kb, uploaded_timestamp }] }
  async downloadUrl(modId, fileId, nxm) {
    const links = await this.api(`/games/${this.game.domain}/mods/${modId}/files/${fileId}/download_link.json`, nxm ? { key: nxm.key, expires: nxm.expires } : undefined);
    if (!Array.isArray(links) || !links.length) throw new Error('Nexus nu a dat niciun link de descărcare');
    return links[0].URI;
  }
  // the newest main file of a mod
  async mainFile(modId) {
    const { files = [] } = await this.files(modId);
    const main = files.filter(f => f.category_name === 'MAIN');
    const pick = (main.length ? main : files.filter(f => f.category_name !== 'OLD_VERSION' && f.category_name !== 'ARCHIVED'))
      .sort((a, b) => (b.uploaded_timestamp || 0) - (a.uploaded_timestamp || 0))[0];
    if (!pick) throw new Error('modul nu are fișiere');
    return pick;
  }
  // ----- public GraphQL v2 (no key needed): search + file lists -----
  async gql(query, variables) {
    const r = await this.fetch(GQL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Application-Name': this.appName }, body: JSON.stringify({ query, variables }) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.errors) throw new Error(`Nexus: ${(j && j.errors && j.errors[0].message) || r.status}`);
    return j.data;
  }
  // cat: a Nexus category name. On the first page the category counts come too ({ Gameplay: 1147, ... }), counted
  // for the search text without the category (a postFilter would zero the other categories)
  // old: also mods not updated since Ashlands (most of those broke with it); without it they are left out
  // need: a word the description must have (full-text MATCHES) - "EML" keeps Enshrouded to mods for its mod loader
  // (most of its top downloads are Cheat Engine tables and saves Bifrost cannot install)
  async search({ q = '', sort = 'downloads', offset = 0, count = 30, cat = null, old = false, need = null } = {}) {
    const all = { gameDomainName: [{ value: this.game.domain }] };
    if (need) all.description = [{ value: String(need), op: 'MATCHES' }];
    if (!old && this.game.outdatedBefore) all.updatedAt = [{ value: String(this.game.outdatedBefore), op: 'GTE' }];   // (epoch seconds; a date string matches nothing)
    if (q.trim()) all.name = [{ value: q.trim(), op: 'WILDCARD' }];   // WILDCARD already means "contains"; added * break it
    const filter = cat ? { ...all, categoryName: [{ value: cat }] } : all, facets = offset === 0;
    const d = await this.gql(`query($f: ModsFilter${facets ? ', $a: ModsFilter' : ''}, $s: [ModsSort!], $o: Int, $c: Int) { mods(filter: $f, sort: $s, offset: $o, count: $c) {
      totalCount nodes { modId name summary version author uploader { name } thumbnailUrl pictureUrl downloads endorsements updatedAt createdAt adultContent modCategory { name } } }
      ${facets ? 'cats: mods(filter: $a, facets: { categoryName: [] }, count: 0) { facetsData }' : ''} }`,
      { f: filter, ...(facets ? { a: all } : {}), s: [{ [sort]: { direction: 'DESC' } }], o: offset, c: count });
    return { total: d.mods.totalCount, mods: d.mods.nodes.filter(m => !m.adultContent), cats: d.cats?.facetsData?.categoryName || null };
  }
  async modFiles(modId) {
    const d = await this.gql(`query($m: ID!, $g: ID!) { modFiles(modId: $m, gameId: $g) { fileId name version category date sizeInBytes primary } }`, { m: String(modId), g: this.game.id });
    return d.modFiles;
  }
  async modInfo(modId) {
    const d = await this.gql(`query($f: ModsFilter) { mods(filter: $f, count: 1) { nodes { modId name summary version author thumbnailUrl } } }`,
      { f: { gameId: [{ value: this.game.id }], modId: [{ value: String(modId) }] } });
    return d.mods.nodes[0] || null;
  }
  // newest file in MAIN (or anything not old/archived)
  static pickMain(files) {
    const live = files.filter(f => f.category === 'MAIN');
    return (live.length ? live : files.filter(f => !/OLD_VERSION|ARCHIVED|REMOVED/.test(f.category))).sort((a, b) => b.date - a.date)[0] || null;
  }
  static parseNxm(url) {
    // nxm://valheim/mods/1234/files/5678?key=...&expires=...&user_id=...
    const m = String(url).match(/^nxm:\/\/([^/]+)\/mods\/(\d+)\/files\/(\d+)\/?\?(.*)$/i);
    if (!m) return null;
    const q = new URLSearchParams(m[4]);
    return { game: m[1].toLowerCase(), modId: +m[2], fileId: +m[3], key: q.get('key'), expires: q.get('expires') };
  }
  static parseModUrl(s) {
    const m = String(s).match(new RegExp(`nexusmods\\.com\\/${Nexus.domain}\\/mods\\/(\\d+)`, 'i')) || String(s).match(/^\s*(\d+)\s*$/);
    return m ? +m[1] : null;
  }
  static filesPage(modId, fileId) { return `https://www.nexusmods.com/${Nexus.domain}/mods/${modId}?tab=files${fileId ? `&file_id=${fileId}&nmm=1` : ''}`; }
}

Nexus.domain = GAMES.valheim.nexus.domain;
module.exports = { Nexus };
