import * as THREE from 'three';

export interface TinyElfRig {
  root: THREE.Group;
  update: (
    dt: number,
    nowSec: number,
    targetX: number,
    targetZ: number,
    grid?: number[][],
    cellSize?: number,
    size?: number
  ) => void;
  dispose: () => void;
}

export function createTinyElf(
  contactShadowTex: THREE.Texture,
  isHelper = false
): TinyElfRig {
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

  let currentYaw = 0;
  let roamTimer = Math.random() * 3;
  let roamDirX = (Math.random() - 0.5) * 2;
  let roamDirZ = (Math.random() - 0.5) * 2;

  return {
    root,
    update(
      dt: number,
      nowSec: number,
      targetX: number,
      targetZ: number,
      grid?: number[][],
      cellSize?: number,
      size?: number
    ) {
      if (isHelper) {
        // Helper elf follows close behind Santa or hunts player
        const dx = targetX - root.position.x;
        const dz = targetZ - root.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 1.6) {
          const speed = 3.2;
          root.position.x += (dx / dist) * speed * dt;
          root.position.z += (dz / dist) * speed * dt;
          currentYaw = Math.atan2(dx, dz);
          root.rotation.y = currentYaw;
        }
      } else {
        // Tiny patrol elf wandering corridors and chasing player if close
        roamTimer -= dt;
        const distToPlayer = Math.hypot(targetX - root.position.x, targetZ - root.position.z);

        let moveX = roamDirX;
        let moveZ = roamDirZ;
        let speed = 1.8;

        if (distToPlayer < 9.5) {
          // Chase player!
          const dx = targetX - root.position.x;
          const dz = targetZ - root.position.z;
          const d = Math.hypot(dx, dz);
          if (d > 0.1) {
            moveX = dx / d;
            moveZ = dz / d;
            speed = 2.7;
          }
        } else if (roamTimer <= 0) {
          roamTimer = 3 + Math.random() * 4;
          const angle = Math.random() * Math.PI * 2;
          roamDirX = Math.sin(angle);
          roamDirZ = Math.cos(angle);
        }

        const nextX = root.position.x + moveX * speed * dt;
        const nextZ = root.position.z + moveZ * speed * dt;

        // Check grid collision if grid provided
        if (grid && cellSize && size) {
          const halfSpan = (size * cellSize) / 2;
          const r = Math.floor((nextZ + halfSpan) / cellSize);
          const c = Math.floor((nextX + halfSpan) / cellSize);
          if (r >= 0 && r < size && c >= 0 && c < size && grid[r][c] === 0) {
            root.position.x = nextX;
            root.position.z = nextZ;
          } else {
            roamDirX = -roamDirX;
            roamDirZ = -roamDirZ;
          }
        } else {
          root.position.x = nextX;
          root.position.z = nextZ;
        }

        const targetYaw = Math.atan2(moveX, moveZ);
        currentYaw = THREE.MathUtils.lerp(currentYaw, targetYaw, dt * 4);
        root.rotation.y = currentYaw;
      }

      root.position.y = 0.05 + Math.abs(Math.sin(nowSec * 7 + root.position.x)) * 0.12;
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
    },
  };
}
