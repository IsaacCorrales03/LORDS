// server/units.js
// Utilidades compartidas sobre fichas: búsqueda, creación, muerte (con la
// habilidad de resurrección del Fénix) y cola de eventos para el historial.

const { statsFor } = require('./combat');
const { GARRISON_TROOP_LIMIT, garrisonTroopCount, POISON_STRIKE } = require('./gameState');

const PHOENIX_REVIVE_COST = 10;

function findPlayer(state, playerId) {
  return state.players.find((p) => p.id === playerId) || null;
}
function findCastle(state, castleId) {
  return state.castles.find((c) => c.id === castleId) || null;
}
function findUnit(state, unitId) {
  return state.units.find((u) => u.id === unitId) || null;
}
function isPlayersTurn(state, playerId) {
  return state.phase === 'playing' && state.turnOrder[state.currentTurnIndex] === playerId;
}

// --- Mejoras permanentes (ver creatures.js) ---
// Se calculan al pelear, no se guardan en la ficha. El Rey y las criaturas
// neutrales no reciben bonos (solo las tropas de un jugador con la mejora).

function upgradesOf(state, ownerId) {
  const p = ownerId ? findPlayer(state, ownerId) : null;
  return (p && p.upgrades) || null;
}

function troopAtkBonus(state, unit) {
  if (!unit || unit.type === 'rey') return 0;
  const up = upgradesOf(state, unit.owner);
  return up ? up.atkBonus : 0;
}

function troopDefBonus(state, unit) {
  if (!unit || unit.type === 'rey') return 0;
  const up = upgradesOf(state, unit.owner);
  return up ? up.defBonus : 0;
}

// Modificadores para duel(): atacante vs defensor (cualquiera puede ser una
// criatura neutral, que no tiene dueño y por tanto no tiene bonos).
function combatMods(state, attacker, defender) {
  return {
    attackerAtk: troopAtkBonus(state, attacker),
    attackerDef: troopDefBonus(state, attacker),
    defenderAtk: troopAtkBonus(state, defender),
    defenderDef: troopDefBonus(state, defender),
  };
}

// Mejora del Basilisco: si el golpe no mató al objetivo, lo envenena.
// Devuelve true si aplicó el veneno.
function applyStrikePoison(state, attacker, target) {
  const up = upgradesOf(state, attacker && attacker.owner);
  if (!up || !up.poisonStrike || !target || target.hp <= 0) return false;
  applyPoison(target, POISON_STRIKE.damage, POISON_STRIKE.turns);
  return true;
}

// --- Ataques: 1 por turno, salvo el 2º ataque de la Hidra ---
// Mejora de la Hidra: 1 vez por turno (state.hydraUsedThisTurn), UNA sola
// tropa que ya haya atacado de verdad puede atacar una segunda vez. Se usa
// sola: la primera tropa que intenta un 2º ataque consume el permiso.

// Lanza error si la ficha no puede atacar ahora. Devuelve { second } para
// pasárselo a markAttacked() una vez validado todo el ataque.
function ensureCanAttack(state, unit) {
  if (!unit.attackedThisTurn) return { second: false };
  const up = upgradesOf(state, unit.owner);
  if (up && up.hydraStrike) {
    if (unit.didAttackThisTurn && !state.hydraUsedThisTurn) return { second: true };
    if (unit.didAttackThisTurn) throw new Error('Esa ficha ya atacó este turno (el 2º ataque de la Hidra ya se usó)');
  }
  throw new Error('Esa ficha ya atacó este turno');
}

// didAttackThisTurn distingue un ataque real de las fichas que solo tienen
// attackedThisTurn=true por haber sido producidas o resucitadas este turno.
function markAttacked(state, unit, attackInfo) {
  unit.attackedThisTurn = true;
  unit.didAttackThisTurn = true;
  if (attackInfo && attackInfo.second) state.hydraUsedThisTurn = true;
}

// --- Estados: veneno (Basilisco) y petrificación (Medusa) ---

function applyPoison(unit, damage, turns) {
  unit.poison = { damage, turns };
}

function applyPetrify(unit, turns) {
  unit.petrified = { turns };
}

function isPetrified(unit) {
  return !!(unit.petrified && unit.petrified.turns > 0);
}

// Se ejecuta al empezar el turno de `playerId`: el veneno inflige daño (y
// puede matar, con la resurrección del Fénix aplicando si corresponde) y la
// petrificación reduce su contador, liberando a la ficha cuando llega a 0.
function tickUnitStatuses(state, playerId) {
  const events = [];
  state.units
    .filter((u) => u.owner === playerId)
    .forEach((u) => {
      if (u.poison && u.poison.turns > 0) {
        u.hp -= u.poison.damage;
        u.poison.turns -= 1;
        if (u.poison.turns <= 0) u.poison = null;
        if (u.hp <= 0) {
          u.hp = 0;
          const kill = killUnit(state, u);
          events.push({
            type: 'poisonDamage', event: 'poisonKilled',
            playerId, unitId: u.id, unitType: u.type, revived: kill.revived,
          });
        } else {
          events.push({
            type: 'poisonDamage', event: 'poisonTick',
            playerId, unitId: u.id, unitType: u.type, hpRemaining: u.hp,
          });
        }
      }
      if (u.petrified && u.petrified.turns > 0) {
        u.petrified.turns -= 1;
        if (u.petrified.turns <= 0) {
          u.petrified = null;
          events.push({ type: 'petrifyWoreOff', event: 'petrifyWoreOff', playerId, unitId: u.id, unitType: u.type });
        }
      }
    });
  return events;
}

// Eventos "de fondo" (clima, resurrección, curación...) que index.js vacía
// hacia el historial después de cada acción.
function queueEvent(state, evt) {
  if (!state.eventQueue) state.eventQueue = [];
  state.eventQueue.push(evt);
}

function createUnit(state, type, owner, x, y, extra = {}) {
  const s = statsFor(type);
  return {
    id: state.unitIdCounter++,
    type,
    owner,
    x,
    y,
    castleId: null,
    movedThisTurn: false,
    attackedThisTurn: false,
    hp: s.hp,
    maxHp: s.hp,
    atk: s.atk,
    ...extra,
  };
}

function removeUnitFromCastleGarrison(state, unitId) {
  state.castles.forEach((c) => {
    c.garrison = c.garrison.filter((g) => g.unitId !== unitId);
  });
}

function removeUnit(state, unitId) {
  removeUnitFromCastleGarrison(state, unitId);
  state.units = state.units.filter((u) => u.id !== unitId);
}

// Fénix: al morir puede resucitar UNA vez por jugador pagando 10 monedas.
// Reaparece en el castillo más cercano que sea suyo (con cupo) o neutral
// (que pasa a ser suyo). Si no hay ninguno disponible, renace en el lugar
// donde cayó: ya no depende de que exista un castillo neutral libre.
function tryPhoenixRevive(state, unit) {
  const player = findPlayer(state, unit.owner);
  if (!player || player.phoenixRevived) return { ok: false, reason: 'yaUsada' };
  if (player.gold < PHOENIX_REVIVE_COST) return { ok: false, reason: 'sinOro' };

  const dist = (c) => Math.abs(c.x - unit.x) + Math.abs(c.y - unit.y);
  const candidates = state.castles.filter((c) => {
    if (c.owner === null) return !state.units.some((u) => u.id !== unit.id && u.x === c.x && u.y === c.y);
    if (c.owner !== player.id) return false;
    return garrisonTroopCount(state, c) - (c.garrison.some((g) => g.unitId === unit.id) ? 1 : 0) < GARRISON_TROOP_LIMIT;
  });
  candidates.sort((a, b) => dist(a) - dist(b));
  const castle = candidates[0] || null;

  player.gold -= PHOENIX_REVIVE_COST;
  player.phoenixRevived = true;
  unit.hp = unit.maxHp;
  unit.movedThisTurn = true;
  unit.attackedThisTurn = true;

  if (!castle) {
    return { ok: true, castleId: unit.castleId || null, x: unit.x, y: unit.y, inPlace: true };
  }
  removeUnitFromCastleGarrison(state, unit.id);
  unit.x = castle.x;
  unit.y = castle.y;
  unit.castleId = castle.id;
  castle.owner = player.id;
  castle.garrison.push({ unitId: unit.id });
  return { ok: true, castleId: castle.id, x: castle.x, y: castle.y };
}

// Punto único de "muerte" de una ficha. Devuelve { revived }.
function killUnit(state, unit) {
  if (unit.type === 'fenix') {
    const res = tryPhoenixRevive(state, unit);
    if (res.ok) {
      queueEvent(state, {
        type: 'phoenixRevived', event: 'phoenixRevived',
        playerId: unit.owner, unitId: unit.id, castleId: res.castleId, inPlace: !!res.inPlace, to: { x: res.x, y: res.y },
      });
      return { revived: true };
    }
    queueEvent(state, {
      type: 'phoenixLost', event: 'phoenixLost',
      playerId: unit.owner, reason: res.reason, to: { x: unit.x, y: unit.y },
    });
  }
  removeUnit(state, unit.id);
  return { revived: false };
}

module.exports = {
  PHOENIX_REVIVE_COST,
  findPlayer, findCastle, findUnit, isPlayersTurn,
  queueEvent, createUnit, removeUnit, removeUnitFromCastleGarrison, killUnit,
  applyPoison, applyPetrify, isPetrified, tickUnitStatuses,
  troopAtkBonus, troopDefBonus, combatMods, applyStrikePoison,
  ensureCanAttack, markAttacked,
};
