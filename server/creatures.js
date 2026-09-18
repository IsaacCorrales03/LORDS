// server/creatures.js
// Criaturas neutrales: a partir de la ronda 5, cada 3 turnos aparece una
// criatura en una casilla accesible aleatoria (no castillo, no ocupada, no
// inaccesible). Solo una activa a la vez; si no muere antes del siguiente
// ciclo, se queda (no expira ni se reemplaza).
//
// Al derrotarlas:
//   - Lobo / Golem / Hidra: el golpe final da oro.
//   - Dragón y Fénix: no mueren, se doman y nacen como tropa del jugador que
//     dio el golpe final, en la misma casilla.

const { resolveAttack } = require('./combat');
const { getRandomAccessibleFreeTile } = require('./terrain');
const {
  createUnit, findUnit, findPlayer, isPlayersTurn, killUnit,
  applyPoison, applyPetrify, isPetrified,
} = require('./units');

const CREATURE_START_ROUND = 5;
const CREATURE_INTERVAL_TURNS = 3;

// weight = probabilidad en % (suman 100). Se reajustó respecto a la spec
// original para dejarle lugar a grifo, basilisco y medusa.
//
// Habilidades especiales (se activan cuando la criatura sobrevive el golpe y
// contraataca, ver attackCreature):
//   - Basilisco: envenena a la ficha atacante (daño por turno, ver units.js).
//   - Medusa: petrifica a la ficha atacante (no puede moverse ni atacar
//     durante sus próximos turnos).
const CREATURE_STATS = {
  lobo:      { atk: 4, hp: 8,  goldReward: 10, weight: 35 },
  golem:     { atk: 3, hp: 12, goldReward: 14, weight: 25 },
  dragon:    { atk: 5, hp: 15, goldReward: 30, weight: 10, tameable: true },
  grifo:     { atk: 4, hp: 13, goldReward: 0,  weight: 10, tameable: true },
  basilisco: { atk: 5, hp: 14, goldReward: 25, weight: 6,  poison: { damage: 2, turns: 3 } },
  medusa:    { atk: 4, hp: 16, goldReward: 35, weight: 5,  petrify: { turns: 2 } },
  hidra:     { atk: 7, hp: 24, goldReward: 60, weight: 5,  regen: 2 },
  fenix:     { atk: 4, hp: 10, goldReward: 0,  weight: 4,  tameable: true },
};

function pickCreatureType() {
  const entries = Object.entries(CREATURE_STATS);
  const totalWeight = entries.reduce((sum, [, s]) => sum + s.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const [type, stats] of entries) {
    roll -= stats.weight;
    if (roll <= 0) return type;
  }
  return entries[entries.length - 1][0];
}

function isTileFreeForCreature(state, x, y) {
  if (state.units.some((u) => u.x === x && u.y === y)) return false;
  if (state.activeCreature && state.activeCreature.x === x && state.activeCreature.y === y) return false;
  return true;
}

function tickCreatureSpawn(state) {
  if (state.activeCreature) return null;
  if (state.round < CREATURE_START_ROUND) return null;
  if (state.turnCounter <= 0 || state.turnCounter % CREATURE_INTERVAL_TURNS !== 0) return null;

  const pos = getRandomAccessibleFreeTile(state, isTileFreeForCreature);
  if (!pos) return null;

  const type = pickCreatureType();
  const stats = CREATURE_STATS[type];
  const creature = {
    id: state.creatureIdCounter++,
    type,
    x: pos.x,
    y: pos.y,
    hp: stats.hp,
    maxHp: stats.hp,
    atk: stats.atk,
  };
  state.activeCreature = creature;
  return creature;
}

// La Hidra regenera vida al cierre de cada ronda si sigue viva.
function tickCreatureRegen(state) {
  const c = state.activeCreature;
  if (!c) return;
  const regen = CREATURE_STATS[c.type].regen;
  if (regen && c.hp < c.maxHp) c.hp = Math.min(c.maxHp, c.hp + regen);
}

function isAdjacent(unit, creature) {
  const dx = Math.abs(unit.x - creature.x);
  const dy = Math.abs(unit.y - creature.y);
  return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
}

// Una ficha propia adyacente ataca a la criatura activa. Varias fichas pueden
// atacarla en el mismo turno; cada ficha ataca una sola vez por turno.
function attackCreature(state, playerId, unitId) {
  if (!isPlayersTurn(state, playerId)) throw new Error('No es tu turno');

  const unit = findUnit(state, unitId);
  if (!unit || unit.owner !== playerId) throw new Error('Ficha inválida');
  if (unit.type === 'rey') throw new Error('El Rey no puede atacar');
  if (isPetrified(unit)) throw new Error('Esa ficha está petrificada y no puede atacar');
  if (unit.attackedThisTurn) throw new Error('Esa ficha ya atacó este turno');

  const creature = state.activeCreature;
  if (!creature) throw new Error('No hay ninguna criatura para atacar');
  if (!isAdjacent(unit, creature)) throw new Error('La ficha debe estar adyacente a la criatura');

  const result = resolveAttack(unit, creature);
  unit.attackedThisTurn = true;

  const log = {
    type: 'attackCreature',
    playerId,
    unitId,
    unitType: unit.type,
    creatureId: creature.id,
    creatureType: creature.type,
    dealt: result.dealt,
    counter: result.counter,
    to: { x: creature.x, y: creature.y },
  };

  if (result.defenderDied) {
    const stats = CREATURE_STATS[creature.type];
    if (stats.tameable) {
      const tamed = createUnit(state, creature.type, playerId, creature.x, creature.y, {
        movedThisTurn: true,
        attackedThisTurn: true,
      });
      state.units.push(tamed);
      log.event = 'creatureTamed';
      log.tamedUnitId = tamed.id;
    } else {
      const player = findPlayer(state, playerId);
      if (player) player.gold += stats.goldReward;
      log.event = 'creatureDefeated';
      log.goldReward = stats.goldReward;
    }
    state.activeCreature = null;
  } else if (result.attackerDied) {
    const kill = killUnit(state, unit);
    log.event = kill.revived ? 'attackerRevived' : 'attackerLostToCreature';
    log.creatureHpRemaining = creature.hp;
  } else {
    log.event = 'creatureSurvived';
    log.creatureHpRemaining = creature.hp;
    log.attackerHpRemaining = unit.hp;

    // El contraataque de la criatura, si conecta, puede envenenar o
    // petrificar a la ficha atacante (Basilisco / Medusa).
    if (result.counter > 0) {
      const stats = CREATURE_STATS[creature.type];
      if (stats.poison) {
        applyPoison(unit, stats.poison.damage, stats.poison.turns);
        log.statusApplied = 'poison';
      } else if (stats.petrify) {
        applyPetrify(unit, stats.petrify.turns);
        log.statusApplied = 'petrified';
      }
    }
  }

  return log;
}

module.exports = {
  CREATURE_START_ROUND,
  CREATURE_INTERVAL_TURNS,
  CREATURE_STATS,
  tickCreatureSpawn,
  tickCreatureRegen,
  attackCreature,
  isAdjacent,
};
