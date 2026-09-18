// server/actions.js
// Lógica de acciones de juego: movimiento, combate, producción de fichas,
// construcción de granjas, y avance de turno/ronda.

const {
  CASTLE_LEVELS,
  UNIT_COSTS,
  MOVEMENT_RANGE,
  FARM_COST,
  FARM_INCOME,
  FLYING_UNITS,
  getActiveCreatures,
} = require('./gameState');
const { duel } = require('./combat');
const {
  findPlayer, findCastle, findUnit, isPlayersTurn,
  createUnit, removeUnit, killUnit, queueEvent,
  isPetrified, tickUnitStatuses,
} = require('./units');
const {
  tickCreatureSpawn, tickCreatureRegen, attackCreature: attackCreatureInternal,
} = require('./creatures');
const { tickWeather, isUnitImmobilized } = require('./weather');

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
    income += ownedFarms.length * FARM_INCOME;
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
      if (!tile || tile.type === 'inaccessible') return false;
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
      if (!tile || tile.type === 'inaccessible') return false;
      if (creatureAt(state, p.x, p.y)) return false;
      const other = unitAt(state, p.x, p.y);
      if (other && other.owner === unit.owner && tile.type !== 'castle') return false;
      return true;
    });
}

function getReachableTiles(state, unit) {
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
function moveUnit(state, playerId, unitId, toX, toY) {
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
  const destTile = tileAt(state, toX, toY);
  if (!destTile) throw new Error('Casilla fuera del tablero');

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
      const res = duel(unit, defender, bonus);
      unit.attackedThisTurn = true;
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
        log = { ...log, event: 'castleStandoff', defenderHp: defender.hp, attackerHp: unit.hp };
      }
    }
  } else if (destCastle && !destCastle.owner) {
    // Castillo neutral: se conquista directamente al entrar.
    occupyCastle(state, unit, destCastle, playerId, fromX, fromY);
    log = { ...log, event: 'neutralCastleCaptured', castleId: destCastle.id };
  } else if (destCastle && destCastle.owner === playerId) {
    const levelInfo = CASTLE_LEVELS[destCastle.level];
    if (destCastle.garrison.length >= levelInfo.militaryCapacity) {
      throw new Error('El castillo no tiene capacidad militar disponible');
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
    const res = duel(unit, enemyUnitAtDest, 0);
    unit.attackedThisTurn = true;
    log = { ...log, dealt: res.dealt, counter: res.counter, defenderType: enemyUnitAtDest.type };

    if (res.defenderDied) {
      killUnit(state, enemyUnitAtDest);
      unit.castleId = null;
      unit.x = toX;
      unit.y = toY;
      unit.movedThisTurn = true;
      claimTerritoryAlongPath(state, playerId, fromX, fromY, toX, toY, JUMPING_UNIT_TYPES.has(unit.type));
      log = { ...log, event: 'fieldCombatAttackerWins', attackerHp: unit.hp };
    } else if (res.attackerDied) {
      const kill = killUnit(state, unit);
      log = { ...log, event: 'fieldCombatDefenderWins', defenderHp: enemyUnitAtDest.hp, attackerRevived: kill.revived };
      return log;
    } else {
      unit.movedThisTurn = true;
      log = { ...log, event: 'fieldCombatStandoff', defenderHp: enemyUnitAtDest.hp, attackerHp: unit.hp };
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
    unit.castleId = null;
    unit.x = toX;
    unit.y = toY;
    unit.movedThisTurn = true;
    claimTerritoryAlongPath(state, playerId, fromX, fromY, toX, toY, JUMPING_UNIT_TYPES.has(unit.type));
    if (destTile.type !== 'castle' && destTile.type !== 'farm') destTile.type = 'territory';
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
  if (unit.attackedThisTurn) throw new Error('Esa ficha ya atacó este turno');

  const target = findUnit(state, targetId);
  if (!target || target.owner === playerId) throw new Error('Objetivo inválido');

  const dx = Math.abs(unit.x - target.x);
  const dy = Math.abs(unit.y - target.y);
  if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) {
    throw new Error('La ficha debe estar adyacente al objetivo');
  }

  const dealt = Math.max(1, unit.atk);
  target.hp -= dealt;
  unit.attackedThisTurn = true;

  const log = {
    type: 'attackUnit',
    playerId,
    unitId: unit.id,
    unitType: unit.type,
    targetId: target.id,
    targetType: target.type,
    targetOwner: target.owner,
    dealt,
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
  }

  state.players.forEach((p) => checkPlayerDefeat(state, p));
  checkVictory(state);
  syncTurnOrder(state);

  return log;
}

// --- Producción de fichas ---
function produceUnit(state, playerId, castleId, unitType) {
  if (!isPlayersTurn(state, playerId)) throw new Error('No es tu turno');
  const player = findPlayer(state, playerId);
  const castle = findCastle(state, castleId);
  if (!castle || castle.owner !== playerId) throw new Error('Castillo inválido');
  if (unitType === 'rey') throw new Error('El Rey no se puede producir');
  const cost = UNIT_COSTS[unitType];
  if (cost === undefined) throw new Error('Tipo de ficha inválido');
  if (player.gold < cost) throw new Error('Oro insuficiente');

  const levelInfo = CASTLE_LEVELS[castle.level];
  if (castle.garrison.length >= levelInfo.militaryCapacity) {
    throw new Error('Capacidad militar del castillo llena');
  }

  player.gold -= cost;
  // No puede moverse ni atacar el mismo turno en que se produce.
  const newUnit = createUnit(state, unitType, playerId, castle.x, castle.y, {
    castleId: castle.id,
    movedThisTurn: true,
    attackedThisTurn: true,
  });
  state.units.push(newUnit);
  castle.garrison.push({ unitId: newUnit.id });
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
  state.players.forEach((p) => checkPlayerDefeat(state, p));
  syncTurnOrder(state);

  const weather = tickWeather(state);
  const spawnedCreature = tickCreatureSpawn(state);

  checkVictory(state);

  return { spawnedCreature, weather, statusEvents };
}

// --- Fin de turno ---
function endTurn(state, playerId) {
  if (!isPlayersTurn(state, playerId)) throw new Error('No es tu turno');

  state.units.forEach((u) => {
    if (u.owner === playerId) {
      u.movedThisTurn = false;
      u.attackedThisTurn = false;
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
  collectGold,
  getReachableTiles,
  getBuildableFarmTiles,
  moveUnit,
  produceUnit,
  buildFarm,
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
