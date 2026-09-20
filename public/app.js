// public/app.js
// Cliente: conexión socket, lobby (líder + sala de espera) y juego (render SVG + interacción).

const socket = io();

// --- Constantes espejo del servidor (solo para mostrar costos/íconos en UI) ---
const UNIT_LABELS = {
  rey: 'Rey', peon: 'Peón', caballo: 'Caballo', alfil: 'Alfil', torre: 'Torre', reina: 'Reina',
  dragon: 'Dragón', fenix: 'Fénix', lobo: 'Lobo', golem: 'Golem', hidra: 'Hidra',
};
// Criaturas neutrales: color de aura, recompensa y nota corta para el panel.
const CREATURE_INFO = {
  lobo:   { color: '#8fa3b8', reward: '10 de oro', note: 'Rápido y mordedor.' },
  golem:  { color: '#b58a5a', reward: '14 de oro', note: 'Lento pero duro.' },
  dragon: { color: '#e2685a', reward: 'Se doma como tropa', note: 'Vuela sobre los abismos.' },
  hidra:  { color: '#6fcf97', reward: '60 de oro', note: 'Regenera +2 de vida por ronda.' },
  fenix:  { color: '#ffb347', reward: 'Se doma como tropa', note: 'Resucita una vez por jugador (10 de oro, en el castillo más cercano).' },
};
const WEATHER_INFO = {
  electrica: { label: 'Tormenta eléctrica', color: '#f5d84a', note: '-1 de vida por turno a quien esté dentro.' },
  nieve:     { label: 'Ventisca de nieve', color: '#bfe3ff', note: '-1 de vida por turno a quien esté dentro.' },
  arena:     { label: 'Tormenta de arena', color: '#d9a85c', note: '-1 de vida por turno a quien esté dentro.' },
  acido:     { label: 'Lluvia ácida', color: '#9be22d', note: '-1 de vida por turno a quien esté dentro.' },
  niebla:    { label: 'Niebla densa', color: '#a9b7c6', note: '-1 de vida por turno a quien esté dentro.' },
  lluvia:    { label: 'Lluvia sanadora', color: '#6ec6ff', note: 'Sin daño: cura +2 de vida por turno a toda ficha dentro.' },
  eclipse:   { label: 'Eclipse', color: '#8a6fd6', note: 'Sin daño: las fichas dentro no pueden atacar (sí moverse).' },
  aurora:    { label: 'Aurora dorada', color: '#5fe0b0', note: 'Sin daño: +3 de oro por turno por cada tropa propia dentro.' },
  terremoto: { label: 'Terremoto', color: '#b58a5a', note: 'Las tropas dentro no pueden moverse.' },
};
const WEATHER_FALLBACK = { label: 'Clima', color: '#9fb3c8', note: '-1 de vida por turno a quien esté dentro.' };
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

const UNIT_COSTS = { peon: 8, caballo: 25, alfil: 50, torre: 85, reina: 125 };
const CASTLE_GOLD_PER_TURN = { 1: 3, 2: 4, 3: 5 };
const FARM_INCOME_CLIENT = 4;
function incomeOf(state, playerId) {
  const castles = state.castles.filter((c) => c.owner === playerId);
  const farms = state.farms.filter((f) => f.owner === playerId).length;
  const fromCastles = castles.reduce((sum, c) => sum + (CASTLE_GOLD_PER_TURN[c.level] || 0), 0);
  return fromCastles + farms * FARM_INCOME_CLIENT;
}
const CASTLE_UPGRADE_COST = { 2: 15, 3: 50 };
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
const UNIT_ICON_PATHS = {
  rey: '<path d="M4 17.5 L4 10.5 L8 13.5 L12 7 L16 13.5 L20 10.5 L20 17.5 Z" fill="currentColor"/><rect x="4" y="17.5" width="16" height="2.3" fill="currentColor"/><circle cx="12" cy="7" r="1.5" fill="currentColor"/>',
  reina: '<path d="M3 17.5 L3 11.5 L6.3 13.8 L9 8.3 L12 12.2 L15 8.3 L17.7 13.8 L21 11.5 L21 17.5 Z" fill="currentColor"/><rect x="3" y="17.5" width="18" height="2.1" fill="currentColor"/><circle cx="12" cy="8.3" r="1.25" fill="currentColor"/><circle cx="6.3" cy="13.8" r="0.9" fill="currentColor"/><circle cx="17.7" cy="13.8" r="0.9" fill="currentColor"/>',
  torre: '<path d="M6.5 20 L6.5 9.6 L8.3 9.6 L8.3 11 L10.6 11 L10.6 9.6 L13.4 9.6 L13.4 11 L15.7 11 L15.7 9.6 L17.5 9.6 L17.5 20 Z" fill="currentColor"/><rect x="6.5" y="7.4" width="11" height="2.2" fill="currentColor"/>',
  alfil: '<path d="M12 3.2 C9.1 6.3 7.9 9.8 7.9 12.9 C7.9 16.1 9.6 18.1 12 19.2 C14.4 18.1 16.1 16.1 16.1 12.9 C16.1 9.8 14.9 6.3 12 3.2 Z" fill="currentColor"/><rect x="11.1" y="6.6" width="1.8" height="5.2" fill="var(--panel)"/><rect x="9.1" y="8.6" width="5.8" height="1.4" fill="var(--panel)"/><circle cx="12" cy="20.6" r="1.35" fill="currentColor"/>',
  caballo: '<path d="M7.2 20 L7.2 12.2 A4.8 4.8 0 0 1 16.8 12.2 L16.8 20" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/><circle cx="8.4" cy="14.6" r="0.85" fill="currentColor"/><circle cx="10.3" cy="12" r="0.85" fill="currentColor"/><circle cx="13.7" cy="12" r="0.85" fill="currentColor"/><circle cx="15.6" cy="14.6" r="0.85" fill="currentColor"/>',
  peon: '<circle cx="12" cy="7.4" r="3" fill="currentColor"/><path d="M8.6 20 L9.6 12.4 H14.4 L15.4 20 Z" fill="currentColor"/><rect x="7.4" y="19" width="9.2" height="2.1" fill="currentColor"/>',
};

// Criaturas y tropas especiales (mismo lienzo 24x24). Los "ojos" usan el color
// del fondo del token para recortar la silueta.
Object.assign(UNIT_ICON_PATHS, {
  lobo: '<path d="M3.5 3.5 L9 8 H15 L20.5 3.5 L20 12.5 C20 16.6 16.4 19.8 12 21.4 C7.6 19.8 4 16.6 4 12.5 Z" fill="currentColor"/><path d="M7.4 12 L10.6 13 L8.4 14.5 Z" fill="#0c1119"/><path d="M16.6 12 L13.4 13 L15.6 14.5 Z" fill="#0c1119"/><path d="M10.4 17.3 H13.6 L12 19 Z" fill="#0c1119"/>',
  golem: '<rect x="8" y="3.5" width="8" height="6.5" rx="1.2" fill="currentColor"/><rect x="5" y="10.8" width="14" height="8" rx="1.2" fill="currentColor"/><rect x="2" y="11.4" width="3" height="7" rx="1" fill="currentColor"/><rect x="19" y="11.4" width="3" height="7" rx="1" fill="currentColor"/><rect x="9.4" y="6" width="1.7" height="1.7" fill="#0c1119"/><rect x="12.9" y="6" width="1.7" height="1.7" fill="#0c1119"/><rect x="6.5" y="19" width="4" height="2.2" fill="currentColor"/><rect x="13.5" y="19" width="4" height="2.2" fill="currentColor"/>',
  dragon: '<path d="M12 21 L8.2 15.6 L1.8 16.6 L5 10.4 L2.4 4.6 L9 7.6 L12 5 L15 7.6 L21.6 4.6 L19 10.4 L22.2 16.6 L15.8 15.6 Z" fill="currentColor"/><path d="M9.6 10.2 L11.2 11.2 L9.6 11.9 Z" fill="#0c1119"/><path d="M14.4 10.2 L12.8 11.2 L14.4 11.9 Z" fill="#0c1119"/>',
  hidra: '<path d="M12 20 V12.5 M12 20 C8 19 5.5 15 6 8.5 M12 20 C16 19 18.5 15 18 8.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="10.2" r="2.5" fill="currentColor"/><circle cx="6" cy="7" r="2.5" fill="currentColor"/><circle cx="18" cy="7" r="2.5" fill="currentColor"/><ellipse cx="12" cy="20.4" rx="5.2" ry="2" fill="currentColor"/><circle cx="11.2" cy="9.9" r="0.6" fill="#0c1119"/><circle cx="12.8" cy="9.9" r="0.6" fill="#0c1119"/>',
  fenix: '<path d="M12 14.4 C8 14.4 3.6 11.2 1.8 4.6 C6.8 6.4 10 7 12 10 C14 7 17.2 6.4 22.2 4.6 C20.4 11.2 16 14.4 12 14.4 Z" fill="currentColor"/><path d="M12 22.2 C9.2 19.4 9.2 17 12 14.6 C14.8 17 14.8 19.4 12 22.2 Z" fill="currentColor"/><circle cx="12" cy="8.2" r="2.2" fill="currentColor"/><path d="M12 3.2 L13 6 H11 Z" fill="currentColor"/>',
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

// --- Estado local del cliente ---
let myId = null;
let currentState = null;
let selectedUnitId = null;
let selectedCastleId = null;
let inspectedUnitId = null; // ficha rival/propia ajena vista en el panel, sin seleccionarla
let inspectedCreatureId = null; // id de la criatura que se ve en el panel (null = ninguna)
const CASTLE_LEVEL_INFO = {
  1: { goldPerTurn: 3, militaryCapacity: 2, maxFarms: 2 },
  2: { goldPerTurn: 4, militaryCapacity: 3, maxFarms: 3 },
  3: { goldPerTurn: 5, militaryCapacity: 4, maxFarms: 4 },
};
let reachableTiles = [];
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

function cancelFarmPlacement() {
  placingFarm = false;
  buildableFarmTiles = [];
  pendingFarmCastleId = null;
  placingBarrier = false;
  buildableBarrierTiles = [];
  pendingBarrierCastleId = null;
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
        <span title="Granjas"><svg class="stat-icon" viewBox="0 0 24 24"><path d="M4 20 V11 L12 5 L20 11 V20 Z" fill="currentColor"/><rect x="9.3" y="13.6" width="5.4" height="6.4" fill="var(--panel-2)"/></svg> <b>${castle ? castle.farms : 0}</b></span>
      </div>
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
  if (creatures.length < maxCreatures) {
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
      if (ownerPlayer && (tile.type === 'territory' || tile.type === 'farm' || tile.type === 'barrier')) {
        // Inline style, no atributo: así le gana a las reglas .tile.* del CSS.
        rect.style.fill = (tile.type === 'farm' || tile.type === 'barrier') ? shade(PLAYER_COLOR_HEX[ownerPlayer.color], tile.type === 'barrier' ? 0.35 : 0.2) : PLAYER_COLOR_HEX[ownerPlayer.color];
      }
      if (isReachable) {
        rect.addEventListener('click', () => {
          reachableTiles = [];
          socket.emit('action:move', { unitId: selectedUnitId, x, y });
        });
      }

      const buildableSet = placingFarm ? buildableFarmSet : (placingBarrier ? buildableBarrierSet : null);
      if (buildableSet && buildableSet.has(key)) {
        rect.classList.add('buildable');
        rect.addEventListener('click', () => {
          if (placingFarm) {
            socket.emit('action:buildFarm', { castleId: pendingFarmCastleId, x, y });
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
          chit.addEventListener('click', () => selectCastle(castle.id));
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
        const fcx = x * TILE_SIZE + TILE_SIZE / 2;
        const fcy = y * TILE_SIZE + TILE_SIZE / 2;

        const farmIcon = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        farmIcon.setAttribute('class', 'farm-badge');
        farmIcon.setAttribute('fill', '#0c1119');
        farmIcon.setAttribute('transform', `translate(${fcx - 10}, ${fcy - 10}) scale(0.83)`);
        farmIcon.innerHTML =
          '<path d="M4 20 V11 L12 5 L20 11 V20 Z" fill="currentColor"/>' +
          '<rect x="9.3" y="13.6" width="5.4" height="6.4" fill="var(--panel-2)"/>';

        boardSvg.appendChild(farmIcon);
      }
      if (tile.type === 'barrier') {
        const barrier = barrierAt(state, x, y);
        const bcx = x * TILE_SIZE + TILE_SIZE / 2;
        const bcy = y * TILE_SIZE + TILE_SIZE / 2;

        const barrierIcon = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        barrierIcon.setAttribute('class', 'barrier-badge');
        barrierIcon.setAttribute('fill', '#0c1119');
        barrierIcon.setAttribute('transform', `translate(${bcx - 10}, ${bcy - 10}) scale(0.83)`);
        barrierIcon.innerHTML =
          '<rect x="3" y="5" width="4" height="15" fill="currentColor"/>' +
          '<rect x="10" y="4" width="4" height="16" fill="currentColor"/>' +
          '<rect x="17" y="5" width="4" height="15" fill="currentColor"/>' +
          '<rect x="2" y="10" width="20" height="3" fill="var(--panel-2)"/>';
        boardSvg.appendChild(barrierIcon);

        if (barrier) {
          boardSvg.appendChild(hpBar(bcx, bcy + TILE_SIZE / 2 - 5, 24, barrier.hp, barrier.maxHp));

          const selUnitForBarrierAttack = selectedUnitId ? state.units.find((u) => u.id === selectedUnitId) : null;
          const barrierAttackable = canAttackBarrierWith(selUnitForBarrierAttack, barrier, state);
          const bHit = svgEl('circle', { cx: bcx, cy: bcy, r: TILE_SIZE / 2 - 2 }, 'unit-hit' + (barrierAttackable ? ' attackable-enemy' : ''));
          bHit.addEventListener('click', () => {
            if (barrierAttackable) attackBarrierWith(selUnitForBarrierAttack.id, barrier.id);
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

  // Destellos de territorio recién reclamado.
  claimedCells.forEach(({ x, y }) => spawnTileFx(x, y, 'tile-claim-fx'));

  // Destellos de combate/conquista a partir de eventos de log pendientes.
  const combatEvents = new Set([
    'attackerWinsCastle', 'defenderWinsCastle', 'fieldCombatAttackerWins', 'fieldCombatDefenderWins',
    'fieldCombatStandoff', 'castleStandoff', 'castleDefenderKilled', 'weatherKill',
    'creatureSurvived', 'attackerLostToCreature', 'attackerRevived', 'creatureDefeated', 'creatureTamed',
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
    } else if (w.type === 'acido') {
      for (let i = 0; i < 3; i++) {
        const dx = px + 6 + ((seed + i * 11) % (T - 12));
        const drop = svgEl('path', { d: `M${dx} ${py} q3 5 0 8 q-3 -3 0 -8 Z` }, 'acid-drop');
        drop.style.animationDuration = `${1.3 + i * 0.35}s`;
        drop.style.animationDelay = phaseDelay(1.8, i + seed);
        g.appendChild(drop);
      }
      const bubble = svgEl('circle', { cx: px + 10 + (seed % 20), cy: py + T - 9, r: 3.2 }, 'acid-bubble');
      bubble.style.animationDelay = phaseDelay(2, seed);
      g.appendChild(bubble);
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
  return isMyTurn && unit.owner === myId && unit.type !== 'rey' && !unit.attackedThisTurn
    && dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
}

function attackCreatureWith(unitId, creatureId) {
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
  if (unit.type === 'rey' || unit.attackedThisTurn) return false;
  const dx = Math.abs(unit.x - target.x);
  const dy = Math.abs(unit.y - target.y);
  return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
}

function attackUnitWith(unitId, targetId) {
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
  if (unit.type === 'rey' || unit.attackedThisTurn) return false;
  const dx = Math.abs(unit.x - barrier.x);
  const dy = Math.abs(unit.y - barrier.y);
  return dx <= 1 && dy <= 1 && !(dx === 0 && dy === 0);
}

function attackBarrierWith(unitId, barrierId) {
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
  inspectedCreatureId = creatureId == null ? null : creatureId;
  inspectedUnitId = null;
  renderSelection();
}

function selectUnit(unitId) {
  const unit = currentState.units.find((u) => u.id === unitId);
  if (!unit || unit.owner !== myId) return;
  cancelFarmPlacement();
  inspectedUnitId = null;
  inspectedCreatureId = null;
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
          <span>${UNIT_LABELS[c.type]}</span>
        </div>
        <div style="color:var(--ink-dim); font-size:12px; margin-top:4px;">Dueño: <b style="color:var(--ink);">Neutral</b></div>
        <div style="color:var(--ink-dim); font-size:12px;">Ficha: <b style="color:var(--ink);">${UNIT_LABELS[c.type]}</b></div>
        <div class="stat-chips" style="margin-top:6px;">
          <span class="chip chip-atk" title="Ataque"><b>${c.atk}</b> ATQ</span>
          <span class="chip chip-hp" title="Vida"><b>${c.hp}</b>/${c.maxHp} VIDA</span>
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
            <span>${UNIT_LABELS[target.type]}</span>
          </div>
          <div style="color:var(--ink-dim); font-size:12px; margin-top:4px;">Dueño: <b style="color:var(--ink);">${owner ? escapeHtml(owner.name) : 'Desconocido'}</b></div>
          <div style="color:var(--ink-dim); font-size:12px;">Ficha: <b style="color:var(--ink);">${UNIT_LABELS[target.type]}</b></div>
          <div class="stat-chips" style="margin-top:6px;">
            <span class="chip chip-atk" title="Ataque"><b>${target.atk}</b> ATQ</span>
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
      <span class="chip chip-atk" title="Ataque"><b>${unit.atk}</b> ATQ</span>
      <span class="chip chip-hp" title="Vida"><b>${unit.hp}</b>/${unit.maxHp} VIDA</span>
    </div>
    <div class="sel-hpbar"><i style="width:${Math.round((unit.hp / unit.maxHp) * 100)}%; background:${hpColor(unit.hp / unit.maxHp)}"></i></div>
    <div style="color:var(--ink-dim); font-size:12px; margin-top:6px;">
      ${unit.type === 'rey' ? 'El Rey permanece en su castillo' : (isInQuake(currentState, unit) ? 'Inmovilizada por el terremoto' : (unit.movedThisTurn ? 'Ya se movió este turno' : 'Puede moverse'))}
      ${unit.type === 'fenix' ? `<br><span class="phoenix-note">${(currentState.players.find((p) => p.id === unit.owner) || {}).phoenixRevived ? 'Resurrección ya usada' : 'Resurrección disponible (10 de oro, castillo más cercano)'}</span>` : ''}
      ${FLYING_TYPES.has(unit.type) ? '<br>Vuela sobre los abismos' : ''}
    </div>
    ${creaturesOf(currentState).filter((c) => canAttackCreatureWith(unit, currentState, c)).map((c) => `<button class="action-btn attack-btn" data-creature="${c.id}" style="margin-top:8px; width:100%;"><span>Atacar a ${UNIT_LABELS[c.type] || c.type}</span><span class="cost">-${unit.atk} vida</span></button>`).join('')}
    ${(currentState.barriers || []).filter((b) => canAttackBarrierWith(unit, b, currentState)).map((b) => `<button class="action-btn attack-btn" data-barrier="${b.id}" style="margin-top:8px; width:100%;"><span>Atacar barrera (Nv ${b.level})</span><span class="cost">-${unit.atk} vida</span></button>`).join('')}
    ${unit.attackedThisTurn && creaturesOf(currentState).length > 0 && unit.type !== 'rey' ? '<div style="color:var(--ink-dim); font-size:11px; margin-top:6px;">Ya atacó este turno</div>' : ''}
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
    const barrierLevelInfo = `Nv ${castle.level}: ${BARRIER_HP_BY_LEVEL[castle.level]} vida${BARRIER_COUNTER_DAMAGE_BY_LEVEL[castle.level] ? `, ${BARRIER_COUNTER_DAMAGE_BY_LEVEL[castle.level]} de contraataque` : ''}`;
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
  Object.keys(UNIT_COSTS).forEach((type) => {
    const cost = UNIT_COSTS[type];
    const btn = document.createElement('button');
    btn.className = 'action-btn';
    btn.innerHTML = `<span style="display:flex; align-items:center; gap:5px;"><svg viewBox="0 0 24 24" fill="var(--gold)" color="var(--gold)">${unitIconMarkup(type)}</svg>${UNIT_LABELS[type]}</span><span class="cost">${cost}</span>`;
    const full = castleTroopStats(castle).produced >= CASTLE_LEVEL_INFO[castle.level].militaryCapacity;
    btn.disabled = !myPlayer || myPlayer.gold < cost || full;
    if (full) btn.title = 'Máximo de tropas del nivel alcanzado: mejora el castillo';
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
  'castleCaptured', 'neutralCastleCaptured', 'farmCaptured',
  'creatureDefeated', 'creatureTamed', 'phoenixRevived',
]);
const WORLD_EVENTS = new Set(['chestSpawned', 'chestCollected', 'creatureDespawned', 'weatherHeal', 'weatherGold', 'turnTimeout', 'creatureSpawned', 'weatherSpawned', 'weatherEnded', 'phoenixLost', 'surrender', 'disconnect']);

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

function describeLog(log) {
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
    case 'moved': return `Movimiento ${from} → ${to}`;

    case 'creatureSpawned': return `Aparece ${label(log.creature.type)} en ${to}`;
    case 'creatureSurvived': return `${label(log.unitType)} golpea a ${label(log.creatureType)}${dmgText(log)}; le quedan ${log.creatureHpRemaining} de vida`;
    case 'attackerLostToCreature': return `${label(log.unitType)} cae ante ${label(log.creatureType)}${dmgText(log)}`;
    case 'attackerRevived': return `${label(log.unitType)} cae ante ${label(log.creatureType)}, ¡pero el Fénix resucita!`;
    case 'creatureDefeated': return `${label(log.creatureType)} derrotado: +${log.goldReward} de oro`;
    case 'creatureTamed': return `¡${label(log.creatureType)} domado! Se une como tropa en ${to}`;

    case 'weatherSpawned': return `${weatherInfo(log.weather.type).label} sobre ${Array.isArray(log.weather.cells) ? log.weather.cells.length : 9} casillas`;
    case 'weatherEnded': return `Se disipa: ${weatherInfo(log.weather.type).label}`;
    case 'surrender': return `${playerNameOf(log.playerId)} se rindió`;
    case 'disconnect': return `${playerNameOf(log.playerId)} se desconectó y queda fuera de la partida`;
    case 'weatherKill': return `${label(log.unitType)} sucumbe al clima en ${to}`;

    case 'chestSpawned': return `Un cofre del tesoro aparece en ${to}`;
    case 'chestCollected': return `${playerNameOf(log.playerId)} abre un cofre: +${log.gold} de oro`;
    case 'creatureDespawned': return `${label(log.creature.type)} se marcha del tablero tras 10 rondas`;
    case 'weatherHeal': return `Lluvia sanadora: ${log.count} ficha(s) recuperan vida`;
    case 'weatherGold': return `${playerNameOf(log.playerId)} gana +${log.gold} de oro bajo la aurora`;
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
    <ul><li>Un castillo sostiene hasta <b>2 / 3 / 4</b> tropas según su nivel.</li>
    <li>Sobre su casilla caben <b>solo 2</b>; las demás aparecen en una casilla libre alrededor.</li>
    <li>Una ficha recién producida no actúa ese turno.</li></ul>` },
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
  { title: 'Cofres y criaturas', body: `<ul><li><b>Cofres del tesoro:</b> aparecen al azar en cualquier casilla libre. Termina un movimiento encima para abrirlos y ganar <b>10 a 50 de oro</b>.</li>
    <li><b>Criaturas</b> desde la ronda 5: derrotarlas da oro. El <b>Dragón, el Fénix y el Grifo</b> no mueren: se domestican y pasan a tu bando.</li>
    <li>Se marchan solas a las 10 rondas. Basilisco y Medusa envenenan o petrifican al contraatacar.</li></ul>` },
  { title: 'Clima', body: `<p>Desde la ronda 3 cae una tormenta sobre <b>9 casillas</b> durante 2 turnos:</p>
    <ul><li><b>Dañan (−1 vida):</b> eléctrica, nieve, arena, ácido y niebla.</li>
    <li><b>Terremoto:</b> inmoviliza a quien esté dentro.</li>
    <li><b>Lluvia:</b> cura +2 de vida.</li>
    <li><b>Eclipse:</b> impide atacar (se puede mover).</li>
    <li><b>Aurora:</b> +3 de oro por tropa propia dentro.</li></ul>` },
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
