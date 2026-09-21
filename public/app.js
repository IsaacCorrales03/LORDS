// public/app.js
// Cliente: conexión socket, lobby (líder + sala de espera) y juego (render SVG + interacción).

const socket = io();

// --- Constantes espejo del servidor (solo para mostrar costos/íconos en UI) ---
const UNIT_LABELS = {
  rey: 'Rey', peon: 'Peón', caballo: 'Caballo', alfil: 'Alfil', torre: 'Torre', reina: 'Reina',
  dragon: 'Dragón', fenix: 'Fénix', lobo: 'Lobo', golem: 'Golem', hidra: 'Hidra',
  grifo: 'Grifo', basilisco: 'Basilisco', medusa: 'Medusa',
};
// Criaturas neutrales: color de aura, recompensa y nota corta para el panel.
const CREATURE_INFO = {
  lobo:      { color: '#8fa3b8', reward: '10 de oro + mejora: +1 ATQ a todas tus tropas', note: 'Rápido y mordedor.' },
  golem:     { color: '#b58a5a', reward: '14 de oro + mejora: +1 DEF a todas tus tropas', note: 'Lento pero duro.' },
  dragon:    { color: '#e2685a', reward: 'desbloquea producir Dragón en tus castillos', note: 'Vuela sobre los abismos.' },
  hidra:     { color: '#6fcf97', reward: '60 de oro + mejora: 2º ataque de una tropa por turno', note: 'Regenera +2 de vida por ronda.' },
  fenix:     { color: '#ffb347', reward: 'desbloquea producir Fénix en tus castillos', note: 'Resucita una vez por jugador (10 de oro, en el castillo más cercano).' },
  grifo:     { color: '#c9c2e8', reward: 'desbloquea producir Grifo en tus castillos', note: 'Salta esquinas 2x2, sin bloqueo, igual que el Caballo.' },
  basilisco: { color: '#7fae5c', reward: '25 de oro + mejora: tus golpes envenenan', note: 'Si contraataca, envenena (2 de daño por turno, 3 turnos).' },
  medusa:    { color: '#9c7fc9', reward: '35 de oro', note: 'Si contraataca, petrifica (no se puede mover ni atacar por 2 turnos).' },
};
const WEATHER_INFO = {
  electrica: { label: 'Tormenta eléctrica', color: '#f5d84a', note: '-1 de vida por turno a quien esté dentro.' },
  meteoros:  { label: 'Lluvia de meteoros', color: '#ff7a3d', note: 'Caen meteoritos en casillas al azar de la zona: -3 de vida a quien esté justo debajo.' },
  nieve:     { label: 'Ventisca de nieve', color: '#bfe3ff', note: 'Las fichas dentro solo pueden avanzar 1 casilla.' },
  arena:     { label: 'Tormenta de arena', color: '#d9a85c', note: 'Las tropas dentro tienen -1 de ATQ.' },
  niebla:    { label: 'Niebla densa', color: '#a9b7c6', note: 'Las tropas dentro tienen +1 de DEF (reciben 1 menos de daño).' },
  lluvia:    { label: 'Lluvia sanadora', color: '#6ec6ff', note: 'Sin daño: cura +2 de vida por turno a toda ficha dentro.' },
  eclipse:   { label: 'Eclipse', color: '#8a6fd6', note: 'Sin daño: las fichas dentro no pueden atacar (sí moverse).' },
  aurora:    { label: 'Aurora dorada', color: '#5fe0b0', note: 'Sin daño: +3 de oro por turno por cada tropa propia dentro.' },
  terremoto: { label: 'Terremoto', color: '#b58a5a', note: 'Las tropas dentro no pueden moverse.' },
  cosecha:   { label: 'Cosecha dorada', color: '#e6c04a', note: 'Cada granja dentro de la zona da su ingreso extra por turno.' },
};
const WEATHER_FALLBACK = { label: 'Clima', color: '#9fb3c8', note: 'Un clima extraño cubre esta zona.' };
// Nunca devuelve undefined: un tipo de clima desconocido no debe romper el render.
function weatherInfo(type) { return WEATHER_INFO[type] || WEATHER_FALLBACK; }
function creatureInfo(type) { return CREATURE_INFO[type] || CREATURE_INFO.lobo; }

// Criaturas activas (el servidor manda un arreglo; se acepta el campo viejo
// activeCreature por compatibilidad).
function creaturesOf(state) {
  if (!state) return [];
  if (Array.isArray(state.activeCreatures)) return state.activeCreatures;
  return state.activeCreature ? [state.activeCreature] : [];
}
// Mismo cálculo que el servidor: 1 criatura por cada 2 jugadores de la partida.
function maxCreaturesFor(playerCount) { return Math.ceil(playerCount / 2); }

// El clima ocupa una lista de casillas (w.cells), no un cuadrado fijo.
function isInWeatherZone(w, x, y) {
  return !!(w && Array.isArray(w.cells) && w.cells.some((c) => c.x === x && c.y === y));
}
function isInQuake(state, unit) {
  const w = state && state.activeWeather;
  return !!(w && w.type === 'terremoto' && unit && isInWeatherZone(w, unit.x, unit.y));
}
function playerNameOf(id) {
  const p = currentState && currentState.players.find((pl) => pl.id === id);
  return p ? p.name : 'Un jugador';
}

const UNIT_COSTS = { peon: 8, caballo: 25, alfil: 50, torre: 85, reina: 125, grifo: 110, fenix: 140, dragon: 180 };
// Tropas especiales: se producen en castillo solo tras derrotar a esa criatura.
const UNLOCKABLE_UNITS = ['grifo', 'fenix', 'dragon'];

// --- Mejoras por criaturas derrotadas (espejo de units.js / creatures.js) ---
// El servidor manda player.upgrades y player.unlockedUnits; aquí solo se
// leen para mostrar los números correctos (el cálculo real lo hace el servidor).
function upgradesOfPlayer(state, ownerId) {
  const p = state && ownerId ? state.players.find((pl) => pl.id === ownerId) : null;
  return (p && p.upgrades) || null;
}
// ATQ / DEF efectivos: el Rey y las criaturas neutrales no reciben bonos.
// Clima que afecta a las tropas dentro de la zona: arena (-1 ATQ) y niebla (+1 DEF).
function inWeatherType(state, unit, type) {
  const w = state && state.activeWeather;
  return !!(w && w.type === type && unit && isInWeatherZone(w, unit.x, unit.y));
}
function effAtk(unit, state = currentState) {
  if (!unit) return 0;
  if (unit.type === 'rey') return unit.atk;
  const up = upgradesOfPlayer(state, unit.owner);
  return unit.atk + (up ? up.atkBonus : 0) - (unit.owner && inWeatherType(state, unit, 'arena') ? 1 : 0);
}
function effDef(unit, state = currentState) {
  if (!unit || unit.type === 'rey') return 0;
  const up = upgradesOfPlayer(state, unit.owner);
  return (up ? up.defBonus : 0) + (unit.owner && inWeatherType(state, unit, 'niebla') ? 1 : 0);
}
// Daño que hará `attacker` a `defender` en su golpe, y lo que le devuelve el contraataque.
function previewHit(attacker, defender) {
  return Math.max(1, effAtk(attacker) - effDef(defender));
}
function previewCounter(attacker, defender) {
  return defender && defender.atk > 0 ? Math.max(1, effAtk(defender) - effDef(attacker)) : 0;
}
// Mejora de la Hidra: 1 vez por turno, una tropa que ya atacó puede atacar otra vez.
function hydraAvailableFor(unit, state = currentState) {
  const up = upgradesOfPlayer(state, unit.owner);
  return !!(up && up.hydraStrike && unit.didAttackThisTurn && !state.hydraUsedThisTurn);
}
function canStrike(unit, state) {
  return !unit.attackedThisTurn || hydraAvailableFor(unit, state);
}
const CASTLE_GOLD_PER_TURN = { 1: 3, 2: 4, 3: 5 };
const FARM_INCOME_CLIENT = 4;
function incomeOf(state, playerId) {
  const castles = state.castles.filter((c) => c.owner === playerId);
  const farms = state.farms.filter((f) => f.owner === playerId).length;
  const fromCastles = castles.reduce((sum, c) => sum + (CASTLE_GOLD_PER_TURN[c.level] || 0), 0);
  return fromCastles + farms * playerFarmIncome(state, playerId);
}
const CASTLE_UPGRADE_COST = { 2: 15, 3: 50 };

// --- Cuartel (espejo de gameState.js): 1 por jugador, 50 de oro ---
const BARRACKS_COST = 50;
const BARRACKS_UPGRADES = {
  farms:    { label: 'Granjas',  costs: [40, 80],       values: [5, 6] },
  walls:    { label: 'Murallas', costs: [40, 80],       values: [2, 3] },
  discount: { label: 'Tropas',   costs: [60, 100, 150], values: [0.10, 0.15, 0.20] },
};
function barracksOfClient(state, playerId) {
  return (state.barracks || []).find((b) => b.owner === playerId) || null;
}
function playerFarmIncome(state, ownerId) {
  const p = state.players.find((pl) => pl.id === ownerId);
  return (p && p.farmIncome) || FARM_INCOME_CLIENT;
}
function troopCostFor(player, type) {
  const d = player && player.troopDiscount ? player.troopDiscount : 0;
  return Math.max(1, Math.round(UNIT_COSTS[type] * (1 - d)));
}
function myWallLevel(state) {
  const b = barracksOfClient(state, myId);
  return 1 + (b ? b.wallsTier : 0);
}
// Cuartel: tienda militar con la bandera del dueño (mismo estilo fijo que las fichas).
function barracksMarkup(flagColor) {
  return '<rect x="11.4" y="1.2" width="1.2" height="6.4" fill="#ece3c9"/>'
    + `<path d="M12.6 1.7 L18.4 3.6 L12.6 5.5 Z" fill="${flagColor}" stroke="#0c1119" stroke-opacity="0.5" stroke-width="0.5" stroke-linejoin="round"/>`
    + '<path d="M2.6 20.8 L12 6.6 L21.4 20.8 Z" fill="#ece3c9"/>'
    + `<path d="M5.4 16.6 L12 6.6 L18.6 16.6 L17.2 18.4 L12 11.6 L6.8 18.4 Z" fill="${flagColor}" stroke="#0c1119" stroke-opacity="0.45" stroke-width="0.5" stroke-linejoin="round"/>`
    + '<path d="M12 12.6 L15.4 20.8 H8.6 Z" fill="#0c1119"/>'
    + '<path d="M3.2 22 L8 18.2 M20.8 22 L16 18.2" stroke="#ece3c9" stroke-width="1.1" stroke-linecap="round"/>';
}
const FARM_COST = 20;
const BARRIER_COST = 20;
const BARRIER_HP_BY_LEVEL = { 1: 4, 2: 8, 3: 12 };
const BARRIER_COUNTER_DAMAGE_BY_LEVEL = { 1: 0, 2: 2, 3: 3 };
const PLAYER_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'cyan', 'pink'];
const PLAYER_COLOR_HEX = {
  red: '#c1483a', blue: '#3f74b8', green: '#4c9160',
  yellow: '#c9a23d', purple: '#8462b8', orange: '#d1823f',
  cyan: '#3aa6a6', pink: '#c8659a',
};

// Emblemas heráldicos: cada ficha es un pictograma plano en vez de un glifo de
// ajedrez, dibujado con formas simples para que se lea bien a tamaño chico.
// ESTILO ÚNICO: todos los colores son valores fijos (crema #ece3c9 para la
// silueta, #0c1119 para los recortes). Sin var() ni currentColor dentro de los
// atributos SVG, así ningún navegador ni modo oscuro/claro los reinterpreta.
const UNIT_ICON_PATHS = {
  rey: '<rect x="10.9" y="1.4" width="2.2" height="6.6" rx="0.5"/><rect x="9" y="3.3" width="6" height="2.2" rx="0.5"/><path d="M4.6 10.2 L8.3 12.6 L12 8.6 L15.7 12.6 L19.4 10.2 L18 17.7 H6 Z"/><circle cx="12" cy="14.2" r="1.1" fill="#0c1119"/><rect x="5.7" y="17.7" width="12.6" height="1.9" rx="0.7"/><rect x="4.8" y="19.7" width="14.4" height="2" rx="1"/>',
  reina: '<path d="M4.4 8.2 L7 14.4 L8.2 6.8 L10.6 13.8 L12 5.2 L13.4 13.8 L15.8 6.8 L17 14.4 L19.6 8.2 L18.1 17.7 H5.9 Z"/><circle cx="4.4" cy="7.4" r="1.35"/><circle cx="8.2" cy="6" r="1.35"/><circle cx="12" cy="4.3" r="1.55"/><circle cx="15.8" cy="6" r="1.35"/><circle cx="19.6" cy="7.4" r="1.35"/><rect x="5.7" y="17.7" width="12.6" height="1.9" rx="0.7"/><rect x="4.8" y="19.7" width="14.4" height="2" rx="1"/>',
  torre: '<path d="M6 3.4 H8.5 V5.9 H10.75 V3.4 H13.25 V5.9 H15.5 V3.4 H18 V8.4 H6 Z"/><path d="M7.4 8.4 H16.6 L15.7 10.4 H8.3 Z"/><path d="M8.3 10.4 H15.7 V18.2 H8.3 Z"/><rect x="11" y="12.2" width="2" height="3.6" rx="1" fill="#0c1119"/><rect x="5.6" y="18.2" width="12.8" height="3.3" rx="0.8"/>',
  alfil: '<circle cx="12" cy="3.7" r="1.6"/><path d="M12 5.5 C8.2 8 7.2 11.4 8.5 13.9 C9.1 15 10.3 15.6 10.5 16.5 H13.5 C13.7 15.6 14.9 15 15.5 13.9 C16.8 11.4 15.8 8 12 5.5 Z"/><path d="M13.8 7.9 L10.4 12.3" stroke="#0c1119" stroke-width="1.6" stroke-linecap="round" fill="none"/><rect x="8.3" y="16.5" width="7.4" height="2" rx="1"/><path d="M6.4 21.5 C6.4 19.9 8.3 18.9 12 18.9 C15.7 18.9 17.6 19.9 17.6 21.5 Z"/>',
  caballo: '<path d="M6 21.4 C6.2 18 7.2 16.2 9.2 14.6 C8 14.6 6.4 14.9 4.6 14.7 C3.3 14.5 2.8 13.3 3.4 12.3 C4.4 10.6 6.4 8.6 7.8 6.3 L8 3.3 L9.9 4.8 C11.3 3.9 13.1 3.6 14.7 4.4 C18.4 6.4 19.7 11.6 18.9 16 C18.5 18.2 18.5 19.8 18.7 21.4 Z"/><circle cx="9.5" cy="8.7" r="0.95" fill="#0c1119"/><circle cx="4.6" cy="12.7" r="0.55" fill="#0c1119"/><path d="M13.4 6.4 C15.6 8.2 16.4 11.6 15.7 14.8" stroke="#0c1119" stroke-width="1" stroke-linecap="round" fill="none"/><path d="M11.4 7.4 C13 9.2 13.6 11.8 13 14.2" stroke="#0c1119" stroke-width="0.9" stroke-linecap="round" fill="none"/><rect x="5" y="19.9" width="14.4" height="2.2" rx="1"/>',
  peon: '<circle cx="12" cy="6.9" r="3.3"/><rect x="8.5" y="10.3" width="7" height="2" rx="1"/><path d="M9.6 12.3 H14.4 L16.3 19.2 H7.7 Z"/><rect x="6" y="19" width="12" height="2.5" rx="1.2"/>',
};

// Criaturas y tropas especiales (mismo lienzo 24x24). Los "ojos" usan el color
// del fondo del token para recortar la silueta.
Object.assign(UNIT_ICON_PATHS, {
  lobo: '<path d="M3.5 3.5 L9 8 H15 L20.5 3.5 L20 12.5 C20 16.6 16.4 19.8 12 21.4 C7.6 19.8 4 16.6 4 12.5 Z" fill="currentColor"/><path d="M7.4 12 L10.6 13 L8.4 14.5 Z" fill="#0c1119"/><path d="M16.6 12 L13.4 13 L15.6 14.5 Z" fill="#0c1119"/><path d="M10.4 17.3 H13.6 L12 19 Z" fill="#0c1119"/>',
  golem: '<rect x="8" y="3.5" width="8" height="6.5" rx="1.2" fill="currentColor"/><rect x="5" y="10.8" width="14" height="8" rx="1.2" fill="currentColor"/><rect x="2" y="11.4" width="3" height="7" rx="1" fill="currentColor"/><rect x="19" y="11.4" width="3" height="7" rx="1" fill="currentColor"/><rect x="9.4" y="6" width="1.7" height="1.7" fill="#0c1119"/><rect x="12.9" y="6" width="1.7" height="1.7" fill="#0c1119"/><rect x="6.5" y="19" width="4" height="2.2" fill="currentColor"/><rect x="13.5" y="19" width="4" height="2.2" fill="currentColor"/>',
  dragon: '<path d="M12 21 L8.2 15.6 L1.8 16.6 L5 10.4 L2.4 4.6 L9 7.6 L12 5 L15 7.6 L21.6 4.6 L19 10.4 L22.2 16.6 L15.8 15.6 Z" fill="currentColor"/><path d="M9.6 10.2 L11.2 11.2 L9.6 11.9 Z" fill="#0c1119"/><path d="M14.4 10.2 L12.8 11.2 L14.4 11.9 Z" fill="#0c1119"/>',
  hidra: '<path d="M12 20 V12.5 M12 20 C8 19 5.5 15 6 8.5 M12 20 C16 19 18.5 15 18 8.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="10.2" r="2.5" fill="currentColor"/><circle cx="6" cy="7" r="2.5" fill="currentColor"/><circle cx="18" cy="7" r="2.5" fill="currentColor"/><ellipse cx="12" cy="20.4" rx="5.2" ry="2" fill="currentColor"/><circle cx="11.2" cy="9.9" r="0.6" fill="#0c1119"/><circle cx="12.8" cy="9.9" r="0.6" fill="#0c1119"/>',
  fenix: '<path d="M12 14.4 C8 14.4 3.6 11.2 1.8 4.6 C6.8 6.4 10 7 12 10 C14 7 17.2 6.4 22.2 4.6 C20.4 11.2 16 14.4 12 14.4 Z" fill="currentColor"/><path d="M12 22.2 C9.2 19.4 9.2 17 12 14.6 C14.8 17 14.8 19.4 12 22.2 Z" fill="currentColor"/><circle cx="12" cy="8.2" r="2.2" fill="currentColor"/><path d="M12 3.2 L13 6 H11 Z" fill="currentColor"/>',
  grifo: '<path d="M12 2.2 C9.6 2.2 8.3 4.3 8.5 6.4 L4 5.4 L8.9 9.3 C9 10.6 9.8 11.6 11 12 L9.2 21.5 H10.8 L12 15.4 L13.2 21.5 H14.8 L13 12 C14.2 11.6 15 10.6 15.1 9.3 L20 5.4 L15.5 6.4 C15.7 4.3 14.4 2.2 12 2.2 Z" fill="currentColor"/><circle cx="10.4" cy="6.6" r="0.75" fill="#0c1119"/><path d="M8.8 8.2 L11.6 9" stroke="#0c1119" stroke-width="0.8" fill="none" stroke-linecap="round"/>',
  basilisco: '<path d="M4 20 C4 20 6 21 8 19 C10 17 8 15 10 13 C12 11 15 13 16 10 C17 7 14 6 15 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M13.2 2.6 L14.4 4.4 L15.6 2.6 L16.8 4.4 L18 2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><circle cx="15.6" cy="4.6" r="0.7" fill="#0c1119"/>',
  medusa: '<circle cx="12" cy="14" r="5" fill="currentColor"/><path d="M6 9 C5 6 6 3 4 2 M8 8 C7.5 5 8.5 2.5 7 1.5 M12 7.5 C12 4.5 12.5 2 11 1 M16 8 C16.5 5 15.5 2.5 17 1.5 M18 9 C19 6 18 3 20 2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10.2" cy="13.3" r="0.75" fill="#0c1119"/><circle cx="13.8" cy="13.3" r="0.75" fill="#0c1119"/><path d="M10.4 16.6 Q12 17.6 13.6 16.6" stroke="#0c1119" stroke-width="0.9" fill="none" stroke-linecap="round"/>',
});

// Icono propio del castillo (distinto al de la Torre): muralla con dos torreones,
// puerta en arco y un estandarte.
const CASTLE_ICON = '<rect x="2" y="8" width="6" height="12"/><rect x="16" y="8" width="6" height="12"/><rect x="7" y="11" width="10" height="9"/>'
  + '<rect x="2" y="6" width="2" height="2"/><rect x="6" y="6" width="2" height="2"/><rect x="16" y="6" width="2" height="2"/><rect x="20" y="6" width="2" height="2"/>'
  + '<rect x="9" y="9" width="2" height="2"/><rect x="13" y="9" width="2" height="2"/>'
  + '<path d="M12 2.5V9" stroke="currentColor" stroke-width="1" fill="none"/><path d="M12 2.6l4 1.6-4 1.6z"/>'
  + '<path d="M10.4 20v-4a1.6 1.6 0 0 1 3.2 0v4z" fill="#0c1119"/>'
  + '<rect x="4.3" y="11.5" width="1.4" height="3" fill="#0c1119"/><rect x="18.3" y="11.5" width="1.4" height="3" fill="#0c1119"/>';

function unitIconMarkup(type) {
  return UNIT_ICON_PATHS[type] || UNIT_ICON_PATHS.peon;
}

// Granja: establo con techo a dos aguas (el techo lleva el color del dueño) y
// puerta con cruz. En el tablero va sobre un campo de surcos; FARM_ICON es la
// versión de un solo color para el panel de jugadores.
function farmBarnMarkup(roofColor) {
  return '<path d="M5 13 L12 7.4 L19 13 V20.6 H5 Z" fill="#ece3c9"/>'
    + `<path d="M2.4 12.4 L12 4 L21.6 12.4 L19.9 14.2 L12 7.3 L4.1 14.2 Z" fill="${roofColor}" stroke="#0c1119" stroke-opacity="0.55" stroke-width="0.6" stroke-linejoin="round"/>`
    + '<rect x="9" y="13.4" width="6" height="7.2" fill="#0c1119"/>'
    + '<path d="M9.6 14 L14.4 20.2 M14.4 14 L9.6 20.2" stroke="#ece3c9" stroke-width="0.9" fill="none"/>'
    + '<rect x="11" y="9.7" width="2" height="1.8" fill="#0c1119"/>';
}
const FARM_ICON = '<path d="M2.4 12.4 L12 4 L21.6 12.4 L19.9 14.2 L12 7.3 L4.1 14.2 Z" fill="currentColor"/>'
  + '<path d="M5 13 L12 7.4 L19 13 V20.6 H5 Z" fill="currentColor"/>'
  + '<rect x="9.2" y="13.8" width="5.6" height="6.8" fill="#182231"/>';

// Empalizada (barrera): estacas puntiagudas de distinta altura, con una viga que las une.
const BARRIER_ICON = '<path d="M4 21 L4 9.5 L6 4.5 L8 9.5 L8 21 Z" fill="currentColor"/>'
  + '<path d="M10 21 L10 7 L12 2.3 L14 7 L14 21 Z" fill="currentColor"/>'
  + '<path d="M16 21 L16 9.5 L18 4.5 L20 9.5 L20 21 Z" fill="currentColor"/>'
  + '<rect x="3" y="12.3" width="18" height="2.3" fill="#0c1119" fill-opacity="0.55"/>';

// --- Estado local del cliente ---
let myId = null;
let currentState = null;
let selectedUnitId = null;
let selectedCastleId = null;
let inspectedUnitId = null; // ficha rival/propia ajena vista en el panel, sin seleccionarla
let inspectedCreatureId = null; // id de la criatura que se ve en el panel (null = ninguna)
let inspectedBarrierId = null; // id de la barrera (propia o rival) que se ve en el panel
const CASTLE_LEVEL_INFO = {
  1: { goldPerTurn: 3, militaryCapacity: 2, maxFarms: 2 },
  2: { goldPerTurn: 4, militaryCapacity: 3, maxFarms: 3 },
  3: { goldPerTurn: 5, militaryCapacity: 4, maxFarms: 4 },
};
let reachableTiles = [];
let dimAnimatedFor = null; // unitId para el que ya se animó el oscurecido del tablero
let nameEditTimer = null;
const TILE_SIZE = 40;

// Snapshots del render anterior, usados solo para animar lo que cambió.
let prevTileSig = null;      // Map "x,y" -> "type:owner"
let prevUnitPos = new Map(); // unitId -> "x,y"
let prevGold = new Map();    // playerId -> gold
let prevTurnPlayerId = null;
let prevRound = null;
let pendingFx = [];
const SVG_NS = 'http://www.w3.org/2000/svg';
const FLYING_TYPES = new Set(['dragon', 'fenix']);

// Fase continua de una animación CSS: evita que reinicie en cada re-render.
function phaseDelay(period, salt = 0) {
  return `${-(((performance.now() / 1000) + salt) % period).toFixed(2)}s`;
}
function svgEl(tag, attrs = {}, cls = '') {
  const el = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  if (cls) el.setAttribute('class', cls);
  return el;
}
function hpColor(ratio) {
  return ratio > 0.6 ? '#6fcf97' : ratio > 0.3 ? '#e5b93f' : '#e2685a';
}
function hpBar(cx, y, w, hp, maxHp) {
  const g = svgEl('g', {}, 'hp-bar');
  g.appendChild(svgEl('rect', { x: cx - w / 2, y, width: w, height: 3.2, rx: 1.6 }, 'hp-bar-bg'));
  const ratio = Math.max(0, Math.min(1, hp / maxHp));
  const fill = svgEl('rect', { x: cx - w / 2, y, width: Math.max(0.1, w * ratio), height: 3.2, rx: 1.6 }, 'hp-bar-fill');
  fill.setAttribute('fill', hpColor(ratio));
  g.appendChild(fill);
  return g;
}          // eventos de log a animar en el próximo render del tablero

// Colocación de granjas y barreras: al pedirla se resaltan las casillas de
// territorio propio disponibles y se espera el clic en una de ellas.
let placingFarm = false;
let buildableFarmTiles = [];
let pendingFarmCastleId = null;
let placingBarrier = false;
let buildableBarrierTiles = [];
let pendingBarrierCastleId = null;
let placingBarracks = false;
let pendingBarracks = false;
let buildableBarracksTiles = [];
let inspectedBarracksId = null; // cuartel (propio o rival) que se ve en el panel

function cancelFarmPlacement() {
  placingFarm = false;
  buildableFarmTiles = [];
  pendingFarmCastleId = null;
  placingBarrier = false;
  buildableBarrierTiles = [];
  pendingBarrierCastleId = null;
  placingBarracks = false;
  pendingBarracks = false;
  buildableBarracksTiles = [];
}

// --- Elementos: lobby ---
const lobbyScreen = document.getElementById('lobby-screen');
const createCard = document.getElementById('createCard');
const createStatus = document.getElementById('createStatus');
const roomCard = document.getElementById('roomCard');
const roomSubtitle = document.getElementById('roomSubtitle');
const myNameInput = document.getElementById('myNameInput');
const colorPicker = document.getElementById('colorPicker');
const roomPlayers = document.getElementById('roomPlayers');
const btnReady = document.getElementById('btnReady');
const btnStartGame = document.getElementById('btnStartGame');
const roomStatus = document.getElementById('roomStatus');

// --- Elementos: juego ---
const gameScreen = document.getElementById('game-screen');
const boardSvg = document.getElementById('board-svg');
const playersList = document.getElementById('playersList');
const turnIndicator = document.getElementById('turnIndicator');
const roundLabel = document.getElementById('roundLabel');
const selectionBox = document.getElementById('selectionBox');
const castleActions = document.getElementById('castleActions');
const produceGrid = document.getElementById('produceGrid');
const btnBuildFarm = document.getElementById('btnBuildFarm');
const btnBuildBarrier = document.getElementById('btnBuildBarrier');
// El botón del cuartel se crea a partir del de la barrera (no hace falta tocar index.html).
const btnBuildBarracks = btnBuildBarrier.cloneNode(true);
btnBuildBarracks.id = 'btnBuildBarracks';
btnBuildBarrier.after(btnBuildBarracks);
const btnUpgrade = document.getElementById('btnUpgrade');
const btnEndTurn = document.getElementById('btnEndTurn');
const toast = document.getElementById('toast');
const gameoverOverlay = document.getElementById('gameover-overlay');
const btnPlayAgain = document.getElementById('btnPlayAgain');
const btnBackToLobby = document.getElementById('btnBackToLobby');
const gameoverWaitStatus = document.getElementById('gameoverWaitStatus');
const turnBanner = document.getElementById('turnBanner');
const turnBannerDot = document.getElementById('turnBannerDot');
const turnBannerText = document.getElementById('turnBannerText');
const harvestBanner = document.getElementById('harvestBanner');
const eventBanner = document.getElementById('eventBanner');
const eventBannerDot = document.getElementById('eventBannerDot');
const eventBannerText = document.getElementById('eventBannerText');
const btnSurrender = document.getElementById('btnSurrender');
const btnEndGame = document.getElementById('btnEndGame');
const confirmOverlay = document.getElementById('confirm-overlay');
const confirmTitleEl = document.getElementById('confirmTitle');
const confirmBodyEl = document.getElementById('confirmBody');
const confirmOkBtn = document.getElementById('confirmOk');
const confirmCancelBtn = document.getElementById('confirmCancel');

// Modal de confirmación genérico: title/body descriptivos + callback si se confirma.
// Se usa antes de cualquier ataque, para que no se dispare un combate por error.
let confirmResolve = null;
function askConfirm(title, body) {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    confirmTitleEl.textContent = title;
    confirmBodyEl.textContent = body;
    confirmOverlay.classList.add('active');
  });
}
function closeConfirm(result) {
  confirmOverlay.classList.remove('active');
  if (confirmResolve) { confirmResolve(result); confirmResolve = null; }
}
confirmOkBtn.addEventListener('click', () => { SFX.play('ui_click'); closeConfirm(true); });
confirmCancelBtn.addEventListener('click', () => { SFX.play('deselect'); closeConfirm(false); });
confirmOverlay.addEventListener('click', (e) => { if (e.target === confirmOverlay) closeConfirm(false); });
const matchTimerEl = document.getElementById('matchTimer');
let matchElapsedBaseMs = null;
let matchElapsedBaseAt = null;

// ================= CONEXIÓN =================

socket.on('connect', () => {
  myId = socket.id;
  createStatus.textContent = 'Si sos la primera persona acá, definí el tamaño y creá la partida.';
});

socket.on('error:message', (msg) => {
  SFX.play('ui_error');
  showToast(msg);
  createStatus.innerHTML = `<span class="warn">${escapeHtml(msg)}</span>`;
  roomStatus.innerHTML = `<span class="warn">${escapeHtml(msg)}</span>`;
  if (currentState && currentState.phase === 'playing') {
    cancelFarmPlacement();
    renderBoard(currentState);
    renderSelection();
  }
});

document.getElementById('btnSetCount').addEventListener('click', () => {
  SFX.play('ui_click');
  const count = document.getElementById('playerCount').value;
  socket.emit('lobby:setPlayerCount', count);
});

// ================= ESTADO GENERAL =================

socket.on('state:update', (state) => {
  currentState = state;

  if (!state) {
    lobbyScreen.style.display = 'flex';
    gameScreen.classList.remove('active');
    createCard.style.display = 'block';
    roomCard.style.display = 'none';
    gameoverOverlay.classList.remove('active');
    return;
  }

  if (state.phase === 'lobby') {
    lobbyScreen.style.display = 'flex';
    gameScreen.classList.remove('active');
    createCard.style.display = 'none';
    roomCard.style.display = 'block';
    SFX.lobbyUpdate(state, myId);
    renderRoom(state);
    return;
  }

  // phase 'playing' o 'finished'
  lobbyScreen.style.display = 'none';
  gameScreen.classList.add('active');

  if (state.phase === 'playing' && prevRound !== null && state.round > prevRound) {
    showHarvestBanner();
    roundLabel.classList.remove('bump');
    void roundLabel.offsetWidth;
    roundLabel.classList.add('bump');
  }
  prevRound = state.round;

  // Si hay una ficha elegida, se recalculan sus casillas (tras atacar o mover
  // cambian: una ficha que ya atacó no puede caer sobre un rival).
  if (state.phase === 'playing' && selectedUnitId && state.turnOrder[state.currentTurnIndex] === myId) {
    const su = state.units.find((u) => u.id === selectedUnitId);
    if (su && su.type !== 'rey' && !su.movedThisTurn) socket.emit('action:getReachable', { unitId: selectedUnitId });
    else reachableTiles = [];
  }

  renderPlayers(state);
  renderWorldInfo(state);
  renderTurnInfo(state);
  updateExitButtons(state);
  maybeShowTurnBanner(state);
  renderBoard(state);
  renderSelection();
  if (state.phase === 'finished') renderGameoverStatus(state);
});

socket.on('game:started', () => {
  SFX.play('game_start');
  showToast('¡La partida ha comenzado!');
});

socket.on('action:log', (log) => {
  queueEventBanner(log);
  SFX.onLog(log);
  pendingFx.push(log);
  if (currentState) renderBoard(currentState);
});

socket.on('action:reachable', ({ unitId, tiles }) => {
  if (unitId !== selectedUnitId) return;
  reachableTiles = tiles;
  renderBoard(currentState);
});

socket.on('action:buildableFarmTiles', ({ tiles }) => {
  if (!pendingFarmCastleId) return;
  buildableFarmTiles = tiles;
  placingFarm = true;
  showToast('Elegí una casilla de tu territorio para la granja');
  renderBoard(currentState);
  renderSelection();
});

socket.on('action:buildableBarrierTiles', ({ tiles }) => {
  if (!pendingBarrierCastleId) return;
  buildableBarrierTiles = tiles;
  placingBarrier = true;
  showToast('Elegí una casilla de tu territorio para la barrera');
  renderBoard(currentState);
  renderSelection();
});

socket.on('action:buildableBarracksTiles', ({ tiles }) => {
  if (!pendingBarracks) return;
  buildableBarracksTiles = tiles;
  placingBarracks = true;
  showToast('Elegí una casilla de tu territorio para el cuartel');
  renderBoard(currentState);
  renderSelection();
});

socket.on('game:over', ({ winner, endedByLeader }) => {
  const title = document.getElementById('gameoverTitle');
  const subtitle = document.getElementById('gameoverSubtitle');
  if (endedByLeader) {
    title.textContent = 'Partida terminada';
    subtitle.textContent = 'El líder dio por terminada la partida.';
  } else if (winner === myId) {
    title.textContent = 'Victoria';
    subtitle.textContent = 'Tu reino se impuso sobre los demás.';
  } else if (winner) {
    const p = currentState.players.find((pl) => pl.id === winner);
    title.textContent = 'Derrota';
    subtitle.textContent = `${p ? p.name : 'Otro jugador'} conquistó el resto del tablero.`;
  } else {
    title.textContent = 'Partida terminada';
    subtitle.textContent = 'No quedaron reinos en pie.';
  }
  SFX.stopMusic();
  if (!endedByLeader) SFX.play(winner === myId ? 'victory' : 'defeat');
  gameoverOverlay.classList.add('active');
});

// Ninguno de los dos botones resetea nada por sí solo: cada uno le avisa al
// server su elección, y hasta que TODOS los jugadores conectados hayan
// elegido, el estado (y esta pantalla) siguen en pie. renderGameoverStatus
// se encarga de mostrar el aviso de espera correspondiente.
btnPlayAgain.addEventListener('click', () => {
  SFX.play('ui_click');
  socket.emit('game:playAgain');
});
btnBackToLobby.addEventListener('click', () => {
  SFX.play('ui_click');
  socket.emit('game:backToLobby');
});

function renderGameoverStatus(state) {
  const mine = state.postGameChoices ? state.postGameChoices[myId] : null;
  if (mine === 'again') {
    gameoverWaitStatus.textContent = 'Ya hay una partida en curso. Esperando a que el resto decida…';
  } else if (mine === 'lobby') {
    gameoverWaitStatus.textContent = 'Partida en curso. Esperando a que el resto decida…';
  } else {
    gameoverWaitStatus.textContent = '';
  }
  btnPlayAgain.disabled = !!mine;
  btnBackToLobby.disabled = !!mine;
}

// ================= SALA DE ESPERA =================

function renderRoom(state) {
  const me = state.players.find((p) => p.id === myId);
  const isLeader = state.leaderId === myId;

  roomSubtitle.textContent = `${state.players.length} / ${state.maxPlayers} jugadores en la sala`;

  // Nombre propio: no pisar mientras el usuario está tipeando.
  if (me && document.activeElement !== myNameInput) {
    myNameInput.value = me.name;
  }

  // Selector de color.
  colorPicker.innerHTML = '';
  const takenColors = new Set(state.players.filter((p) => p.id !== myId).map((p) => p.color));
  PLAYER_COLORS.forEach((color) => {
    const btn = document.createElement('button');
    btn.className = 'color-swatch' + (me && me.color === color ? ' selected' : '');
    btn.style.background = PLAYER_COLOR_HEX[color];
    btn.disabled = takenColors.has(color) && !(me && me.color === color);
    btn.title = color;
    btn.addEventListener('click', () => { SFX.play('ui_click'); socket.emit('lobby:setColor', color); });
    colorPicker.appendChild(btn);
  });

  // Lista de jugadores + cupos vacíos.
  roomPlayers.innerHTML = '';
  state.players.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'room-player-row';
    row.innerHTML = `
      <span class="swatch" style="background:${p.color ? PLAYER_COLOR_HEX[p.color] : '#333'}"></span>
      <span class="name">${escapeHtml(p.name)}${p.id === myId ? ' (vos)' : ''}</span>
      ${p.id === state.leaderId ? '<span class="leader-tag">Líder</span>' : ''}
      <span class="ready-tag ${p.ready ? 'is-ready' : ''}">${p.ready ? 'Listo ✓' : 'Esperando…'}</span>
    `;
    roomPlayers.appendChild(row);
  });
  for (let i = state.players.length; i < state.maxPlayers; i++) {
    const row = document.createElement('div');
    row.className = 'room-player-row';
    row.innerHTML = '<span class="swatch" style="background:#222"></span><span class="name empty-slot">Cupo libre…</span>';
    roomPlayers.appendChild(row);
  }

  // Botón "Listo".
  btnReady.textContent = me && me.ready ? 'Cancelar listo' : 'Estoy listo';
  btnReady.disabled = !me || !me.color;
  btnReady.onclick = () => { SFX.play(me && me.ready ? 'ready_off' : 'ready_on'); socket.emit('lobby:setReady', !(me && me.ready)); };

  // Botón de inicio, solo para el líder.
  if (isLeader) {
    const roomFull = state.players.length === state.maxPlayers;
    const allReady = state.players.every((p) => p.ready);
    btnStartGame.style.display = 'block';
    btnStartGame.disabled = !roomFull || !allReady;
    btnStartGame.textContent = !roomFull
      ? `Faltan jugadores (${state.players.length}/${state.maxPlayers})`
      : (!allReady ? 'Esperando a que todos estén listos' : 'Iniciar partida');
    btnStartGame.onclick = () => { SFX.play('ui_click'); socket.emit('lobby:startGame'); };
  } else {
    btnStartGame.style.display = 'none';
  }
}

myNameInput.addEventListener('input', () => {
  clearTimeout(nameEditTimer);
  nameEditTimer = setTimeout(() => {
    socket.emit('lobby:setName', myNameInput.value);
  }, 350);
});

myNameInput.addEventListener('blur', () => {
  socket.emit('lobby:setName', myNameInput.value);
});

// ================= RENDER: JUGADORES / TURNO (partida en curso) =================

// Chips de mejoras permanentes (por criaturas derrotadas) y tropas desbloqueadas.
function upgradeChipsHtml(state, p, isCurrent) {
  const up = p.upgrades;
  const chips = [];
  const ico = (type, color) => `<svg viewBox="0 0 24 24" fill="${color}" color="${color}">${unitIconMarkup(type)}</svg>`;
  if (up) {
    if (up.atkBonus > 0) chips.push(`<span class="up-chip" title="Lobo derrotado: +${up.atkBonus} ATQ a todas sus tropas">${ico('lobo', CREATURE_INFO.lobo.color)}+${up.atkBonus} ATQ</span>`);
    if (up.defBonus > 0) chips.push(`<span class="up-chip" title="Golem derrotado: +${up.defBonus} de defensa a todas sus tropas (reciben ${up.defBonus} menos de daño, mínimo 1)">${ico('golem', CREATURE_INFO.golem.color)}+${up.defBonus} DEF</span>`);
    if (up.poisonStrike) chips.push(`<span class="up-chip" title="Basilisco derrotado: sus golpes envenenan al rival que sobreviva (2 de daño por turno, 3 turnos)">${ico('basilisco', CREATURE_INFO.basilisco.color)}Veneno</span>`);
    if (up.hydraStrike) {
      const used = isCurrent && state.hydraUsedThisTurn;
      chips.push(`<span class="up-chip${used ? ' used' : ''}" title="Hidra derrotada: 1 vez por turno, una tropa que ya atacó puede atacar por segunda vez${used ? ' (ya usado este turno)' : ''}">${ico('hidra', CREATURE_INFO.hidra.color)}2º ataque${used ? ' ✓' : ''}</span>`);
    }
  }
  (p.unlockedUnits || []).forEach((t) => {
    chips.push(`<span class="up-chip" title="${label(t)} desbloqueado: ya lo puede producir en sus castillos (${UNIT_COSTS[t]} de oro)">${ico(t, '#ece3c9')}${label(t)}</span>`);
  });
  return chips.length ? `<div class="up-chips">${chips.join('')}</div>` : '';
}

function renderPlayers(state) {
  playersList.innerHTML = '';
  state.players.forEach((p) => {
    const castle = state.castles.find((c) => c.id === p.castleId);
    const isCurrent = state.turnOrder[state.currentTurnIndex] === p.id;
    const card = document.createElement('div');
    card.className = 'player-card' + (isCurrent ? ' current-turn' : '') + (!p.alive ? ' dead' : '');
    card.style.setProperty('--card-color', PLAYER_COLOR_HEX[p.color] || '#666');
    card.innerHTML = `
      <div class="name-row">
        <span class="swatch" style="background:${PLAYER_COLOR_HEX[p.color] || '#666'}"></span>
        <span>${escapeHtml(p.name)}${p.id === myId ? ' (vos)' : ''}</span>
        ${p.surrendered ? '<span class="surrender-tag">Rendido</span>' : ''}
      </div>
      <div class="stats">
        <span title="Oro"><svg class="stat-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/></svg> <b class="gold-value" data-player="${p.id}">${castleOrZero(p)}</b></span>
        <span title="Ingreso por ronda"><svg class="stat-icon" viewBox="0 0 24 24"><path d="M4 16 L9 10 L13 13 L20 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 5 H20 V10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg> <b>+${incomeOf(state, p.id)}</b></span>
        <span title="Nivel de castillo"><svg class="stat-icon" viewBox="0 0 24 24"><path d="M4 20 V10 L8 13 L12 7 L16 13 L20 10 V20 Z" fill="currentColor"/></svg> <b>${castle ? castle.level : '—'}</b></span>
        <span title="Granjas"><svg class="stat-icon" viewBox="0 0 24 24">${FARM_ICON}</svg> <b>${castle ? castle.farms : 0}</b></span>
      </div>
      ${upgradeChipsHtml(state, p, isCurrent)}
    `;
    playersList.appendChild(card);

    const goldEl = card.querySelector('.gold-value');
    animateGoldTo(goldEl, p.id, p.gold);
  });
}

// Panel "Mundo": criatura activa, clima activo y cuenta atrás de próximos eventos.
function renderWorldInfo(state) {
  const el = document.getElementById('worldInfo');
  if (!el) return;
  const creatures = creaturesOf(state);
  const maxCreatures = maxCreaturesFor(state.maxPlayers || state.players.length);
  const w = state.activeWeather;
  const nextIn = (state.turnCounter % 3 === 0) ? 3 : 3 - (state.turnCounter % 3);

  let html = '';
  creatures.forEach((c) => {
    const info = creatureInfo(c.type);
    html += `<div class="world-card" style="--wc:${info.color}">
      <div class="wc-head"><svg viewBox="0 0 24 24" fill="${info.color}" color="${info.color}">${unitIconMarkup(c.type)}</svg><b>${UNIT_LABELS[c.type] || c.type}</b><span class="wc-stats">${c.atk} ATQ · ${c.hp}/${c.maxHp}</span></div>
      <div class="sel-hpbar"><i style="width:${Math.round((c.hp / c.maxHp) * 100)}%; background:${hpColor(c.hp / c.maxHp)}"></i></div>
      <div class="wc-note">Botín: ${info.reward}. ${info.note}</div>
      ${c.despawnRound ? `<div class="wc-despawn">Se marcha en ${Math.max(0, c.despawnRound - state.round)} ronda(s)</div>` : ''}
    </div>`;
  });
  if (state.pendingCreatureSpawn) {
    const p = state.pendingCreatureSpawn;
    const info = creatureInfo(p.type);
    html += `<div class="world-card telegraph-card" style="--wc:${info.color}">
      <div class="wc-head"><svg viewBox="0 0 24 24" fill="${info.color}" color="${info.color}">${unitIconMarkup(p.type)}</svg><b>¿${label(p.type)}?</b><span class="wc-stats">se avista</span></div>
      <div class="wc-note">Aparece en ${pos({ x: p.x, y: p.y })} el próximo turno.</div>
    </div>`;
  } else if (creatures.length < maxCreatures) {
    html += `<div class="world-card muted"><div class="wc-note">${state.round < 5 ? 'Las criaturas aparecen desde la ronda 5.' : `Próxima criatura en ${nextIn} turno(s) (${creatures.length}/${maxCreatures} en el tablero).`}</div></div>`;
  }
  if (w) {
    const info = weatherInfo(w.type);
    const n = Array.isArray(w.cells) ? w.cells.length : 0;
    html += `<div class="world-card" style="--wc:${info.color}">
      <div class="wc-head"><b>${info.label}</b><span class="wc-stats">${w.turnsLeft} turno(s)</span></div>
      <div class="wc-note">Afecta ${n} casillas del tablero. ${info.note}</div>
    </div>`;
  } else {
    html += `<div class="world-card muted"><div class="wc-note">${state.round < 3 ? 'El clima cambia desde la ronda 3.' : `Próximo clima en ${nextIn} turno(s).`}</div></div>`;
  }
  el.innerHTML = html;
}

function castleOrZero(p) {
  return prevGold.has(p.id) ? prevGold.get(p.id) : p.gold;
}

// Anima el número de oro contando hacia el nuevo valor y lo resalta en
// verde (sube) o rojo (baja) un instante.
function animateGoldTo(el, playerId, newValue) {
  const from = prevGold.has(playerId) ? prevGold.get(playerId) : newValue;
  prevGold.set(playerId, newValue);

  if (from === newValue) {
    el.textContent = newValue;
    return;
  }
  const diffClass = newValue > from ? 'gold-up' : 'gold-down';
  el.classList.add(diffClass);
  const duration = 500;
  const start = performance.now();
  function step(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const value = Math.round(from + (newValue - from) * eased);
    el.textContent = value;
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      el.textContent = newValue;
      setTimeout(() => el.classList.remove(diffClass), 400);
    }
  }
  requestAnimationFrame(step);
}

// --- Temporizador de turno (45 s, lo controla el servidor) ---
let turnEndsAt = null;
let turnTimerMine = false;
let lastTickSecond = null;
setInterval(() => {
  const el = document.getElementById('turnTimer');
  if (!el || !turnEndsAt) return;
  const left = Math.max(0, Math.ceil((turnEndsAt - Date.now()) / 1000));
  el.textContent = `${left}s`;
  el.classList.toggle('warn', left <= 15 && left > 5);
  el.classList.toggle('urgent', left <= 5);
  if (turnTimerMine && left <= 5 && left > 0 && left !== lastTickSecond) { lastTickSecond = left; SFX.play('ui_click'); }
}, 250);

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
setInterval(() => {
  if (matchElapsedBaseMs == null || !matchTimerEl) { if (matchTimerEl) matchTimerEl.textContent = ''; return; }
  matchTimerEl.textContent = formatDuration(matchElapsedBaseMs + (Date.now() - matchElapsedBaseAt));
}, 1000);

function renderTurnInfo(state) {
  roundLabel.textContent = state.phase === 'playing' ? `Ronda ${state.round}` : '';
  if (state.phase === 'playing' && state.startedAt) {
    matchElapsedBaseMs = (state.serverNow || Date.now()) - state.startedAt;
    matchElapsedBaseAt = Date.now();
  } else {
    matchElapsedBaseMs = null;
  }
  const currentId = state.turnOrder[state.currentTurnIndex];
  const player = state.players.find((p) => p.id === currentId);
  if (!player || state.phase !== 'playing') {
    turnIndicator.innerHTML = '';
    turnIndicator.classList.remove('mine');
    btnEndTurn.disabled = true;
    return;
  }
  const mine = currentId === myId;
  turnEndsAt = state.turnDeadline ? Date.now() + (state.turnDeadline - (state.serverNow || Date.now())) : null;
  turnTimerMine = mine;
  turnIndicator.classList.toggle('mine', mine);
  turnIndicator.innerHTML = `<span class="dot" style="color:${PLAYER_COLOR_HEX[player.color]}; background:${PLAYER_COLOR_HEX[player.color]}"></span>${mine ? 'Tu turno' : `Turno de ${escapeHtml(player.name)}`}<span id="turnTimer" class="turn-timer">${turnEndsAt ? Math.max(0, Math.ceil((turnEndsAt - Date.now()) / 1000)) + 's' : ''}</span>`;
  btnEndTurn.disabled = !mine;
}

// Estandarte que se desliza al cambiar el turno actual.
function maybeShowTurnBanner(state) {
  if (state.phase !== 'playing') { prevTurnPlayerId = null; return; }
  const currentId = state.turnOrder[state.currentTurnIndex];
  if (currentId === prevTurnPlayerId) return;
  prevTurnPlayerId = currentId;

  const player = state.players.find((p) => p.id === currentId);
  if (!player) return;
  const color = PLAYER_COLOR_HEX[player.color] || '#d8ad5c';
  const mine = currentId === myId;
  SFX.play(mine ? 'turn_mine' : 'turn_other');

  turnBanner.style.setProperty('--banner-color', color);
  turnBannerDot.style.background = color;
  turnBannerText.textContent = mine ? 'Tu turno ha comenzado' : `Turno de ${player.name}`;

  turnBanner.classList.remove('show');
  // Forzar reflow para poder re-disparar la animación en turnos seguidos.
  void turnBanner.offsetWidth;
  turnBanner.classList.add('show');
  clearTimeout(maybeShowTurnBanner._t);
  maybeShowTurnBanner._t = setTimeout(() => turnBanner.classList.remove('show'), 1900);
}

// Estandarte central que marca el cierre de ronda y el cobro de oro.
function showHarvestBanner() {
  SFX.play('harvest');
  harvestBanner.classList.remove('show');
  void harvestBanner.offsetWidth;
  harvestBanner.classList.add('show');
  clearTimeout(showHarvestBanner._t);
  showHarvestBanner._t = setTimeout(() => harvestBanner.classList.remove('show'), 1700);
}

// Estandarte de acciones: cola de mensajes (movimientos, combates, capturas,
// clima, aparición de criaturas...) que se muestran uno tras otro con el
// mismo estilo que el estandarte de turno.
const eventBannerColors = {
  'log-combat': 'var(--ember-bright)',
  'log-capture': 'var(--gold-bright)',
  'log-economy': '#4c9160',
  'log-world': '#6fa8dc',
  'log-move': 'var(--panel-border)',
};
let eventBannerQueue = [];
let eventBannerBusy = false;

function queueEventBanner(log) {
  const text = describeLog(log);
  if (!text) return;
  const color = eventBannerColors[logClassFor(log.event)] || eventBannerColors['log-move'];
  eventBannerQueue.push({ text, color });
  if (!eventBannerBusy) showNextEventBanner();
}

function showNextEventBanner() {
  const next = eventBannerQueue.shift();
  if (!next) { eventBannerBusy = false; return; }
  eventBannerBusy = true;

  eventBanner.style.setProperty('--banner-color', next.color);
  eventBannerDot.style.background = next.color;
  eventBannerText.textContent = next.text;

  eventBanner.classList.remove('show');
  void eventBanner.offsetWidth;
  eventBanner.classList.add('show');

  clearTimeout(showNextEventBanner._t);
  showNextEventBanner._t = setTimeout(() => {
    eventBanner.classList.remove('show');
    clearTimeout(showNextEventBanner._t2);
    showNextEventBanner._t2 = setTimeout(showNextEventBanner, 350);
  }, 1450);
}

// ================= RENDER: TABLERO =================

function renderBoard(state) {
  const size = state.boardSize;
  const px = size * TILE_SIZE;
  boardSvg.setAttribute('viewBox', `0 0 ${px} ${px}`);
  boardSvg.setAttribute('width', px);
  boardSvg.setAttribute('height', px);
  boardSvg.innerHTML = '';

  const reachableSet = new Set(reachableTiles.map((t) => `${t.x},${t.y}`));
  const buildableFarmSet = new Set(buildableFarmTiles.map((t) => `${t.x},${t.y}`));
  const buildableBarrierSet = new Set(buildableBarrierTiles.map((t) => `${t.x},${t.y}`));
  const buildableBarracksSet = new Set(buildableBarracksTiles.map((t) => `${t.x},${t.y}`));
  const newTileSig = new Map();
  const claimedCells = [];

  // Casillas
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tile = state.tiles[y][x];
      const key = `${x},${y}`;
      if (tile.type === 'inaccessible') {
        newTileSig.set(key, 'void'); // hueco: no se dibuja, se ve el fondo del SVG
        continue;
      }
      const sig = `${tile.type}:${tile.owner || ''}`;
      newTileSig.set(key, sig);
      if (prevTileSig && prevTileSig.has(key) && prevTileSig.get(key) !== sig
        && (tile.type === 'territory' || tile.type === 'farm' || tile.type === 'barrier' || tile.type === 'castle')) {
        claimedCells.push({ x, y });
      }

      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', x * TILE_SIZE);
      rect.setAttribute('y', y * TILE_SIZE);
      rect.setAttribute('width', TILE_SIZE);
      rect.setAttribute('height', TILE_SIZE);

      const checker = (x + y) % 2 === 0 ? ' checker' : '';
      let cls = 'tile' + checker + ' ' + (tile.type === 'farm' ? 'farm' : (tile.type === 'barrier' ? 'barrier' : (tile.type === 'territory' ? 'territory' : 'neutral')));
      const isReachable = reachableSet.has(key);
      if (isReachable) cls += ' reachable';
      rect.setAttribute('class', cls);

      const ownerPlayer = tile.owner ? state.players.find((p) => p.id === tile.owner) : null;
      if (ownerPlayer && (tile.type === 'territory' || tile.type === 'barrier')) {
        // Inline style, no atributo: así le gana a las reglas .tile.* del CSS.
        // (La granja no se pinta del color del dueño: es un campo verde con su
        // marco y su techo de ese color; ver más abajo.)
        rect.style.fill = tile.type === 'barrier' ? shade(PLAYER_COLOR_HEX[ownerPlayer.color], 0.35) : PLAYER_COLOR_HEX[ownerPlayer.color];
      }
      if (isReachable) {
        rect.addEventListener('click', () => {
          const targetUnit = state.units.find((u) => u.x === x && u.y === y && u.owner !== myId);
          const doMove = () => {
            reachableTiles = [];
            socket.emit('action:move', { unitId: selectedUnitId, x, y });
          };
          if (targetUnit) {
            const mover = state.units.find((u) => u.id === selectedUnitId);
            const owner = state.players.find((p) => p.id === targetUnit.owner);
            askConfirm(
              `¿Atacar a ${label(targetUnit.type)} de ${owner ? owner.name : 'otro jugador'}?`,
              `Tu ${mover ? label(mover.type) : 'ficha'} golpea primero por ${mover ? previewHit(mover, targetUnit) : '?'} de daño. Tiene ${targetUnit.hp}/${targetUnit.maxHp} de vida; si sobrevive, contraataca por ${mover ? previewCounter(mover, targetUnit) : targetUnit.atk}.`
            ).then((ok) => { if (ok) doMove(); });
          } else {
            doMove();
          }
        });
      }

      const buildableSet = placingFarm ? buildableFarmSet : (placingBarrier ? buildableBarrierSet : (placingBarracks ? buildableBarracksSet : null));
      if (buildableSet && buildableSet.has(key)) {
        rect.classList.add('buildable');
        rect.addEventListener('click', () => {
          if (placingFarm) {
            socket.emit('action:buildFarm', { castleId: pendingFarmCastleId, x, y });
          } else if (placingBarracks) {
            socket.emit('action:buildBarracks', { x, y });
          } else {
            socket.emit('action:buildBarrier', { castleId: pendingBarrierCastleId, x, y });
          }
          cancelFarmPlacement();
        });
      }
      boardSvg.appendChild(rect);

      // Borde de acantilado en los lados que dan a un hueco.
      [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(([dx, dy], i) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) return;
        if (state.tiles[ny][nx].type !== 'inaccessible') return;
        const x0 = x * TILE_SIZE;
        const y0 = y * TILE_SIZE;
        const pts = [[x0, y0, x0 + TILE_SIZE, y0], [x0 + TILE_SIZE, y0, x0 + TILE_SIZE, y0 + TILE_SIZE],
          [x0, y0 + TILE_SIZE, x0 + TILE_SIZE, y0 + TILE_SIZE], [x0, y0, x0, y0 + TILE_SIZE]][i];
        boardSvg.appendChild(svgEl('line', { x1: pts[0], y1: pts[1], x2: pts[2], y2: pts[3] }, 'cliff-edge'));
      });

      if (tile.type === 'castle') {
        const castle = state.castles.find((c) => c.id === tile.occupantCastleId);
        const cx = x * TILE_SIZE + TILE_SIZE / 2;
        const cy = y * TILE_SIZE + TILE_SIZE / 2;
        const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ring.setAttribute('cx', cx);
        ring.setAttribute('cy', cy);
        ring.setAttribute('r', TILE_SIZE / 2 - 4);
        const cOwner = castle && castle.owner ? state.players.find((p) => p.id === castle.owner) : null;
        ring.setAttribute('class', 'castle-badge' + (cOwner ? '' : ' neutral'));
        if (cOwner) ring.setAttribute('stroke', PLAYER_COLOR_HEX[cOwner.color]);
        boardSvg.appendChild(ring);

        if (castle) {
          const tower = document.createElementNS('http://www.w3.org/2000/svg', 'g');
          tower.setAttribute('transform', `translate(${cx - 12}, ${cy - 12}) scale(1)`);
          tower.setAttribute('fill', cOwner ? PLAYER_COLOR_HEX[cOwner.color] : '#5a6b7d');
          tower.setAttribute('opacity', '0.9');
          tower.setAttribute('class', 'castle-icon' + (cOwner ? ' owned' : ''));
          tower.setAttribute('color', cOwner ? PLAYER_COLOR_HEX[cOwner.color] : '#5a6b7d');
          tower.innerHTML = CASTLE_ICON;
          boardSvg.appendChild(tower);
        }


        if (castle && cOwner && castle.owner === myId) {
          if (selectedCastleId === castle.id || (selectedUnitId && (state.units.find((u) => u.id === selectedUnitId) || {}).castleId === castle.id)) {
            boardSvg.appendChild(svgEl('circle', { cx, cy, r: TILE_SIZE / 2 - 1 }, 'castle-selected-ring'));
          }
          const chit = svgEl('circle', { cx, cy, r: TILE_SIZE / 2 - 3 }, 'unit-hit castle-hit mine');
          chit.addEventListener('click', () => {
            // Con una ficha elegida que puede llegar a este castillo, el clic la
            // MUEVE ahí (guarnecer) en vez de abrir el panel del castillo.
            if (selectedUnitId && reachableSet.has(key)) {
              reachableTiles = [];
              socket.emit('action:move', { unitId: selectedUnitId, x, y });
            } else {
              selectCastle(castle.id);
            }
          });
          boardSvg.appendChild(chit);
        }

        if (castle && castle.level > 1) {
          const lvl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          lvl.setAttribute('x', cx + TILE_SIZE / 2 - 6);
          lvl.setAttribute('y', y * TILE_SIZE + 9);
          lvl.setAttribute('font-size', '9');
          lvl.setAttribute('font-family', 'var(--font-display)');
          lvl.setAttribute('fill', '#d8ad5c');
          lvl.textContent = castle.level;
          boardSvg.appendChild(lvl);
        }
      }
      if (tile.type === 'farm') {
        const fx0 = x * TILE_SIZE;
        const fy0 = y * TILE_SIZE;
        const fcx = fx0 + TILE_SIZE / 2;
        const fcy = fy0 + TILE_SIZE / 2;
        const farmColor = ownerPlayer ? PLAYER_COLOR_HEX[ownerPlayer.color] : '#888888';

        // Campo sembrado: filas discontinuas de cultivo.
        [0.2, 0.4, 0.6, 0.8].forEach((f) => {
          boardSvg.appendChild(svgEl('line', {
            x1: fx0 + 3, y1: fy0 + TILE_SIZE * f, x2: fx0 + TILE_SIZE - 3, y2: fy0 + TILE_SIZE * f,
          }, 'farm-row'));
        });

        // Marco del color del dueño (así se ve de quién es la granja).
        const farmFrame = svgEl('rect', { x: fx0 + 1.5, y: fy0 + 1.5, width: TILE_SIZE - 3, height: TILE_SIZE - 3 }, 'farm-frame');
        farmFrame.setAttribute('stroke', farmColor);
        boardSvg.appendChild(farmFrame);

        // Establo con el techo del color del dueño.
        const barnScale = 1.08;
        const farmIcon = svgEl('g', { transform: `translate(${fcx - 12 * barnScale}, ${fcy - 12.3 * barnScale}) scale(${barnScale})` }, 'farm-icon');
        farmIcon.innerHTML = farmBarnMarkup(farmColor);
        boardSvg.appendChild(farmIcon);

        // Etiqueta de ingreso arriba a la derecha.
        boardSvg.appendChild(svgEl('rect', { x: fx0 + TILE_SIZE - 16, y: fy0 + 3, width: 13, height: 8.5, rx: 4.2 }, 'farm-pill'));
        const farmTag = svgEl('text', { x: fx0 + TILE_SIZE - 9.5, y: fy0 + 9.3, 'text-anchor': 'middle' }, 'farm-tag');
        farmTag.textContent = `+${ownerPlayer ? playerFarmIncome(state, ownerPlayer.id) : FARM_INCOME_CLIENT}`;
        boardSvg.appendChild(farmTag);
      }
      if (tile.type === 'barracks') {
        const bx0 = x * TILE_SIZE;
        const by0 = y * TILE_SIZE;
        const bcx0 = bx0 + TILE_SIZE / 2;
        const bcy0 = by0 + TILE_SIZE / 2;
        const bColor = ownerPlayer ? PLAYER_COLOR_HEX[ownerPlayer.color] : '#888888';
        const barracksObj = (state.barracks || []).find((b) => b.x === x && b.y === y);

        [0.25, 0.5, 0.75].forEach((f) => {
          boardSvg.appendChild(svgEl('line', { x1: bx0 + 2, y1: by0 + TILE_SIZE * f, x2: bx0 + TILE_SIZE - 2, y2: by0 + TILE_SIZE * f }, 'barracks-row'));
        });
        const bFrame = svgEl('rect', { x: bx0 + 1.5, y: by0 + 1.5, width: TILE_SIZE - 3, height: TILE_SIZE - 3 }, 'farm-frame');
        bFrame.setAttribute('stroke', bColor);
        boardSvg.appendChild(bFrame);

        const bScale = 1.1;
        const bIcon = svgEl('g', { transform: `translate(${bcx0 - 12 * bScale}, ${bcy0 - 11.8 * bScale}) scale(${bScale})` }, 'farm-icon');
        bIcon.innerHTML = barracksMarkup(bColor);
        boardSvg.appendChild(bIcon);

        if (barracksObj) {
          const stars = barracksObj.farmsTier + barracksObj.wallsTier + barracksObj.discountTier;
          if (stars > 0) {
            boardSvg.appendChild(svgEl('rect', { x: bx0 + TILE_SIZE - 16, y: by0 + 3, width: 13, height: 8.5, rx: 4.2 }, 'farm-pill'));
            const sTag = svgEl('text', { x: bx0 + TILE_SIZE - 9.5, y: by0 + 9.3, 'text-anchor': 'middle' }, 'farm-tag');
            sTag.textContent = `★${stars}`;
            boardSvg.appendChild(sTag);
          }
          const barHit = svgEl('circle', { cx: bcx0, cy: bcy0, r: TILE_SIZE / 2 - 3 }, 'unit-hit');
          barHit.addEventListener('click', () => {
            // Con una ficha elegida que puede llegar aquí, el clic la mueve (captura si es rival).
            if (selectedUnitId && reachableSet.has(key)) {
              reachableTiles = [];
              socket.emit('action:move', { unitId: selectedUnitId, x, y });
            } else {
              inspectBarracks(barracksObj.id);
            }
          });
          boardSvg.appendChild(barHit);
        }
      }

      if (tile.type === 'barrier') {
        const barrier = barrierAt(state, x, y);
        const bcx = x * TILE_SIZE + TILE_SIZE / 2;
        const bcy = y * TILE_SIZE + TILE_SIZE / 2;

        // Textura de veta de madera: unas líneas verticales tenues.
        [0.22, 0.5, 0.78].forEach((f) => {
          const grain = svgEl('line', {
            x1: x * TILE_SIZE + TILE_SIZE * f, y1: y * TILE_SIZE + 3,
            x2: x * TILE_SIZE + TILE_SIZE * f, y2: y * TILE_SIZE + TILE_SIZE - 3,
          }, 'barrier-grain');
          boardSvg.appendChild(grain);
        });

        const barrierBadge = svgEl('circle', { cx: bcx, cy: bcy, r: TILE_SIZE / 2 - 8 }, 'barrier-badge');
        barrierBadge.setAttribute('stroke', ownerPlayer ? PLAYER_COLOR_HEX[ownerPlayer.color] : '#888');
        boardSvg.appendChild(barrierBadge);

        const barrierIcon = svgEl('g', { transform: `translate(${bcx - 11}, ${bcy - 11}) scale(0.92)`, fill: '#ece3c9', color: '#ece3c9' }, 'barrier-icon');
        barrierIcon.innerHTML = BARRIER_ICON;
        boardSvg.appendChild(barrierIcon);

        if (barrier) {
          const barrierTag = svgEl('text', { x: bcx, y: y * TILE_SIZE + 9, 'text-anchor': 'middle' }, 'barrier-tag');
          barrierTag.textContent = `Nv ${barrier.level}`;
          boardSvg.appendChild(barrierTag);
          boardSvg.appendChild(hpBar(bcx, bcy + TILE_SIZE / 2 - 5, 24, barrier.hp, barrier.maxHp));

          const selUnitForBarrierAttack = selectedUnitId ? state.units.find((u) => u.id === selectedUnitId) : null;
          const barrierAttackable = canAttackBarrierWith(selUnitForBarrierAttack, barrier, state);
          const bHit = svgEl('circle', { cx: bcx, cy: bcy, r: TILE_SIZE / 2 - 2 }, 'unit-hit' + (barrierAttackable ? ' attackable-enemy' : ''));
          bHit.addEventListener('click', () => {
            if (barrierAttackable) attackBarrierWith(selUnitForBarrierAttack.id, barrier.id);
            else inspectBarrier(barrier.id);
          });
          boardSvg.appendChild(bHit);
        }
      }
    }
  }

  // Cofres del tesoro
  (state.chests || []).forEach((ch) => {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'chest-badge');
    g.setAttribute('transform', `translate(${ch.x * TILE_SIZE + TILE_SIZE / 2 - 12}, ${ch.y * TILE_SIZE + TILE_SIZE / 2 - 11})`);
    g.innerHTML = '<rect x="2" y="9" width="20" height="12" rx="1.5" fill="#8a5a2b" stroke="#3b2410" stroke-width="1.2"/>'
      + '<path d="M2 10a10 7 0 0 1 20 0z" fill="#b57a3a" stroke="#3b2410" stroke-width="1.2"/>'
      + '<rect x="2" y="12" width="20" height="2.2" fill="#e5b93f"/><rect x="10" y="10.5" width="4" height="6" rx="0.8" fill="#f0c877" stroke="#3b2410" stroke-width="0.8"/>'
      + '<circle cx="12" cy="13.4" r="0.9" fill="#3b2410"/>';
    boardSvg.appendChild(g);
  });

  // Aviso de próxima criatura: marca la casilla telegrafiada un turno antes.
  if (state.pendingCreatureSpawn) {
    const p = state.pendingCreatureSpawn;
    const info = creatureInfo(p.type);
    const pcx = p.x * TILE_SIZE + TILE_SIZE / 2;
    const pcy = p.y * TILE_SIZE + TILE_SIZE / 2;
    const warnRing = svgEl('circle', { cx: pcx, cy: pcy, r: TILE_SIZE / 2 - 3 }, 'telegraph-ring');
    warnRing.style.setProperty('--tg-color', info.color);
    boardSvg.appendChild(warnRing);
    const ghostIcon = svgEl('g', { transform: `translate(${pcx - 12}, ${pcy - 12})`, fill: info.color, color: info.color }, 'telegraph-icon');
    ghostIcon.innerHTML = unitIconMarkup(p.type);
    boardSvg.appendChild(ghostIcon);
  }

  renderWeather(state);

  // Fichas
  const unitsByTile = new Map();
  state.units.forEach((u) => {
    const k = `${u.x},${u.y}`;
    if (!unitsByTile.has(k)) unitsByTile.set(k, []);
    unitsByTile.get(k).push(u);
  });

  state.units.forEach((unit) => {
    // Si hay más de una ficha propia en la misma casilla (guarnición), se
    // separan en abanico para que cada una sea clickeable por separado.
    const stackMates = unitsByTile.get(`${unit.x},${unit.y}`);
    const stackSize = stackMates.length;
    const stackIdx = stackMates.indexOf(unit);
    const s = stackSize > 1 ? 0.62 : 1;
    let ox = 0, oy = 0;
    if (stackSize > 1) {
      const angle = (2 * Math.PI * stackIdx) / stackSize - Math.PI / 2;
      ox = Math.cos(angle) * TILE_SIZE * 0.22;
      oy = Math.sin(angle) * TILE_SIZE * 0.22;
    }
    const cx = unit.x * TILE_SIZE + TILE_SIZE / 2 + ox;
    const cy = unit.y * TILE_SIZE + TILE_SIZE / 2 + oy;
    const owner = state.players.find((p) => p.id === unit.owner);
    const isMine = unit.owner === myId;
    const canMove = isMine && unit.type !== 'rey' && !unit.movedThisTurn && !isInQuake(state, unit) && state.turnOrder[state.currentTurnIndex] === myId;
    const selUnitForAttack = selectedUnitId ? state.units.find((u) => u.id === selectedUnitId) : null;
    const isAttackable = !isMine && canAttackUnitWith(selUnitForAttack, unit, state);

    if (unit.id === selectedUnitId) {
      const selRing = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      selRing.setAttribute('cx', cx);
      selRing.setAttribute('cy', cy);
      selRing.setAttribute('r', TILE_SIZE / 2 - 2);
      selRing.setAttribute('class', 'unit-hit selected-ring');
      boardSvg.appendChild(selRing);
    }

    const posKey = `${unit.x},${unit.y}`;
    const justMoved = prevUnitPos.has(unit.id) && prevUnitPos.get(unit.id) !== posKey;
    prevUnitPos.set(unit.id, posKey);

    const badge = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    badge.setAttribute('cx', cx);
    badge.setAttribute('cy', cy);
    badge.setAttribute('r', (TILE_SIZE / 2 - 6) * s);
    badge.setAttribute('class', 'unit-badge' + (justMoved ? ' landed' : '') + (unit.type === 'fenix' ? ' phoenix' : (unit.type === 'dragon' ? ' dragon' : '')) + (isAttackable ? ' attackable-enemy' : ''));
    if (unit.type === 'fenix') badge.style.animationDelay = phaseDelay(2.4);
    badge.setAttribute('stroke', owner ? PLAYER_COLOR_HEX[owner.color] : '#888');
    boardSvg.appendChild(badge);

    const iconGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    iconGroup.setAttribute('class', 'unit-icon-group');
    iconGroup.setAttribute('transform', `translate(${cx - 12 * s}, ${cy - 12 * s}) scale(${s})`);
    iconGroup.setAttribute('fill', '#ece3c9');
    iconGroup.setAttribute('color', '#ece3c9');
    iconGroup.innerHTML = unitIconMarkup(unit.type);
    boardSvg.appendChild(iconGroup);

    if (unit.maxHp) boardSvg.appendChild(hpBar(cx, cy + TILE_SIZE / 2 - 5, 24, unit.hp, unit.maxHp));
    if (FLYING_TYPES.has(unit.type)) {
      const wing = svgEl('circle', { cx, cy, r: TILE_SIZE / 2 - 3 }, 'fly-ring');
      boardSvg.appendChild(wing);
    }

    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    hit.setAttribute('cx', cx);
    hit.setAttribute('cy', cy);
    hit.setAttribute('r', (TILE_SIZE / 2 - 2) * s);
    hit.setAttribute('class', 'unit-hit' + (isMine ? ' mine' : '') + (canMove ? ' movable' : '') + (isAttackable ? ' attackable-enemy' : ''));
    hit.addEventListener('click', () => handleUnitClick(unit.id));
    boardSvg.appendChild(hit);
  });

  renderCreature(state);

  // Al elegir una ficha con movimientos posibles, el resto del tablero se
  // oscurece: solo quedan a la vista las casillas alcanzables, las fichas
  // enemigas, las granjas y las barreras (más la ficha elegida). Es una capa
  // con "huecos" (evenodd) dibujada AL FINAL para cubrir también fichas,
  // castillos y criaturas; no captura clics (pointer-events: none).
  // Objetivos adyacentes que la ficha elegida puede atacar ahora mismo (antes
  // o después de moverse): fichas rivales, criaturas y barreras. Se marcan en
  // rojo y quedan visibles aunque el resto se oscurezca.
  const attackSel = selectedUnitId ? state.units.find((u) => u.id === selectedUnitId) : null;
  const attackTargets = [];
  if (attackSel && attackSel.owner === myId) {
    state.units.forEach((u) => { if (canAttackUnitWith(attackSel, u, state)) attackTargets.push(u); });
    creaturesOf(state).forEach((c) => { if (canAttackCreatureWith(attackSel, state, c)) attackTargets.push(c); });
    (state.barriers || []).forEach((b) => { if (canAttackBarrierWith(attackSel, b, state)) attackTargets.push(b); });
  }

  if (selectedUnitId && reachableTiles.length > 0) {
    const visible = new Set(reachableSet);
    attackTargets.forEach((t) => visible.add(`${t.x},${t.y}`));
    state.units.forEach((u) => { if (u.owner !== myId || u.id === selectedUnitId) visible.add(`${u.x},${u.y}`); });
    state.farms.forEach((f) => visible.add(`${f.x},${f.y}`));
    (state.barriers || []).forEach((b) => visible.add(`${b.x},${b.y}`));

    let d = `M0 0H${px}V${px}H0Z`;
    visible.forEach((k) => {
      const [vx, vy] = k.split(',').map(Number);
      d += `M${vx * TILE_SIZE} ${vy * TILE_SIZE}h${TILE_SIZE}v${TILE_SIZE}h${-TILE_SIZE}Z`;
    });
    const dim = svgEl('path', { d, 'fill-rule': 'evenodd' }, 'move-dim' + (dimAnimatedFor !== selectedUnitId ? ' fresh' : ''));
    boardSvg.appendChild(dim);
    dimAnimatedFor = selectedUnitId;

    // Marco amarillo grueso sobre cada casilla alcanzable (dentro de la casilla,
    // para que el oscurecido de las vecinas no se lo coma).
    reachableTiles.forEach((t) => {
      boardSvg.appendChild(svgEl('rect', {
        x: t.x * TILE_SIZE + 1.5, y: t.y * TILE_SIZE + 1.5, width: TILE_SIZE - 3, height: TILE_SIZE - 3,
      }, 'reach-frame'));
    });
  } else {
    dimAnimatedFor = null;
  }
  attackTargets.forEach((t) => {
    boardSvg.appendChild(svgEl('rect', {
      x: t.x * TILE_SIZE + 1.5, y: t.y * TILE_SIZE + 1.5, width: TILE_SIZE - 3, height: TILE_SIZE - 3,
    }, 'attack-frame'));
  });

  // Destellos de territorio recién reclamado.
  claimedCells.forEach(({ x, y }) => spawnTileFx(x, y, 'tile-claim-fx'));

  // Destellos de combate/conquista a partir de eventos de log pendientes.
  const combatEvents = new Set([
    'attackerWinsCastle', 'defenderWinsCastle', 'fieldCombatAttackerWins', 'fieldCombatDefenderWins',
    'fieldCombatStandoff', 'castleStandoff', 'castleDefenderKilled', 'weatherKill',
    'creatureSurvived', 'attackerLostToCreature', 'attackerRevived', 'creatureDefeated', 'creatureUnlocked',
    'attackUnitKilled', 'attackUnitHit', 'barrierDamaged', 'barrierDestroyed', 'attackerLostToBarrier',
  ]);
  pendingFx.forEach((log) => {
    if (log.to && combatEvents.has(log.event)) spawnTileFx(log.to.x, log.to.y, 'combat-fx');
    if (log.to && log.event === 'phoenixRevived') spawnTileFx(log.to.x, log.to.y, 'revive-fx');
    if (log.to && log.event === 'creatureSpawned') spawnTileFx(log.to.x, log.to.y, 'spawn-fx');
    if (log.to && log.dealt) spawnFloat(log.to.x, log.to.y, `-${log.dealt}`, 'float-dmg');
    if (log.counter) {
      let at = log.from;
      if (log.type === 'attackCreature' || log.type === 'attackBarrier') {
        const u = state.units.find((uu) => uu.id === log.unitId);
        at = u ? { x: u.x, y: u.y } : null;
      }
      if (at) spawnFloat(at.x, at.y, `-${log.counter}`, 'float-dmg counter');
    }
    if (log.goldReward) spawnFloat(log.to.x, log.to.y, `+${log.goldReward}`, 'float-gold');
  });
  pendingFx = [];

  prevTileSig = newTileSig;
}

function spawnTileFx(x, y, className) {
  const cx = x * TILE_SIZE + TILE_SIZE / 2;
  const cy = y * TILE_SIZE + TILE_SIZE / 2;
  const fx = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  fx.setAttribute('x', x * TILE_SIZE + 2);
  fx.setAttribute('y', y * TILE_SIZE + 2);
  fx.setAttribute('width', TILE_SIZE - 4);
  fx.setAttribute('height', TILE_SIZE - 4);
  fx.setAttribute('class', className);
  fx.style.transformBox = 'fill-box';
  boardSvg.appendChild(fx);
  setTimeout(() => fx.remove(), 750);
}

function spawnFloat(x, y, text, cls) {
  const t = svgEl('text', { x: x * TILE_SIZE + TILE_SIZE / 2, y: y * TILE_SIZE + 12, 'text-anchor': 'middle' }, cls);
  t.textContent = text;
  boardSvg.appendChild(t);
  setTimeout(() => t.remove(), 1100);
}

// Zona de clima (9 casillas de forma variable): velo de color por casilla
// accesible + efecto propio de cada tipo + contorno solo por fuera de la zona.
function renderWeather(state) {
  const w = state.activeWeather;
  if (!w || !Array.isArray(w.cells)) return;
  const info = weatherInfo(w.type);
  const g = svgEl('g', {}, `weather weather-${w.type}`);
  g.style.pointerEvents = 'none';
  const T = TILE_SIZE;
  const inZone = new Set(w.cells.map((c) => `${c.x},${c.y}`));

  w.cells.forEach(({ x, y }) => {
    const tile = state.tiles[y] && state.tiles[y][x];
    if (!tile || tile.type === 'inaccessible') return;
    const px = x * T;
    const py = y * T;
    const veil = svgEl('rect', { x: px, y: py, width: T, height: T }, 'weather-veil');
    veil.setAttribute('fill', info.color);
    g.appendChild(veil);
    const seed = x * 7 + y * 13;

    if (w.type === 'nieve') {
      for (let i = 0; i < 4; i++) {
        const fx = px + 5 + ((seed + i * 9) % (T - 10));
        const flake = svgEl('circle', { cx: fx, cy: py + 2, r: 1.4 + (i % 2) * 0.6 }, 'snow-flake');
        flake.style.animationDuration = `${2 + (i % 3) * 0.6}s`;
        flake.style.animationDelay = phaseDelay(2.6, i + seed);
        g.appendChild(flake);
      }
    } else if (w.type === 'arena') {
      for (let i = 0; i < 3; i++) {
        const ly = py + 8 + ((seed + i * 11) % (T - 16));
        const streak = svgEl('line', { x1: px + 2, y1: ly, x2: px + 14, y2: ly }, 'sand-streak');
        streak.style.animationDuration = `${1.6 + i * 0.3}s`;
        streak.style.animationDelay = phaseDelay(2, i + seed);
        g.appendChild(streak);
      }
    } else if (w.type === 'meteoros') {
      if ((x * 3 + y) % 2 === 0) {
        const tail = svgEl('line', { x1: px + 26, y1: py + 6, x2: px + 32, y2: py - 4 }, 'meteor-tail');
        tail.style.animationDelay = phaseDelay(2.2, seed);
        g.appendChild(tail);
        const rock = svgEl('circle', { cx: px + 26, cy: py + 6, r: 3 }, 'meteor-rock');
        rock.style.animationDelay = phaseDelay(2.2, seed);
        g.appendChild(rock);
      }
    } else if (w.type === 'cosecha') {
      for (let i = 0; i < 2; i++) {
        const sx = px + 10 + i * 16 + (seed % 4);
        const stalk = svgEl('path', { d: `M${sx} ${py + T - 4} q2 -8 0 -16 m0 4 l-3 -3 m3 6 l3 -3 m-3 -1 l-3 -3` }, 'harvest-stalk');
        stalk.style.animationDelay = phaseDelay(2.6, seed + i * 3);
        g.appendChild(stalk);
      }
    } else if (w.type === 'niebla') {
      for (let i = 0; i < 2; i++) {
        const puff = svgEl('ellipse', {
          cx: px + 10 + ((seed + i * 7) % 20), cy: py + 12 + i * 15, rx: 12, ry: 6,
        }, 'fog-puff');
        puff.style.animationDuration = `${4 + i * 1.3}s`;
        puff.style.animationDelay = phaseDelay(5, i + seed);
        g.appendChild(puff);
      }
    } else if (w.type === 'lluvia') {
      for (let i = 0; i < 3; i++) {
        const dx = px + 6 + ((seed + i * 11) % (T - 12));
        const drop = svgEl('path', { d: `M${dx} ${py} q3 5 0 8 q-3 -3 0 -8 Z` }, 'rain-drop');
        drop.style.animationDuration = `${1.5 + i * 0.4}s`;
        drop.style.animationDelay = phaseDelay(2, i + seed);
        g.appendChild(drop);
      }
      const plus = svgEl('path', { d: `M${px + T - 12} ${py + T - 9} h6 M${px + T - 9} ${py + T - 12} v6` }, 'heal-plus');
      plus.style.animationDelay = phaseDelay(2.2, seed);
      g.appendChild(plus);
    } else if (w.type === 'eclipse') {
      const disc = svgEl('circle', { cx: px + T / 2, cy: py + T / 2, r: 9 }, 'eclipse-disc');
      disc.style.animationDelay = phaseDelay(3, seed);
      g.appendChild(disc);
      g.appendChild(svgEl('circle', { cx: px + T / 2, cy: py + T / 2, r: 12 }, 'eclipse-corona'));
    } else if (w.type === 'aurora') {
      for (let i = 0; i < 2; i++) {
        const rib = svgEl('path', { d: `M${px + 2} ${py + 10 + i * 14} q9 -8 18 0 t18 0` }, 'aurora-ribbon');
        rib.style.animationDelay = phaseDelay(3.4, seed + i * 5);
        g.appendChild(rib);
      }
      const spark = svgEl('circle', { cx: px + 8 + (seed % 22), cy: py + 8 + ((seed * 3) % 22), r: 1.6 }, 'aurora-spark');
      spark.style.animationDelay = phaseDelay(1.8, seed);
      g.appendChild(spark);
    } else if (w.type === 'terremoto') {
      const crack = svgEl('path', {
        d: `M${px + 6} ${py + 8} L${px + 16} ${py + 17} L${px + 11} ${py + 23} L${px + 24} ${py + 33}`,
      }, 'quake-crack');
      crack.style.animationDelay = phaseDelay(1.2, seed);
      g.appendChild(crack);
    } else if ((x + y) % 2 === 0) {
      const bolt = svgEl('path', { d: `M${px + 22} ${py + 4} L${px + 15} ${py + 21} L${px + 21} ${py + 21} L${px + 16} ${py + 36}` }, 'bolt');
      bolt.style.animationDelay = phaseDelay(1.4, seed);
      g.appendChild(bolt);
    }
  });

  // Contorno: solo los bordes que dan hacia fuera de la zona.
  w.cells.forEach(({ x, y }) => {
    const px = x * T;
    const py = y * T;
    const edges = [
      [0, -1, px, py, px + T, py],
      [0, 1, px, py + T, px + T, py + T],
      [-1, 0, px, py, px, py + T],
      [1, 0, px + T, py, px + T, py + T],
    ];
    edges.forEach(([dx, dy, x1, y1, x2, y2]) => {
      if (inZone.has(`${x + dx},${y + dy}`)) return;
      const line = svgEl('line', { x1, y1, x2, y2 }, 'weather-frame');
      line.setAttribute('stroke', info.color);
      g.appendChild(line);
    });
  });
  boardSvg.appendChild(g);
}

// Ataque a una criatura concreta: la ficha propia debe estar adyacente.
function canAttackCreatureWith(unit, state, c) {
  if (!c || !unit) return false;
  const isMyTurn = state.turnOrder[state.currentTurnIndex] === myId;
  const dx = Math.abs(unit.x - c.x);
  const dy = Math.abs(unit.y - c.y);
  return isMyTurn && unit.owner === myId && unit.type !== 'rey' && canStrike(unit, state)
    && dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
}

async function attackCreatureWith(unitId, creatureId) {
  const unit = currentState.units.find((u) => u.id === unitId);
  const creature = creaturesOf(currentState).find((c) => c.id === creatureId);
  if (!unit || !creature) return;
  const ok = await askConfirm(
    `¿Atacar a ${label(creature.type)}?`,
    `Tu ${label(unit.type)} golpea primero por ${previewHit(unit, creature)} de daño. Tiene ${creature.hp}/${creature.maxHp} de vida; si sobrevive, contraataca por ${previewCounter(unit, creature)}.${hydraAvailableFor(unit) && unit.attackedThisTurn ? ' (Usa el 2º ataque de la Hidra de este turno.)' : ''}`
  );
  if (!ok) return;
  socket.emit('action:attackCreature', { unitId, creatureId });
}

function renderCreature(state) {
  creaturesOf(state).forEach((c) => renderOneCreature(state, c));
}

function renderOneCreature(state, c) {
  const info = creatureInfo(c.type);
  const cx = c.x * TILE_SIZE + TILE_SIZE / 2;
  const cy = c.y * TILE_SIZE + TILE_SIZE / 2;
  const selUnit = selectedUnitId ? state.units.find((u) => u.id === selectedUnitId) : null;
  const attackable = canAttackCreatureWith(selUnit, state, c);

  const g = svgEl('g', {}, 'creature-token' + (attackable ? ' attackable' : ''));
  g.style.setProperty('--creature-color', info.color);

  const aura = svgEl('circle', { cx, cy, r: TILE_SIZE / 2 - 1 }, 'creature-aura');
  aura.style.animationDelay = phaseDelay(2.2);
  g.appendChild(aura);
  const badge = svgEl('circle', { cx, cy, r: TILE_SIZE / 2 - 5 }, 'creature-badge');
  badge.setAttribute('stroke', info.color);
  g.appendChild(badge);
  const icon = svgEl('g', { transform: `translate(${cx - 12}, ${cy - 12})`, fill: info.color, color: info.color }, 'creature-icon');
  icon.innerHTML = unitIconMarkup(c.type);
  g.appendChild(icon);
  g.appendChild(hpBar(cx, cy + TILE_SIZE / 2 - 5, 28, c.hp, c.maxHp));

  const tag = svgEl('text', { x: cx, y: c.y * TILE_SIZE + 8, 'text-anchor': 'middle' }, 'creature-tag');
  tag.textContent = `${c.atk}⚔ ${c.hp}♥`;
  g.appendChild(tag);

  const hit = svgEl('circle', { cx, cy, r: TILE_SIZE / 2 - 1 }, 'unit-hit creature-hit');
  hit.addEventListener('click', () => {
    if (attackable) attackCreatureWith(selUnit.id, c.id);
    else inspectCreature(c.id);
  });
  g.appendChild(hit);
  boardSvg.appendChild(g);
}

function shade(hex, amount) {
  // Oscurece un color hex mezclándolo hacia negro en `amount` (0-1, 0 = sin cambio).
  if (!hex) return '#333';
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * (1 - amount));
  const g = Math.round(((n >> 8) & 255) * (1 - amount));
  const b = Math.round((n & 255) * (1 - amount));
  return `rgb(${r},${g},${b})`;
}

// ================= SELECCIÓN Y ACCIONES =================

// Ataque a distancia corta (sin moverse, sin contraataque) contra una ficha
// rival adyacente. Igual patrón que atacar a una criatura adyacente.
function canAttackUnitWith(unit, target, state) {
  if (!unit || !target) return false;
  const isMyTurn = state.turnOrder[state.currentTurnIndex] === myId;
  if (!isMyTurn || unit.owner !== myId || target.owner === myId) return false;
  if (unit.type === 'rey' || !canStrike(unit, state)) return false;
  const dx = Math.abs(unit.x - target.x);
  const dy = Math.abs(unit.y - target.y);
  return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
}

async function attackUnitWith(unitId, targetId) {
  const unit = currentState.units.find((u) => u.id === unitId);
  const target = currentState.units.find((u) => u.id === targetId);
  if (!unit || !target) return;
  const owner = currentState.players.find((p) => p.id === target.owner);
  const ok = await askConfirm(
    `¿Atacar a ${label(target.type)} de ${owner ? owner.name : 'otro jugador'}?`,
    `Tu ${label(unit.type)} golpea primero por ${previewHit(unit, target)} de daño (sin contraataque a corta distancia). Tiene ${target.hp}/${target.maxHp} de vida.${hydraAvailableFor(unit) && unit.attackedThisTurn ? ' (Usa el 2º ataque de la Hidra de este turno.)' : ''}`
  );
  if (!ok) return;
  socket.emit('action:attackUnit', { unitId, targetId });
}

function barrierAt(state, x, y) {
  return (state.barriers || []).find((b) => b.x === x && b.y === y) || null;
}

// Ataque a una barrera rival adyacente, igual patrón que atacar una criatura.
function canAttackBarrierWith(unit, barrier, state) {
  if (!unit || !barrier) return false;
  const isMyTurn = state.turnOrder[state.currentTurnIndex] === myId;
  if (!isMyTurn || unit.owner !== myId || barrier.owner === myId) return false;
  if (unit.type === 'rey' || !canStrike(unit, state)) return false;
  const dx = Math.abs(unit.x - barrier.x);
  const dy = Math.abs(unit.y - barrier.y);
  return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
}

async function attackBarrierWith(unitId, barrierId) {
  const unit = currentState.units.find((u) => u.id === unitId);
  const barrier = (currentState.barriers || []).find((b) => b.id === barrierId);
  if (!unit || !barrier) return;
  const owner = currentState.players.find((p) => p.id === barrier.owner);
  const counter = BARRIER_COUNTER_DAMAGE_BY_LEVEL[barrier.level] || 0;
  const ok = await askConfirm(
    `¿Atacar la barrera (Nv ${barrier.level}) de ${owner ? owner.name : 'otro jugador'}?`,
    `Tu ${label(unit.type)} le pega por ${effAtk(unit)}. Tiene ${barrier.hp}/${barrier.maxHp} de vida${counter > 0 ? ` y contraataca por ${counter}` : ' (no contraataca)'}.${hydraAvailableFor(unit) && unit.attackedThisTurn ? ' (Usa el 2º ataque de la Hidra de este turno.)' : ''}`
  );
  if (!ok) return;
  socket.emit('action:attackBarrier', { unitId, barrierId });
}

// Click en una ficha ajena (rival o neutral): si tengo una ficha propia
// seleccionada y adyacente, ataca; si no, solo muestra su información.
function handleUnitClick(unitId) {
  const unit = currentState.units.find((u) => u.id === unitId);
  if (!unit) return;
  if (unit.owner === myId) { selectUnit(unitId); return; }

  const selUnit = selectedUnitId ? currentState.units.find((u) => u.id === selectedUnitId) : null;
  if (canAttackUnitWith(selUnit, unit, currentState)) {
    attackUnitWith(selUnit.id, unit.id);
    return;
  }
  inspectUnit(unitId);
}

function inspectUnit(unitId) {
  inspectedUnitId = unitId;
  inspectedCreatureId = null;
  renderSelection();
}

function inspectCreature(creatureId) {
  inspectedBarracksId = null;
  inspectedCreatureId = creatureId == null ? null : creatureId;
  inspectedUnitId = null;
  inspectedBarrierId = null;
  renderSelection();
}

function inspectBarracks(barracksId) {
  cancelFarmPlacement();
  selectedUnitId = null;
  selectedCastleId = null;
  reachableTiles = [];
  inspectedUnitId = null;
  inspectedCreatureId = null;
  inspectedBarrierId = null;
  inspectedBarracksId = barracksId == null ? null : barracksId;
  renderBoard(currentState);
  renderSelection();
}

function inspectBarrier(barrierId) {
  inspectedBarracksId = null;
  inspectedBarrierId = barrierId == null ? null : barrierId;
  inspectedUnitId = null;
  inspectedCreatureId = null;
  renderSelection();
}

function selectUnit(unitId) {
  const unit = currentState.units.find((u) => u.id === unitId);
  if (!unit || unit.owner !== myId) return;
  cancelFarmPlacement();
  inspectedUnitId = null;
  inspectedCreatureId = null;
  inspectedBarrierId = null;
  inspectedBarracksId = null;
  selectedCastleId = null;
  if (selectedUnitId === unitId) {
    SFX.play('deselect');
    selectedUnitId = null;
    reachableTiles = [];
  } else {
    SFX.play('select_unit');
    selectedUnitId = unitId;
    reachableTiles = [];
    const isMyTurn = currentState.turnOrder[currentState.currentTurnIndex] === myId;
    if (isMyTurn && unit.type !== 'rey' && !unit.movedThisTurn) {
      socket.emit('action:getReachable', { unitId });
    }
  }
  renderBoard(currentState);
  renderSelection();
}

function selectCastle(castleId) {
  const castle = currentState.castles.find((c) => c.id === castleId);
  if (!castle || castle.owner !== myId) return;
  cancelFarmPlacement();
  selectedUnitId = null;
  inspectedUnitId = null;
  inspectedCreatureId = null;
  inspectedBarrierId = null;
  inspectedBarracksId = null;
  reachableTiles = [];
  SFX.play(selectedCastleId === castleId ? 'deselect' : 'select_castle');
  selectedCastleId = selectedCastleId === castleId ? null : castleId;
  renderBoard(currentState);
  renderSelection();
}

const GARRISON_TROOP_LIMIT = 2; // tropas que caben sobre la casilla del castillo
function castleTroopStats(castle) {
  const units = currentState.units;
  const produced = units.filter((u) => u.type !== 'rey' && u.owner === castle.owner && u.originCastleId === castle.id).length;
  const inside = castle.garrison.filter((g) => { const u = units.find((x) => x.id === g.unitId); return u && u.type !== 'rey'; }).length;
  return { produced, inside };
}

function renderSelection() {
  if (!currentState) return;
  const unit = selectedUnitId ? currentState.units.find((u) => u.id === selectedUnitId) : null;
  const isMyTurn = currentState.turnOrder[currentState.currentTurnIndex] === myId;
  const myPlayer = currentState.players.find((p) => p.id === myId);

  // Castillo activo: el seleccionado directamente, o el que guarnece la ficha seleccionada.
  let castle = null;
  if (unit && unit.castleId) castle = currentState.castles.find((c) => c.id === unit.castleId) || null;
  else if (!unit && selectedCastleId) castle = currentState.castles.find((c) => c.id === selectedCastleId) || null;
  if (castle && castle.owner !== myId) castle = null;

  if (!unit && !castle) {
    const inspected = inspectedCreatureId != null ? creaturesOf(currentState).find((cc) => cc.id === inspectedCreatureId) : null;
    if (inspected) {
      const c = inspected;
      selectionBox.innerHTML = `
        <div style="display:flex; align-items:center; gap:6px; font-size:15px; font-weight:600;">
          <svg class="sel-icon" viewBox="0 0 24 24" fill="var(--gold-bright)" color="var(--gold-bright)">${unitIconMarkup(c.type)}</svg>
          <span>${label(c.type)}</span>
        </div>
        <div style="color:var(--ink-dim); font-size:12px; margin-top:4px;">Dueño: <b style="color:var(--ink);">Neutral</b></div>
        <div style="color:var(--ink-dim); font-size:12px;">Ficha: <b style="color:var(--ink);">${label(c.type)}</b></div>
        <div class="stat-chips" style="margin-top:6px;">
          <span class="chip chip-atk" title="Ataque"><b>${c.atk}</b> ATQ</span>
          <span class="chip chip-hp" title="Vida"><b>${c.hp}</b>/${c.maxHp} VIDA</span>
        </div>
      `;
      castleActions.style.display = 'none';
      return;
    }
    const inspectedBarracks = inspectedBarracksId != null ? (currentState.barracks || []).find((b) => b.id === inspectedBarracksId) : null;
    if (inspectedBarracks) {
      const b = inspectedBarracks;
      const owner = currentState.players.find((p) => p.id === b.owner);
      const mine = b.owner === myId;
      const flag = owner ? PLAYER_COLOR_HEX[owner.color] : '#888888';
      const rows = Object.keys(BARRACKS_UPGRADES).map((track) => {
        const up = BARRACKS_UPGRADES[track];
        const tier = b[`${track}Tier`];
        const maxed = tier >= up.costs.length;
        const cost = maxed ? null : up.costs[tier];
        const fmt = (v) => (track === 'farms' ? `${v} oro por granja` : (track === 'walls' ? `Nv ${v}` : `-${Math.round(v * 100)}% costo`));
        const cur = track === 'farms' ? (tier > 0 ? up.values[tier - 1] : 4) : (track === 'walls' ? 1 + tier : (tier > 0 ? up.values[tier - 1] : 0));
        const curTxt = track === 'discount' && cur === 0 ? 'sin descuento' : fmt(cur);
        const nextTxt = maxed ? 'Nivel máximo' : `→ ${fmt(up.values[tier])}`;
        const can = mine && isMyTurn && !maxed && myPlayer && myPlayer.gold >= cost;
        return `<div class="barracks-row">
          <div><b>${up.label}</b> <span class="barracks-pips">${'●'.repeat(tier)}${'○'.repeat(up.costs.length - tier)}</span><br><small>${curTxt} ${nextTxt}</small></div>
          ${mine ? `<button class="action-btn" data-track="${track}" ${can ? '' : 'disabled'}><span>${maxed ? 'Máx.' : 'Mejorar'}</span><span class="cost">${maxed ? '' : cost}</span></button>` : ''}
        </div>`;
      }).join('');
      selectionBox.innerHTML = `
        <div style="display:flex; align-items:center; gap:6px; font-size:15px; font-weight:600;">
          <svg class="sel-icon" viewBox="0 0 24 24">${barracksMarkup(flag)}</svg>
          <span>Cuartel</span>
        </div>
        <div style="color:var(--ink-dim); font-size:12px; margin-top:4px;">Dueño: <b style="color:var(--ink);">${mine ? 'Tuyo' : (owner ? escapeHtml(owner.name) : 'Desconocido')}</b></div>
        <div style="color:var(--ink-dim); font-size:12px;">${mine ? 'Si un rival lo pisa, se destruye con todas sus mejoras.' : 'Pisalo con una ficha para destruirlo.'}</div>
        <div class="barracks-list">${rows}</div>
      `;
      selectionBox.querySelectorAll('[data-track]').forEach((btn) => {
        btn.onclick = () => { SFX.play('ui_click'); socket.emit('action:upgradeBarracks', { track: btn.dataset.track }); };
      });
      castleActions.style.display = 'none';
      return;
    }
    const inspectedBarrier = inspectedBarrierId != null ? (currentState.barriers || []).find((b) => b.id === inspectedBarrierId) : null;
    if (inspectedBarrier) {
      const b = inspectedBarrier;
      const owner = currentState.players.find((p) => p.id === b.owner);
      const mine = b.owner === myId;
      const counter = BARRIER_COUNTER_DAMAGE_BY_LEVEL[b.level] || 0;
      selectionBox.innerHTML = `
        <div style="display:flex; align-items:center; gap:6px; font-size:15px; font-weight:600;">
          <svg class="sel-icon" viewBox="0 0 24 24" fill="var(--gold-bright)" color="var(--gold-bright)">${BARRIER_ICON}</svg>
          <span>Barrera (Nv ${b.level})</span>
        </div>
        <div style="color:var(--ink-dim); font-size:12px; margin-top:4px;">Dueño: <b style="color:var(--ink);">${mine ? 'Tuya' : (owner ? escapeHtml(owner.name) : 'Desconocido')}</b></div>
        <div style="color:var(--ink-dim); font-size:12px;">Se regenera por completo cada turno${counter > 0 ? ` · contraataca por ${counter}` : ' · no contraataca (Nv 1)'}</div>
        <div class="sel-hpbar" style="margin-top:6px;"><i style="width:${Math.round((b.hp / b.maxHp) * 100)}%; background:${hpColor(b.hp / b.maxHp)}"></i></div>
        <div class="stat-chips" style="margin-top:6px;">
          <span class="chip chip-hp" title="Vida"><b>${b.hp}</b>/${b.maxHp} VIDA</span>
          <span class="chip" title="Daño de contraataque"><b>${counter}</b> CONTRAATQ</span>
        </div>
      `;
      castleActions.style.display = 'none';
      return;
    }
    if (inspectedUnitId) {
      const target = currentState.units.find((u) => u.id === inspectedUnitId);
      if (target) {
        const owner = currentState.players.find((p) => p.id === target.owner);
        selectionBox.innerHTML = `
          <div style="display:flex; align-items:center; gap:6px; font-size:15px; font-weight:600;">
            <svg class="sel-icon" viewBox="0 0 24 24" fill="var(--gold-bright)" color="var(--gold-bright)">${unitIconMarkup(target.type)}</svg>
            <span>${label(target.type)}</span>
          </div>
          <div style="color:var(--ink-dim); font-size:12px; margin-top:4px;">Dueño: <b style="color:var(--ink);">${owner ? escapeHtml(owner.name) : 'Desconocido'}</b></div>
          <div style="color:var(--ink-dim); font-size:12px;">Ficha: <b style="color:var(--ink);">${label(target.type)}</b></div>
          <div class="stat-chips" style="margin-top:6px;">
            <span class="chip chip-atk" title="Ataque"><b>${effAtk(target)}</b> ATQ</span>
            ${effDef(target) > 0 ? `<span class="chip chip-def" title="Defensa: recibe ${effDef(target)} menos de daño (mínimo 1)"><b>+${effDef(target)}</b> DEF</span>` : ''}
            <span class="chip chip-hp" title="Vida"><b>${target.hp}</b>/${target.maxHp} VIDA</span>
          </div>
        `;
        castleActions.style.display = 'none';
        return;
      }
    }
    selectionBox.innerHTML = '<span class="empty">Elegí una ficha o un castillo propio en el tablero</span>';
    castleActions.style.display = 'none';
    return;
  }

  if (!unit) {
    const info = CASTLE_LEVEL_INFO[castle.level];
    selectionBox.innerHTML = `
      <div style="display:flex; align-items:center; gap:6px; font-size:15px; font-weight:600;">
        <svg class="sel-icon" viewBox="0 0 24 24" fill="var(--gold-bright)" color="var(--gold-bright)">${CASTLE_ICON}</svg>
        <span>Castillo #${castle.id}${castle.hasKing ? ' (Rey)' : ''}</span>
      </div>
      <div class="stat-chips">
        <span class="chip"><b>Nv ${castle.level}</b></span>
        <span class="chip"><b>+${info.goldPerTurn}</b> oro/ronda</span>
        <span class="chip" title="Tropas producidas / máximo del nivel"><b>${castleTroopStats(castle).produced}</b>/${info.militaryCapacity} tropas</span>
        <span class="chip" title="Tropas sobre la casilla del castillo"><b>${castleTroopStats(castle).inside}</b>/${GARRISON_TROOP_LIMIT} dentro</span>
        <span class="chip"><b>${castle.farms}</b>/${info.maxFarms} granjas</span>
        <span class="chip" title="Barreras construidas por este castillo"><b>${currentState.barriers ? currentState.barriers.filter((b) => b.castleId === castle.id).length : 0}</b> barreras</span>
      </div>`;
  } else selectionBox.innerHTML = `
    <div style="display:flex; align-items:center; gap:6px; font-size:15px; font-weight:600;">
      <svg class="sel-icon" viewBox="0 0 24 24" fill="var(--gold-bright)" color="var(--gold-bright)">${unitIconMarkup(unit.type)}</svg>
      <span>${UNIT_LABELS[unit.type]}</span>
    </div>
    <div class="stat-chips">
      <span class="chip chip-atk" title="${effAtk(unit) !== unit.atk ? `Ataque base ${unit.atk} + ${effAtk(unit) - unit.atk} por mejora` : 'Ataque'}"><b>${effAtk(unit)}</b> ATQ${effAtk(unit) !== unit.atk ? ` <small>(+${effAtk(unit) - unit.atk})</small>` : ''}</span>
      ${effDef(unit) > 0 ? `<span class="chip chip-def" title="Defensa: recibe ${effDef(unit)} menos de daño (mínimo 1)"><b>+${effDef(unit)}</b> DEF</span>` : ''}
      <span class="chip chip-hp" title="Vida"><b>${unit.hp}</b>/${unit.maxHp} VIDA</span>
    </div>
    <div class="sel-hpbar"><i style="width:${Math.round((unit.hp / unit.maxHp) * 100)}%; background:${hpColor(unit.hp / unit.maxHp)}"></i></div>
    <div style="color:var(--ink-dim); font-size:12px; margin-top:6px;">
      ${unit.type !== 'rey' && inWeatherType(currentState, unit, 'nieve') ? '<span style="color:#bfe3ff">Ventisca: solo puede avanzar 1 casilla</span><br>' : ''}${unit.type !== 'rey' && unit.owner && inWeatherType(currentState, unit, 'arena') ? '<span style="color:#d9a85c">Tormenta de arena: -1 ATQ</span><br>' : ''}${unit.type !== 'rey' && unit.owner && inWeatherType(currentState, unit, 'niebla') ? '<span style="color:#a9b7c6">Niebla densa: +1 DEF</span><br>' : ''}
      ${unit.type === 'rey' ? 'El Rey permanece en su castillo' : (isInQuake(currentState, unit) ? 'Inmovilizada por el terremoto' : (unit.movedThisTurn ? 'Ya se movió este turno' : 'Puede moverse'))}
      ${unit.type === 'fenix' ? `<br><span class="phoenix-note">${(currentState.players.find((p) => p.id === unit.owner) || {}).phoenixRevived ? 'Resurrección ya usada' : 'Resurrección disponible (10 de oro, castillo más cercano)'}</span>` : ''}
      ${FLYING_TYPES.has(unit.type) ? '<br>Vuela sobre los abismos' : ''}
    </div>
    ${creaturesOf(currentState).filter((c) => canAttackCreatureWith(unit, currentState, c)).map((c) => `<button class="action-btn attack-btn" data-creature="${c.id}" style="margin-top:8px; width:100%;"><span>Atacar a ${UNIT_LABELS[c.type] || c.type}${unit.attackedThisTurn ? ' (2º ataque)' : ''}</span><span class="cost">-${previewHit(unit, c)} vida</span></button>`).join('')}
    ${(currentState.barriers || []).filter((b) => canAttackBarrierWith(unit, b, currentState)).map((b) => `<button class="action-btn attack-btn" data-barrier="${b.id}" style="margin-top:8px; width:100%;"><span>Atacar barrera (Nv ${b.level})${unit.attackedThisTurn ? ' (2º ataque)' : ''}</span><span class="cost">-${effAtk(unit)} vida</span></button>`).join('')}
    ${unit.didAttackThisTurn && unit.type !== 'rey' ? (hydraAvailableFor(unit) ? '<div class="hydra-note">Ya atacó, pero el 2º ataque de la Hidra está disponible: puede atacar otra vez.</div>' : '<div style="color:var(--ink-dim); font-size:11px; margin-top:6px;">Ya atacó este turno</div>') : ''}
  `;
  selectionBox.querySelectorAll('[data-creature]').forEach((b) => {
    b.onclick = () => attackCreatureWith(unit.id, Number(b.dataset.creature));
  });
  selectionBox.querySelectorAll('[data-barrier]').forEach((b) => {
    b.onclick = () => attackBarrierWith(unit.id, Number(b.dataset.barrier));
  });

  if (castle && isMyTurn) {
    castleActions.style.display = 'block';
    renderProduceGrid(castle, myPlayer);

    const inPlacement = placingFarm && pendingFarmCastleId === castle.id;
    const farmMax = CASTLE_LEVEL_INFO[castle.level].maxFarms;
    const farmDisabled = !myPlayer || myPlayer.gold < FARM_COST || castle.farms >= farmMax;
    btnBuildFarm.disabled = farmDisabled && !inPlacement;
    btnBuildFarm.querySelector('span:first-child').textContent = inPlacement ? 'Cancelar selección' : 'Construir granja';
    btnBuildFarm.querySelector('.cost').textContent = inPlacement ? '' : (castle.farms >= farmMax ? `Máx. ${farmMax}` : `${FARM_COST} oro`);
    btnBuildFarm.onclick = () => {
      if (inPlacement) {
        cancelFarmPlacement();
        renderBoard(currentState);
        renderSelection();
      } else {
        SFX.play('ui_click');
        pendingFarmCastleId = castle.id;
        socket.emit('action:getBuildableFarmTiles');
      }
    };

    const inBarrierPlacement = placingBarrier && pendingBarrierCastleId === castle.id;
    const barrierDisabled = !myPlayer || myPlayer.gold < BARRIER_COST;
    btnBuildBarrier.disabled = barrierDisabled && !inBarrierPlacement;
    const wl = myWallLevel(currentState);
    const barrierLevelInfo = `Nv ${wl} (sube con el cuartel): ${BARRIER_HP_BY_LEVEL[wl]} vida${BARRIER_COUNTER_DAMAGE_BY_LEVEL[wl] ? `, ${BARRIER_COUNTER_DAMAGE_BY_LEVEL[wl]} de contraataque` : ''}`;
    btnBuildBarrier.title = barrierLevelInfo;
    btnBuildBarrier.querySelector('span:first-child').textContent = inBarrierPlacement ? 'Cancelar selección' : 'Construir barrera';
    btnBuildBarrier.querySelector('.cost').textContent = inBarrierPlacement ? '' : `${BARRIER_COST} oro`;
    btnBuildBarrier.onclick = () => {
      if (inBarrierPlacement) {
        cancelFarmPlacement();
        renderBoard(currentState);
        renderSelection();
      } else {
        SFX.play('ui_click');
        pendingBarrierCastleId = castle.id;
        socket.emit('action:getBuildableBarrierTiles');
      }
    };

    // Cuartel: 1 por jugador. Si ya tenés uno, el botón se oculta.
    if (barracksOfClient(currentState, myId)) {
      btnBuildBarracks.style.display = 'none';
    } else {
      btnBuildBarracks.style.display = '';
      btnBuildBarracks.disabled = (!myPlayer || myPlayer.gold < BARRACKS_COST) && !placingBarracks;
      btnBuildBarracks.title = 'Mejora granjas, murallas y el costo de las tropas. Máx. 1; si un rival lo pisa, se destruye.';
      btnBuildBarracks.querySelector('span:first-child').textContent = placingBarracks ? 'Cancelar selección' : 'Construir cuartel';
      btnBuildBarracks.querySelector('.cost').textContent = placingBarracks ? '' : `${BARRACKS_COST} oro`;
      btnBuildBarracks.onclick = () => {
        if (placingBarracks) {
          cancelFarmPlacement();
          renderBoard(currentState);
          renderSelection();
        } else {
          SFX.play('ui_click');
          pendingBarracks = true;
          socket.emit('action:getBuildableBarracksTiles');
        }
      };
    }

    const nextCost = CASTLE_UPGRADE_COST[castle.level + 1];
    if (nextCost === undefined) {
      btnUpgrade.disabled = true;
      btnUpgrade.querySelector('.cost').textContent = 'Nivel máx.';
    } else {
      btnUpgrade.disabled = !myPlayer || myPlayer.gold < nextCost;
      btnUpgrade.querySelector('.cost').textContent = `${nextCost} oro`;
      btnUpgrade.onclick = () => socket.emit('action:upgradeCastle', { castleId: castle.id });
    }
  } else {
    castleActions.style.display = 'none';
  }
}

function renderProduceGrid(castle, myPlayer) {
  produceGrid.innerHTML = '';
  const unlocked = (myPlayer && myPlayer.unlockedUnits) || [];
  Object.keys(UNIT_COSTS).forEach((type) => {
    const cost = troopCostFor(myPlayer, type);
    const baseCost = UNIT_COSTS[type];
    const locked = UNLOCKABLE_UNITS.includes(type) && !unlocked.includes(type);
    const btn = document.createElement('button');
    btn.className = 'action-btn' + (locked ? ' locked' : '');
    btn.innerHTML = `<span style="display:flex; align-items:center; gap:5px;"><svg viewBox="0 0 24 24" fill="${locked ? '#5a6b7d' : 'var(--gold)'}" color="${locked ? '#5a6b7d' : 'var(--gold)'}">${unitIconMarkup(type)}</svg>${UNIT_LABELS[type]}</span><span class="cost">${locked ? 'Bloq.' : cost}</span>`;
    if (!locked && cost < baseCost) btn.title = `Precio base ${baseCost}: descuento del cuartel`;
    const full = castleTroopStats(castle).produced >= CASTLE_LEVEL_INFO[castle.level].militaryCapacity;
    btn.disabled = locked || !myPlayer || myPlayer.gold < cost || full;
    if (locked) btn.title = `Derrota a un ${UNIT_LABELS[type]} salvaje para desbloquearlo (${cost} de oro)`;
    else if (full) btn.title = 'Máximo de tropas del nivel alcanzado: mejora el castillo';
    btn.addEventListener('click', () => {
      socket.emit('action:produce', { castleId: castle.id, unitType: type });
    });
    produceGrid.appendChild(btn);
  });
}

// Rendirse (cualquier jugador vivo) y Terminar partida (solo el líder).
// Piden confirmación con un segundo clic para evitar accidentes.
function updateExitButtons(state) {
  const playing = !!state && state.phase === 'playing';
  const me = state ? state.players.find((p) => p.id === myId) : null;
  btnSurrender.style.display = playing && me && me.alive ? 'block' : 'none';
  btnEndGame.style.display = playing && state.leaderId === myId ? 'block' : 'none';
}

function armConfirm(btn, idleText, confirmText, onConfirm) {
  let timer = null;
  const reset = () => {
    clearTimeout(timer);
    btn.dataset.armed = '0';
    btn.textContent = idleText;
    btn.classList.remove('armed');
  };
  btn.addEventListener('click', () => {
    if (btn.dataset.armed === '1') {
      reset();
      onConfirm();
      return;
    }
    SFX.play('ui_click');
    btn.dataset.armed = '1';
    btn.textContent = confirmText;
    btn.classList.add('armed');
    timer = setTimeout(reset, 3000);
  });
}

armConfirm(btnSurrender, 'Rendirse', '¿Seguro? Toca otra vez', () => {
  selectedUnitId = null;
  selectedCastleId = null;
  cancelFarmPlacement();
  reachableTiles = [];
  socket.emit('action:surrender');
});

armConfirm(btnEndGame, 'Terminar partida', '¿Terminar para todos? Toca otra vez', () => {
  socket.emit('game:end');
});

btnEndTurn.addEventListener('click', () => {
  SFX.play('end_turn');
  selectedUnitId = null;
  selectedCastleId = null;
  cancelFarmPlacement();
  reachableTiles = [];
  socket.emit('action:endTurn');
});

// ================= LOG Y TOAST =================

const COMBAT_EVENTS = new Set([
  'attackerWinsCastle', 'defenderWinsCastle', 'fieldCombatAttackerWins', 'fieldCombatDefenderWins',
  'fieldCombatStandoff', 'castleStandoff', 'castleDefenderKilled',
  'creatureSurvived', 'attackerLostToCreature', 'attackerRevived', 'weatherKill',
  'attackUnitKilled', 'attackUnitHit', 'barrierDamaged', 'barrierDestroyed', 'attackerLostToBarrier',
]);
const CAPTURE_EVENTS = new Set([
  'castleCaptured', 'neutralCastleCaptured', 'farmCaptured', 'barracksCaptured',
  'creatureDefeated', 'creatureUnlocked', 'phoenixRevived',
]);
const WORLD_EVENTS = new Set(['chestSpawned', 'chestCollected', 'creatureDespawned', 'weatherHeal', 'weatherGold', 'weatherMeteor', 'turnTimeout', 'creatureSpawned', 'weatherSpawned', 'weatherEnded', 'phoenixLost', 'surrender', 'disconnect']);

function logClassFor(event) {
  if (COMBAT_EVENTS.has(event)) return 'log-combat';
  if (CAPTURE_EVENTS.has(event)) return 'log-capture';
  if (WORLD_EVENTS.has(event)) return 'log-world';
  if (event === 'garrisoned' || event === 'healed') return 'log-economy';
  return 'log-move';
}

function pos(p) { return p ? `(${p.x},${p.y})` : ''; }
function dmgText(log) {
  const parts = [];
  if (log.dealt) parts.push(`-${log.dealt} al rival`);
  if (log.counter) parts.push(`-${log.counter} de contraataque`);
  return parts.length ? ` [${parts.join(', ')}]` : '';
}
function label(t) { return UNIT_LABELS[t] || t; }

// Texto de la mejora ganada al derrotar a una criatura (log.upgrade = { key, value }).
function upgradeGainText(up) {
  switch (up.key) {
    case 'atkBonus': return `+${up.value} ATQ en todas sus tropas`;
    case 'defBonus': return `+${up.value} DEF en todas sus tropas`;
    case 'poisonStrike': return 'sus golpes ahora envenenan';
    case 'hydraStrike': return '1 tropa por turno puede atacar 2 veces';
    default: return 'nueva mejora';
  }
}

// Envuelve el texto base con avisos extra: veneno aplicado y 2º ataque de la Hidra.
function describeLog(log) {
  let text = describeLogBase(log);
  if (log.poisoned) text += ' · ¡envenenado!';
  if (log.second) text += ' · 2º ataque (Hidra)';
  if (log.barracksCaptured) text += ' · ¡cuartel destruido!';
  return text;
}

function describeLogBase(log) {
  const from = pos(log.from);
  const to = pos(log.to);
  switch (log.event) {
    case 'castleCaptured': return `Castillo #${log.castleId} conquistado sin resistencia, ${from} → ${to}`;
    case 'neutralCastleCaptured': return `Castillo neutral #${log.castleId} ocupado, ${from} → ${to}`;
    case 'garrisoned': return `Ficha guarnecida en castillo #${log.castleId}`;
    case 'attackerWinsCastle': return `Castillo #${log.castleId} tomado: cae ${label(log.defenderType)}${dmgText(log)}`;
    case 'castleDefenderKilled': return `Cae ${label(log.defenderType)} en el castillo #${log.castleId}, pero quedan defensores${dmgText(log)}`;
    case 'castleStandoff': return `Asalto al castillo #${log.castleId}: ambos resisten${dmgText(log)}`;
    case 'defenderWinsCastle': return `Asalto rechazado en castillo #${log.castleId}: el atacante cae${log.attackerRevived ? ' (el Fénix resucita)' : ''}${dmgText(log)}`;
    case 'fieldCombatAttackerWins': return `Combate en campo abierto ganado: cae ${label(log.defenderType)}${dmgText(log)}`;
    case 'fieldCombatDefenderWins': return `Combate en campo abierto perdido: el atacante cae${log.attackerRevived ? ' (el Fénix resucita)' : ''}${dmgText(log)}`;
    case 'fieldCombatStandoff': return `Combate en campo abierto: ambos sobreviven${dmgText(log)}`;
    case 'farmCaptured': return `Granja capturada en ${to}`;
    case 'barracksCaptured': return `¡Cuartel de ${playerNameOf(log.ownerId) || 'un rival'} destruido en ${to}!`;
    case 'moved': return `Movimiento ${from} → ${to}`;

    case 'creatureSpawned': return `Aparece ${label(log.creature.type)} en ${to}`;
    case 'creatureTelegraph': return `Se avista ${label(log.creature.type)}: aparecerá en ${to} el próximo turno`;
    case 'creatureSurvived': return `${label(log.unitType)} golpea a ${label(log.creatureType)}${dmgText(log)}; le quedan ${log.creatureHpRemaining} de vida`;
    case 'attackerLostToCreature': return `${label(log.unitType)} cae ante ${label(log.creatureType)}${dmgText(log)}`;
    case 'attackerRevived': return `${label(log.unitType)} cae ante ${label(log.creatureType)}, ¡pero el Fénix resucita!`;
    case 'creatureDefeated': return `${label(log.creatureType)} derrotado: +${log.goldReward} de oro${log.upgrade ? ` · ${playerNameOf(log.playerId)} obtiene una mejora: ${upgradeGainText(log.upgrade)}` : ''}`;
    case 'creatureUnlocked': return `¡${label(log.creatureType)} derrotado! ${playerNameOf(log.playerId)} desbloquea al ${label(log.unlockedType)}: ya puede producirlo en sus castillos`;

    case 'weatherSpawned': return `${weatherInfo(log.weather.type).label} sobre ${Array.isArray(log.weather.cells) ? log.weather.cells.length : 9} casillas`;
    case 'weatherEnded': return `Se disipa: ${weatherInfo(log.weather.type).label}`;
    case 'surrender': return `${playerNameOf(log.playerId)} se rindió`;
    case 'disconnect': return `${playerNameOf(log.playerId)} se desconectó y queda fuera de la partida`;
    case 'weatherKill': return `${label(log.unitType)} sucumbe al clima en ${to}`;

    case 'chestSpawned': return `Un cofre del tesoro aparece en ${to}`;
    case 'chestCollected': return `${playerNameOf(log.playerId)} abre un cofre: +${log.gold} de oro`;
    case 'creatureDespawned': return `${label(log.creature.type)} se marcha del tablero tras 10 rondas`;
    case 'weatherHeal': return `Lluvia sanadora: ${log.count} ficha(s) recuperan vida`;
    case 'weatherGold': return log.weatherType === 'cosecha'
      ? `${playerNameOf(log.playerId)} cosecha +${log.gold} de oro de sus granjas`
      : `${playerNameOf(log.playerId)} gana +${log.gold} de oro bajo la aurora`;
    case 'weatherMeteor': return `Lluvia de meteoros: ${log.cells ? log.cells.length : 0} impacto(s)${log.hits ? `, ${log.hits} ficha(s) golpeada(s)` : ', ninguna ficha golpeada'}`;
    case 'turnTimeout': return `${playerNameOf(log.playerId)} se quedó sin tiempo: turno terminado`;
    case 'phoenixRevived': return log.inPlace ? '¡El Fénix renace donde cayó! (-10 de oro)' : `¡El Fénix renace en el castillo #${log.castleId}! (-10 de oro)`;
    case 'phoenixLost': {
      const why = { yaUsada: 'ya usó su resurrección', sinOro: 'no hay 10 de oro', sinCastillo: 'no queda ningún castillo neutral' }[log.reason] || 'no pudo resucitar';
      return `El Fénix se pierde para siempre (${why})`;
    }
    case 'healed': return `Fin de ronda: ${log.count} tropa(s) curada(s) en castillo`;

    case 'attackUnitKilled': return `${label(log.unitType)} elimina a ${label(log.targetType)}${dmgText(log)}${log.targetRevived ? ' (el Fénix resucita)' : ''}`;
    case 'attackUnitHit': return `${label(log.unitType)} golpea a ${label(log.targetType)}${dmgText(log)}; le quedan ${log.targetHpRemaining} de vida`;
    case 'barrierDamaged': return `${label(log.unitType)} golpea una barrera (Nv ${log.barrierLevel})${dmgText(log)}; le quedan ${log.barrierHpRemaining} de vida`;
    case 'barrierDestroyed': return `${label(log.unitType)} destruye una barrera (Nv ${log.barrierLevel})${dmgText(log)}`;
    case 'attackerLostToBarrier': return `${label(log.unitType)} cae ante una barrera (Nv ${log.barrierLevel})${log.attackerRevived ? ' (el Fénix resucita)' : ''}${dmgText(log)}`;
    default:
      if (log.type === 'produce') return `Ficha producida: ${label(log.unitType)}`;
      if (log.type === 'buildFarm') return `Granja construida`;
      if (log.type === 'buildBarrier') return `Barrera construida`;
      if (log.type === 'buildBarracks') return `${playerNameOf(log.playerId)} construyó un cuartel`;
      if (log.type === 'upgradeBarracks') return `${playerNameOf(log.playerId)} mejoró su cuartel (${(BARRACKS_UPGRADES[log.track] || {}).label || log.track} ${log.tier})`;
      if (log.type === 'upgradeCastle') return `Castillo mejorado a nivel ${log.newLevel}`;
      return from && to ? `Movimiento ${from} → ${to}` : 'Acción';
  }
}

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove('show'), 2600);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}


// ===================== Pantalla de reglas =====================
const RULES_SLIDES = [
  { title: 'Objetivo', body: `<p>Tu <b>Rey</b> vive en tu castillo inicial y no se mueve.</p>
    <p>Quedás eliminado si <b>tu Rey cae</b> o si <b>te quitan ese castillo</b>. Gana el <b>último jugador en pie</b>.</p>
    <p class="rules-tip">Defendé tu castillo y conquistá el de los rivales.</p>` },
  { title: 'Tu turno', body: `<p>Tenés <b>45 segundos</b> por turno (el contador está arriba). Si se acaba, el turno se cierra solo.</p>
    <ul><li>Cada ficha puede <b>moverse una vez</b> y <b>atacar una vez</b> por turno.</li>
    <li>Podés <b>producir</b> tropas, <b>construir granjas</b> y <b>mejorar</b> castillos.</li>
    <li>Al terminar, pulsá el botón de terminar turno.</li></ul>` },
  { title: 'Economía', body: `<p>Empezás con <b>30 de oro</b>.</p>
    <ul><li>Cada ronda tu castillo da <b>+3 / +4 / +5</b> de oro según su nivel (1 / 2 / 3).</li>
    <li>Cada <b>granja</b> da <b>+4</b> por ronda. Cuesta 20 y solo se construye en tu territorio.</li>
    <li>Una <b>barrera</b> cuesta 20 (igual que una granja) y bloquea el paso: hay que destruirla para avanzar. Tiene <b>4 / 8 / 12</b> de vida según el nivel del castillo, se regenera por completo cada turno, y desde el nivel 2 contraataca (<b>2</b> o <b>3</b> de daño).</li>
    <li><b>Mejorar</b> el castillo: nivel 2 cuesta 15, nivel 3 cuesta 50. Sube el oro, las granjas y las tropas máximas; el nivel 3 además reduce 1 el daño que recibe.</li></ul>` },
  { title: 'Tropas', body: `<p>Selecciona tu castillo para comprar fichas:</p>
    <div class="rules-grid"><span>Peón</span><b>8</b><span>Caballo</span><b>25</b><span>Alfil</span><b>50</b><span>Torre</span><b>85</b><span>Reina</span><b>125</b></div>
    <p><b>Especiales</b> (solo tras derrotar a esa criatura): Grifo <b>110</b>, Fénix <b>140</b>, Dragón <b>180</b>.</p>
    <ul><li>Un castillo sostiene hasta <b>2 / 3 / 4</b> tropas según su nivel.</li>
    <li>Sobre su casilla caben <b>solo 2</b>; las demás aparecen en una casilla libre alrededor.</li>
    <li>Una ficha recién producida no actúa ese turno.</li></ul>` },
  { title: 'Cuartel', body: `<p>Cuesta <b>50 de oro</b>, se construye en tu territorio y solo puedes tener <b>1</b>. Sus mejoras:</p>
    <ul><li><b>Granjas:</b> todas rinden 5, luego 6 de oro (base 4).</li>
    <li><b>Murallas:</b> tus barreras suben a Nv 2 y Nv 3 (también las ya construidas).</li>
    <li><b>Tropas:</b> 10%, 15% y 20% de descuento al producir.</li></ul>
    <p class="rules-tip">Si un rival pisa tu cuartel, se destruye con todas sus mejoras. Puedes construir otro desde cero.</p>` },
  { title: 'Movimiento', body: `<ul><li><b>Peón:</b> 1 casilla, sin diagonales.</li>
    <li><b>Caballo:</b> salto en L, como en el ajedrez.</li>
    <li><b>Alfil:</b> diagonales, hasta chocar.</li>
    <li><b>Torre:</b> líneas rectas, hasta chocar.</li>
    <li><b>Reina:</b> rectas y diagonales.</li></ul>
    <p class="rules-tip">Las casillas negras son huecos: bloquean el paso (los voladores los cruzan).</p>` },
  { title: 'Combate', body: `<p>Cada ficha tiene <b>ATQ</b> y <b>vida</b>: Peón 2/4, Caballo 3/6, Alfil 3/6, Torre 4/8, Reina 5/10.</p>
    <ul><li>El que ataca <b>golpea primero</b>: su ATQ se resta a la vida del defensor.</li>
    <li>Si el defensor sobrevive, <b>contraataca</b>. Si muere, no hay contraataque.</li>
    <li>Vida 0 = ficha eliminada.</li></ul>` },
  { title: 'Conquista', body: `<ul><li>Entrar a un castillo <b>neutral</b> lo reclama.</li>
    <li>Un castillo <b>enemigo</b> con guarnición hay que ganarlo peleando: defienden primero las tropas y el Rey al final.</li>
    <li>Entrar a una <b>granja</b> enemiga la captura.</li>
    <li>Tu territorio (tu color) crece por donde pasas.</li></ul>` },
  { title: 'Cofres y criaturas', body: `<ul><li><b>Cofres del tesoro:</b> aparecen al azar en cualquier casilla libre (poco frecuentes). Termina un movimiento encima para abrirlos y ganar <b>5 a 25 de oro</b>.</li>
    <li><b>Criaturas</b> desde la ronda 5: derrotarlas da oro y una <b>mejora permanente</b> (ver el paso siguiente).</li>
    <li>Se marchan solas a las 10 rondas. Basilisco y Medusa envenenan o petrifican al contraatacar.</li></ul>` },
  { title: 'Mejoras de criaturas', body: `<p>Las gana <b>quien da el golpe final</b> y valen para siempre:</p>
    <ul><li><b>Lobo:</b> +1 ATQ a todas tus tropas (hasta +3).</li>
    <li><b>Golem:</b> +1 de defensa a todas tus tropas: reciben 1 menos de daño, mínimo 1 (hasta +3).</li>
    <li><b>Basilisco:</b> tus golpes envenenan al rival que sobreviva (2 de daño por turno, 3 turnos).</li>
    <li><b>Hidra:</b> una vez por turno, <b>una sola tropa</b> que ya atacó puede atacar por segunda vez.</li>
    <li><b>Dragón, Grifo y Fénix:</b> desbloquean producirlos en tus castillos.</li></ul>
    <p class="rules-tip">El Rey no recibe bonos. Tus mejoras se ven en tu tarjeta de jugador.</p>` },
  { title: 'Clima', body: `<p>Desde la ronda 3 cae un clima sobre una zona de <b>6 a 27 casillas</b> (el tamaño cambia cada vez) durante 2 turnos:</p>
    <ul><li><b>Eléctrica:</b> −1 de vida por turno.</li>
    <li><b>Meteoros:</b> impactos al azar en la zona: −3 de vida a quien esté debajo.</li>
    <li><b>Ventisca:</b> solo se avanza 1 casilla.</li>
    <li><b>Arena:</b> −1 ATQ a las tropas dentro. <b>Niebla:</b> +1 DEF.</li>
    <li><b>Terremoto:</b> inmoviliza. <b>Eclipse:</b> impide atacar.</li>
    <li><b>Lluvia:</b> cura +2. <b>Aurora:</b> +3 de oro por tropa propia dentro.</li>
    <li><b>Cosecha:</b> cada granja dentro da su ingreso extra por turno.</li></ul>` },
];

(function setupRules() {
  let idx = 0;
  const overlay = document.createElement('div');
  overlay.id = 'rules-overlay';
  overlay.innerHTML = `<div class="rules-card" role="dialog" aria-modal="true" aria-label="Cómo se juega">
    <button type="button" class="rules-close" aria-label="Cerrar">✕</button>
    <div class="rules-step"></div><h2 class="rules-title"></h2><div class="rules-body"></div>
    <div class="rules-nav"><button type="button" class="rules-prev">‹ Anterior</button><div class="rules-dots"></div><button type="button" class="rules-next">Siguiente ›</button></div>
  </div>`;
  const q = (s) => overlay.querySelector(s);
  function paint() {
    const s = RULES_SLIDES[idx];
    q('.rules-step').textContent = `Paso ${idx + 1} de ${RULES_SLIDES.length}`;
    q('.rules-title').textContent = s.title;
    q('.rules-body').innerHTML = s.body;
    q('.rules-prev').disabled = idx === 0;
    q('.rules-next').textContent = idx === RULES_SLIDES.length - 1 ? 'Entendido' : 'Siguiente ›';
    q('.rules-dots').innerHTML = RULES_SLIDES.map((_, i) => `<i class="${i === idx ? 'on' : ''}"></i>`).join('');
  }
  function open(at = 0) { idx = at; paint(); overlay.classList.add('open'); try { SFX.play('ui_click'); } catch (e) {} }
  function close() {
    overlay.classList.remove('open');
    try { localStorage.setItem('rulesSeen', '1'); } catch (e) {}
  }
  q('.rules-close').addEventListener('click', close);
  q('.rules-prev').addEventListener('click', () => { if (idx > 0) { idx--; paint(); } });
  q('.rules-next').addEventListener('click', () => { if (idx < RULES_SLIDES.length - 1) { idx++; paint(); } else close(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  window.addEventListener('keydown', (e) => {
    if (!overlay.classList.contains('open')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') q('.rules-next').click();
    if (e.key === 'ArrowLeft') q('.rules-prev').click();
  });

  const btn = document.createElement('button');
  btn.id = 'rules-button';
  btn.type = 'button';
  btn.title = '¿Cómo se juega?';
  btn.setAttribute('aria-label', '¿Cómo se juega?');
  btn.textContent = '?';
  btn.addEventListener('click', () => open(0));

  function mount() {
    document.body.appendChild(btn);
    document.body.appendChild(overlay);
    let seen = false;
    try { seen = localStorage.getItem('rulesSeen') === '1'; } catch (e) {}
    if (!seen) open(0); // primera visita: se muestra sola una vez
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
