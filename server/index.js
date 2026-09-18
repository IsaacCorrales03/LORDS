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
} = require('./gameState');
const actions = require('./actions');

const PORT = process.env.PORT || 3000;

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
    })),
    turnOrder: s.turnOrder,
    currentTurnIndex: s.currentTurnIndex,
    round: s.round,
    phase: s.phase,
    leaderId: s.leaderId,
    units: s.units,
    farms: s.farms,
    winner: s.winner,
    activeCreatures: s.activeCreatures,
    activeWeather: s.activeWeather,
    turnCounter: s.turnCounter,
  };
}

function broadcastState() {
  io.emit('state:update', serializeState(state));
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
  if (result.spawnedCreature) {
    io.emit('action:log', {
      type: 'creatureSpawned',
      event: 'creatureSpawned',
      creature: result.spawnedCreature,
      to: { x: result.spawnedCreature.x, y: result.spawnedCreature.y },
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

  socket.on('action:attackCreature', ({ unitId }) => {
    if (!state) return;
    try {
      const log = actions.attackCreature(state, socket.id, unitId);
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
      state = null;
    }
    broadcastState();
  });
});

server.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
