// server/index.js
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const {
  createGameState,
  addPlayer,
  setPlayerName,
  setPlayerColor,
  setPlayerReady,
  removePlayer,
  startGame,
  MIN_PLAYERS,
  MAX_PLAYERS,
  getActiveCreatures,
  farmIncomeFor,
  troopDiscountFor,
} = require('./gameState');
const actions = require('./actions');

const PORT = process.env.PORT || 3000;
const TURN_TIME_MS = 45000; // tiempo máximo por turno

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Estado de la sala única (fase 1: 1 sala fija) ---
let state = null; // se crea cuando el líder define el tamaño de partida

function serializeState(s) {
  if (!s) return null;
  return {
    boardSize: s.boardSize,
    maxPlayers: s.maxPlayers,
    tiles: s.tiles,
    castles: s.castles,
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      ready: p.ready,
      gold: p.gold,
      alive: p.alive,
      castleId: p.castleId,
      phoenixRevived: p.phoenixRevived,
      surrendered: !!p.surrendered,
      upgrades: p.upgrades || null, // mejoras permanentes por criaturas derrotadas
      unlockedUnits: p.unlockedUnits || [], // tropas especiales desbloqueadas
      farmIncome: farmIncomeFor(s, p.id), // oro por granja (sube con el cuartel)
      troopDiscount: troopDiscountFor(s, p.id), // 0..0.2, descuento del cuartel en tropas
    })),
    turnOrder: s.turnOrder,
    currentTurnIndex: s.currentTurnIndex,
    round: s.round,
    phase: s.phase,
    leaderId: s.leaderId,
    units: s.units,
    farms: s.farms,
    winner: s.winner,
    activeCreatures: getActiveCreatures(s),
    pendingCreatureSpawn: s.pendingCreatureSpawn || null,
    activeWeather: s.activeWeather,
    chests: s.chests || [],
    barriers: s.barriers || [],
    barracks: s.barracks || [],
    turnCounter: s.turnCounter,
    hydraUsedThisTurn: !!s.hydraUsedThisTurn,
    turnDeadline: s.turnDeadline || null,
    startedAt: s.startedAt || null,
    postGameChoices: s.postGameChoices || {},
    serverNow: Date.now(),
  };
}

// --- Temporizador de turno ---
// Se re-arma solo cuando cambia el turno (turnCounter + jugador actual). Si el
// jugador no termina a tiempo, su turno se cierra automáticamente.
let turnTimer = null;
let turnTimerToken = null;

function clearTurnTimer() {
  if (turnTimer) clearTimeout(turnTimer);
  turnTimer = null;
  turnTimerToken = null;
  if (state) state.turnDeadline = null;
}

function syncTurnTimer() {
  if (!state || state.phase !== 'playing') { clearTurnTimer(); return; }
  const currentId = state.turnOrder[state.currentTurnIndex];
  if (!currentId) { clearTurnTimer(); return; }
  const token = `${state.turnCounter}:${currentId}`;
  if (token === turnTimerToken) return;
  if (turnTimer) clearTimeout(turnTimer);
  turnTimerToken = token;
  state.turnDeadline = Date.now() + TURN_TIME_MS;
  turnTimer = setTimeout(() => onTurnTimeout(token, currentId), TURN_TIME_MS);
}

function onTurnTimeout(token, playerId) {
  if (!state || state.phase !== 'playing' || token !== turnTimerToken) return;
  try {
    io.emit('action:log', { type: 'turnTimeout', event: 'turnTimeout', playerId });
    const result = actions.endTurn(state, playerId);
    broadcastState();
    emitTurnResult(result);
    flushEvents();
    if (state.phase === 'finished') io.emit('game:over', { winner: state.winner });
  } catch (err) {
    console.error('[timeout de turno]', err.message);
  }
}

function broadcastState() {
  syncTurnTimer();
  io.emit('state:update', serializeState(state));
}

// --- Coordinación de fin de partida ---
// Al terminar la partida, cada jugador elige "jugar de nuevo" o "volver al
// lobby". Ninguna de las dos acciones resetea nada por sí sola: hasta que
// TODOS los jugadores conectados hayan elegido una de las dos, el estado
// sigue en pie (así los demás pueden seguir viendo el tablero final). El
// último en decidir dispara el reset y todos vuelven a la pantalla de
// elegir cantidad de jugadores, sin importar cuál de las dos botoneras usó.
function registerPostGameChoice(socket, action) {
  if (!state || state.phase !== 'finished') return;
  if (!state.postGameChoices) state.postGameChoices = {};
  state.postGameChoices[socket.id] = action;
  broadcastState();
  maybeResetAfterGame();
}

function maybeResetAfterGame() {
  if (!state || state.phase !== 'finished') return;
  if (state.players.length === 0) return;
  const allDecided = state.players.every((p) => {
    const sock = io.sockets.sockets.get(p.id);
    return !sock || (state.postGameChoices && state.postGameChoices[p.id]);
  });
  if (allDecided) {
    state = null;
    broadcastState();
  }
}

// Envía al historial los eventos de fondo (resurrección de Fénix, muertes por
// clima, curación...) que la lógica dejó en state.eventQueue.
function flushEvents() {
  if (!state || !state.eventQueue || state.eventQueue.length === 0) return;
  const events = state.eventQueue;
  state.eventQueue = [];
  events.forEach((evt) => io.emit('action:log', evt));
}

// Avisa a los clientes de lo que pasó al avanzar el turno (clima, criatura).
function emitTurnResult(result) {
  if (!result) return;
  if (result.weather && result.weather.spawned) {
    io.emit('action:log', { type: 'weatherSpawned', event: 'weatherSpawned', weather: result.weather.spawned });
  }
  if (result.weather && result.weather.expired) {
    io.emit('action:log', { type: 'weatherEnded', event: 'weatherEnded', weather: result.weather.expired });
  }
  (result.despawnedCreatures || []).forEach((c) => {
    io.emit('action:log', { type: 'creatureDespawned', event: 'creatureDespawned', creature: c, to: { x: c.x, y: c.y } });
  });
  if (result.spawnedChest) {
    io.emit('action:log', { type: 'chestSpawned', event: 'chestSpawned', to: { x: result.spawnedChest.x, y: result.spawnedChest.y } });
  }
  if (result.spawnedCreature) {
    io.emit('action:log', {
      type: 'creatureSpawned',
      event: 'creatureSpawned',
      creature: result.spawnedCreature,
      to: { x: result.spawnedCreature.x, y: result.spawnedCreature.y },
    });
  }
  if (result.telegraphedCreature) {
    io.emit('action:log', {
      type: 'creatureTelegraph',
      event: 'creatureTelegraph',
      creature: result.telegraphedCreature,
      to: { x: result.telegraphedCreature.x, y: result.telegraphedCreature.y },
    });
  }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

io.on('connection', (socket) => {
  console.log(`[conexión] ${socket.id}`);

  // Si ya existe una sala en fase de lobby con cupo libre, el jugador se une
  // automáticamente (con nombre y color por defecto, editables después).
  if (state && state.phase === 'lobby' && state.players.length < state.maxPlayers) {
    try {
      addPlayer(state, socket.id, null);
    } catch (err) {
      // sala llena justo en este instante: no pasa nada, queda como espectador
    }
  }

  socket.emit('state:update', serializeState(state));
  broadcastState();

  // El primer jugador en conectarse (sin sala aún) crea la partida y se
  // convierte en el líder: define cuántos jugadores tendrá (2-8).
  socket.on('lobby:setPlayerCount', (count) => {
    if (state) {
      socket.emit('error:message', 'La partida ya fue inicializada.');
      return;
    }
    const n = Number(count);
    if (!Number.isInteger(n) || n < MIN_PLAYERS || n > MAX_PLAYERS) {
      socket.emit('error:message', `El número de jugadores debe estar entre ${MIN_PLAYERS} y ${MAX_PLAYERS}.`);
      return;
    }
    state = createGameState(n);
    state.leaderId = socket.id;
    addPlayer(state, socket.id, null);
    broadcastState();
  });

  socket.on('lobby:setName', (name) => {
    if (!state || state.phase !== 'lobby') return;
    try {
      setPlayerName(state, socket.id, name);
      broadcastState();
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  socket.on('lobby:setColor', (color) => {
    if (!state || state.phase !== 'lobby') return;
    try {
      setPlayerColor(state, socket.id, color);
      broadcastState();
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  socket.on('lobby:setReady', (ready) => {
    if (!state || state.phase !== 'lobby') return;
    try {
      setPlayerReady(state, socket.id, !!ready);
      broadcastState();
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  socket.on('lobby:startGame', () => {
    if (!state) return;
    if (socket.id !== state.leaderId) {
      socket.emit('error:message', 'Solo el líder puede iniciar la partida.');
      return;
    }
    try {
      startGame(state);
      state.turnOrder = shuffle(state.players.map((p) => p.id));
      state.currentTurnIndex = 0;
      io.emit('game:started', { turnOrder: state.turnOrder });
      broadcastState();
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  // --- Acciones de juego ---
  socket.on('action:getReachable', ({ unitId }) => {
    if (!state) return;
    const unit = state.units.find((u) => u.id === unitId);
    if (!unit || unit.owner !== socket.id) {
      socket.emit('error:message', 'Ficha inválida');
      return;
    }
    if (unit.movedThisTurn) {
      socket.emit('action:reachable', { unitId, tiles: [] });
      return;
    }
    const tiles = actions.getReachableTiles(state, unit);
    socket.emit('action:reachable', { unitId, tiles });
  });

  socket.on('action:move', ({ unitId, x, y }) => {
    if (!state) return;
    try {
      const unitBefore = state.units.find((u) => u.id === unitId);
      const unitType = unitBefore ? unitBefore.type : null;
      const log = actions.moveUnit(state, socket.id, unitId, x, y);
      broadcastState();
      io.emit('action:log', { ...log, type: 'move', playerId: socket.id, unitType });
      flushEvents();
      if (state.phase === 'finished') io.emit('game:over', { winner: state.winner });
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  socket.on('action:produce', ({ castleId, unitType }) => {
    if (!state) return;
    try {
      const unit = actions.produceUnit(state, socket.id, castleId, unitType);
      broadcastState();
      io.emit('action:log', { type: 'produce', playerId: socket.id, unitType: unit.type, castleId });
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  socket.on('action:getBuildableFarmTiles', () => {
    if (!state) return;
    const tiles = actions.getBuildableFarmTiles(state, socket.id);
    socket.emit('action:buildableFarmTiles', { tiles });
  });

  socket.on('action:buildFarm', ({ castleId, x, y }) => {
    if (!state) return;
    try {
      actions.buildFarm(state, socket.id, castleId, x, y);
      broadcastState();
      io.emit('action:log', { type: 'buildFarm', playerId: socket.id, castleId });
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  socket.on('action:getBuildableBarrierTiles', () => {
    if (!state) return;
    const tiles = actions.getBuildableBarrierTiles(state, socket.id);
    socket.emit('action:buildableBarrierTiles', { tiles });
  });

  socket.on('action:buildBarrier', ({ castleId, x, y }) => {
    if (!state) return;
    try {
      actions.buildBarrier(state, socket.id, castleId, x, y);
      broadcastState();
      io.emit('action:log', { type: 'buildBarrier', playerId: socket.id, castleId });
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  // Cuartel: mismas casillas que la barrera (territorio propio sin ficha).
  socket.on('action:getBuildableBarracksTiles', () => {
    if (!state) return;
    const tiles = actions.getBuildableBarrierTiles(state, socket.id);
    socket.emit('action:buildableBarracksTiles', { tiles });
  });

  socket.on('action:buildBarracks', ({ x, y }) => {
    if (!state) return;
    try {
      actions.buildBarracks(state, socket.id, x, y);
      broadcastState();
      io.emit('action:log', { type: 'buildBarracks', playerId: socket.id });
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  socket.on('action:upgradeBarracks', ({ track }) => {
    if (!state) return;
    try {
      const res = actions.upgradeBarracks(state, socket.id, track);
      broadcastState();
      io.emit('action:log', { type: 'upgradeBarracks', playerId: socket.id, track: res.track, tier: res.tier });
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  socket.on('action:attackBarrier', ({ unitId, barrierId }) => {
    if (!state) return;
    try {
      const log = actions.attackBarrier(state, socket.id, unitId, barrierId);
      broadcastState();
      io.emit('action:log', log);
      flushEvents();
      if (state.phase === 'finished') io.emit('game:over', { winner: state.winner });
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  socket.on('action:upgradeCastle', ({ castleId }) => {
    if (!state) return;
    try {
      const castle = actions.upgradeCastle(state, socket.id, castleId);
      broadcastState();
      io.emit('action:log', { type: 'upgradeCastle', playerId: socket.id, castleId, newLevel: castle.level });
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  socket.on('action:endTurn', () => {
    if (!state) return;
    try {
      const result = actions.endTurn(state, socket.id);
      broadcastState();
      emitTurnResult(result);
      flushEvents();
      if (state.phase === 'finished') io.emit('game:over', { winner: state.winner });
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  // Cualquier jugador vivo puede rendirse en cualquier momento.
  socket.on('action:surrender', () => {
    if (!state) return;
    try {
      const result = actions.surrenderPlayer(state, socket.id);
      broadcastState();
      io.emit('action:log', { type: 'surrender', event: 'surrender', playerId: socket.id });
      emitTurnResult(result);
      flushEvents();
      if (state.phase === 'finished') io.emit('game:over', { winner: state.winner });
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  // Solo el líder puede terminar la partida (queda sin ganador).
  socket.on('game:end', () => {
    if (!state) return;
    if (socket.id !== state.leaderId) {
      socket.emit('error:message', 'Solo el líder puede terminar la partida.');
      return;
    }
    try {
      actions.forceEndGame(state);
      broadcastState();
      io.emit('game:over', { winner: null, endedByLeader: true });
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  socket.on('game:playAgain', () => registerPostGameChoice(socket, 'again'));
  socket.on('game:backToLobby', () => registerPostGameChoice(socket, 'lobby'));

  socket.on('action:attackCreature', ({ unitId, creatureId }) => {
    if (!state) return;
    try {
      const log = actions.attackCreature(state, socket.id, unitId, creatureId);
      broadcastState();
      io.emit('action:log', log);
      flushEvents();
      if (state.phase === 'finished') io.emit('game:over', { winner: state.winner });
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  socket.on('action:attackUnit', ({ unitId, targetId }) => {
    if (!state) return;
    try {
      const log = actions.attackUnit(state, socket.id, unitId, targetId);
      broadcastState();
      io.emit('action:log', log);
      flushEvents();
      if (state.phase === 'finished') io.emit('game:over', { winner: state.winner });
    } catch (err) {
      socket.emit('error:message', err.message);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[desconexión] ${socket.id}`);
    if (!state) return;

    if (state.phase === 'lobby') {
      // Mientras se arma la partida, un jugador que se va libera su cupo y su color.
      removePlayer(state, socket.id);
      if (state.leaderId === socket.id) {
        // El líder se fue: el siguiente en la sala pasa a liderar, o se
        // desarma la sala si no queda nadie.
        state.leaderId = state.players.length > 0 ? state.players[0].id : null;
        if (!state.leaderId) state = null;
      }
      broadcastState();
    }

    if (!state) return;

    if (state.phase === 'finished') {
      // Ya no cuenta como "indeciso": si era el último que faltaba, esto
      // dispara el reset para los que quedan.
      maybeResetAfterGame();
    }

    if (!state) return;

    if (state.phase === 'playing') {
      // Partida en curso: quien se desconecta se rinde automáticamente, así
      // el turno nunca queda trabado esperando a un jugador que ya no está.
      const player = state.players.find((p) => p.id === socket.id);
      if (player && player.alive) {
        try {
          const result = actions.surrenderPlayer(state, socket.id);
          io.emit('action:log', { type: 'disconnect', event: 'disconnect', playerId: socket.id });
          emitTurnResult(result);
          flushEvents();
          if (state.phase === 'finished') io.emit('game:over', { winner: state.winner });
        } catch (err) {
          console.error('[desconexión] error al rendir jugador:', err.message);
        }
      }
    }

    // Si se fue el líder, el mando pasa a otro jugador vivo.
    if (state.leaderId === socket.id) {
      const nextLeader = state.players.find((p) => p.alive && p.id !== socket.id);
      state.leaderId = nextLeader ? nextLeader.id : null;
    }

    // Sin nadie conectado, se libera la sala para poder crear otra partida.
    if (io.of('/').sockets.size === 0) {
      clearTurnTimer();
      state = null;
    }
    broadcastState();
  });
});

server.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
