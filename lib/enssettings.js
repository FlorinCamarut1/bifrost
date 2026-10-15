// Enshrouded's dedicated server settings: enshrouded_server.json next to enshrouded_server.exe. The settings page
// edits a copy of the whole file, so keys this table does not know (a newer game) are kept as they are.
//   gameSettings only count when gameSettingsPreset is "Custom" - the page switches to it when one is changed.
//   Durations are stored in nanoseconds; the page shows minutes.
// Docker images write some keys from their environment at every start (indifferentbroccoli/enshrouded-server-docker:
// SERVER_NAME, SERVER_PASSWORD -> userGroups[0].password, MAX_PLAYERS): ENV_KEYS says which, main.js writes them to
// the compose env_file too, or the next start would undo the change.

const MIN = 60e9;   // ns per minute
const PRESETS = ['Default', 'Relaxed', 'Hard', 'Survival', 'Custom'];

// [key, type, label, hint, extra]   type: factor | bool | enum | minutes | number
const GAME = [
  ['Player', [
    ['playerHealthFactor', 'factor', 'Health', '', { min: 0.25, max: 4 }],
    ['playerManaFactor', 'factor', 'Mana', '', { min: 0.25, max: 4 }],
    ['playerStaminaFactor', 'factor', 'Stamina', '', { min: 0.25, max: 4 }],
    ['playerBodyHeatFactor', 'factor', 'Body heat', 'How long you stay warm in the cold.', { min: 0.5, max: 2 }],
    ['playerDivingTimeFactor', 'factor', 'Diving time', '', { min: 0.5, max: 2 }],
    ['tombstoneMode', 'enum', 'On death', 'AddBackpackMaterials = the tombstone keeps the backpack\'s materials; Everything = all items; NoTombstone = you keep everything.', { options: ['AddBackpackMaterials', 'Everything', 'NoTombstone'] }],
    ['enableGliderTurbulences', 'bool', 'Glider turbulence', ''],
  ]],
  ['Survival', [
    ['enableDurability', 'bool', 'Weapon durability', 'Off = weapons never break.'],
    ['enableStarvingDebuff', 'bool', 'Starving', 'Off = no penalty for not eating.'],
    ['foodBuffDurationFactor', 'factor', 'Food buff duration', '', { min: 0.5, max: 2 }],
    ['fromHungerToStarving', 'minutes', 'Hungry → starving after', 'Minutes.', { min: 5, max: 20 }],
    ['shroudTimeFactor', 'factor', 'Time in the Shroud', '', { min: 0.5, max: 2 }],
  ]],
  ['World and resources', [
    ['miningDamageFactor', 'factor', 'Mining damage', '', { min: 0.5, max: 2 }],
    ['plantGrowthSpeedFactor', 'factor', 'Plant growth speed', '', { min: 0.25, max: 2 }],
    ['resourceDropStackAmountFactor', 'factor', 'Resources dropped', '', { min: 0.25, max: 2 }],
    ['factoryProductionSpeedFactor', 'factor', 'Crafting stations speed', '', { min: 0.25, max: 2 }],
    ['weatherFrequency', 'enum', 'Weather', '', { options: ['Disabled', 'Rare', 'Normal', 'Often'] }],
    ['fishingDifficulty', 'enum', 'Fishing', '', { options: ['VeryEasy', 'Easy', 'Normal', 'Hard', 'VeryHard'] }],
    ['tamingStartleRepercussion', 'enum', 'Startled while taming', '', { options: ['KeepProgress', 'LoseSomeProgress', 'LoseAllProgress'] }],
  ]],
  ['Progression', [
    ['experienceCombatFactor', 'factor', 'XP from combat', '', { min: 0.25, max: 2 }],
    ['experienceMiningFactor', 'factor', 'XP from mining', '', { min: 0, max: 2 }],
    ['experienceExplorationQuestsFactor', 'factor', 'XP from exploring and quests', '', { min: 0.25, max: 2 }],
    ['perkCostFactor', 'factor', 'Rune cost of perks', '', { min: 0.25, max: 2 }],
    ['perkUpgradeRecyclingFactor', 'factor', 'Runes back when recycling perks', '', { min: 0, max: 1 }],
  ]],
  ['Enemies', [
    ['randomSpawnerAmount', 'enum', 'How many enemies', '', { options: ['Few', 'Normal', 'Many', 'Extreme'] }],
    ['aggroPoolAmount', 'enum', 'How many attack at once', '', { options: ['Few', 'Normal', 'Many', 'Extreme'] }],
    ['enemyDamageFactor', 'factor', 'Enemy damage', '', { min: 0.25, max: 5 }],
    ['enemyHealthFactor', 'factor', 'Enemy health', '', { min: 0.25, max: 4 }],
    ['enemyStaminaFactor', 'factor', 'Enemy stamina', 'How long until they are stunned.', { min: 0.5, max: 2 }],
    ['enemyPerceptionRangeFactor', 'factor', 'Enemy perception range', '', { min: 0.5, max: 2 }],
    ['bossDamageFactor', 'factor', 'Boss damage', '', { min: 0.2, max: 5 }],
    ['bossHealthFactor', 'factor', 'Boss health', '', { min: 0.2, max: 5 }],
    ['threatBonus', 'factor', 'Threat bonus', 'How fast enemy attacks get stronger over a fight.', { min: 0.25, max: 4 }],
    ['pacifyAllEnemies', 'bool', 'Peaceful enemies', 'Enemies only attack when attacked.'],
  ]],
  ['Day and night', [
    ['dayTimeDuration', 'minutes', 'Day length', 'Minutes.', { min: 2, max: 60 }],
    ['nightTimeDuration', 'minutes', 'Night length', 'Minutes.', { min: 2, max: 60 }],
    ['curseModifier', 'enum', 'Curse (Shroud) strength', '', { options: ['Easy', 'Normal', 'Hard'] }],
  ]],
];

// a user group: who knows its password gets these rights
const GROUP = [
  ['canKickBan', 'Kick / ban players'],
  ['canAccessInventories', 'Open chests'],
  ['canEditWorld', 'Change the world (terraform, build outside bases)'],
  ['canEditBase', 'Build in bases'],
  ['canExtendBase', 'Extend bases'],
];
const newGroup = name => ({ name, password: '', canKickBan: false, canAccessInventories: true, canEditWorld: true, canEditBase: true, canExtendBase: true, reservedSlots: 0 });

// json keys -> environment variables the Docker image writes them from at start
const ENV_KEYS = {
  name: ['SERVER_NAME'],
  groupPassword: ['SERVER_PASSWORD'],          // userGroups[0].password (and the old top-level password)
  slotCount: ['MAX_PLAYERS', 'SERVER_SLOT_COUNT'],
};

// every leaf that differs, as "a.b.0.c" paths
function diff(a, b, base = '', out = []) {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], base ? `${base}.${k}` : k, out);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(base);
  return out;
}

function validate(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return 'The settings are not a JSON object.';
  if (!String(j.name || '').trim()) return 'The server name cannot be empty.';
  const slots = j.slotCount;
  if (slots !== undefined && (!Number.isInteger(slots) || slots < 1 || slots > 16)) return 'Players: a whole number from 1 to 16.';
  if (j.gameSettingsPreset !== undefined && !PRESETS.includes(j.gameSettingsPreset)) return `Difficulty preset: one of ${PRESETS.join(', ')}.`;
  const gs = j.gameSettings || {};
  for (const [, rows] of GAME) for (const [k, type, label, , x] of rows) {
    if (!(k in gs)) continue;
    const v = gs[k];
    if (type === 'bool' && typeof v !== 'boolean') return `${label}: true or false.`;
    if (type === 'enum' && !x.options.includes(v)) return `${label}: one of ${x.options.join(', ')}.`;
    if ((type === 'factor' || type === 'minutes') && (typeof v !== 'number' || !isFinite(v) || v < 0)) return `${label}: a number.`;
  }
  if (!Array.isArray(j.userGroups) || !j.userGroups.length) return 'There must be at least one user group.';
  const names = new Set();
  for (const g of j.userGroups) {
    if (!String(g.name || '').trim()) return 'Every user group needs a name.';
    if (names.has(g.name)) return `Two user groups are called "${g.name}".`;
    names.add(g.name);
  }
  // the server tells groups apart by password: two groups with the same one make the second unreachable
  const pws = j.userGroups.map(g => g.password || '').filter(Boolean);
  if (new Set(pws).size !== pws.length) return 'Two user groups have the same password - players would always land in the first one.';
  return null;
}

// the tab-indented layout the server writes itself
const stringify = j => JSON.stringify(j, null, '\t') + '\n';

module.exports = { MIN, PRESETS, GAME, GROUP, ENV_KEYS, newGroup, diff, validate, stringify };
