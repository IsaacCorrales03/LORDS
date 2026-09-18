// public/sound.js
// Motor de sonido del cliente. Los .mp3 viven en /sounds/. Si falta alguno,
// simplemente no suena (no rompe el juego).

const SFX = (() => {
  const BASE = '/sounds/';
  // nombre -> [archivo, volumen 0-1]
  const DEFS = {
    // Interfaz / lobby
    ui_click: ['ui_click.mp3', 0.5],
    ui_error: ['ui_error.mp3', 0.6],
    player_join: ['player_join.mp3', 0.6],
    player_leave: ['player_leave.mp3', 0.5],
    ready_on: ['ready_on.mp3', 0.6],
    ready_off: ['ready_off.mp3', 0.5],
    game_start: ['game_start.mp3', 0.8],
    // Selección
    select_unit: ['select_unit.mp3', 0.5],
    select_castle: ['select_castle.mp3', 0.5],
    deselect: ['deselect.mp3', 0.4],
    // Turnos / rondas
    turn_mine: ['turn_mine.mp3', 0.8],
    turn_other: ['turn_other.mp3', 0.35],
    end_turn: ['end_turn.mp3', 0.6],
    harvest: ['harvest.mp3', 0.7],
    // Movimiento
    move_walk: ['move_walk.mp3', 0.6],
    move_horse: ['move_horse.mp3', 0.6],
    move_fly: ['move_fly.mp3', 0.6],
    garrison: ['garrison.mp3', 0.6],
    // Construcción / economía
    produce: ['produce.mp3', 0.7],
    build_farm: ['build_farm.mp3', 0.7],
    upgrade_castle: ['upgrade_castle.mp3', 0.8],
    heal: ['heal.mp3', 0.5],
    coins: ['coins.mp3', 0.7],
    // Conquista
    castle_claim: ['castle_claim.mp3', 0.7],
    castle_captured: ['castle_captured.mp3', 0.8],
    farm_captured: ['farm_captured.mp3', 0.6],
    // Combate
    swing: ['swing.mp3', 0.5],
    hit: ['hit.mp3', 0.7],
    hit_counter: ['hit_counter.mp3', 0.6],
    unit_death: ['unit_death.mp3', 0.7],
    // Criaturas
    creature_spawn_lobo: ['creature_spawn_lobo.mp3', 0.8],
    creature_spawn_golem: ['creature_spawn_golem.mp3', 0.8],
    creature_spawn_dragon: ['creature_spawn_dragon.mp3', 0.9],
    creature_spawn_hidra: ['creature_spawn_hidra.mp3', 0.9],
    creature_spawn_fenix: ['creature_spawn_fenix.mp3', 0.9],
    creature_death: ['creature_death.mp3', 0.8],
    creature_tamed: ['creature_tamed.mp3', 0.9],
    // Clima
    weather_electrica: ['weather_electrica.mp3', 0.7],
    weather_nieve: ['weather_nieve.mp3', 0.7],
    weather_arena: ['weather_arena.mp3', 0.7],
    weather_acido: ['weather_acido.mp3', 0.7],
    weather_niebla: ['weather_niebla.mp3', 0.7],
    weather_terremoto: ['weather_terremoto.mp3', 0.8],
    weather_end: ['weather_end.mp3', 0.5],
    weather_kill: ['weather_kill.mp3', 0.6],
    // Fénix
    phoenix_revive: ['phoenix_revive.mp3', 0.9],
    phoenix_lost: ['phoenix_lost.mp3', 0.7],
    // Fin de partida
    victory: ['victory.mp3', 0.9],
    defeat: ['defeat.mp3', 0.9],
  };
  const MUSIC_FILE = 'music_theme.mp3';
  const MUSIC_VOL = 0.25;

  const cache = {};
  let sfxOn = true;
  let musicOn = true;
  let music = null;
  let musicStarted = false;
  let lobbyCount = null;
  let lobbyReadySet = null;

  try {
    sfxOn = localStorage.getItem('sfxOn') !== '0';
    musicOn = localStorage.getItem('musicOn') !== '0';
  } catch (e) { /* sin storage: valores por defecto */ }

  function load(name) {
    if (cache[name]) return cache[name];
    const def = DEFS[name];
    if (!def) return null;
    const a = new Audio(BASE + def[0]);
    a.preload = 'auto';
    a.volume = def[1];
    cache[name] = a;
    return a;
  }

  function play(name) {
    if (!sfxOn) return;
    const base = load(name);
    if (!base) return;
    // Clonar permite superponer el mismo sonido (varios golpes seguidos).
    const a = base.cloneNode();
    a.volume = base.volume;
    a.play().catch(() => {});
  }
  function later(name, ms) { setTimeout(() => play(name), ms); }

  // ---------- Música ----------
  function ensureMusic() {
    if (music) return music;
    music = new Audio(BASE + MUSIC_FILE);
    music.loop = true;
    music.volume = MUSIC_VOL;
    return music;
  }
  function startMusic() {
    if (!musicOn) return;
    ensureMusic().play().then(() => { musicStarted = true; }).catch(() => {});
  }
  function stopMusic() { if (music) music.pause(); }

  // Los navegadores bloquean el audio hasta la primera interacción.
  function unlock() {
    startMusic();
    if (musicStarted) {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    }
  }
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  // ---------- Botones mute ----------
  // Van arriba a la derecha, dentro del hueco que .topbar reserva con
  // padding-right (style.css), así no tapan el indicador "Turno de".
  // El contenedor tiene id "sound-controls": se puede mover desde style.css.
  const ICONS = {
    music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    sfx: '<path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  };
  function buildControls() {
    if (document.getElementById('sound-controls')) return;
    const wrap = document.createElement('div');
    wrap.id = 'sound-controls';
    wrap.style.cssText = 'position:fixed;top:11px;right:12px;z-index:60;display:flex;gap:6px;';
    const mk = (title, icon, get, set) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.style.cssText = 'background:#141b26;color:#ece3c9;border:1px solid #3a4658;border-radius:8px;width:34px;height:34px;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;';
      const paint = () => {
        const off = !get();
        b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
          + ICONS[icon] + (off ? '<path d="M3 3l18 18"/>' : '') + '</svg>';
        b.style.opacity = off ? '0.55' : '1';
      };
      b.addEventListener('click', () => { set(!get()); paint(); });
      paint();
      wrap.appendChild(b);
    };
    mk('Música', 'music', () => musicOn, (v) => {
      musicOn = v;
      try { localStorage.setItem('musicOn', v ? '1' : '0'); } catch (e) {}
      if (v) startMusic(); else stopMusic();
    });
    mk('Efectos de sonido', 'sfx', () => sfxOn, (v) => {
      sfxOn = v;
      try { localStorage.setItem('sfxOn', v ? '1' : '0'); } catch (e) {}
    });
    document.body.appendChild(wrap);
  }
  if (document.body) buildControls();
  else document.addEventListener('DOMContentLoaded', buildControls);

  // ---------- Lobby: detectar entradas/salidas y "listo" ajenos ----------
  function lobbyUpdate(state, myId) {
    const n = state.players.length;
    if (lobbyCount !== null) {
      if (n > lobbyCount) play('player_join');
      else if (n < lobbyCount) play('player_leave');
    }
    lobbyCount = n;
  }

  // ---------- Eventos de log del servidor (todos los jugadores) ----------
  function moveSoundFor(unitType) {
    if (unitType === 'dragon' || unitType === 'fenix') return 'move_fly';
    if (unitType === 'caballo') return 'move_horse';
    return 'move_walk';
  }
  function strike(log, withSwing = true) {
    let t = 0;
    if (withSwing) { play('swing'); t = 120; }
    later('hit', t);
    if (log.counter) later('hit_counter', t + 320);
    return t + (log.counter ? 320 : 0);
  }

  function onLog(log) {
    if (!log) return;
    switch (log.event) {
      // Movimiento y conquista sin combate
      case 'moved': play(moveSoundFor(log.unitType)); return;
      case 'garrisoned': play(moveSoundFor(log.unitType)); later('garrison', 250); return;
      case 'neutralCastleCaptured': play(moveSoundFor(log.unitType)); later('castle_claim', 300); return;
      case 'castleCaptured': play(moveSoundFor(log.unitType)); later('castle_captured', 300); return;
      case 'farmCaptured': play(moveSoundFor(log.unitType)); later('farm_captured', 300); return;

      // Combate contra castillos / campo abierto
      case 'attackerWinsCastle': { const t = strike(log); later('unit_death', t + 350); later('castle_captured', t + 750); return; }
      case 'castleDefenderKilled': { const t = strike(log); later('unit_death', t + 350); return; }
      case 'castleStandoff':
      case 'fieldCombatStandoff': strike(log); return;
      case 'defenderWinsCastle':
      case 'fieldCombatDefenderWins': { const t = strike(log); later('unit_death', t + 400); return; }
      case 'fieldCombatAttackerWins': { const t = strike(log); later('unit_death', t + 350); return; }

      // Criaturas
      case 'creatureSpawned': play('creature_spawn_' + (log.creature && log.creature.type)); return;
      case 'creatureSurvived': strike(log); return;
      case 'attackerLostToCreature': { const t = strike(log); later('unit_death', t + 400); return; }
      case 'attackerRevived': strike(log); return; // el sonido del Fénix llega con phoenixRevived
      case 'creatureDefeated': { const t = strike(log); later('creature_death', t + 350); later('coins', t + 800); return; }
      case 'creatureTamed': { const t = strike(log); later('creature_tamed', t + 400); return; }

      // Clima
      case 'weatherSpawned': play('weather_' + (log.weather && log.weather.type)); return;
      case 'weatherEnded': play('weather_end'); return;
      case 'weatherKill': play('weather_kill'); later('unit_death', 250); return;

      // Fénix
      case 'phoenixRevived': play('phoenix_revive'); return;
      case 'phoenixLost': play('phoenix_lost'); return;

      // Rendición / desconexión
      case 'surrender':
      case 'disconnect': play('player_leave'); return;

      // Economía
      case 'healed': play('heal'); return;
      default: break;
    }
    // Acciones sin "event": producir, granja, mejora
    if (log.type === 'produce') play('produce');
    else if (log.type === 'buildFarm') play('build_farm');
    else if (log.type === 'upgradeCastle') play('upgrade_castle');
  }

  // Precarga tras el primer gesto para que no haya lag en el primer golpe.
  window.addEventListener('pointerdown', () => Object.keys(DEFS).forEach(load), { once: true });

  return { play, later, onLog, lobbyUpdate, startMusic, stopMusic };
})();
