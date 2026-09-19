// server/weather.js
// Eventos climáticos: a partir de la ronda 3, cada 3 turnos aparece un evento
// en una zona aleatoria de 9 casillas (irregular, no un cuadrado fijo). Uno
// solo a la vez; dura 2 turnos. La zona se guarda como lista de casillas
// (`cells`) y se recalcula en vivo: solo cuenta quien esté dentro en ese
// momento.
//   - electrica, nieve, arena, acido, niebla: las fichas dentro pierden
//     1 de vida por turno (hoy todas tienen el mismo efecto).
//   - terremoto: no hace daño, pero las fichas dentro NO pueden moverse
//     mientras dure (ver isUnitImmobilized).

const { isAccessibleTile } = require('./terrain');
const { killUnit, queueEvent, findPlayer } = require('./units');

const WEATHER_START_ROUND = 3;
const WEATHER_INTERVAL_TURNS = 3;
const WEATHER_DURATION_TURNS = 2;
const WEATHER_DAMAGE = 1;
const WEATHER_CELLS = 9;
const WEATHER_HEAL = 2;      // lluvia: vida que recupera cada ficha dentro por turno
const WEATHER_GOLD = 3;      // aurora: oro por ficha propia dentro, por turno
const WEATHER_TYPES = ['electrica', 'nieve', 'arena', 'acido', 'niebla', 'terremoto', 'lluvia', 'eclipse', 'aurora'];
// Sin daño: terremoto (inmoviliza), lluvia (cura), eclipse (no se puede
// atacar), aurora (da oro).
const NO_DAMAGE_TYPES = new Set(['terremoto', 'lluvia', 'eclipse', 'aurora']);

const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function isInZone(w, x, y) {
  return w.cells.some((c) => c.x === x && c.y === y);
}

// Tropa dentro de un terremoto activo: no puede moverse (sí puede atacar).
function isUnitImmobilized(state, unit) {
  const w = state.activeWeather;
  return !!(w && w.type === 'terremoto' && isInZone(w, unit.x, unit.y));
}

// Eclipse: las fichas dentro no pueden atacar (sí moverse).
function isUnitDisarmed(state, unit) {
  const w = state.activeWeather;
  return !!(w && w.type === 'eclipse' && isInZone(w, unit.x, unit.y));
}

// Elige una zona de 9 casillas accesibles conectadas entre sí: parte de una
// casilla al azar y crece hacia vecinas ortogonales, así cada evento tiene
// una forma distinta.
function pickZone(state) {
  const size = state.boardSize;
  const key = (x, y) => `${x},${y}`;

  for (let attempt = 0; attempt < 200; attempt++) {
    const sx = Math.floor(Math.random() * size);
    const sy = Math.floor(Math.random() * size);
    if (!isAccessibleTile(state, sx, sy)) continue;

    const cells = [{ x: sx, y: sy }];
    const taken = new Set([key(sx, sy)]);

    while (cells.length < WEATHER_CELLS) {
      const frontier = [];
      cells.forEach((c) => {
        ORTHO.forEach(([dx, dy]) => {
          const nx = c.x + dx;
          const ny = c.y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) return;
          if (taken.has(key(nx, ny))) return;
          if (!isAccessibleTile(state, nx, ny)) return;
          frontier.push({ x: nx, y: ny });
        });
      });
      if (frontier.length === 0) break; // quedó encerrada: reintentar
      const next = frontier[Math.floor(Math.random() * frontier.length)];
      cells.push(next);
      taken.add(key(next.x, next.y));
    }

    if (cells.length === WEATHER_CELLS) return cells;
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
    // se puede mover, así que queda a salvo. El terremoto no hace daño.
    if (!NO_DAMAGE_TYPES.has(w.type)) {
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
    }
    if (w.type === 'lluvia') {
      let healed = 0;
      state.units.forEach((u) => {
        if (u.hp < u.maxHp && isInZone(w, u.x, u.y)) {
          u.hp = Math.min(u.maxHp, u.hp + WEATHER_HEAL);
          healed++;
        }
      });
      if (healed > 0) queueEvent(state, { type: 'weatherHeal', event: 'weatherHeal', count: healed, weatherType: w.type });
    } else if (w.type === 'aurora') {
      const gains = new Map();
      state.units.forEach((u) => {
        if (u.type !== 'rey' && isInZone(w, u.x, u.y)) gains.set(u.owner, (gains.get(u.owner) || 0) + WEATHER_GOLD);
      });
      gains.forEach((gold, pid) => {
        const p = findPlayer(state, pid);
        if (!p || !p.alive) return;
        p.gold += gold;
        queueEvent(state, { type: 'weatherGold', event: 'weatherGold', playerId: pid, gold, weatherType: w.type });
      });
    }
    w.turnsLeft -= 1;
    if (w.turnsLeft <= 0) {
      state.activeWeather = null;
      result.expired = w;
    }
    return result;
  }

  if (state.round < WEATHER_START_ROUND) return result;
  if (state.turnCounter <= 0 || state.turnCounter % WEATHER_INTERVAL_TURNS !== 0) return result;

  const cells = pickZone(state);
  if (!cells) return result;
  state.activeWeather = {
    id: state.weatherIdCounter++,
    type: WEATHER_TYPES[Math.floor(Math.random() * WEATHER_TYPES.length)],
    cells,
    turnsLeft: WEATHER_DURATION_TURNS,
  };
  result.spawned = state.activeWeather;
  return result;
}

module.exports = {
  WEATHER_START_ROUND, WEATHER_INTERVAL_TURNS, WEATHER_DURATION_TURNS,
  WEATHER_DAMAGE, WEATHER_CELLS, WEATHER_TYPES, tickWeather, isInZone, isUnitImmobilized, isUnitDisarmed,
};
