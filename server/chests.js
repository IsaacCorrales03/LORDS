// server/chests.js
// Cofres del tesoro: aparecen al azar en cualquier casilla accesible libre
// (no castillo, no granja, sin fichas ni criaturas). Se abren al terminar un
// movimiento encima; dan oro. No caducan.

const { getRandomAccessibleFreeTile } = require('./terrain');
const { queueEvent, findPlayer, findUnit } = require('./units');
const { getActiveCreatures } = require('./gameState');

const CHEST_START_ROUND = 2;
const CHEST_SPAWN_CHANCE = 0.3; // probabilidad por turno cuando hay cupo
// peso = probabilidad relativa de cada premio
const CHEST_REWARDS = [
  { gold: 10, weight: 30 },
  { gold: 20, weight: 30 },
  { gold: 30, weight: 25 },
  { gold: 50, weight: 15 },
];

function maxChestsFor(state) {
  return Math.max(2, state.maxPlayers);
}

function pickReward() {
  const total = CHEST_REWARDS.reduce((s, r) => s + r.weight, 0);
  let roll = Math.random() * total;
  for (const r of CHEST_REWARDS) { roll -= r.weight; if (roll <= 0) return r.gold; }
  return CHEST_REWARDS[0].gold;
}

function isTileFreeForChest(state, x, y) {
  if (state.tiles[y][x].type === 'farm') return false;
  if (state.units.some((u) => u.x === x && u.y === y)) return false;
  if (getActiveCreatures(state).some((c) => c.x === x && c.y === y)) return false;
  if ((state.chests || []).some((c) => c.x === x && c.y === y)) return false;
  return true;
}

// Se llama una vez por turno. Devuelve el cofre creado o null.
function tickChestSpawn(state) {
  if (!Array.isArray(state.chests)) state.chests = [];
  if (state.round < CHEST_START_ROUND) return null;
  if (state.chests.length >= maxChestsFor(state)) return null;
  if (Math.random() > CHEST_SPAWN_CHANCE) return null;

  const pos = getRandomAccessibleFreeTile(state, isTileFreeForChest);
  if (!pos) return null;
  const chest = { id: state.chestIdCounter++, x: pos.x, y: pos.y, gold: pickReward() };
  state.chests.push(chest);
  return chest;
}

// Si la ficha terminó su movimiento sobre un cofre, su dueño lo abre.
function collectChestAt(state, unitId) {
  const unit = findUnit(state, unitId);
  if (!unit || !Array.isArray(state.chests)) return null;
  const chest = state.chests.find((c) => c.x === unit.x && c.y === unit.y);
  if (!chest) return null;
  const player = findPlayer(state, unit.owner);
  if (!player) return null;
  player.gold += chest.gold;
  state.chests = state.chests.filter((c) => c.id !== chest.id);
  queueEvent(state, {
    type: 'chestCollected', event: 'chestCollected',
    playerId: unit.owner, unitType: unit.type, gold: chest.gold, to: { x: chest.x, y: chest.y },
  });
  return chest;
}

module.exports = { CHEST_START_ROUND, CHEST_SPAWN_CHANCE, CHEST_REWARDS, tickChestSpawn, collectChestAt };
