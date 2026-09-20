// server/creatures.js
// Criaturas neutrales: a partir de la ronda 5, cada 3 turnos aparece una
// criatura en una casilla accesible aleatoria (no castillo, no ocupada, no
// inaccesible). Solo una activa a la vez; si no muere antes del siguiente
// ciclo, se queda (no expira ni se reemplaza).
//
// Al derrotarlas (siempre para el jugador que dio el golpe final):
//   - Lobo:      +1 ATQ permanente a todas sus tropas (hasta +3) + oro.
//   - Golem:     +1 DEF permanente a todas sus tropas (hasta +3) + oro.
//   - Basilisco: sus golpes envenenan al rival que sobreviva + oro.
//   - Hidra:     1 vez por turno, UNA tropa puede atacar 2 veces + oro.
//   - Dragón / Grifo / Fénix: desbloquean esa tropa para producirla en sus
//     castillos (ya no nacen en el acto). Si ya la tenía, paga oro.
//   - Medusa: solo oro.

const { resolveAttack } = require('./combat');
const { getActiveCreatures, maxCreaturesFor, UPGRADE_CAPS, createUpgrades } = require('./gameState');
const { getRandomAccessibleFreeTile } = require('./terrain');
const {
  findUnit, findPlayer, isPlayersTurn, killUnit,
  applyPoison, applyPetrify, isPetrified,
  combatMods, ensureCanAttack, markAttacked,
} = require('./units');
const { isUnitDisarmed } = require('./weather');

const CREATURE_START_ROUND = 5;
const CREATURE_INTERVAL_TURNS = 3;
const CREATURE_DESPAWN_ROUNDS = 10; // rondas que dura una criatura sin morir

// weight = probabilidad en % (suman 100). Se reajustó respecto a la spec
// original para dejarle lugar a grifo, basilisco y medusa.
//
// Habilidades especiales (se activan cuando la criatura sobrevive el golpe y
// contraataca, ver attackCreature):
//   - Basilisco: envenena a la ficha atacante (daño por turno, ver units.js).
//   - Medusa: petrifica a la ficha atacante (no puede moverse ni atacar
//     durante sus próximos turnos).
//
// Recompensa al derrotarlas:
//   - upgrade:  mejora permanente (clave dentro de player.upgrades).
//   - unlocks:  tropa que se desbloquea para producir en castillo.
//   - goldReward: oro del golpe final. En las que desbloquean tropa solo se
//     paga si el jugador ya la tenía desbloqueada.
const CREATURE_STATS = {
  lobo:      { atk: 4, hp: 8,  goldReward: 10, weight: 35, upgrade: 'atkBonus' },
  golem:     { atk: 3, hp: 12, goldReward: 14, weight: 25, upgrade: 'defBonus' },
  dragon:    { atk: 5, hp: 15, goldReward: 30, weight: 10, unlocks: 'dragon' },
  grifo:     { atk: 4, hp: 13, goldReward: 15, weight: 10, unlocks: 'grifo' },
  basilisco: { atk: 5, hp: 14, goldReward: 25, weight: 6,  poison: { damage: 2, turns: 3 }, upgrade: 'poisonStrike' },
  medusa:    { atk: 4, hp: 16, goldReward: 35, weight: 5,  petrify: { turns: 2 } },
  hidra:     { atk: 7, hp: 24, goldReward: 60, weight: 5,  regen: 2, upgrade: 'hydraStrike' },
  fenix:     { atk: 4, hp: 10, goldReward: 20, weight: 4,  unlocks: 'fenix' },
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
  if (getActiveCreatures(state).some((c) => c.x === x && c.y === y)) return false;
  return true;
}

// Un turno antes de que corresponda aparecer, se sortea ya el tipo y la
// casilla y se guardan en state.pendingCreatureSpawn. Así el cliente puede
// avisar "va a aparecer un Lobo en (x,y)" antes de que pase de verdad.
function tickCreatureTelegraph(state) {
  if (state.pendingCreatureSpawn) return null; // ya hay uno preparado
  if (getActiveCreatures(state).length >= maxCreaturesFor(state.maxPlayers)) return null;
  if (state.round < CREATURE_START_ROUND) return null;
  if (state.turnCounter % CREATURE_INTERVAL_TURNS !== CREATURE_INTERVAL_TURNS - 1) return null;

  const pos = getRandomAccessibleFreeTile(state, isTileFreeForCreature);
  if (!pos) return null;
  state.pendingCreatureSpawn = { type: pickCreatureType(), x: pos.x, y: pos.y };
  return state.pendingCreatureSpawn;
}

function tickCreatureSpawn(state) {
  if (getActiveCreatures(state).length >= maxCreaturesFor(state.maxPlayers)) {
    state.pendingCreatureSpawn = null;
    return null;
  }
  if (state.round < CREATURE_START_ROUND) return null;
  if (state.turnCounter <= 0 || state.turnCounter % CREATURE_INTERVAL_TURNS !== 0) return null;

  // Se usa lo telegrafiado si la casilla sigue libre; si no (alguien se
  // movió ahí mientras tanto), se sortea de nuevo en el momento.
  const pending = state.pendingCreatureSpawn;
  let type;
  let pos;
  if (pending && isTileFreeForCreature(state, pending.x, pending.y)) {
    type = pending.type;
    pos = { x: pending.x, y: pending.y };
  } else {
    pos = getRandomAccessibleFreeTile(state, isTileFreeForCreature);
    if (!pos) { state.pendingCreatureSpawn = null; return null; }
    type = pickCreatureType();
  }
  state.pendingCreatureSpawn = null;

  const stats = CREATURE_STATS[type];
  const creature = {
    id: state.creatureIdCounter++,
    type,
    x: pos.x,
    y: pos.y,
    hp: stats.hp,
    maxHp: stats.hp,
    atk: stats.atk,
    spawnedRound: state.round,
    despawnRound: state.round + CREATURE_DESPAWN_ROUNDS,
  };
  if (!Array.isArray(state.activeCreatures)) state.activeCreatures = [];
  state.activeCreatures.push(creature);
  return creature;
}

// Cada criatura desaparece si lleva CREATURE_DESPAWN_ROUNDS rondas sin morir.
// Devuelve la lista de criaturas retiradas.
function tickCreatureDespawn(state) {
  const gone = getActiveCreatures(state).filter((c) => c.despawnRound !== undefined && state.round >= c.despawnRound);
  if (gone.length > 0) removeCreatures(state, gone.map((c) => c.id));
  return gone;
}

function removeCreatures(state, ids) {
  const keep = getActiveCreatures(state).filter((c) => !ids.includes(c.id));
  state.activeCreatures = keep;
  state.activeCreature = null; // campo legado
}

// La Hidra regenera vida al cierre de cada ronda si sigue viva.
function tickCreatureRegen(state) {
  getActiveCreatures(state).forEach((c) => {
    const regen = CREATURE_STATS[c.type].regen;
    if (regen && c.hp < c.maxHp) c.hp = Math.min(c.maxHp, c.hp + regen);
  });
}

function isAdjacent(unit, creature) {
  const dx = Math.abs(unit.x - creature.x);
  const dy = Math.abs(unit.y - creature.y);
  return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
}

// Aplica la recompensa de una criatura derrotada al jugador del golpe final y
// la anota en el log:
//   log.event = 'creatureDefeated' | 'creatureUnlocked'
//   log.upgrade = { key, value }   (si ganó una mejora nueva)
//   log.unlockedType               (si desbloqueó una tropa)
//   log.goldReward                 (oro pagado)
function grantCreatureReward(state, player, creature, log) {
  const stats = CREATURE_STATS[creature.type];
  if (!player.upgrades) player.upgrades = createUpgrades();
  if (!Array.isArray(player.unlockedUnits)) player.unlockedUnits = [];

  let gold = stats.goldReward;
  log.event = 'creatureDefeated';

  if (stats.unlocks) {
    if (!player.unlockedUnits.includes(stats.unlocks)) {
      player.unlockedUnits.push(stats.unlocks);
      log.event = 'creatureUnlocked';
      log.unlockedType = stats.unlocks;
      gold = 0;
    }
  } else if (stats.upgrade) {
    const key = stats.upgrade;
    if (typeof player.upgrades[key] === 'boolean') {
      if (!player.upgrades[key]) {
        player.upgrades[key] = true;
        log.upgrade = { key, value: true };
      }
    } else if (player.upgrades[key] < UPGRADE_CAPS[key]) {
      player.upgrades[key] += 1;
      log.upgrade = { key, value: player.upgrades[key] };
    }
  }

  player.gold += gold;
  log.goldReward = gold;
}

// Una ficha propia adyacente ataca a la criatura activa. Varias fichas pueden
// atacarla en el mismo turno; cada ficha ataca una sola vez por turno.
function attackCreature(state, playerId, unitId, creatureId) {
  if (!isPlayersTurn(state, playerId)) throw new Error('No es tu turno');

  const unit = findUnit(state, unitId);
  if (!unit || unit.owner !== playerId) throw new Error('Ficha inválida');
  if (unit.type === 'rey') throw new Error('El Rey no puede atacar');
  if (isPetrified(unit)) throw new Error('Esa ficha está petrificada y no puede atacar');
  if (isUnitDisarmed(state, unit)) throw new Error('Un eclipse impide atacar a esa ficha');
  const attackInfo = ensureCanAttack(state, unit);

  const creature = getActiveCreatures(state).find((c) => c.id === creatureId);
  if (!creature) throw new Error('Esa criatura ya no está en el tablero');
  if (!isAdjacent(unit, creature)) throw new Error('La ficha debe estar adyacente a la criatura');

  const result = resolveAttack(unit, creature, combatMods(state, unit, creature));
  markAttacked(state, unit, attackInfo);

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
    second: !!attackInfo.second, // 2º ataque de la Hidra
  };

  if (result.defenderDied) {
    const player = findPlayer(state, playerId);
    if (player) grantCreatureReward(state, player, creature, log);
    removeCreatures(state, [creature.id]);
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
  tickCreatureTelegraph,
  tickCreatureSpawn,
  tickCreatureRegen,
  tickCreatureDespawn,
  CREATURE_DESPAWN_ROUNDS,
  attackCreature,
  isAdjacent,
};
