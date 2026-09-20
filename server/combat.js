// server/combat.js
// Sistema de combate por vida/ataque (reemplaza la degradación por rango).
//
// Reglas:
//   - Atacar: daño = ataque del atacante, restado a la vida del defensor.
//   - Si el defensor sobrevive, contraataca automáticamente.
//   - Si el golpe mata al defensor, no hay contraataque.
//   - Vida 0 = ficha eliminada.
//   - Mejoras de criaturas (ver creatures.js / units.js): el ataque y la
//     defensa extra NO se guardan en la ficha; se pasan como modificadores a
//     duel(), así las tropas nuevas los heredan sin código extra.

const UNIT_STATS = {
  rey:     { atk: 0, hp: 10 }, // no ataca ni se mueve; solo puede ser atacado
  peon:    { atk: 2, hp: 4 },
  caballo: { atk: 3, hp: 6 },
  alfil:   { atk: 3, hp: 6 },
  torre:   { atk: 4, hp: 8 },
  reina:   { atk: 5, hp: 10 },
  dragon:  { atk: 5, hp: 12 }, // tropa desbloqueada: se produce en castillo (ver gameState.js)
  fenix:   { atk: 4, hp: 10 }, // tropa desbloqueada, puede resucitar (ver units.js)
  grifo:   { atk: 4, hp: 11 }, // tropa desbloqueada (ver creatures.js)
};

function statsFor(type) {
  return UNIT_STATS[type] || { atk: 1, hp: 1 };
}

// Un "duelo" de una sola ronda: golpe del atacante y, si el defensor
// sobrevive, contraataque. Muta hp de ambos.
//
//   defenseBonus: reducción de daño del defensor por el castillo (nivel 3).
//   mods (todos opcionales, por defecto 0):
//     attackerAtk / defenderAtk -> ataque extra (mejora del Lobo)
//     attackerDef / defenderDef -> defensa extra (mejora del Golem)
//
// El daño mínimo siempre es 1. El Rey (atk 0) nunca contraataca.
function duel(attacker, defender, defenseBonus = 0, mods = {}) {
  const aAtk = attacker.atk + (mods.attackerAtk || 0);
  const dAtk = defender.atk + (mods.defenderAtk || 0);

  const dealt = Math.max(1, aAtk - defenseBonus - (mods.defenderDef || 0));
  defender.hp -= dealt;

  if (defender.hp <= 0) {
    defender.hp = 0;
    return { dealt, counter: 0, defenderDied: true, attackerDied: false };
  }

  const counter = defender.atk > 0 ? Math.max(1, dAtk - (mods.attackerDef || 0)) : 0;
  if (counter > 0) attacker.hp -= counter;
  if (attacker.hp <= 0) {
    attacker.hp = 0;
    return { dealt, counter, defenderDied: false, attackerDied: true };
  }
  return { dealt, counter, defenderDied: false, attackerDied: false };
}

// Ficha propia vs criatura neutral (misma regla: golpe, y contraataque si
// sobrevive). Las criaturas no tienen mejoras: solo se pasan las del atacante.
function resolveAttack(unit, creature, mods = {}) {
  return duel(unit, creature, 0, mods);
}

module.exports = { UNIT_STATS, statsFor, duel, resolveAttack };
