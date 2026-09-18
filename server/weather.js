// server/weather.js
// Eventos climáticos: a partir de la ronda 3, cada 3 turnos aparece un evento
// en una zona aleatoria de 3x3. Uno solo a la vez; dura 2 turnos. Mientras
// está activo, las fichas dentro de la zona pierden 1 de vida por turno
// (se recalcula en vivo: solo cuenta quien esté dentro en ese momento).
// Las cinco variantes (eléctrica, nieve, arena, fuego, niebla) hoy tienen el mismo efecto.

const { isAccessibleTile } = require('./terrain');
const { killUnit, queueEvent } = require('./units');

const WEATHER_START_ROUND = 3;
const WEATHER_INTERVAL_TURNS = 3;
const WEATHER_DURATION_TURNS = 2;
const WEATHER_DAMAGE = 1;
const WEATHER_SIZE = 3;
const WEATHER_TYPES = ['electrica', 'nieve', 'arena', 'fuego', 'niebla'];

function isInZone(w, x, y) {
  return x >= w.x && x < w.x + w.size && y >= w.y && y < w.y + w.size;
}

// Elige una zona 3x3 dentro del tablero con al menos 5 casillas accesibles
// (las inaccesibles quedan excluidas del clima).
function pickZone(state) {
  const max = state.boardSize - WEATHER_SIZE;
  for (let attempt = 0; attempt < 200; attempt++) {
    const x = Math.floor(Math.random() * (max + 1));
    const y = Math.floor(Math.random() * (max + 1));
    let accessible = 0;
    for (let dy = 0; dy < WEATHER_SIZE; dy++) {
      for (let dx = 0; dx < WEATHER_SIZE; dx++) {
        if (isAccessibleTile(state, x + dx, y + dy)) accessible++;
      }
    }
    if (accessible >= 5) return { x, y };
  }
  return null;
}

// Se llama una vez por cada fin de turno. Devuelve { spawned, expired } para
// que index.js pueda avisar a los clientes.
function tickWeather(state) {
  const result = { spawned: null, expired: null, damaged: 0 };
  const w = state.activeWeather;

  if (w) {
    // Daño: solo fichas físicamente dentro de la zona ahora mismo. El Rey no
    // se puede mover, así que queda a salvo.
    const victims = state.units.filter((u) => u.type !== 'rey' && isInZone(w, u.x, u.y));
    victims.forEach((u) => {
      u.hp -= WEATHER_DAMAGE;
      result.damaged++;
      if (u.hp <= 0) {
        u.hp = 0;
        queueEvent(state, { type: 'weatherKill', event: 'weatherKill', unitId: u.id, unitType: u.type, playerId: u.owner, weatherType: w.type, to: { x: u.x, y: u.y } });
        killUnit(state, u);
      }
    });
    w.turnsLeft -= 1;
    if (w.turnsLeft <= 0) {
      state.activeWeather = null;
      result.expired = w;
    }
    return result;
  }

  if (state.round < WEATHER_START_ROUND) return result;
  if (state.turnCounter <= 0 || state.turnCounter % WEATHER_INTERVAL_TURNS !== 0) return result;

  const zone = pickZone(state);
  if (!zone) return result;
  state.activeWeather = {
    id: state.weatherIdCounter++,
    type: WEATHER_TYPES[Math.floor(Math.random() * WEATHER_TYPES.length)],
    x: zone.x,
    y: zone.y,
    size: WEATHER_SIZE,
    turnsLeft: WEATHER_DURATION_TURNS,
  };
  result.spawned = state.activeWeather;
  return result;
}

module.exports = {
  WEATHER_START_ROUND, WEATHER_INTERVAL_TURNS, WEATHER_DURATION_TURNS,
  WEATHER_DAMAGE, WEATHER_TYPES, tickWeather, isInZone,
};
