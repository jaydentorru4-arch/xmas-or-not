import { GridCoord, MazeData } from './types';

export const MAZE_SIZE = 17; // Must be odd (interior nodes 1..15)
export const CELL_SIZE = 4.0;
export const WALL_HEIGHT = 3.8;

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function cellToWorld(r: number, c: number, size = MAZE_SIZE, cellSize = CELL_SIZE): { x: number; z: number } {
  const half = ((size - 1) * cellSize) / 2;
  return {
    x: c * cellSize - half,
    z: r * cellSize - half,
  };
}

export function worldToCell(x: number, z: number, size = MAZE_SIZE, cellSize = CELL_SIZE): GridCoord {
  const half = ((size - 1) * cellSize) / 2;
  return {
    c: Math.round((x + half) / cellSize),
    r: Math.round((z + half) / cellSize),
  };
}

export function generateMaze(ornamentCount = 5): MazeData {
  const size = MAZE_SIZE;
  const grid: number[][] = Array.from({ length: size }, () => Array(size).fill(1));

  // Recursive backtracker on odd cells
  const startR = 1;
  const startC = 1;
  grid[startR][startC] = 0;

  const stack: GridCoord[] = [{ r: startR, c: startC }];
  const dirs = [
    { dr: -2, dc: 0 },
    { dr: 2, dc: 0 },
    { dr: 0, dc: -2 },
    { dr: 0, dc: 2 },
  ];

  while (stack.length > 0) {
    const curr = stack[stack.length - 1];
    const shuffled = shuffle([...dirs]);
    let carved = false;

    for (const d of shuffled) {
      const nr = curr.r + d.dr;
      const nc = curr.c + d.dc;
      if (nr > 0 && nr < size - 1 && nc > 0 && nc < size - 1 && grid[nr][nc] === 1) {
        grid[curr.r + d.dr / 2][curr.c + d.dc / 2] = 0;
        grid[nr][nc] = 0;
        stack.push({ r: nr, c: nc });
        carved = true;
        break;
      }
    }

    if (!carved) {
      stack.pop();
    }
  }

  // Carve strategic loops (~20% of interior walls separating two open cells)
  // so players can outmaneuver Evil Santa rather than getting cornered in dead ends.
  const candidates: GridCoord[] = [];
  for (let r = 2; r < size - 2; r++) {
    for (let c = 2; c < size - 2; c++) {
      if (grid[r][c] !== 1) continue;
      const horizOpen = grid[r][c - 1] === 0 && grid[r][c + 1] === 0 && grid[r - 1][c] === 1 && grid[r + 1][c] === 1;
      const vertOpen = grid[r - 1][c] === 0 && grid[r + 1][c] === 0 && grid[r][c - 1] === 1 && grid[r][c + 1] === 1;
      if (horizOpen || vertOpen) {
        candidates.push({ r, c });
      }
    }
  }
  shuffle(candidates);
  const loopCount = Math.floor(candidates.length * 0.24);
  for (let i = 0; i < loopCount; i++) {
    grid[candidates[i].r][candidates[i].c] = 0;
  }

  // BFS distances from playerSpawn (1,1)
  const playerSpawn: GridCoord = { r: 1, c: 1 };
  const distMap = computeDistanceMap(grid, playerSpawn);

  const openCells: { r: number; c: number; dist: number }[] = [];
  for (let r = 1; r < size - 1; r++) {
    for (let c = 1; c < size - 1; c++) {
      if (grid[r][c] === 0) {
        openCells.push({ r, c, dist: distMap[r][c] });
      }
    }
  }

  // Exit cell at one of the furthest corners/edges
  openCells.sort((a, b) => b.dist - a.dist);
  const exitCandidate = openCells.find((cell) => cell.r >= size - 4 && cell.c >= size - 4) ?? openCells[0];
  const exitCell: GridCoord = { r: exitCandidate.r, c: exitCandidate.c };

  // Santa spawns far away from player (e.g., opposite diagonal quadrant)
  const santaCandidate =
    openCells.find(
      (cell) =>
        cell.dist >= 14 &&
        (cell.r !== exitCell.r || cell.c !== exitCell.c) &&
        Math.abs(cell.r - exitCell.r) + Math.abs(cell.c - exitCell.c) >= 4
    ) ?? openCells[1];
  const santaSpawn: GridCoord = { r: santaCandidate.r, c: santaCandidate.c };

  // Distribute ornaments across distinct regions of the maze
  const ornaments: GridCoord[] = [];
  const eligible = openCells.filter(
    (cell) =>
      cell.dist >= 5 &&
      (cell.r !== exitCell.r || cell.c !== exitCell.c) &&
      (cell.r !== santaSpawn.r || cell.c !== santaSpawn.c)
  );
  shuffle(eligible);

  let minSpacing = 6;
  while (ornaments.length < ornamentCount && minSpacing >= 2) {
    for (const cand of eligible) {
      if (ornaments.length >= ornamentCount) break;
      const already = ornaments.some((o) => o.r === cand.r && o.c === cand.c);
      if (already) continue;
      const farEnough = ornaments.every((o) => Math.abs(o.r - cand.r) + Math.abs(o.c - cand.c) >= minSpacing);
      if (farEnough) {
        ornaments.push({ r: cand.r, c: cand.c });
      }
    }
    minSpacing--;
  }

  return {
    size,
    cellSize: CELL_SIZE,
    wallHeight: WALL_HEIGHT,
    grid,
    playerSpawn,
    santaSpawn,
    exitCell,
    ornaments,
  };
}

export function computeDistanceMap(grid: number[][], start: GridCoord): number[][] {
  const size = grid.length;
  const dist: number[][] = Array.from({ length: size }, () => Array(size).fill(Infinity));
  const queue: GridCoord[] = [start];
  dist[start.r][start.c] = 0;

  let head = 0;
  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];

  while (head < queue.length) {
    const curr = queue[head++];
    const nextDist = dist[curr.r][curr.c] + 1;
    for (const [dr, dc] of dirs) {
      const nr = curr.r + dr;
      const nc = curr.c + dc;
      if (nr >= 0 && nr < size && nc >= 0 && nc < size && grid[nr][nc] === 0 && dist[nr][nc] > nextDist) {
        dist[nr][nc] = nextDist;
        queue.push({ r: nr, c: nc });
      }
    }
  }
  return dist;
}

export function findNextStepBFS(grid: number[][], from: GridCoord, to: GridCoord): GridCoord | null {
  if (from.r === to.r && from.c === to.c) return to;
  const size = grid.length;
  const visited = Array.from({ length: size }, () => Array(size).fill(false));
  const parent: (GridCoord | null)[][] = Array.from({ length: size }, () => Array(size).fill(null));
  const queue: GridCoord[] = [from];
  visited[from.r][from.c] = true;

  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];

  let head = 0;
  let found = false;
  while (head < queue.length) {
    const curr = queue[head++];
    if (curr.r === to.r && curr.c === to.c) {
      found = true;
      break;
    }
    for (const [dr, dc] of dirs) {
      const nr = curr.r + dr;
      const nc = curr.c + dc;
      if (nr >= 0 && nr < size && nc >= 0 && nc < size && grid[nr][nc] === 0 && !visited[nr][nc]) {
        visited[nr][nc] = true;
        parent[nr][nc] = curr;
        queue.push({ r: nr, c: nc });
      }
    }
  }

  if (!found) return null;
  let step: GridCoord = to;
  while (parent[step.r][step.c]) {
    const p = parent[step.r][step.c]!;
    if (p.r === from.r && p.c === from.c) {
      return step;
    }
    step = p;
  }
  return step;
}

export function hasLineOfSight(
  grid: number[][],
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cellSize = CELL_SIZE
): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.05) return true;
  const steps = Math.ceil(dist / 0.35);
  const size = grid.length;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const px = ax + dx * t;
    const pz = az + dz * t;
    const cell = worldToCell(px, pz, size, cellSize);
    if (cell.r < 0 || cell.r >= size || cell.c < 0 || cell.c >= size || grid[cell.r][cell.c] === 1) {
      return false;
    }
  }
  return true;
}
