// server/combat.js
// Sistema de combate por vida/ataque (reemplaza la degradación por rango).
//
// Reglas:
//   - Atacar: daño = ataque del atacante, restado a la vida del defensor.
//   - Si el defensor sobrevive, contraataca automáticamente.
//   - Si el golpe mata al defensor, no hay contraataque.
//   - Vida 0 = ficha eliminada.

const UNIT_STATS = {
  rey:     { atk: 0, hp: 10 }, // no ataca ni se mueve; solo puede ser atacado
  peon:    { atk: 2, hp: 4 },
  caballo: { atk: 3, hp: 6 },
  alfil:   { atk: 3, hp: 6 },
  torre:   { atk: 4, hp: 8 },
  reina:   { atk: 5, hp: 10 },
  dragon:  { atk: 5, hp: 12 }, // tropa domada
  fenix:   { atk: 4, hp: 10 }, // tropa domada, puede resucitar (ver units.js)
};

function statsFor(type) {
  return UNIT_STATS[type] || { atk: 1, hp: 1 };
}

// Un "duelo" de una sola ronda: golpe del atacante y, si el defensor
// sobrevive, contraataque. `defenseBonus` reduce el daño recibido por el
// defensor (bonus de castillo nivel 3). Muta hp de ambos.
function duel(attacker, defender, defenseBonus = 0) {
  const dealt = Math.max(1, attacker.atk - defenseBonus);
  defender.hp -= dealt;

  if (defender.hp <= 0) {
    defender.hp = 0;
    return { dealt, counter: 0, defenderDied: true, attackerDied: false };
  }

  const counter = defender.atk > 0 ? defender.atk : 0;
  if (counter > 0) attacker.hp -= counter;
  if (attacker.hp <= 0) {
    attacker.hp = 0;
    return { dealt, counter, defenderDied: false, attackerDied: true };
  }
  return { dealt, counter, defenderDied: false, attackerDied: false };
}

// Ficha propia vs criatura neutral (misma regla: golpe, y contraataque si sobrevive).
function resolveAttack(unit, creature) {
  return duel(unit, creature, 0);
}

module.exports = { UNIT_STATS, statsFor, duel, resolveAttack };
