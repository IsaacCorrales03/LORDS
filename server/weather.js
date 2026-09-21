// server/weather.js
// Eventos climáticos: a partir de la ronda 3, cada 3 turnos aparece un evento
// en una zona irregular de entre WEATHER_MIN_CELLS y WEATHER_MAX_CELLS casillas
// (el tamaño se sortea en cada evento). Uno solo a la vez; dura 2 turnos. La
// zona se guarda como lista de casillas (`cells`) y se recalcula en vivo: solo
// cuenta quien esté dentro en ese momento.
//
// Cada clima hace algo DISTINTO (ya no hay 5 variantes de "-1 de vida"):
//   - electrica: -1 de vida por turno a las fichas dentro (único daño parejo).
//   - meteoros:  caen meteoritos en casillas al azar de la zona: -3 de vida a
//                quien esté justo debajo (pocos golpes, pero fuertes).
//   - nieve:     Ventisca: las fichas dentro solo avanzan 1 casilla (actions.js).
//   - arena:     Tormenta de arena: -1 ATQ a las tropas dentro (units.js).
//   - niebla:    Niebla densa: +1 DEF a las tropas dentro (units.js).
//   - terremoto: las fichas dentro NO pueden moverse (ver isUnitImmobilized).
//   - lluvia:    cura +2 de vida por turno a toda ficha dentro.
//   - eclipse:   las fichas dentro no pueden atacar (ver isUnitDisarmed).
//   - aurora:    +3 de oro por turno por cada tropa propia dentro.
//   - cosecha:   cada granja dentro de la zona da su ingreso extra por turno.

const { isAccessibleTile } = require('./terrain');
const { killUnit, queueEvent, findPlayer } = require('./units');
const { farmIncomeFor } = require('./gameState');

const WEATHER_START_ROUND = 3;
const WEATHER_INTERVAL_TURNS = 3;
const WEATHER_DURATION_TURNS = 2;
const WEATHER_DAMAGE = 1;
const WEATHER_MIN_CELLS = 6;
const WEATHER_MAX_CELLS = 27;
const WEATHER_HEAL = 2;      // lluvia: vida que recupera cada ficha dentro por turno
const WEATHER_GOLD = 3;      // aurora: oro por ficha propia dentro, por turno
const METEOR_DAMAGE = 3;     // meteoros: daño del impacto
const WEATHER_TYPES = [
  'electrica', 'meteoros', 'nieve', 'arena', 'niebla',
  'terremoto', 'lluvia', 'eclipse', 'aurora', 'cosecha',
];

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

// Elige una zona de `count` casillas accesibles conectadas entre sí: parte de
// una casilla al azar y crece hacia vecinas ortogonales, así cada evento tiene
// una forma distinta. Si en el tablero no cabe el tamaño pedido, devuelve la
// zona más grande lograda (mientras llegue al mínimo).
function pickZone(state, count) {
  const size = state.boardSize;
  const key = (x, y) => `${x},${y}`;
  let best = null;

  for (let attempt = 0; attempt < 200; attempt++) {
    const sx = Math.floor(Math.random() * size);
    const sy = Math.floor(Math.random() * size);
    if (!isAccessibleTile(state, sx, sy)) continue;

    const cells = [{ x: sx, y: sy }];
    const taken = new Set([key(sx, sy)]);

    while (cells.length < count) {
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
      if (frontier.length === 0) break; // quedó encerrada
      const next = frontier[Math.floor(Math.random() * frontier.length)];
      cells.push(next);
      taken.add(key(next.x, next.y));
    }

    if (cells.length === count) return cells;
    if (!best || cells.length > best.length) best = cells;
  }
  return best && best.length >= WEATHER_MIN_CELLS ? best : null;
}

// Daña a una ficha (no al Rey) y encola el aviso si muere de verdad. Devuelve true si murió.
function hurt(state, unit, amount, weatherType) {
  unit.hp -= amount;
  if (unit.hp > 0) return false;
  unit.hp = 0;
  const res = killUnit(state, unit);
  if (!res.revived) {
    queueEvent(state, { type: 'weatherKill', event: 'weatherKill', unitId: unit.id, unitType: unit.type, playerId: unit.owner, weatherType, to: { x: unit.x, y: unit.y } });
  }
  return !res.revived;
}

// Se llama una vez por cada fin de turno. Devuelve { spawned, expired } para
// que index.js pueda avisar a los clientes.
function tickWeather(state) {
  const result = { spawned: null, expired: null, damaged: 0 };
  const w = state.activeWeather;

  if (w) {
    // El Rey no se puede mover, así que queda a salvo de los daños.
    if (w.type === 'electrica') {
      state.units.filter((u) => u.type !== 'rey' && isInZone(w, u.x, u.y)).forEach((u) => {
        result.damaged++;
        hurt(state, u, WEATHER_DAMAGE, w.type);
      });
    } else if (w.type === 'meteoros') {
      // Más casillas en juego = más impactos (2 a 5), sin repetir casilla.
      const strikes = Math.max(2, Math.round(w.cells.length / 6));
      const pool = w.cells.slice();
      const struck = [];
      for (let i = 0; i < strikes && pool.length > 0; i++) {
        struck.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
      }
      let hits = 0;
      struck.forEach((c) => {
        state.units.filter((u) => u.type !== 'rey' && u.x === c.x && u.y === c.y).forEach((u) => {
          hits++;
          result.damaged++;
          hurt(state, u, METEOR_DAMAGE, w.type);
        });
      });
      queueEvent(state, { type: 'weatherMeteor', event: 'weatherMeteor', weatherType: w.type, cells: struck, hits });
    } else if (w.type === 'lluvia') {
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
    } else if (w.type === 'cosecha') {
      const gains = new Map();
      (state.farms || []).forEach((f) => {
        if (f.owner && isInZone(w, f.x, f.y)) gains.set(f.owner, (gains.get(f.owner) || 0) + farmIncomeFor(state, f.owner));
      });
      gains.forEach((gold, pid) => {
        const p = findPlayer(state, pid);
        if (!p || !p.alive) return;
        p.gold += gold;
        queueEvent(state, { type: 'weatherGold', event: 'weatherGold', playerId: pid, gold, weatherType: w.type });
      });
    }
    // nieve, arena, niebla, terremoto y eclipse no actúan aquí: sus efectos se
    // aplican al mover / pelear (actions.js, units.js).

    w.turnsLeft -= 1;
    if (w.turnsLeft <= 0) {
      state.activeWeather = null;
      result.expired = w;
    }
    return result;
  }

  if (state.round < WEATHER_START_ROUND) return result;
  if (state.turnCounter <= 0 || state.turnCounter % WEATHER_INTERVAL_TURNS !== 0) return result;

  const count = WEATHER_MIN_CELLS + Math.floor(Math.random() * (WEATHER_MAX_CELLS - WEATHER_MIN_CELLS + 1));
  const cells = pickZone(state, count);
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
  WEATHER_DAMAGE, WEATHER_MIN_CELLS, WEATHER_MAX_CELLS, WEATHER_TYPES,
  tickWeather, isInZone, isUnitImmobilized, isUnitDisarmed,
};
