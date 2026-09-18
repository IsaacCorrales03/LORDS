// server/units.js
// Utilidades compartidas sobre fichas: búsqueda, creación, muerte (con la
// habilidad de resurrección del Fénix) y cola de eventos para el historial.

const { statsFor } = require('./combat');

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

// Fénix: al morir puede resucitar UNA vez por jugador pagando 10 monedas, en
// un castillo neutral (que pasa a ser suyo). Si no hay castillo neutral libre,
// no tiene oro o ya usó su resurrección, la ficha se pierde.
function tryPhoenixRevive(state, unit) {
  const player = findPlayer(state, unit.owner);
  if (!player || player.phoenixRevived) return { ok: false, reason: 'yaUsada' };
  if (player.gold < PHOENIX_REVIVE_COST) return { ok: false, reason: 'sinOro' };

  const free = state.castles.filter(
    (c) => c.owner === null && !state.units.some((u) => u.id !== unit.id && u.x === c.x && u.y === c.y)
  );
  if (free.length === 0) return { ok: false, reason: 'sinCastillo' };

  free.sort(
    (a, b) =>
      Math.abs(a.x - unit.x) + Math.abs(a.y - unit.y) - (Math.abs(b.x - unit.x) + Math.abs(b.y - unit.y))
  );
  const castle = free[0];

  player.gold -= PHOENIX_REVIVE_COST;
  player.phoenixRevived = true;
  removeUnitFromCastleGarrison(state, unit.id);
  unit.hp = unit.maxHp;
  unit.x = castle.x;
  unit.y = castle.y;
  unit.castleId = castle.id;
  unit.movedThisTurn = true;
  unit.attackedThisTurn = true;
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
        playerId: unit.owner, unitId: unit.id, castleId: res.castleId, to: { x: res.x, y: res.y },
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
};
