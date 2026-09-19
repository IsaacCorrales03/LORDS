// gameState.js
// Estado central del juego: tablero, castillos, jugadores, fichas.
// Tamaño de tablero según jugadores:
//   - 1 a 3 jugadores -> 13x13
//   - 4 jugadores     -> 17x17
//   - 5 a 8 jugadores -> 25x25
// Castillos neutrales: proporcionales a la cantidad de jugadores
// (NEUTRAL_PER_PLAYER por jugador + NEUTRAL_BASE). Ajustable.

const { UNIT_STATS } = require('./combat');
const { generateInaccessibleTiles } = require('./terrain');

const MIN_PLAYERS = 2; // con 1 solo jugador la partida terminaría al instante
const MAX_PLAYERS = 8;

const NEUTRAL_PER_PLAYER = 2;
const NEUTRAL_BASE = 2;

function boardSizeFor(playerCount) {
  if (playerCount <= 3) return 13;
  if (playerCount === 4) return 17;
  return 25;
}

// Máximo de criaturas neutrales simultáneas: 1 por cada 2 jugadores de la
// partida (1-2: 1, 3-4: 2, 5-6: 3, 7-8: 4). Se calcula con el total de
// jugadores (maxPlayers), no con los que sigan vivos.
function maxCreaturesFor(playerCount) {
  return Math.ceil(playerCount / 2);
}

// Criaturas activas como arreglo. Compatibilidad: mientras creatures.js siga
// usando el campo viejo (activeCreature, una sola), se expone como lista.
function getActiveCreatures(state) {
  if (state.activeCreatures && state.activeCreatures.length > 0) return state.activeCreatures;
  return state.activeCreature ? [state.activeCreature] : [];
}

const BOARD_CONFIG = {
  small: { size: 13 },
  medium: { size: 17 },
  large: { size: 25 },
};

function getBoardConfig(playerCount) {
  if (playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) {
    throw new Error(`El número de jugadores debe estar entre ${MIN_PLAYERS} y ${MAX_PLAYERS}`);
  }
  return {
    size: boardSizeFor(playerCount),
    maxPlayers: playerCount,
    neutralCastles: playerCount * NEUTRAL_PER_PLAYER + NEUTRAL_BASE,
  };
}

// Rangos de fichas (reglamento base)
const RANKS = {
  rey: 0,
  peon: 1,
  caballo: 2,
  alfil: 3,
  torre: 4,
  reina: 5,
  dragon: 6, // criatura domada al derrotar al Dragón; no se produce en castillo
  fenix: 7, // criatura domada al derrotar al Fénix; no se produce en castillo
  grifo: 8, // criatura domada al derrotar al Grifo; no se produce en castillo
};

// militaryCapacity = cuántas tropas puede PRODUCIR/sostener el castillo (2/3/4
// según nivel). Sobre su casilla solo pueden estar GARRISON_TROOP_LIMIT a la
// vez; las demás salen a una casilla adyacente.
const CASTLE_LEVELS = {
  1: { upgradeCost: 0, goldPerTurn: 3, militaryCapacity: 2, maxFarms: 2, defenseBonus: 0 },
  2: { upgradeCost: 15, goldPerTurn: 4, militaryCapacity: 3, maxFarms: 3, defenseBonus: 0 },
  3: { upgradeCost: 50, goldPerTurn: 5, militaryCapacity: 4, maxFarms: 4, defenseBonus: 1 },
};

const GARRISON_TROOP_LIMIT = 2; // tropas (sin contar al Rey) que caben sobre la casilla del castillo

// Tropas (no Rey) que hay ahora mismo dentro de la casilla del castillo.
function garrisonTroopCount(state, castle) {
  return castle.garrison.filter((g) => {
    const u = state.units.find((x) => x.id === g.unitId);
    return u && u.type !== 'rey';
  }).length;
}

// Tropas vivas producidas por este castillo (estén donde estén).
function castleTroopCount(state, castle) {
  return state.units.filter((u) => u.type !== 'rey' && u.owner === castle.owner && u.originCastleId === castle.id).length;
}

const PLAYER_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'cyan', 'pink'];

// Costos de producción. El reglamento dejaba "por definir" para peón/caballo/
// alfil/torre; se fija un valor por defecto escalado por rango (fácil de
// ajustar luego). La reina mantiene el costo definido: 150.
const UNIT_COSTS = {
  peon: 10,
  caballo: 30,
  alfil: 60,
  torre: 100,
  reina: 150,
};

// Alcance de movimiento por tipo de ficha. La lógica real vive en
// getReachableTiles (actions.js), que trata cada tipo con su propio patrón;
// esta tabla queda como referencia/documentación y como valor por defecto
// para tipos no reconocidos explícitamente.
//   - peon: 1 casilla, solo ortogonal (arriba/abajo/izquierda/derecha).
//   - caballo: salto en L, como en el ajedrez (manejado aparte).
//   - alfil: solo diagonal, sin límite de alcance (hasta chocar).
//   - torre: solo ortogonal, sin límite de alcance (hasta chocar).
//   - reina: diagonal + ortogonal, sin límite de alcance (hasta chocar).
//   - dragon: como la reina, pero sin bloqueo: ignora todo lo que haya en
//     el camino (fichas, castillos, huecos) y solo importa el destino.
//   - fenix: como el Rey del ajedrez (8 direcciones), pero 2 casillas.
//   - grifo: salta a las 4 esquinas de un cuadrado de 2x2 (±2,±2), sin
//     bloqueo, igual que el caballo.
const MOVEMENT_RANGE = {
  rey: 0, // el Rey no se mueve: permanece en su castillo
  peon: 1,
  caballo: null, // salto en L, manejado aparte
  alfil: Infinity,
  torre: Infinity,
  reina: Infinity,
  dragon: Infinity, // ficha domada; vuela y no se bloquea (ver getUnblockedLineMoves)
  fenix: 2, // ficha domada; vuela
  grifo: null, // salto de esquina, manejado aparte
};

// Tropas voladoras: pueden cruzar (no aterrizar en) casillas inaccesibles.
const FLYING_UNITS = new Set(['dragon', 'fenix']);

const FARM_COST = 20;
const FARM_INCOME = 4;

// Distribuye N castillos iniciales en un anillo alrededor del centro del tablero,
// con margen fijo desde los bordes, para que queden equidistantes entre sí.
function getInitialCastlePositions(boardSize, playerCount) {
  const margin = 1;
  const center = (boardSize - 1) / 2;
  const radius = center - margin;
  const positions = [];

  for (let i = 0; i < playerCount; i++) {
    const angle = (2 * Math.PI * i) / playerCount - Math.PI / 2; // primer jugador arriba
    const x = Math.round(center + radius * Math.cos(angle));
    const y = Math.round(center + radius * Math.sin(angle));
    positions.push({
      x: Math.min(Math.max(x, 0), boardSize - 1),
      y: Math.min(Math.max(y, 0), boardSize - 1),
    });
  }
  return positions;
}

function isTooClose(pos, existingPositions, minDist = 1) {
  return existingPositions.some((p) => {
    const dx = Math.abs(p.x - pos.x);
    const dy = Math.abs(p.y - pos.y);
    return dx <= minDist && dy <= minDist;
  });
}

// Genera posiciones aleatorias para castillos neutrales, evitando los iniciales
// y evitando que queden demasiado pegados entre sí.
function getNeutralCastlePositions(boardSize, initialPositions, count) {
  const positions = [...initialPositions];
  const neutrals = [];
  let attempts = 0;
  const maxAttempts = 8000;

  while (neutrals.length < count && attempts < maxAttempts) {
    attempts++;
    const pos = {
      x: Math.floor(Math.random() * boardSize),
      y: Math.floor(Math.random() * boardSize),
    };
    if (isTooClose(pos, positions, 1)) continue;
    positions.push(pos);
    neutrals.push(pos);
  }

  if (neutrals.length < count) {
    throw new Error(
      `No se pudieron colocar ${count} castillos neutrales tras ${maxAttempts} intentos (colocados: ${neutrals.length})`
    );
  }

  return neutrals;
}

function createCastle(id, owner, pos) {
  return {
    id,
    owner, // null = neutral, o playerId
    x: pos.x,
    y: pos.y,
    level: 1,
    farms: 0,
    hasKing: owner !== null,
    garrison: [], // fichas estacionadas: { unitId }
  };
}

function createBoard(boardSize) {
  const tiles = [];
  for (let y = 0; y < boardSize; y++) {
    const row = [];
    for (let x = 0; x < boardSize; x++) {
      row.push({ x, y, type: 'neutral', occupantCastleId: null });
    }
    tiles.push(row);
  }
  return tiles;
}

// playerCount determina el tamaño del tablero y cuántos castillos iniciales
// se reservan. Los jugadores se asignan a esos castillos al conectarse.
function createGameState(playerCount) {
  const config = getBoardConfig(playerCount);
  const boardSize = config.size;

  const initialPositions = getInitialCastlePositions(boardSize, playerCount);
  const neutralPositions = getNeutralCastlePositions(
    boardSize,
    initialPositions,
    config.neutralCastles
  );

  const tiles = createBoard(boardSize);
  const castles = [];

  let castleIdCounter = 1;

  const playerCastles = initialPositions.map((pos) => {
    const castle = createCastle(castleIdCounter++, null, pos);
    castles.push(castle);
    tiles[pos.y][pos.x].type = 'castle';
    tiles[pos.y][pos.x].occupantCastleId = castle.id;
    return castle;
  });

  neutralPositions.forEach((pos) => {
    const castle = createCastle(castleIdCounter++, null, pos);
    castle.hasKing = false;
    castles.push(castle);
    tiles[pos.y][pos.x].type = 'castle';
    tiles[pos.y][pos.x].occupantCastleId = castle.id;
  });

  // Huecos del mapa (fijos toda la partida) + validación de conectividad.
  generateInaccessibleTiles(tiles, boardSize, castles, playerCastles);

  return {
    boardSize,
    maxPlayers: playerCount,
    tiles,
    castles,
    players: [],
    playerStartCastleIds: playerCastles.map((c) => c.id),
    turnOrder: [],
    currentTurnIndex: 0,
    round: 0,
    phase: 'lobby', // lobby -> playing -> finished
    leaderId: null,
    units: [],
    unitIdCounter: 1,
    farms: [],
    farmIdCounter: 1,
    winner: null,
    // Criaturas neutrales (ver creatures.js). Tope: maxCreaturesFor(maxPlayers)
    activeCreatures: [],
    creatureIdCounter: 1,
    turnCounter: 0, // cuenta turnos individuales jugados (no rondas)
    // Clima (ver weather.js)
    activeWeather: null,
    weatherIdCounter: 1,
    eventQueue: [], // eventos de fondo pendientes de enviar al historial
  };
}

function addPlayer(state, socketId, name) {
  if (state.players.length >= state.maxPlayers) {
    throw new Error(`La partida ya tiene ${state.maxPlayers} jugadores`);
  }
  const usedColors = new Set(state.players.map((p) => p.color));
  const color = PLAYER_COLORS.find((c) => !usedColors.has(c)) || null;

  const player = {
    id: socketId,
    name: name || `Jugador ${state.players.length + 1}`,
    color,
    ready: false,
    gold: 0,
    alive: true,
    castleId: null,
    phoenixRevived: false, // el Fénix solo puede resucitar 1 vez por jugador
  };

  state.players.push(player);
  return player;
}

function setPlayerName(state, playerId, name) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error('Jugador no encontrado');
  const trimmed = (name || '').trim().slice(0, 20);
  if (trimmed) player.name = trimmed;
  return player;
}

function setPlayerColor(state, playerId, color) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error('Jugador no encontrado');
  if (!PLAYER_COLORS.includes(color)) throw new Error('Color inválido');
  const taken = state.players.some((p) => p.id !== playerId && p.color === color);
  if (taken) throw new Error('Ese color ya lo eligió otro jugador');
  player.color = color;
  return player;
}

function setPlayerReady(state, playerId, ready) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error('Jugador no encontrado');
  player.ready = !!ready;
  return player;
}

function removePlayer(state, playerId) {
  state.players = state.players.filter((p) => p.id !== playerId);
}

// Reclama las 8 casillas alrededor de un castillo inicial como territorio del
// dueño (patrón 3x3 sin contar la casilla del propio castillo). Solo se
// reclaman casillas neutrales, para no pisar otro castillo cercano.
function claimInitialTerritory(state, castle) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = castle.x + dx;
      const y = castle.y + dy;
      if (x < 0 || y < 0 || x >= state.boardSize || y >= state.boardSize) continue;
      const tile = state.tiles[y][x];
      if (tile.type === 'neutral') {
        tile.type = 'territory';
        tile.owner = castle.owner;
      }
    }
  }
}

// Asigna castillos iniciales, oro y Rey a cada jugador y pasa la partida a
// fase 'playing'. Se llama solo cuando el líder confirma el inicio.
function startGame(state) {
  if (state.phase !== 'lobby') throw new Error('La partida ya comenzó');
  if (state.players.length !== state.maxPlayers) {
    throw new Error(`Necesitás ${state.maxPlayers} jugadores para iniciar`);
  }
  if (state.players.some((p) => !p.ready)) {
    throw new Error('No todos los jugadores están listos');
  }
  if (state.players.some((p) => !p.color)) {
    throw new Error('Todos los jugadores deben tener un color asignado');
  }

  state.players.forEach((player, index) => {
    const castleId = state.playerStartCastleIds[index];
    const castle = state.castles.find((c) => c.id === castleId);
    player.castleId = castleId;
    player.gold = 20;
    castle.owner = player.id;
    castle.hasKing = true;

    const king = {
      id: state.unitIdCounter++,
      type: 'rey',
      owner: player.id,
      x: castle.x,
      y: castle.y,
      castleId: castle.id,
      movedThisTurn: false,
      attackedThisTurn: false,
      hp: UNIT_STATS.rey.hp,
      maxHp: UNIT_STATS.rey.hp,
      atk: UNIT_STATS.rey.atk,
    };
    state.units.push(king);
    castle.garrison.push({ unitId: king.id });
    claimInitialTerritory(state, castle);
  });

  state.phase = 'playing';
  state.round = 1;
}

module.exports = {
  MIN_PLAYERS,
  MAX_PLAYERS,
  BOARD_CONFIG,
  getBoardConfig,
  maxCreaturesFor,
  getActiveCreatures,
  RANKS,
  CASTLE_LEVELS,
  GARRISON_TROOP_LIMIT,
  garrisonTroopCount,
  castleTroopCount,
  PLAYER_COLORS,
  UNIT_COSTS,
  MOVEMENT_RANGE,
  FARM_COST,
  FARM_INCOME,
  FLYING_UNITS,
  createGameState,
  addPlayer,
  setPlayerName,
  setPlayerColor,
  setPlayerReady,
  removePlayer,
  startGame,
};
