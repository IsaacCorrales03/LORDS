// server/actions.js
// Lógica de acciones de juego: movimiento, combate, producción de fichas,
// construcción de granjas, y avance de turno/ronda.

const {
  CASTLE_LEVELS,
  UNIT_COSTS,
  MOVEMENT_RANGE,
  FARM_COST,
  FARM_INCOME,
  inActiveWeather,
  BARRACKS_COST, BARRACKS_UPGRADES, barracksOf, farmIncomeFor, barrierLevelFor, troopCostFor,
  BARRIER_COST,
  BARRIER_HP_BY_LEVEL,
  BARRIER_COUNTER_DAMAGE_BY_LEVEL,
  FLYING_UNITS,
  UNLOCKABLE_UNITS,
  getActiveCreatures,
  GARRISON_TROOP_LIMIT, garrisonTroopCount, castleTroopCount,
} = require('./gameState');
const { duel } = require('./combat');
const { tickChestSpawn, collectChestAt } = require('./chests');
const {
  findPlayer, findCastle, findUnit, isPlayersTurn,
  createUnit, removeUnit, removeUnitFromCastleGarrison, killUnit, queueEvent,
  isPetrified, tickUnitStatuses,
  troopAtkBonus, troopDefBonus, combatMods, applyStrikePoison,
  ensureCanAttack, markAttacked,
} = require('./units');
const {
  tickCreatureTelegraph, tickCreatureSpawn, tickCreatureRegen, tickCreatureDespawn, attackCreature: attackCreatureInternal,
} = require('./creatures');
const { tickWeather, isUnitImmobilized, isUnitDisarmed } = require('./weather');

function tileAt(state, x, y) {
  if (y < 0 || y >= state.boardSize || x < 0 || x >= state.boardSize) return null;
  return state.tiles[y][x];
}

function unitAt(state, x, y) {
  return state.units.find((u) => u.x === x && u.y === y) || null;
}

function creatureAt(state, x, y) {
  return getActiveCreatures(state).find((c) => c.x === x && c.y === y) || null;
}

function barrierAt(state, x, y) {
  return (state.barriers || []).find((b) => b.x === x && b.y === y) || null;
}

// --- Fase 1: obtener oro ---
function collectGold(state) {
  state.players.forEach((player) => {
    if (!player.alive) return;
    const ownedCastles = state.castles.filter((c) => c.owner === player.id);
    let income = 0;
    ownedCastles.forEach((castle) => {
      const levelInfo = CASTLE_LEVELS[castle.level];
      income += levelInfo.goldPerTurn;
    });
    const ownedFarms = state.farms.filter((f) => f.owner === player.id);
    income += ownedFarms.length * farmIncomeFor(state, player.id);
    player.gold += income;
  });
}

// --- Movimiento ---

// Devuelve las casillas candidatas alcanzables en línea recta (8 direcciones)
// hasta `range` pasos, deteniéndose si choca con un castillo en medio del
// camino (no puede atravesarlo, salvo que sea el destino final).
const ORTHOGONAL_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGONAL_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ALL_DIRS = [...ORTHOGONAL_DIRS, ...DIAGONAL_DIRS];

// Una casilla no es válida como destino/paso si es un hueco, tiene una
// criatura, o hay una ficha propia en ella (salvo que sea un castillo propio).
function getLineMoves(state, unit, range, dirs) {
  dirs = dirs || ALL_DIRS;
  const flying = FLYING_UNITS.has(unit.type);
  const moves = [];
  dirs.forEach(([dx, dy]) => {
    for (let step = 1; step <= range; step++) {
      const x = unit.x + dx * step;
      const y = unit.y + dy * step;
      const tile = tileAt(state, x, y);
      if (!tile) break;
      if (tile.type === 'inaccessible') {
        if (flying) continue; // sobrevuela el hueco pero no puede aterrizar
        break;
      }
      if (tile.type === 'barrier') {
        if (flying) continue; // sobrevuela la barrera pero no puede aterrizar
        break; // bloquea el paso: hay que destruirla para avanzar
      }
      if (creatureAt(state, x, y)) break; // a las criaturas se las ataca, no se pisan
      const other = unitAt(state, x, y);
      if (other && other.owner === unit.owner && tile.type !== 'castle') break;
      moves.push({ x, y });
      if (tile.type === 'castle' || other) break;
    }
  });
  return moves;
}

// Movimiento del Dragón: igual que la Reina (8 direcciones) pero sin
// bloqueo alguno. Cada casilla de cada dirección se evalúa de forma
// independiente como posible destino (nada detiene el recorrido salvo salir
// del tablero); solo importa si esa casilla puntual es un destino válido.
function getUnblockedLineMoves(state, unit, dirs) {
  dirs = dirs || ALL_DIRS;
  const moves = [];
  dirs.forEach(([dx, dy]) => {
    for (let step = 1; step <= Math.max(state.boardSize, 1); step++) {
      const x = unit.x + dx * step;
      const y = unit.y + dy * step;
      const tile = tileAt(state, x, y);
      if (!tile) break; // fuera del tablero: no hay más casillas en esta dirección
      if (tile.type === 'inaccessible') continue; // sobrevuela, no puede aterrizar
      if (tile.type === 'barrier') continue; // sobrevuela la barrera, no puede aterrizar
      if (creatureAt(state, x, y)) continue; // sobrevuela, se ataca aparte
      const other = unitAt(state, x, y);
      if (other && other.owner === unit.owner && tile.type !== 'castle') continue; // sobrevuela
      moves.push({ x, y });
      // sin "break": el Dragón sigue pudiendo aterrizar más lejos en esta dirección
    }
  });
  return moves;
}

function getKnightMoves(state, unit) {
  const jumps = [
    [1, 2], [2, 1], [-1, 2], [-2, 1],
    [1, -2], [2, -1], [-1, -2], [-2, -1],
  ];
  return jumps
    .map(([dx, dy]) => ({ x: unit.x + dx, y: unit.y + dy }))
    .filter((p) => {
      const tile = tileAt(state, p.x, p.y);
      if (!tile || tile.type === 'inaccessible' || tile.type === 'barrier') return false;
      if (creatureAt(state, p.x, p.y)) return false;
      const other = unitAt(state, p.x, p.y);
      if (other && other.owner === unit.owner && tile.type !== 'castle') return false;
      return true;
    });
}

// Movimiento del Grifo: salta directo a las 4 esquinas de un cuadrado de
// 2x2 casillas a su alrededor (±2, ±2), sin bloqueo por el camino —
// misma lógica que el salto del Caballo.
function getGriffinMoves(state, unit) {
  const jumps = [[2, 2], [2, -2], [-2, 2], [-2, -2]];
  return jumps
    .map(([dx, dy]) => ({ x: unit.x + dx, y: unit.y + dy }))
    .filter((p) => {
      const tile = tileAt(state, p.x, p.y);
      if (!tile || tile.type === 'inaccessible' || tile.type === 'barrier') return false;
      if (creatureAt(state, p.x, p.y)) return false;
      const other = unitAt(state, p.x, p.y);
      if (other && other.owner === unit.owner && tile.type !== 'castle') return false;
      return true;
    });
}

// ¿Entrar a (x, y) sería un ataque? (ficha rival o castillo rival con defensores)
function isHostileTile(state, unit, x, y) {
  if (state.units.some((u) => u.x === x && u.y === y && u.owner !== unit.owner)) return true;
  const tile = tileAt(state, x, y);
  if (tile && tile.type === 'castle') {
    const c = findCastle(state, tile.occupantCastleId);
    if (c && c.owner && c.owner !== unit.owner && c.garrison.length > 0) return true;
  }
  return false;
}

// Casillas alcanzables. Regla "o atacas o te mueves contra un rival": una
// ficha que ya atacó este turno no puede entrar a una casilla hostil (salvo
// el 2º ataque de la Hidra, ver ensureCanAttack).
function getReachableTiles(state, unit) {
  let tiles = getReachableTilesRaw(state, unit);
  // Ventisca: quien esté dentro solo puede avanzar 1 casilla (en cualquier dirección).
  if (inActiveWeather(state, 'nieve', unit.x, unit.y)) {
    tiles = tiles.filter((t) => Math.max(Math.abs(t.x - unit.x), Math.abs(t.y - unit.y)) <= 1);
  }
  if (!unit.attackedThisTurn) return tiles;
  let canAgain = true;
  try { ensureCanAttack(state, unit); } catch (e) { canAgain = false; }
  return canAgain ? tiles : tiles.filter((t) => !isHostileTile(state, unit, t.x, t.y));
}

function getReachableTilesRaw(state, unit) {
  if (unit.type === 'rey') return []; // el Rey nunca puede moverse
  if (isPetrified(unit)) return []; // petrificado: no puede moverse
  if (isUnitImmobilized(state, unit)) return []; // terremoto: no puede moverse

  switch (unit.type) {
    case 'peon':
      return getLineMoves(state, unit, 1, ORTHOGONAL_DIRS);
    case 'caballo':
      return getKnightMoves(state, unit);
    case 'alfil':
      return getLineMoves(state, unit, state.boardSize, DIAGONAL_DIRS);
    case 'torre':
      return getLineMoves(state, unit, state.boardSize, ORTHOGONAL_DIRS);
    case 'reina':
      return getLineMoves(state, unit, state.boardSize, ALL_DIRS);
    case 'dragon':
      return getUnblockedLineMoves(state, unit, ALL_DIRS);
    case 'fenix':
      return getLineMoves(state, unit, 2, ALL_DIRS);
    case 'grifo':
      return getGriffinMoves(state, unit);
    default: {
      const range = MOVEMENT_RANGE[unit.type] || 1;
      return getLineMoves(state, unit, range);
    }
  }
}

// Tipos cuyo movimiento es un "salto" (ignora el camino intermedio): al
// reclamar territorio solo se reclama la casilla de destino, nunca el
// trayecto, incluso cuando ese trayecto sea geométricamente una línea recta
// (como pasa con el salto en diagonal del Grifo).
const JUMPING_UNIT_TYPES = new Set(['caballo', 'grifo']);

// Un rival que pisa el cuartel lo destruye (con todas sus mejoras): la casilla
// queda como territorio del que lo capturó. Devuelve el id del dueño anterior
// (o null si no había cuartel rival ahí).
function captureBarracksIfEnemy(state, playerId, destTile, x, y) {
  if (!destTile || destTile.type !== 'barracks' || destTile.owner === playerId) return null;
  const prevOwner = destTile.owner;
  state.barracks = (state.barracks || []).filter((b) => !(b.x === x && b.y === y));
  destTile.type = 'territory';
  destTile.owner = playerId;
  return prevOwner;
}

function claimTerritoryAlongPath(state, playerId, fromX, fromY, toX, toY, isJump = false) {
  const dx = Math.sign(toX - fromX);
  const dy = Math.sign(toY - fromY);
  const distX = Math.abs(toX - fromX);
  const distY = Math.abs(toY - fromY);
  const isStraightLine = !isJump && (distX === 0 || distY === 0 || distX === distY);

  if (!isStraightLine) {
    // Movimiento tipo salto (Caballo o Grifo) o no lineal: solo se reclama
    // el destino, no hay un "camino" recto que trazar.
    const destTile = tileAt(state, toX, toY);
    if (destTile && (destTile.type === 'neutral' || destTile.type === 'territory')) {
      destTile.type = 'territory';
      destTile.owner = playerId;
    }
    return;
  }

  let x = fromX;
  let y = fromY;
  // Reclama cada casilla del camino recorrido (sin contar la de origen).
  while (x !== toX || y !== toY) {
    x += dx;
    y += dy;
    const tile = tileAt(state, x, y);
    if (!tile) break;
    if (tile.type === 'neutral' || tile.type === 'territory') {
      tile.type = 'territory';
      tile.owner = playerId;
    }
    if (x === toX && y === toY) break;
  }
}

// Verifica si el jugador pierde: su castillo con el Rey fue conquistado/destruido.
function checkPlayerDefeat(state, player) {
  const kingUnit = state.units.find((u) => u.owner === player.id && u.type === 'rey');
  if (!kingUnit) {
    player.alive = false;
    return true;
  }
  const castle = state.castles.find((c) => c.id === kingUnit.castleId);
  if (!castle || castle.owner !== player.id) {
    player.alive = false;
    return true;
  }
  return false;
}

function checkVictory(state) {
  const aliveIds = state.players.filter((p) => p.alive).map((p) => p.id);
  if (aliveIds.length <= 1 && state.phase === 'playing') {
    state.phase = 'finished';
    state.winner = aliveIds[0] || null;
  }
}

// Orden de defensa de una guarnición: primero las tropas (más vida primero),
// el Rey al final.
function garrisonDefenders(state, castle) {
  return castle.garrison
    .map((g) => findUnit(state, g.unitId))
    .filter(Boolean)
    .sort((a, b) => {
      if ((a.type === 'rey') !== (b.type === 'rey')) return a.type === 'rey' ? 1 : -1;
      return b.hp - a.hp;
    });
}

function occupyCastle(state, unit, castle, playerId, fromX, fromY) {
  unit.x = castle.x;
  unit.y = castle.y;
  unit.castleId = castle.id;
  unit.movedThisTurn = true;
  castle.owner = playerId;
  castle.garrison.push({ unitId: unit.id });
  claimTerritoryAlongPath(state, playerId, fromX, fromY, castle.x, castle.y, JUMPING_UNIT_TYPES.has(unit.type));
}

// unitId se mueve a (toX, toY). Maneja reclamo de territorio, captura de
// granjas, combate (vida/ataque) al entrar en castillo/casilla enemiga, y
// conquista.
function moveUnitInner(state, playerId, unitId, toX, toY) {
  let markAttackPermission = null;
  if (!isPlayersTurn(state, playerId)) throw new Error('No es tu turno');
  const unit = findUnit(state, unitId);
  if (!unit || unit.owner !== playerId) throw new Error('Ficha inválida');
  if (isPetrified(unit)) throw new Error('Esa ficha está petrificada y no puede moverse');
  if (isUnitImmobilized(state, unit)) throw new Error('Un terremoto inmoviliza a esa ficha');
  if (unit.movedThisTurn) throw new Error('Esa ficha ya se movió este turno');

  const reachable = getReachableTiles(state, unit);
  if (!reachable.some((t) => t.x === toX && t.y === toY)) {
    throw new Error('Movimiento inválido para esa ficha');
  }

  const fromX = unit.x;
  const fromY = unit.y;

  // Un ataque por turno: si ya atacó (adyacente o moviéndose), no puede caer
  // sobre una casilla hostil. Se valida ANTES de tocar la guarnición.
  if (isHostileTile(state, unit, toX, toY)) {
    if (isUnitDisarmed(state, unit)) throw new Error('Un eclipse impide atacar a esa ficha');
    markAttackPermission = ensureCanAttack(state, unit);
  }

  // La ficha deja la casilla donde estaba: si estaba guarnecida en un
  // castillo, se libera ese cupo (antes solo se liberaba al morir).
  removeUnitFromCastleGarrison(state, unit.id);

  const destTile = tileAt(state, toX, toY);
  if (!destTile) throw new Error('Casilla fuera del tablero');

  const isHostileDest = (destTile.type === 'castle' && (() => { const c = findCastle(state, destTile.occupantCastleId); return c && c.owner && c.owner !== playerId; })())
    || state.units.some((u) => u.x === toX && u.y === toY && u.owner !== playerId);
  if (isHostileDest && isUnitDisarmed(state, unit)) throw new Error('Un eclipse impide atacar a esa ficha');

  let log = { type: 'move', unitId, from: { x: fromX, y: fromY }, to: { x: toX, y: toY } };

  const enemyUnitAtDest = state.units.find((u) => u.x === toX && u.y === toY && u.owner !== playerId);
  const destCastle = destTile.type === 'castle' ? findCastle(state, destTile.occupantCastleId) : null;

  if (destCastle && destCastle.owner && destCastle.owner !== playerId) {
    // Castillo enemigo: se pelea contra el mejor defensor guarnecido; si no
    // hay guarnición, conquista directa.
    const previousOwner = destCastle.owner;
    const defender = garrisonDefenders(state, destCastle)[0];

    if (!defender) {
      occupyCastle(state, unit, destCastle, playerId, fromX, fromY);
      log = { ...log, event: 'castleCaptured', castleId: destCastle.id, previousOwner };
    } else {
      const bonus = (CASTLE_LEVELS[destCastle.level] || {}).defenseBonus || 0;
      const res = duel(unit, defender, bonus, combatMods(state, unit, defender));
      markAttacked(state, unit, markAttackPermission);
      log = { ...log, dealt: res.dealt, counter: res.counter, defenderUnitId: defender.id, defenderType: defender.type, castleId: destCastle.id };

      if (res.defenderDied) {
        killUnit(state, defender);
        if (destCastle.garrison.length === 0) {
          occupyCastle(state, unit, destCastle, playerId, fromX, fromY);
          log = { ...log, event: 'attackerWinsCastle', previousOwner };
        } else {
          unit.movedThisTurn = true; // cayó un defensor, pero aún quedan más
          log = { ...log, event: 'castleDefenderKilled', attackerHp: unit.hp };
        }
      } else if (res.attackerDied) {
        const kill = killUnit(state, unit);
        log = { ...log, event: 'defenderWinsCastle', defenderHp: defender.hp, attackerRevived: kill.revived };
        return log;
      } else {
        unit.movedThisTurn = true;
        const poisoned = applyStrikePoison(state, unit, defender);
        log = { ...log, event: 'castleStandoff', defenderHp: defender.hp, attackerHp: unit.hp, poisoned };
      }
    }
  } else if (destCastle && !destCastle.owner) {
    // Castillo neutral: se conquista directamente al entrar.
    occupyCastle(state, unit, destCastle, playerId, fromX, fromY);
    log = { ...log, event: 'neutralCastleCaptured', castleId: destCastle.id };
  } else if (destCastle && destCastle.owner === playerId) {
    const levelInfo = CASTLE_LEVELS[destCastle.level];
    if (garrisonTroopCount(state, destCastle) >= GARRISON_TROOP_LIMIT) {
      throw new Error(`Solo caben ${GARRISON_TROOP_LIMIT} tropas sobre el castillo`);
    }
    unit.x = toX;
    unit.y = toY;
    unit.castleId = destCastle.id;
    unit.movedThisTurn = true;
    destCastle.garrison.push({ unitId: unit.id });
    claimTerritoryAlongPath(state, playerId, fromX, fromY, toX, toY, JUMPING_UNIT_TYPES.has(unit.type));
    log = { ...log, event: 'garrisoned', castleId: destCastle.id };
  } else if (enemyUnitAtDest) {
    // Combate en campo abierto.
    const res = duel(unit, enemyUnitAtDest, 0, combatMods(state, unit, enemyUnitAtDest));
    markAttacked(state, unit, markAttackPermission);
    log = { ...log, dealt: res.dealt, counter: res.counter, defenderType: enemyUnitAtDest.type };

    if (res.defenderDied) {
      killUnit(state, enemyUnitAtDest);
      unit.castleId = null;
      unit.x = toX;
      unit.y = toY;
      unit.movedThisTurn = true;
      claimTerritoryAlongPath(state, playerId, fromX, fromY, toX, toY, JUMPING_UNIT_TYPES.has(unit.type));

      // La casilla queda conquistada; si era granja enemiga, se captura en
      // vez de quedar sin dueño (antes dependía solo de claimTerritoryAlongPath,
      // que no toca casillas tipo 'farm').
      const barracksTaken = captureBarracksIfEnemy(state, playerId, destTile, toX, toY);
      if (destTile.type === 'farm' && destTile.owner && destTile.owner !== playerId) {
        const farm = state.farms.find((f) => f.x === toX && f.y === toY);
        if (farm) {
          const originCastle = findCastle(state, farm.castleId);
          if (originCastle) originCastle.farms = Math.max(0, originCastle.farms - 1);
          farm.owner = playerId;
          farm.castleId = null;
        }
      } else if (destTile.type !== 'castle' && destTile.type !== 'barracks') {
        destTile.type = 'territory';
      }
      destTile.owner = playerId;

      log = { ...log, event: 'fieldCombatAttackerWins', attackerHp: unit.hp, barracksCaptured: !!barracksTaken, ownerId: barracksTaken };
    } else if (res.attackerDied) {
      const kill = killUnit(state, unit);
      log = { ...log, event: 'fieldCombatDefenderWins', defenderHp: enemyUnitAtDest.hp, attackerRevived: kill.revived };
      return log;
    } else {
      unit.movedThisTurn = true;
      const poisoned = applyStrikePoison(state, unit, enemyUnitAtDest);
      log = { ...log, event: 'fieldCombatStandoff', defenderHp: enemyUnitAtDest.hp, attackerHp: unit.hp, poisoned };
    }
  } else {
    // Movimiento libre: reclama territorio; si pisa una granja enemiga la captura.
    if (destTile.type === 'farm' && destTile.owner && destTile.owner !== playerId) {
      const farm = state.farms.find((f) => f.x === toX && f.y === toY);
      if (farm) {
        const originCastle = findCastle(state, farm.castleId);
        if (originCastle) originCastle.farms = Math.max(0, originCastle.farms - 1);
        farm.owner = playerId;
        farm.castleId = null;
      }
      destTile.owner = playerId;
      log = { ...log, event: 'farmCaptured' };
    }
    const prevBarracksOwner = captureBarracksIfEnemy(state, playerId, destTile, toX, toY);
    if (prevBarracksOwner) log = { ...log, event: 'barracksCaptured', ownerId: prevBarracksOwner };
    unit.castleId = null;
    unit.x = toX;
    unit.y = toY;
    unit.movedThisTurn = true;
    claimTerritoryAlongPath(state, playerId, fromX, fromY, toX, toY, JUMPING_UNIT_TYPES.has(unit.type));
    if (destTile.type !== 'castle' && destTile.type !== 'farm' && destTile.type !== 'barracks') destTile.type = 'territory';
    destTile.owner = playerId;
    if (!log.event) log = { ...log, event: 'moved' };
  }

  // Tras cualquier combate/conquista, revisar si algún jugador perdió su rey.
  state.players.forEach((p) => checkPlayerDefeat(state, p));
  checkVictory(state);
  syncTurnOrder(state);

  return log;
}

// Ataque a corta distancia contra una ficha rival adyacente, sin mover la
// ficha atacante y SIN contraataque: solo se aplica el daño del atacante
// sobre el defensor (a diferencia del combate al entrar en su casilla, que
// sí tiene contraataque). Análogo a atacar una criatura adyacente.
function attackUnit(state, playerId, unitId, targetId) {
  if (!isPlayersTurn(state, playerId)) throw new Error('No es tu turno');

  const unit = findUnit(state, unitId);
  if (!unit || unit.owner !== playerId) throw new Error('Ficha inválida');
  if (unit.type === 'rey') throw new Error('El Rey no puede atacar');
  if (isPetrified(unit)) throw new Error('Esa ficha está petrificada y no puede atacar');
  if (isUnitDisarmed(state, unit)) throw new Error('Un eclipse impide atacar a esa ficha');
  const attackInfo = ensureCanAttack(state, unit);

  const target = findUnit(state, targetId);
  if (!target || target.owner === playerId) throw new Error('Objetivo inválido');

  const dx = Math.abs(unit.x - target.x);
  const dy = Math.abs(unit.y - target.y);
  if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) {
    throw new Error('La ficha debe estar adyacente al objetivo');
  }

  // Mejoras: +ATQ del atacante (Lobo) y -daño por la defensa del objetivo (Golem).
  const dealt = Math.max(1, unit.atk + troopAtkBonus(state, unit) - troopDefBonus(state, target));
  target.hp -= dealt;
  markAttacked(state, unit, attackInfo);

  const log = {
    type: 'attackUnit',
    playerId,
    unitId: unit.id,
    unitType: unit.type,
    targetId: target.id,
    targetType: target.type,
    targetOwner: target.owner,
    dealt,
    second: attackInfo.second, // 2º ataque de la Hidra
    to: { x: target.x, y: target.y },
  };

  if (target.hp <= 0) {
    target.hp = 0;
    const kill = killUnit(state, target);
    log.event = 'attackUnitKilled';
    log.targetRevived = kill.revived;
  } else {
    log.event = 'attackUnitHit';
    log.targetHpRemaining = target.hp;
    log.poisoned = applyStrikePoison(state, unit, target); // mejora del Basilisco
  }

  state.players.forEach((p) => checkPlayerDefeat(state, p));
  checkVictory(state);
  syncTurnOrder(state);

  return log;
}

// Casilla libre más cercana alrededor del castillo (radio 1, luego 2): accesible,
// sin castillo, sin fichas ni criaturas. Prefiere territorio propio.
function findFreeTileAround(state, castle) {
  const creatures = getActiveCreatures(state);
  const options = [];
  for (let r = 1; r <= 2 && options.length === 0; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = castle.x + dx, y = castle.y + dy;
        if (x < 0 || y < 0 || x >= state.boardSize || y >= state.boardSize) continue;
        const t = state.tiles[y][x];
        if (!t || t.type === 'castle' || t.type === 'inaccessible') continue;
        if (state.units.some((u) => u.x === x && u.y === y)) continue;
        if (creatures.some((c) => c.x === x && c.y === y)) continue;
        options.push({ x, y, own: t.owner === castle.owner ? 0 : 1 });
      }
    }
  }
  options.sort((a, b) => a.own - b.own);
  return options[0] || null;
}

// Mueve la ficha y, si termina sobre un cofre, lo abre.
function moveUnit(state, playerId, unitId, toX, toY) {
  const log = moveUnitInner(state, playerId, unitId, toX, toY);
  collectChestAt(state, unitId);
  return log;
}

// --- Producción de fichas ---
function produceUnit(state, playerId, castleId, unitType) {
  if (!isPlayersTurn(state, playerId)) throw new Error('No es tu turno');
  const player = findPlayer(state, playerId);
  const castle = findCastle(state, castleId);
  if (!castle || castle.owner !== playerId) throw new Error('Castillo inválido');
  if (unitType === 'rey') throw new Error('El Rey no se puede producir');
  if (UNIT_COSTS[unitType] === undefined) throw new Error('Tipo de ficha inválido');
  const cost = troopCostFor(state, playerId, unitType); // con el descuento del cuartel
  // Grifo / Fénix / Dragón: solo tras derrotar a la criatura correspondiente.
  if (UNLOCKABLE_UNITS.includes(unitType) && !(player.unlockedUnits || []).includes(unitType)) {
    throw new Error('Todavía no desbloqueaste esa tropa: derrota a la criatura correspondiente');
  }
  if (player.gold < cost) throw new Error('Oro insuficiente');

  const levelInfo = CASTLE_LEVELS[castle.level];
  if (castleTroopCount(state, castle) >= levelInfo.militaryCapacity) {
    throw new Error(`Este castillo ya sostiene el máximo de tropas (${levelInfo.militaryCapacity}). Mejóralo para producir más`);
  }

  // Sobre la casilla del castillo caben solo GARRISON_TROOP_LIMIT tropas; las
  // demás aparecen en la casilla libre más cercana alrededor.
  let spawn = null;
  if (garrisonTroopCount(state, castle) >= GARRISON_TROOP_LIMIT) {
    spawn = findFreeTileAround(state, castle);
    if (!spawn) throw new Error('No hay casilla libre junto al castillo para la nueva tropa');
  }

  player.gold -= cost;
  // No puede moverse ni atacar el mismo turno en que se produce.
  const newUnit = createUnit(state, unitType, playerId, spawn ? spawn.x : castle.x, spawn ? spawn.y : castle.y, {
    castleId: spawn ? null : castle.id,
    originCastleId: castle.id,
    movedThisTurn: true,
    attackedThisTurn: true,
  });
  state.units.push(newUnit);
  if (!spawn) castle.garrison.push({ unitId: newUnit.id });
  else collectChestAt(state, newUnit.id);
  return newUnit;
}

// Devuelve las casillas del jugador donde puede colocar una granja: casillas
// que ya son su territorio (o su propio castillo... no, el castillo no sirve)
// y que todavía no tienen una granja encima.
function getBuildableFarmTiles(state, playerId) {
  const tiles = [];
  for (let y = 0; y < state.boardSize; y++) {
    for (let x = 0; x < state.boardSize; x++) {
      const tile = state.tiles[y][x];
      if (tile.type === 'territory' && tile.owner === playerId) {
        tiles.push({ x, y });
      }
    }
  }
  return tiles;
}

// --- Construcción de granjas ---
// El jugador elige la casilla (x, y): debe ser territorio propio ya reclamado.
function buildFarm(state, playerId, castleId, x, y) {
  if (!isPlayersTurn(state, playerId)) throw new Error('No es tu turno');
  const player = findPlayer(state, playerId);
  const castle = findCastle(state, castleId);
  if (!castle || castle.owner !== playerId) throw new Error('Castillo inválido');
  const levelInfo = CASTLE_LEVELS[castle.level];
  if (castle.farms >= levelInfo.maxFarms) throw new Error('Ya alcanzó el máximo de granjas para su nivel');
  if (player.gold < FARM_COST) throw new Error('Oro insuficiente');

  const tile = tileAt(state, x, y);
  if (!tile) throw new Error('Casilla fuera del tablero');
  if (tile.type !== 'territory' || tile.owner !== playerId) {
    throw new Error('Solo podés construir granjas en tu propio territorio');
  }

  player.gold -= FARM_COST;
  castle.farms += 1;
  tile.type = 'farm';
  tile.owner = playerId;
  const farm = { id: state.farmIdCounter++, x: tile.x, y: tile.y, castleId: castle.id, owner: playerId };
  state.farms.push(farm);
  return farm;
}

// --- Construcción de barreras ---
// Igual patrón que las granjas: solo en territorio propio ya reclamado, y
// no debajo de una ficha (propia o ajena).
function getBuildableBarrierTiles(state, playerId) {
  const tiles = [];
  for (let y = 0; y < state.boardSize; y++) {
    for (let x = 0; x < state.boardSize; x++) {
      const tile = state.tiles[y][x];
      if (tile.type === 'territory' && tile.owner === playerId && !unitAt(state, x, y)) {
        tiles.push({ x, y });
      }
    }
  }
  return tiles;
}

function buildBarrier(state, playerId, castleId, x, y) {
  if (!isPlayersTurn(state, playerId)) throw new Error('No es tu turno');
  const player = findPlayer(state, playerId);
  const castle = findCastle(state, castleId);
  if (!castle || castle.owner !== playerId) throw new Error('Castillo inválido');
  if (player.gold < BARRIER_COST) throw new Error('Oro insuficiente');

  const tile = tileAt(state, x, y);
  if (!tile) throw new Error('Casilla fuera del tablero');
  if (tile.type !== 'territory' || tile.owner !== playerId) {
    throw new Error('Solo podés construir barreras en tu propio territorio');
  }
  if (unitAt(state, x, y)) throw new Error('No podés construir una barrera debajo de una ficha');

  player.gold -= BARRIER_COST;
  // El nivel de la muralla lo da la mejora "murallas" del cuartel (Nv 1 sin cuartel).
  const level = barrierLevelFor(state, playerId);
  const maxHp = BARRIER_HP_BY_LEVEL[level] || BARRIER_HP_BY_LEVEL[1];
  tile.type = 'barrier';
  tile.owner = playerId;
  const barrier = {
    id: state.barrierIdCounter++,
    x: tile.x,
    y: tile.y,
    owner: playerId,
    castleId: castle.id,
    level,
    hp: maxHp,
    maxHp,
  };
  if (!Array.isArray(state.barriers)) state.barriers = [];
  state.barriers.push(barrier);
  return barrier;
}

// --- Cuartel ---
// Solo en territorio propio, sin ficha encima, y máximo 1 por jugador.
function buildBarracks(state, playerId, x, y) {
  if (!isPlayersTurn(state, playerId)) throw new Error('No es tu turno');
  const player = findPlayer(state, playerId);
  if (!player) throw new Error('Jugador inválido');
  if (barracksOf(state, playerId)) throw new Error('Ya tenés un cuartel (solo se permite 1)');
  if (player.gold < BARRACKS_COST) throw new Error('Oro insuficiente');

  const tile = tileAt(state, x, y);
  if (!tile) throw new Error('Casilla fuera del tablero');
  if (tile.type !== 'territory' || tile.owner !== playerId) {
    throw new Error('Solo podés construir el cuartel en tu propio territorio');
  }
  if (unitAt(state, x, y)) throw new Error('No podés construir el cuartel debajo de una ficha');

  player.gold -= BARRACKS_COST;
  tile.type = 'barracks';
  tile.owner = playerId;
  const barracks = {
    id: state.barracksIdCounter++, x, y, owner: playerId,
    farmsTier: 0, wallsTier: 0, discountTier: 0,
  };
  if (!Array.isArray(state.barracks)) state.barracks = [];
  state.barracks.push(barracks);
  return barracks;
}

// track: 'farms' | 'walls' | 'discount'. Cada mejora tiene niveles con costo propio.
function upgradeBarracks(state, playerId, track) {
  if (!isPlayersTurn(state, playerId)) throw new Error('No es tu turno');
  const player = findPlayer(state, playerId);
  const up = BARRACKS_UPGRADES[track];
  if (!player || !up) throw new Error('Mejora inválida');
  const barracks = barracksOf(state, playerId);
  if (!barracks) throw new Error('No tenés un cuartel');
  const key = `${track}Tier`;
  const tier = barracks[key];
  if (tier >= up.costs.length) throw new Error('Esa mejora ya está al máximo');
  const cost = up.costs[tier];
  if (player.gold < cost) throw new Error('Oro insuficiente');

  player.gold -= cost;
  barracks[key] = tier + 1;

  // Murallas: la mejora sube el nivel de TODAS las barreras del jugador.
  if (track === 'walls') {
    const level = 1 + barracks.wallsTier;
    (state.barriers || []).filter((b) => b.owner === playerId).forEach((b) => {
      b.level = level;
      b.maxHp = BARRIER_HP_BY_LEVEL[level] || b.maxHp;
      b.hp = b.maxHp;
    });
  }
  return { track, tier: barracks[key], cost };
}

// La barrera desaparece: la casilla vuelve a ser territorio de su dueño.
function removeBarrier(state, barrier) {
  state.barriers = (state.barriers || []).filter((b) => b.id !== barrier.id);
  const tile = tileAt(state, barrier.x, barrier.y);
  if (tile && tile.type === 'barrier') {
    tile.type = 'territory';
    tile.owner = barrier.owner;
  }
}

// Se regenera por completo al comienzo de cada turno (no solo al de su dueño).
function tickBarrierRegen(state) {
  (state.barriers || []).forEach((b) => { b.hp = b.maxHp; });
}

// Ataque a una barrera rival adyacente: mismo patrón que atacar una
// criatura, pero desde el nivel 2 la barrera contraataca en vez de morir sola.
function attackBarrier(state, playerId, unitId, barrierId) {
  if (!isPlayersTurn(state, playerId)) throw new Error('No es tu turno');
  const unit = findUnit(state, unitId);
  if (!unit || unit.owner !== playerId) throw new Error('Ficha inválida');
  if (unit.type === 'rey') throw new Error('El Rey no puede atacar');
  if (isPetrified(unit)) throw new Error('Esa ficha está petrificada y no puede atacar');
  if (isUnitDisarmed(state, unit)) throw new Error('Un eclipse impide atacar a esa ficha');
  const attackInfo = ensureCanAttack(state, unit);

  const barrier = (state.barriers || []).find((b) => b.id === barrierId);
  if (!barrier || barrier.owner === playerId) throw new Error('Barrera inválida');

  const dx = Math.abs(unit.x - barrier.x);
  const dy = Math.abs(unit.y - barrier.y);
  if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) {
    throw new Error('La ficha debe estar adyacente a la barrera');
  }

  const dealt = Math.max(1, unit.atk + troopAtkBonus(state, unit));
  barrier.hp -= dealt;
  markAttacked(state, unit, attackInfo);

  const log = {
    type: 'attackBarrier',
    playerId,
    unitId: unit.id,
    unitType: unit.type,
    barrierId: barrier.id,
    barrierLevel: barrier.level,
    dealt,
    second: attackInfo.second, // 2º ataque de la Hidra
    to: { x: barrier.x, y: barrier.y },
  };

  if (barrier.hp <= 0) {
    barrier.hp = 0;
    removeBarrier(state, barrier);
    log.event = 'barrierDestroyed';
    return log;
  }

  const counter = BARRIER_COUNTER_DAMAGE_BY_LEVEL[barrier.level] || 0;
  if (counter > 0) {
    unit.hp -= counter;
    if (unit.hp <= 0) {
      unit.hp = 0;
      const kill = killUnit(state, unit);
      log.event = 'attackerLostToBarrier';
      log.counter = counter;
      log.attackerRevived = kill.revived;
      log.barrierHpRemaining = barrier.hp;
      state.players.forEach((p) => checkPlayerDefeat(state, p));
      checkVictory(state);
      syncTurnOrder(state);
      return log;
    }
  }

  log.event = 'barrierDamaged';
  log.counter = counter;
  log.barrierHpRemaining = barrier.hp;
  log.attackerHpRemaining = unit.hp;
  return log;
}

// --- Mejora de castillo ---
function upgradeCastle(state, playerId, castleId) {
  if (!isPlayersTurn(state, playerId)) throw new Error('No es tu turno');
  const player = findPlayer(state, playerId);
  const castle = findCastle(state, castleId);
  if (!castle || castle.owner !== playerId) throw new Error('Castillo inválido');
  const nextLevel = castle.level + 1;
  const nextInfo = CASTLE_LEVELS[nextLevel];
  if (!nextInfo) throw new Error('El castillo ya está en el nivel máximo');
  if (player.gold < nextInfo.upgradeCost) throw new Error('Oro insuficiente');

  player.gold -= nextInfo.upgradeCost;
  castle.level = nextLevel;
  return castle;
}

// --- Criaturas neutrales ---
function attackCreature(state, playerId, unitId, creatureId) {
  return attackCreatureInternal(state, playerId, unitId, creatureId);
}

// --- Curación en castillo ---
// Al cierre de ronda (después de cobrar oro), toda tropa que esté DENTRO de un
// castillo propio se cura al máximo, gratis.
function healTroopsInCastles(state) {
  let healed = 0;
  state.units.forEach((u) => {
    if (u.hp >= u.maxHp) return;
    const tile = tileAt(state, u.x, u.y);
    if (!tile || tile.type !== 'castle') return;
    const castle = findCastle(state, tile.occupantCastleId);
    if (castle && castle.owner === u.owner) {
      u.hp = u.maxHp;
      healed++;
    }
  });
  if (healed > 0) queueEvent(state, { type: 'healed', event: 'healed', count: healed });
}

// --- Orden de turnos ---
// Saca de turnOrder a los jugadores eliminados SIN descuadrar currentTurnIndex.
// (Antes se filtraba la lista sin ajustar el índice, y eso hacía que a veces
// se saltara o se perdiera un turno.) Devuelve:
//   currentRemoved: el jugador que tenía el turno ya no está vivo; el índice
//                   apunta ahora al siguiente jugador vivo.
//   wrapped:        para llegar a ese siguiente jugador se pasó por el final
//                   del orden (o sea, cierra una ronda).
function syncTurnOrder(state) {
  const old = state.turnOrder;
  const cur = state.currentTurnIndex;
  const isAlive = (id) => {
    const p = findPlayer(state, id);
    return !!(p && p.alive);
  };
  const fresh = old.filter(isAlive);
  const currentRemoved = old.length > 0 && !isAlive(old[cur]);

  let newIndex = 0;
  let wrapped = false;
  for (let i = 0; i < old.length; i++) {
    const id = old[(cur + i) % old.length];
    if (isAlive(id)) {
      newIndex = fresh.indexOf(id);
      wrapped = cur + i >= old.length;
      break;
    }
  }
  state.turnOrder = fresh;
  state.currentTurnIndex = newIndex;
  return { currentRemoved, wrapped };
}

// Efectos de inicio de turno del jugador que acaba de recibir el turno.
function beginTurn(state, wrapped) {
  state.turnCounter += 1;
  state.hydraUsedThisTurn = false; // el 2º ataque de la Hidra se renueva cada turno

  // Cierre de ronda: cobrar oro -> curar tropas -> regeneración de criatura.
  if (wrapped) {
    state.round += 1;
    collectGold(state);
    healTroopsInCastles(state);
    tickCreatureRegen(state);
  }

  // Veneno inflige daño (puede matar) y petrificación cuenta regresiva hasta
  // liberar a la ficha.
  const newCurrentPlayerId = state.turnOrder[state.currentTurnIndex];
  const statusEvents = tickUnitStatuses(state, newCurrentPlayerId);
  statusEvents.forEach((evt) => queueEvent(state, evt));
  tickBarrierRegen(state);
  state.players.forEach((p) => checkPlayerDefeat(state, p));
  syncTurnOrder(state);

  const weather = tickWeather(state);
  const despawnedCreatures = tickCreatureDespawn(state);
  const telegraphedCreature = tickCreatureTelegraph(state);
  const spawnedCreature = tickCreatureSpawn(state);
  const spawnedChest = tickChestSpawn(state);

  checkVictory(state);

  return { spawnedCreature, telegraphedCreature, despawnedCreatures, spawnedChest, weather, statusEvents };
}

// --- Fin de turno ---
function endTurn(state, playerId) {
  if (!isPlayersTurn(state, playerId)) throw new Error('No es tu turno');

  state.units.forEach((u) => {
    if (u.owner === playerId) {
      u.movedThisTurn = false;
      u.attackedThisTurn = false;
      u.didAttackThisTurn = false;
    }
  });

  // Limpiar eliminados antes de avanzar (el índice se re-calcula solo).
  syncTurnOrder(state);
  if (state.turnOrder.length === 0) return {};

  state.currentTurnIndex = (state.currentTurnIndex + 1) % state.turnOrder.length;
  const wrapped = state.currentTurnIndex === 0;
  return beginTurn(state, wrapped);
}

// --- Rendirse / desconexión / fin forzado ---
// Elimina a un jugador: sus fichas y granjas desaparecen, sus castillos
// vuelven a ser neutrales y su territorio queda libre.
function eliminatePlayer(state, player) {
  player.alive = false;
  player.surrendered = true;

  state.units = state.units.filter((u) => u.owner !== player.id);
  state.farms = state.farms.filter((f) => f.owner !== player.id);
  state.barriers = (state.barriers || []).filter((b) => b.owner !== player.id);
  state.barracks = (state.barracks || []).filter((b) => b.owner !== player.id);
  state.castles.forEach((c) => {
    if (c.owner === player.id) {
      c.owner = null;
      c.hasKing = false;
      c.garrison = [];
      c.farms = 0;
    }
  });
  state.tiles.forEach((row) => {
    row.forEach((t) => {
      if (t.owner === player.id) {
        if (t.type !== 'castle') t.type = 'neutral';
        delete t.owner;
      }
    });
  });
}

// El jugador se rinde (o se desconectó). Puede hacerse aunque no sea su
// turno; si lo era, el turno pasa automáticamente al siguiente jugador.
// Devuelve el mismo formato que endTurn ({ spawnedCreature, weather, ... }).
function surrenderPlayer(state, playerId) {
  if (state.phase !== 'playing') throw new Error('La partida no está en curso');
  const player = findPlayer(state, playerId);
  if (!player || !player.alive) throw new Error('No estás en la partida');

  eliminatePlayer(state, player);
  const { currentRemoved, wrapped } = syncTurnOrder(state);

  checkVictory(state);
  if (state.phase !== 'playing') return {};
  if (currentRemoved) return beginTurn(state, wrapped);
  return {};
}

// El líder termina la partida: sin ganador.
function forceEndGame(state) {
  if (state.phase !== 'playing') throw new Error('La partida no está en curso');
  state.phase = 'finished';
  state.winner = null;
}

module.exports = {
  isPlayersTurn,
  buildBarracks,
  upgradeBarracks,
  collectGold,
  getReachableTiles,
  getBuildableFarmTiles,
  moveUnit,
  produceUnit,
  buildFarm,
  getBuildableBarrierTiles,
  buildBarrier,
  attackBarrier,
  upgradeCastle,
  attackCreature,
  attackUnit,
  endTurn,
  surrenderPlayer,
  forceEndGame,
  syncTurnOrder,
  healTroopsInCastles,
  checkVictory,
};
