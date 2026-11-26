import * as THREE from 'three';
import { createRng } from './maze';

export interface ElfTarget {
  x: number;
  z: number;
}

export interface TinyElfRig {
  root: THREE.Group;
  update: (
    dt: number,
    nowSec: number,
    targets: ElfTarget[],
    santaPos?: ElfTarget | null,
    grid?: number[][],
    cellSize?: number,
    size?: number
  ) => ElfTarget | null;
  dispose: () => void;
}

function isWalkableWorld(
  wx: number,
  wz: number,
  grid: number[][],
  cellSize: number,
  size: number,
  radius = 0.28
): boolean {
  const half = ((size - 1) * cellSize) / 2;
  const offsets = [
    [0, 0],
    [radius, 0],
    [-radius, 0],
    [0, radius],
    [0, -radius],
  ];
  for (const [ox, oz] of offsets) {
    const c = Math.round((wx + ox + half) / cellSize);
    const r = Math.round((wz + oz + half) / cellSize);
    if (r < 0 || r >= size || c < 0 || c >= size || grid[r][c] !== 0) {
      return false;
    }
  }
  return true;
}

export function createTinyElf(
  contactShadowTex: THREE.Texture,
  isHelper = false,
  seed = 101
): TinyElfRig {
  const rng = createRng(seed);
  const root = new THREE.Group();
  const disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(d: T): T => {
    disposables.push(d);
    return d;
  };

  const scale = isHelper ? 0.72 : 0.58;
  root.scale.setScalar(scale);

  const greenClothMat = track(
    new THREE.MeshStandardMaterial({
      color: isHelper ? 0x047857 : 0x059669,
      roughness: 0.75,
      metalness: 0.05,
    })
  );
  const redTrimMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x991b1b,
      roughness: 0.8,
      metalness: 0.05,
    })
  );
  const skinMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xfca5a5,
      roughness: 0.65,
      metalness: 0.02,
    })
  );
  const hatMat = track(
    new THREE.MeshStandardMaterial({
      color: isHelper ? 0xb91c1c : 0x047857,
      roughness: 0.8,
      metalness: 0.05,
    })
  );
  const whitePomMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xf8fafc,
      roughness: 0.9,
      metalness: 0.0,
    })
  );

  const shadow = new THREE.Mesh(
    track(new THREE.PlaneGeometry(0.8, 0.8)),
    track(
      new THREE.MeshBasicMaterial({
        map: contactShadowTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.55,
      })
    )
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.015;
  root.add(shadow);

  // Body
  const body = new THREE.Mesh(track(new THREE.CylinderGeometry(0.18, 0.22, 0.48, 8)), greenClothMat);
  body.position.y = 0.36;
  root.add(body);

  const belt = new THREE.Mesh(track(new THREE.BoxGeometry(0.38, 0.06, 0.38)), redTrimMat);
  belt.position.y = 0.28;
  root.add(belt);

  // Head
  const head = new THREE.Mesh(track(new THREE.SphereGeometry(0.16, 10, 10)), skinMat);
  head.position.y = 0.74;
  root.add(head);

  // Pointy Elf Hat
  const hatBase = new THREE.Mesh(track(new THREE.CylinderGeometry(0.15, 0.17, 0.1, 10)), redTrimMat);
  hatBase.position.y = 0.84;
  const hatCone = new THREE.Mesh(track(new THREE.ConeGeometry(0.16, 0.35, 10)), hatMat);
  hatCone.position.set(0, 1.05, -0.04);
  hatCone.rotation.x = -0.3;
  const pom = new THREE.Mesh(track(new THREE.SphereGeometry(0.045, 8, 8)), whitePomMat);
  pom.position.set(0, 1.22, -0.12);
  root.add(hatBase, hatCone, pom);

  const cardinals: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const initCard = cardinals[Math.floor(rng() * cardinals.length)];
  let currentYaw = 0;
  let roamTimer = 1.5 + rng() * 3.0;
  let roamDirX = initCard[0];
  let roamDirZ = initCard[1];

  return {
    root,
    update(
      dt: number,
      nowSec: number,
      targets: ElfTarget[],
      santaPos?: ElfTarget | null,
      grid?: number[][],
      cellSize?: number,
      size?: number
    ): ElfTarget | null {
      // Find nearest alive survivor among all players
      let nearestPlayer: ElfTarget | null = null;
      let nearestDist = Infinity;
      for (const t of targets) {
        const d = Math.hypot(t.x - root.position.x, t.z - root.position.z);
        if (d < nearestDist) {
          nearestDist = d;
          nearestPlayer = t;
        }
      }

      if (isHelper) {
        // Nightmare Helper Elf scouts slightly ahead of Santa and alerts him when a survivor is nearby
        let targetX = santaPos ? santaPos.x : root.position.x;
        let targetZ = santaPos ? santaPos.z : root.position.z;
        let spotted: ElfTarget | null = null;

        if (nearestPlayer && nearestDist < 7.5) {
          spotted = nearestPlayer;
          const distFromSanta = santaPos
            ? Math.hypot(nearestPlayer.x - santaPos.x, nearestPlayer.z - santaPos.z)
            : 0;
          if (distFromSanta < 9.5) {
            targetX = nearestPlayer.x;
            targetZ = nearestPlayer.z;
          }
        }

        const dx = targetX - root.position.x;
        const dz = targetZ - root.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 1.35) {
          const speed = spotted ? 3.8 : 3.25;
          const stepX = (dx / dist) * speed * dt;
          const stepZ = (dz / dist) * speed * dt;
          if (grid && cellSize && size) {
            if (isWalkableWorld(root.position.x + stepX, root.position.z, grid, cellSize, size, 0.25)) {
              root.position.x += stepX;
            }
            if (isWalkableWorld(root.position.x, root.position.z + stepZ, grid, cellSize, size, 0.25)) {
              root.position.z += stepZ;
            }
          } else {
            root.position.x += stepX;
            root.position.z += stepZ;
          }
          currentYaw = Math.atan2(dx, dz);
          root.rotation.y = currentYaw;
        }

        root.position.y = 0.05 + Math.abs(Math.sin(nowSec * 8.5 + root.position.x)) * 0.14;
        return spotted;
      }

      // Tiny patrol elf deterministically wandering corridors and chasing closest player
      roamTimer -= dt;
      let moveX = roamDirX;
      let moveZ = roamDirZ;
      let speed = 1.9;

      if (nearestPlayer && nearestDist < 9.5 && nearestDist > 0.2) {
        const dx = nearestPlayer.x - root.position.x;
        const dz = nearestPlayer.z - root.position.z;
        moveX = dx / nearestDist;
        moveZ = dz / nearestDist;
        speed = 2.65;
      } else if (roamTimer <= 0) {
        roamTimer = 2.5 + rng() * 3.5;
        if (grid && cellSize && size) {
          const openDirs = cardinals.filter(([cx, cz]) =>
            isWalkableWorld(
              root.position.x + cx * 0.85,
              root.position.z + cz * 0.85,
              grid,
              cellSize,
              size,
              0.26
            )
          );
          if (openDirs.length > 0) {
            const pick = openDirs[Math.floor(rng() * openDirs.length)];
            roamDirX = pick[0];
            roamDirZ = pick[1];
            moveX = roamDirX;
            moveZ = roamDirZ;
          }
        } else {
          const angle = rng() * Math.PI * 2;
          roamDirX = Math.sin(angle);
          roamDirZ = Math.cos(angle);
          moveX = roamDirX;
          moveZ = roamDirZ;
        }
      }

      const stepX = moveX * speed * dt;
      const stepZ = moveZ * speed * dt;

      if (grid && cellSize && size) {
        let moved = false;
        if (isWalkableWorld(root.position.x + stepX, root.position.z, grid, cellSize, size, 0.26)) {
          root.position.x += stepX;
          moved = true;
        }
        if (isWalkableWorld(root.position.x, root.position.z + stepZ, grid, cellSize, size, 0.26)) {
          root.position.z += stepZ;
          moved = true;
        }
        if (!moved) {
          roamTimer = 0; // Pick a new open corridor immediately
          const openDirs = cardinals.filter(([cx, cz]) =>
            isWalkableWorld(
              root.position.x + cx * 0.7,
              root.position.z + cz * 0.7,
              grid,
              cellSize,
              size,
              0.26
            )
          );
          if (openDirs.length > 0) {
            const pick = openDirs[Math.floor(rng() * openDirs.length)];
            roamDirX = pick[0];
            roamDirZ = pick[1];
          } else {
            roamDirX = -roamDirX;
            roamDirZ = -roamDirZ;
          }
        }
      } else {
        root.position.x += stepX;
        root.position.z += stepZ;
      }

      const targetYaw = Math.atan2(moveX, moveZ);
      let deltaYaw = targetYaw - currentYaw;
      while (deltaYaw > Math.PI) deltaYaw -= Math.PI * 2;
      while (deltaYaw < -Math.PI) deltaYaw += Math.PI * 2;
      currentYaw += deltaYaw * Math.min(1, dt * 6);
      root.rotation.y = currentYaw;
      root.position.y = 0.05 + Math.abs(Math.sin(nowSec * 7 + root.position.x)) * 0.12;
      return null;
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
    },
  };
}
