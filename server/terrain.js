// server/terrain.js
// Utilidades sobre el tablero relacionadas con accesibilidad de casillas.

// Una casilla es "accesible" para spawnear una criatura si existe, no es un
// castillo (propio, neutral o ajeno) y no está marcada como inaccesible.
function isAccessibleTile(state, x, y) {
  if (y < 0 || y >= state.boardSize || x < 0 || x >= state.boardSize) return false;
  const tile = state.tiles[y][x];
  if (!tile) return false;
  if (tile.type === 'castle') return false;
  if (tile.type === 'inaccessible') return false;
  return true;
}

// Busca una casilla accesible y libre al azar (según isFreeFn(state, x, y)).
// Reintenta un número acotado de veces antes de rendirse; si el tablero está
// muy lleno puede no encontrar ninguna, en cuyo caso devuelve null.
function getRandomAccessibleFreeTile(state, isFreeFn, maxAttempts = 300) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const x = Math.floor(Math.random() * state.boardSize);
    const y = Math.floor(Math.random() * state.boardSize);
    if (!isAccessibleTile(state, x, y)) continue;
    if (isFreeFn && !isFreeFn(state, x, y)) continue;
    return { x, y };
  }

  // Fallback exhaustivo: si el azar no encontró nada en maxAttempts intentos
  // (tablero casi lleno), se recorre todo el tablero una vez.
  const candidates = [];
  for (let y = 0; y < state.boardSize; y++) {
    for (let x = 0; x < state.boardSize; x++) {
      if (!isAccessibleTile(state, x, y)) continue;
      if (isFreeFn && !isFreeFn(state, x, y)) continue;
      candidates.push({ x, y });
    }
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// --- Casillas inaccesibles ("huecos") ---
// Se generan una sola vez al crear el mapa. El 10% del tablero (sin contar
// castillos ni su anillo 3x3 de los castillos iniciales) queda inaccesible, y
// luego se valida por flood-fill que todos los castillos estén conectados.
const INACCESSIBLE_RATIO = 0.10;
const CARDINAL = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function floodFill(tiles, size, startX, startY) {
  const seen = new Set([`${startX},${startY}`]);
  const stack = [[startX, startY]];
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [dx, dy] of CARDINAL) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const key = `${nx},${ny}`;
      if (seen.has(key)) continue;
      if (tiles[ny][nx].type === 'inaccessible') continue;
      seen.add(key);
      stack.push([nx, ny]);
    }
  }
  return seen;
}

function generateInaccessibleTiles(tiles, size, castles, startCastles) {
  const protectedKeys = new Set();
  castles.forEach((c) => protectedKeys.add(`${c.x},${c.y}`));
  startCastles.forEach((c) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) protectedKeys.add(`${c.x + dx},${c.y + dy}`);
    }
  });

  const candidates = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (tiles[y][x].type === 'neutral' && !protectedKeys.has(`${x},${y}`)) candidates.push({ x, y });
    }
  }
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const target = Math.min(candidates.length, Math.round(size * size * INACCESSIBLE_RATIO));
  const holes = candidates.slice(0, target);
  holes.forEach(({ x, y }) => { tiles[y][x].type = 'inaccessible'; });

  // Validación: todos los castillos deben quedar conectados al primero. Si un
  // hueco aísla a un castillo, se regenera un hueco de su frontera como accesible.
  const base = castles[0];
  let guard = holes.length + 5;
  while (guard-- > 0) {
    const reached = floodFill(tiles, size, base.x, base.y);
    const isolated = castles.find((c) => !reached.has(`${c.x},${c.y}`));
    if (!isolated) break;

    const comp = floodFill(tiles, size, isolated.x, isolated.y);
    const boundary = [];
    comp.forEach((key) => {
      const [x, y] = key.split(',').map(Number);
      CARDINAL.forEach(([dx, dy]) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) return;
        if (tiles[ny][nx].type === 'inaccessible') boundary.push({ x: nx, y: ny });
      });
    });
    if (boundary.length === 0) break;
    const pick = boundary[Math.floor(Math.random() * boundary.length)];
    tiles[pick.y][pick.x].type = 'neutral';
  }
}

module.exports = {
  isAccessibleTile,
  getRandomAccessibleFreeTile,
  generateInaccessibleTiles,
  INACCESSIBLE_RATIO,
};
