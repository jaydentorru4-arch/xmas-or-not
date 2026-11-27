import * as THREE from 'three';
import { buildWeaponCompositeMesh } from './props';
import { HatStyle, RoomPlayerData, WeaponType } from './types';

export interface RemoteSurvivorRig {
  uid: string;
  displayName: string;
  coatColorHex: string;
  root: THREE.Group;
  targetX: number;
  targetZ: number;
  targetYaw: number;
  flashlightOn: boolean;
  alive: boolean;
  escaped: boolean;
  stunned: boolean;
  equippedWeapon: WeaponType | '';
  shotCount: number;
  reviveCount: number;
  update: (dt: number, nowSec: number) => void;
  syncFromData: (data: RoomPlayerData) => {
    justCaught: boolean;
    justRevived: boolean;
    justEscaped: boolean;
    justStunned: boolean;
    justShot: boolean;
    shotHit: boolean;
  };
  dispose: () => void;
}

function createNameTagTexture(
  label: string,
  coatColor: string,
  statusBadge?: 'TRAPPED' | 'REVIVE (R)'
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = statusBadge === 'TRAPPED'
    ? 'rgba(124, 45, 18, 0.92)'
    : statusBadge === 'REVIVE (R)'
      ? 'rgba(6, 78, 59, 0.92)'
      : 'rgba(6, 9, 19, 0.85)';
  ctx.beginPath();
  ctx.roundRect(12, 10, 232, 44, 10);
  ctx.fill();

  ctx.strokeStyle = statusBadge === 'TRAPPED'
    ? '#f97316'
    : statusBadge === 'REVIVE (R)'
      ? '#34d399'
      : coatColor;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(12, 10, 232, 44, 10);
  ctx.stroke();

  ctx.font = '600 20px system-ui, sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = statusBadge ? `${label.slice(0, 10)} · ${statusBadge}` : label.slice(0, 18);
  ctx.fillText(text, 128, 33);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createRemoteSurvivor(
  initial: RoomPlayerData,
  contactShadowTex: THREE.Texture,
  candyCaneTex: THREE.Texture
): RemoteSurvivorRig {
  const root = new THREE.Group();
  root.position.set(initial.x, 0, initial.z);
  root.rotation.y = initial.yaw + Math.PI;

  const disposables: { dispose: () => void }[] = [];
  const track = <T extends { dispose: () => void }>(d: T): T => {
    disposables.push(d);
    return d;
  };

  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

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
      color: new THREE.Color(initial.scarfColor || '#e2e8f0'),
      roughness: 0.92,
      metalness: 0.0,
    })
  );
  const whiteFurMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xf1f5f9,
      roughness: 0.94,
      metalness: 0.0,
    })
  );
  const santaHatRedMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xb91c1c,
      roughness: 0.85,
      metalness: 0.03,
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
  bodyGroup.add(leftLeg, rightLeg);

  // Parka Torso & Backpack
  const torso = new THREE.Mesh(track(new THREE.CylinderGeometry(0.24, 0.28, 0.76, 10)), coatMat);
  torso.position.y = 1.14;
  bodyGroup.add(torso);

  const scarf = new THREE.Mesh(track(new THREE.TorusGeometry(0.2, 0.06, 7, 12)), scarfMat);
  scarf.rotation.x = Math.PI / 2;
  scarf.position.y = 1.5;
  bodyGroup.add(scarf);

  const pack = new THREE.Mesh(track(new THREE.BoxGeometry(0.32, 0.42, 0.18)), darkPantsMat);
  pack.position.set(0, 1.18, -0.24);
  bodyGroup.add(pack);

  // Head
  const head = new THREE.Mesh(track(new THREE.SphereGeometry(0.18, 10, 10)), skinMat);
  head.position.y = 1.68;
  bodyGroup.add(head);

  // Customizable Hats
  const hoodGroup = new THREE.Group();
  const hood = new THREE.Mesh(
    track(new THREE.SphereGeometry(0.21, 10, 10, 0, Math.PI * 2, 0, Math.PI * 0.68)),
    coatMat
  );
  hood.position.set(0, 1.7, -0.02);
  hood.rotation.x = -0.25;
  hoodGroup.add(hood);
  bodyGroup.add(hoodGroup);

  const beanieGroup = new THREE.Group();
  const beanieDome = new THREE.Mesh(
    track(new THREE.SphereGeometry(0.195, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.56)),
    scarfMat
  );
  beanieDome.position.set(0, 1.71, 0);
  const beanieCuff = new THREE.Mesh(track(new THREE.TorusGeometry(0.185, 0.036, 7, 14)), coatMat);
  beanieCuff.rotation.x = Math.PI / 2;
  beanieCuff.position.set(0, 1.73, 0);
  const beaniePom = new THREE.Mesh(track(new THREE.SphereGeometry(0.055, 8, 8)), whiteFurMat);
  beaniePom.position.set(0, 1.94, 0);
  beanieGroup.add(beanieDome, beanieCuff, beaniePom);
  bodyGroup.add(beanieGroup);

  const santaHatGroup = new THREE.Group();
  const sBrim = new THREE.Mesh(track(new THREE.TorusGeometry(0.19, 0.04, 7, 14)), whiteFurMat);
  sBrim.rotation.x = Math.PI / 2;
  sBrim.position.set(0, 1.74, 0);
  const sCone = new THREE.Mesh(track(new THREE.ConeGeometry(0.18, 0.38, 10)), santaHatRedMat);
  sCone.position.set(0, 1.94, -0.04);
  sCone.rotation.x = -0.24;
  const sPom = new THREE.Mesh(track(new THREE.SphereGeometry(0.05, 8, 8)), whiteFurMat);
  sPom.position.set(0, 2.11, -0.1);
  santaHatGroup.add(sBrim, sCone, sPom);
  bodyGroup.add(santaHatGroup);

  const ushankaGroup = new THREE.Group();
  const uCrown = new THREE.Mesh(track(new THREE.CylinderGeometry(0.19, 0.2, 0.2, 10)), coatMat);
  uCrown.position.set(0, 1.81, 0);
  const uFlapFront = new THREE.Mesh(track(new THREE.BoxGeometry(0.32, 0.14, 0.08)), whiteFurMat);
  uFlapFront.position.set(0, 1.82, 0.17);
  const uEarL = new THREE.Mesh(track(new THREE.BoxGeometry(0.07, 0.24, 0.16)), whiteFurMat);
  uEarL.position.set(-0.2, 1.71, 0);
  const uEarR = new THREE.Mesh(track(new THREE.BoxGeometry(0.07, 0.24, 0.16)), whiteFurMat);
  uEarR.position.set(0.2, 1.71, 0);
  ushankaGroup.add(uCrown, uFlapFront, uEarL, uEarR);
  bodyGroup.add(ushankaGroup);

  const applyHatStyle = (style: HatStyle) => {
    hoodGroup.visible = style === 'hood';
    beanieGroup.visible = style === 'beanie';
    santaHatGroup.visible = style === 'santa_hat';
    ushankaGroup.visible = style === 'ushanka';
  };

  // Right arm holding flashlight + lightweight additive volumetric beam cone (zero PointLights)
  const flashlightTorch = new THREE.Group();
  flashlightTorch.position.set(0.3, 1.24, 0.22);
  bodyGroup.add(flashlightTorch);

  const torchBody = new THREE.Mesh(track(new THREE.CylinderGeometry(0.035, 0.035, 0.24, 8)), metalMat);
  torchBody.rotation.x = Math.PI / 2;
  flashlightTorch.add(torchBody);

  const torchLens = new THREE.Mesh(track(new THREE.CylinderGeometry(0.04, 0.04, 0.03, 8)), beamGlowMat);
  torchLens.rotation.x = Math.PI / 2;
  torchLens.position.z = 0.12;
  flashlightTorch.add(torchLens);

  const beamConeMat = track(
    new THREE.MeshBasicMaterial({
      color: 0xffe6b0,
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    })
  );
  const beamCone = new THREE.Mesh(track(new THREE.ConeGeometry(0.85, 3.6, 10, 1, true)), beamConeMat);
  beamCone.rotation.x = -Math.PI / 2;
  beamCone.position.set(0, 0, 1.94);
  flashlightTorch.add(beamCone);

  // Left arm weapon mount so teammates see equipped stun weapons
  const weaponMount = new THREE.Group();
  weaponMount.position.set(-0.32, 1.22, 0.22);
  weaponMount.scale.setScalar(0.95);
  bodyGroup.add(weaponMount);

  let weaponDisposables: { dispose: () => void }[] = [];
  let mountedWeaponType: WeaponType | '' = '';
  const syncWeaponMesh = (type: WeaponType | '') => {
    if (mountedWeaponType === type) return;
    mountedWeaponType = type;
    while (weaponMount.children.length > 0) {
      weaponMount.remove(weaponMount.children[0]);
    }
    weaponDisposables.forEach((d) => d.dispose());
    weaponDisposables = [];
    if (!type) return;
    const mesh = buildWeaponCompositeMesh(type, candyCaneTex, weaponDisposables);
    if (type === 'candy_bat') {
      mesh.rotation.set(0.55, 0, -0.2);
    } else {
      mesh.rotation.set(0, Math.PI, 0);
    }
    weaponMount.add(mesh);
  };

  // Remote shot tracer flash beam (in local forward Z+ of avatar)
  const tracerGeo = track(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.32, 1.24, 0.45),
      new THREE.Vector3(-0.32, 1.24, 10.5),
    ])
  );
  const tracerMat = track(
    new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.92 })
  );
  const shotTracer = new THREE.Line(tracerGeo, tracerMat);
  shotTracer.visible = false;
  root.add(shotTracer);
  let shotFlashTimer = 0;

  // Stunned / Trapped glowing ring around feet
  const trapRingMat = track(
    new THREE.MeshBasicMaterial({
      color: 0xf97316,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    })
  );
  const trapRing = new THREE.Mesh(track(new THREE.RingGeometry(0.45, 0.62, 18)), trapRingMat);
  trapRing.rotation.x = -Math.PI / 2;
  trapRing.position.y = 0.04;
  trapRing.visible = false;
  root.add(trapRing);

  // Downed survivor body + glowing emerald rescue beacon (zero PointLights)
  const fallenGroup = new THREE.Group();
  const fallenBody = new THREE.Mesh(track(new THREE.CylinderGeometry(0.22, 0.24, 0.72, 10)), coatMat);
  fallenBody.rotation.x = Math.PI / 2;
  fallenBody.position.set(0, 0.22, 0.05);
  const fallenScarf = new THREE.Mesh(track(new THREE.TorusGeometry(0.18, 0.05, 6, 12)), scarfMat);
  fallenScarf.position.set(0, 0.24, 0.4);
  const fallenHead = new THREE.Mesh(track(new THREE.SphereGeometry(0.17, 10, 10)), skinMat);
  fallenHead.position.set(0, 0.24, 0.56);
  const fallenLegs = new THREE.Mesh(track(new THREE.BoxGeometry(0.32, 0.16, 0.56)), darkPantsMat);
  fallenLegs.position.set(0, 0.14, -0.52);

  const rescueRingMat = track(
    new THREE.MeshBasicMaterial({
      color: 0x34d399,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide,
    })
  );
  const rescueRing = new THREE.Mesh(track(new THREE.RingGeometry(0.62, 0.82, 22)), rescueRingMat);
  rescueRing.rotation.x = -Math.PI / 2;
  rescueRing.position.y = 0.04;

  const rescueBeamMat = track(
    new THREE.MeshBasicMaterial({
      color: 0x34d399,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    })
  );
  const rescueBeam = new THREE.Mesh(track(new THREE.CylinderGeometry(0.18, 0.45, 2.4, 12, 1, true)), rescueBeamMat);
  rescueBeam.position.y = 1.2;

  fallenGroup.add(fallenBody, fallenScarf, fallenHead, fallenLegs, rescueRing, rescueBeam);
  fallenGroup.visible = false;
  root.add(fallenGroup);

  // Floating Name Sprite
  let currentNameKey = '';
  let nameTex = createNameTagTexture(initial.displayName, initial.coatColor);
  const nameMat = track(
    new THREE.SpriteMaterial({
      map: nameTex,
      transparent: true,
      depthTest: true,
    })
  );
  const nameSprite = new THREE.Sprite(nameMat);
  nameSprite.position.set(0, 2.25, 0);
  nameSprite.scale.set(1.4, 0.35, 1);
  root.add(nameSprite);

  const refreshNameTag = (name: string, coat: string, badge?: 'TRAPPED' | 'REVIVE (R)') => {
    const key = `${name}|${coat}|${badge || ''}`;
    if (key === currentNameKey) return;
    currentNameKey = key;
    const oldTex = nameTex;
    nameTex = createNameTagTexture(name, coat, badge);
    nameMat.map = nameTex;
    nameMat.needsUpdate = true;
    oldTex.dispose();
  };

  let initialized = false;
  let lastSyncMs = performance.now();
  let estVelX = 0;
  let estVelZ = 0;

  const rig: RemoteSurvivorRig = {
    uid: initial.uid,
    displayName: initial.displayName,
    coatColorHex: initial.coatColor || '#3b82f6',
    root,
    targetX: initial.x,
    targetZ: initial.z,
    targetYaw: initial.yaw,
    flashlightOn: initial.flashlightOn,
    alive: initial.alive,
    escaped: initial.escaped,
    stunned: Boolean(initial.stunned),
    equippedWeapon: initial.equippedWeapon || '',
    shotCount: initial.shotCount || 0,
    reviveCount: Number(initial.reviveCount || 0),
    syncFromData(data: RoomPlayerData) {
      const prevAlive = this.alive;
      const prevEscaped = this.escaped;
      const prevStunned = this.stunned;
      const prevShots = this.shotCount;
      const prevRevives = this.reviveCount;

      const justCaught = initialized && prevAlive && !data.alive;
      const justRevived = initialized && ((!prevAlive && data.alive) || Number(data.reviveCount || 0) > prevRevives);
      const justEscaped = initialized && !prevEscaped && data.escaped;
      const justStunned = initialized && !prevStunned && Boolean(data.stunned);
      const justShot = initialized && (data.shotCount || 0) > prevShots;

      const nowMs = performance.now();
      const dtSec = Math.max(0.05, Math.min(1.0, (nowMs - lastSyncMs) / 1000));
      if (initialized && data.alive && !data.escaped) {
        const dx = data.x - this.targetX;
        const dz = data.z - this.targetZ;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.02 && dist < 8) {
          estVelX = THREE.MathUtils.clamp(dx / dtSec, -7.2, 7.2);
          estVelZ = THREE.MathUtils.clamp(dz / dtSec, -7.2, 7.2);
        } else {
          estVelX = 0;
          estVelZ = 0;
        }
      } else {
        estVelX = 0;
        estVelZ = 0;
      }
      lastSyncMs = nowMs;

      this.displayName = data.displayName;
      this.coatColorHex = data.coatColor || '#3b82f6';
      this.targetX = data.x;
      this.targetZ = data.z;
      this.targetYaw = data.yaw;
      this.flashlightOn = Boolean(data.flashlightOn);
      this.alive = data.alive;
      this.escaped = data.escaped;
      this.stunned = Boolean(data.stunned);
      this.equippedWeapon = data.equippedWeapon || '';
      this.shotCount = data.shotCount || 0;
      this.reviveCount = Number(data.reviveCount || 0);

      coatMat.color.set(data.coatColor || '#3b82f6');
      scarfMat.color.set(data.scarfColor || '#e2e8f0');
      applyHatStyle(data.hatStyle || 'hood');
      syncWeaponMesh(this.equippedWeapon);

      beamCone.visible = data.flashlightOn && data.alive;
      torchLens.visible = data.flashlightOn && data.alive;

      bodyGroup.visible = data.alive && !data.escaped;
      fallenGroup.visible = !data.alive && !data.escaped;
      trapRing.visible = data.alive && !data.escaped && this.stunned;
      root.visible = !data.escaped;

      const badge: 'TRAPPED' | 'REVIVE (R)' | undefined = !data.alive
        ? 'REVIVE (R)'
        : this.stunned
          ? 'TRAPPED'
          : undefined;
      refreshNameTag(data.displayName, this.coatColorHex, badge);
      nameSprite.position.y = data.alive ? 2.25 : 1.05;

      if (justShot) {
        shotFlashTimer = 0.22;
        shotTracer.visible = true;
      }

      initialized = true;
      return {
        justCaught,
        justRevived,
        justEscaped,
        justStunned,
        justShot,
        shotHit: Boolean(data.lastShotHit),
      };
    },
    update(dt: number, nowSec: number) {
      const prevX = root.position.x;
      const prevZ = root.position.z;

      const ageSec = Math.min(0.24, Math.max(0, (performance.now() - lastSyncMs) / 1000));
      const goalX = this.alive && !this.stunned ? this.targetX + estVelX * ageSec : this.targetX;
      const goalZ = this.alive && !this.stunned ? this.targetZ + estVelZ * ageSec : this.targetZ;

      root.position.x = THREE.MathUtils.damp(root.position.x, goalX, 12, dt);
      root.position.z = THREE.MathUtils.damp(root.position.z, goalZ, 12, dt);

      const desiredRotY = this.targetYaw + Math.PI;
      let deltaYaw = desiredRotY - root.rotation.y;
      while (deltaYaw > Math.PI) deltaYaw -= Math.PI * 2;
      while (deltaYaw < -Math.PI) deltaYaw += Math.PI * 2;
      root.rotation.y += deltaYaw * Math.min(1, dt * 12);

      if (shotFlashTimer > 0) {
        shotFlashTimer -= dt;
        if (shotFlashTimer <= 0) {
          shotTracer.visible = false;
        }
      }

      if (this.stunned && this.alive) {
        bodyGroup.position.y = -0.18 + Math.sin(nowSec * 18) * 0.02;
        trapRingMat.opacity = 0.55 + Math.sin(nowSec * 10) * 0.35;
        trapRing.rotation.z = nowSec * 2.5;
      } else {
        bodyGroup.position.y = THREE.MathUtils.damp(bodyGroup.position.y, 0, 10, dt);
      }

      if (!this.alive && !this.escaped) {
        const pulse = 0.55 + Math.sin(nowSec * 5.2) * 0.35;
        rescueRingMat.opacity = pulse;
        rescueBeamMat.opacity = 0.12 + pulse * 0.16;
        rescueRing.scale.setScalar(0.94 + Math.sin(nowSec * 4) * 0.08);
      }

      const moveDist = Math.hypot(root.position.x - prevX, root.position.z - prevZ);
      const speed = moveDist / Math.max(0.001, dt);
      if (speed > 0.25 && this.alive && !this.stunned) {
        const swing = Math.sin(nowSec * 11) * 0.45;
        leftLeg.rotation.x = swing;
        rightLeg.rotation.x = -swing;
      } else {
        leftLeg.rotation.x = THREE.MathUtils.damp(leftLeg.rotation.x, 0, 8, dt);
        rightLeg.rotation.x = THREE.MathUtils.damp(rightLeg.rotation.x, 0, 8, dt);
      }
    },
    dispose() {
      nameTex.dispose();
      weaponDisposables.forEach((d) => d.dispose());
      disposables.forEach((d) => d.dispose());
    },
  };

  rig.syncFromData(initial);
  return rig;
}
