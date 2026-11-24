import * as THREE from 'three';
import { RoomPlayerData } from './types';

export interface RemoteSurvivorRig {
  uid: string;
  root: THREE.Group;
  targetX: number;
  targetZ: number;
  targetYaw: number;
  alive: boolean;
  escaped: boolean;
  update: (dt: number, nowSec: number) => void;
  syncFromData: (data: RoomPlayerData) => void;
  dispose: () => void;
}

function createNameTagTexture(label: string, coatColor: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = 'rgba(6, 9, 19, 0.85)';
  ctx.beginPath();
  ctx.roundRect(12, 10, 232, 44, 10);
  ctx.fill();

  ctx.strokeStyle = coatColor;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(12, 10, 232, 44, 10);
  ctx.stroke();

  ctx.font = '600 22px system-ui, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label.slice(0, 18), 128, 33);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createRemoteSurvivor(
  initial: RoomPlayerData,
  contactShadowTex: THREE.Texture
): RemoteSurvivorRig {
  const root = new THREE.Group();
  root.position.set(initial.x, 0, initial.z);
  root.rotation.y = initial.yaw + Math.PI;

  const disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(d: T): T => {
    disposables.push(d);
    return d;
  };

  const coatMat = track(
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(initial.coatColor || '#3b82f6'),
      roughness: 0.78,
      metalness: 0.05,
    })
  );
  const darkPantsMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x18202c,
      roughness: 0.85,
      metalness: 0.05,
    })
  );
  const skinMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xd8b8a4,
      roughness: 0.65,
      metalness: 0.02,
    })
  );
  const scarfMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      roughness: 0.92,
      metalness: 0.0,
    })
  );
  const metalMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x334155,
      roughness: 0.3,
      metalness: 0.85,
    })
  );
  const beamGlowMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xfff3d1,
      emissive: 0xffe4a0,
      emissiveIntensity: 2.5,
      roughness: 0.2,
    })
  );

  // Ground contact shadow
  const shadow = new THREE.Mesh(
    track(new THREE.PlaneGeometry(1.1, 1.1)),
    track(
      new THREE.MeshBasicMaterial({
        map: contactShadowTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.65,
      })
    )
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.015;
  root.add(shadow);

  // Articulated Legs (bottom at y = 0)
  const makeLeg = (side: -1 | 1): THREE.Group => {
    const lg = new THREE.Group();
    lg.position.set(side * 0.14, 0.74, 0);
    const legMesh = new THREE.Mesh(track(new THREE.CylinderGeometry(0.09, 0.08, 0.64, 8)), darkPantsMat);
    legMesh.position.y = -0.32;
    lg.add(legMesh);
    const boot = new THREE.Mesh(track(new THREE.BoxGeometry(0.15, 0.16, 0.24)), darkPantsMat);
    boot.position.set(0, -0.66, 0.04);
    lg.add(boot);
    return lg;
  };
  const leftLeg = makeLeg(-1);
  const rightLeg = makeLeg(1);
  root.add(leftLeg, rightLeg);

  // Parka Torso & Backpack
  const torso = new THREE.Mesh(track(new THREE.CylinderGeometry(0.24, 0.28, 0.76, 10)), coatMat);
  torso.position.y = 1.14;
  torso.castShadow = true;
  root.add(torso);

  const scarf = new THREE.Mesh(track(new THREE.TorusGeometry(0.2, 0.06, 7, 12)), scarfMat);
  scarf.rotation.x = Math.PI / 2;
  scarf.position.y = 1.5;
  root.add(scarf);

  const pack = new THREE.Mesh(track(new THREE.BoxGeometry(0.32, 0.42, 0.18)), darkPantsMat);
  pack.position.set(0, 1.18, -0.24);
  root.add(pack);

  // Head & Winter Hood
  const head = new THREE.Mesh(track(new THREE.SphereGeometry(0.18, 10, 10)), skinMat);
  head.position.y = 1.68;
  root.add(head);

  const hood = new THREE.Mesh(
    track(new THREE.SphereGeometry(0.21, 10, 10, 0, Math.PI * 2, 0, Math.PI * 0.68)),
    coatMat
  );
  hood.position.set(0, 1.7, -0.02);
  hood.rotation.x = -0.25;
  root.add(hood);

  // Right arm holding flashlight
  const flashlightTorch = new THREE.Group();
  flashlightTorch.position.set(0.3, 1.24, 0.22);
  root.add(flashlightTorch);

  const torchBody = new THREE.Mesh(track(new THREE.CylinderGeometry(0.035, 0.035, 0.24, 8)), metalMat);
  torchBody.rotation.x = Math.PI / 2;
  flashlightTorch.add(torchBody);

  const torchLens = new THREE.Mesh(track(new THREE.CylinderGeometry(0.04, 0.04, 0.03, 8)), beamGlowMat);
  torchLens.rotation.x = Math.PI / 2;
  torchLens.position.z = 0.12;
  flashlightTorch.add(torchLens);

  const torchLight = new THREE.PointLight(0xffe6b0, 1.8, 7.5, 1.8);
  torchLight.position.set(0, 0, 0.35);
  flashlightTorch.add(torchLight);

  // Floating Name Sprite
  const nameTex = track(createNameTagTexture(initial.displayName, initial.coatColor));
  const nameMat = track(
    new THREE.SpriteMaterial({
      map: nameTex,
      transparent: true,
      depthTest: true,
    })
  );
  const nameSprite = new THREE.Sprite(nameMat);
  nameSprite.position.set(0, 2.18, 0);
  nameSprite.scale.set(1.4, 0.35, 1);
  root.add(nameSprite);

  const rig: RemoteSurvivorRig = {
    uid: initial.uid,
    root,
    targetX: initial.x,
    targetZ: initial.z,
    targetYaw: initial.yaw,
    alive: initial.alive,
    escaped: initial.escaped,
    syncFromData(data: RoomPlayerData) {
      this.targetX = data.x;
      this.targetZ = data.z;
      this.targetYaw = data.yaw;
      this.alive = data.alive;
      this.escaped = data.escaped;
      coatMat.color.set(data.coatColor || '#3b82f6');
      torchLight.intensity = data.flashlightOn && data.alive ? 1.8 : 0;
      torchLens.visible = data.flashlightOn && data.alive;
      root.visible = data.alive && !data.escaped;
    },
    update(dt: number, nowSec: number) {
      const prevX = root.position.x;
      const prevZ = root.position.z;
      root.position.x = THREE.MathUtils.damp(root.position.x, this.targetX, 10, dt);
      root.position.z = THREE.MathUtils.damp(root.position.z, this.targetZ, 10, dt);

      const desiredRotY = this.targetYaw + Math.PI;
      let deltaYaw = desiredRotY - root.rotation.y;
      while (deltaYaw > Math.PI) deltaYaw -= Math.PI * 2;
      while (deltaYaw < -Math.PI) deltaYaw += Math.PI * 2;
      root.rotation.y += deltaYaw * Math.min(1, dt * 10);

      const moveDist = Math.hypot(root.position.x - prevX, root.position.z - prevZ);
      const speed = moveDist / Math.max(0.001, dt);
      if (speed > 0.25) {
        const swing = Math.sin(nowSec * 11) * 0.45;
        leftLeg.rotation.x = swing;
        rightLeg.rotation.x = -swing;
      } else {
        leftLeg.rotation.x = THREE.MathUtils.damp(leftLeg.rotation.x, 0, 8, dt);
        rightLeg.rotation.x = THREE.MathUtils.damp(rightLeg.rotation.x, 0, 8, dt);
      }
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
    },
  };

  rig.syncFromData(initial);
  return rig;
}
