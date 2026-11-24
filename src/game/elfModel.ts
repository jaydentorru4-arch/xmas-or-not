import * as THREE from 'three';

export interface TinyElfRig {
  root: THREE.Group;
  update: (dt: number, nowSec: number, targetX: number, targetZ: number) => void;
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

  let currentX = 0;
  let currentZ = 0;

  return {
    root,
    update(dt: number, nowSec: number, targetX: number, targetZ: number) {
      if (isHelper) {
        // Helper elf follows close behind Santa or hunts player
        const dx = targetX - root.position.x;
        const dz = targetZ - root.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 1.8) {
          root.position.x += (dx / dist) * 2.8 * dt;
          root.position.z += (dz / dist) * 2.8 * dt;
          root.rotation.y = Math.atan2(dx, dz);
        }
      } else {
        // Patrol wander
        root.position.y = 0.1 + Math.sin(nowSec * 6 + root.position.x) * 0.05;
      }
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
    },
  };
}
