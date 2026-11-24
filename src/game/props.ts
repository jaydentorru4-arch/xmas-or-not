import * as THREE from 'three';

export interface OrnamentProp {
  id: number;
  r: number;
  c: number;
  collected: boolean;
  group: THREE.Group;
  starGroup: THREE.Group;
  light: THREE.PointLight;
}

export interface ExitGateProp {
  group: THREE.Group;
  portalMesh: THREE.Mesh;
  portalMat: THREE.MeshStandardMaterial;
  sigilMat: THREE.MeshStandardMaterial;
  beaconMat: THREE.MeshBasicMaterial;
  gateLight: THREE.PointLight;
}

function createStarShape(outerR = 0.28, innerR = 0.12, points = 5): THREE.Shape {
  const shape = new THREE.Shape();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const a = (i * Math.PI) / points - Math.PI / 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

export function createOrnamentProp(
  id: number,
  r: number,
  c: number,
  worldX: number,
  worldZ: number,
  contactShadowTex: THREE.Texture,
  disposables: { dispose: () => void }[]
): OrnamentProp {
  const track = <T extends { dispose: () => void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const group = new THREE.Group();
  group.position.set(worldX, 0, worldZ);

  // Contact shadow grounded on floor
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
  group.add(shadow);

  // Wooden gift pedestal crate (bottom at y = 0)
  const crateMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x3a1814,
      roughness: 0.82,
      metalness: 0.08,
    })
  );
  const ribbonMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xd4a438,
      roughness: 0.25,
      metalness: 0.85,
    })
  );
  const crate = new THREE.Mesh(track(new THREE.BoxGeometry(0.68, 0.58, 0.68)), crateMat);
  crate.position.y = 0.29;
  crate.castShadow = true;
  crate.receiveShadow = true;
  group.add(crate);

  const ribbonA = new THREE.Mesh(track(new THREE.BoxGeometry(0.71, 0.6, 0.1)), ribbonMat);
  ribbonA.position.y = 0.29;
  const ribbonB = new THREE.Mesh(track(new THREE.BoxGeometry(0.1, 0.6, 0.71)), ribbonMat);
  ribbonB.position.y = 0.29;
  group.add(ribbonA, ribbonB);

  // Floating Golden Star Ornament Relic
  const starGroup = new THREE.Group();
  starGroup.position.y = 1.18;
  group.add(starGroup);

  const starGeo = track(
    new THREE.ExtrudeGeometry(createStarShape(0.28, 0.12, 5), {
      depth: 0.08,
      bevelEnabled: true,
      bevelSegments: 2,
      steps: 1,
      bevelSize: 0.02,
      bevelThickness: 0.02,
    })
  );
  starGeo.center();

  const goldStarMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xffcf4d,
      emissive: 0xd98a18,
      emissiveIntensity: 1.4,
      roughness: 0.18,
      metalness: 0.92,
    })
  );
  const starMesh = new THREE.Mesh(starGeo, goldStarMat);
  starGroup.add(starMesh);

  // Outer brass ring halo
  const halo = new THREE.Mesh(track(new THREE.TorusGeometry(0.36, 0.02, 8, 24)), goldStarMat);
  starGroup.add(halo);

  // Warm golden beacon light
  const light = new THREE.PointLight(0xffb838, 2.6, 9.0, 1.7);
  light.position.y = 1.25;
  group.add(light);

  return {
    id,
    r,
    c,
    collected: false,
    group,
    starGroup,
    light,
  };
}

export function createExitGate(
  worldX: number,
  worldZ: number,
  candyCaneTex: THREE.Texture,
  disposables: { dispose: () => void }[]
): ExitGateProp {
  const track = <T extends { dispose: () => void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const group = new THREE.Group();
  group.position.set(worldX, 0, worldZ);

  const pillarMat = track(
    new THREE.MeshStandardMaterial({
      map: candyCaneTex,
      roughness: 0.45,
      metalness: 0.15,
    })
  );
  const ironMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x202630,
      roughness: 0.35,
      metalness: 0.85,
    })
  );
  const sigilMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xff3344,
      emissive: 0xff1122,
      emissiveIntensity: 2.6,
      roughness: 0.25,
    })
  );

  // Twin Tall Candy-Cane Iron Pillars grounded at y = 0
  const pillarGeo = track(new THREE.CylinderGeometry(0.26, 0.3, 3.6, 12));
  const leftPillar = new THREE.Mesh(pillarGeo, pillarMat);
  leftPillar.position.set(-1.35, 1.8, 0);
  const rightPillar = new THREE.Mesh(pillarGeo, pillarMat);
  rightPillar.position.set(1.35, 1.8, 0);
  group.add(leftPillar, rightPillar);

  // Pillar Lantern Caps
  const lanternGeo = track(new THREE.SphereGeometry(0.22, 10, 10));
  const leftLantern = new THREE.Mesh(lanternGeo, sigilMat);
  leftLantern.position.set(-1.35, 3.72, 0);
  const rightLantern = new THREE.Mesh(lanternGeo, sigilMat);
  rightLantern.position.set(1.35, 3.72, 0);
  group.add(leftLantern, rightLantern);

  // Archway Crossbeam + Crown Sigil
  const beam = new THREE.Mesh(track(new THREE.BoxGeometry(3.35, 0.38, 0.46)), ironMat);
  beam.position.set(0, 3.55, 0);
  group.add(beam);

  const sigil = new THREE.Mesh(track(new THREE.OctahedronGeometry(0.36, 0)), sigilMat);
  sigil.position.set(0, 4.1, 0);
  group.add(sigil);

  // Towering Sky Beacon Column visible above maze walls in the night fog
  const beaconMat = track(
    new THREE.MeshBasicMaterial({
      color: 0xff2233,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  const skyBeacon = new THREE.Mesh(track(new THREE.CylinderGeometry(0.35, 1.15, 22, 12, 1, true)), beaconMat);
  skyBeacon.position.set(0, 14, 0);
  group.add(skyBeacon);

  // Shimmering Portal Barrier inside archway
  const portalMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x3b0a12,
      emissive: 0xaa1122,
      emissiveIntensity: 1.3,
      transparent: true,
      opacity: 0.56,
      roughness: 0.15,
      metalness: 0.2,
      side: THREE.DoubleSide,
    })
  );
  const portalMesh = new THREE.Mesh(track(new THREE.PlaneGeometry(2.3, 3.35)), portalMat);
  portalMesh.position.set(0, 1.68, 0);
  group.add(portalMesh);

  const gateLight = new THREE.PointLight(0xff2233, 4.2, 15, 1.5);
  gateLight.position.set(0, 2.4, 0);
  group.add(gateLight);

  return {
    group,
    portalMesh,
    portalMat,
    sigilMat,
    beaconMat,
    gateLight,
  };
}

export interface WeaponProp {
  id: number;
  type: 'tranq_dart' | 'cryo_blaster' | 'candy_bat';
  r: number;
  c: number;
  collected: boolean;
  group: THREE.Group;
  weaponMeshGroup: THREE.Group;
  light: THREE.PointLight;
}

export function buildWeaponCompositeMesh(
  type: 'tranq_dart' | 'cryo_blaster' | 'candy_bat',
  candyCaneTex: THREE.Texture,
  disposables: { dispose: () => void }[]
): THREE.Group {
  const track = <T extends { dispose: () => void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const g = new THREE.Group();

  const walnutMat = track(
    new THREE.MeshStandardMaterial({ color: 0x4b2a16, roughness: 0.78, metalness: 0.06 })
  );
  const darkSteelMat = track(
    new THREE.MeshStandardMaterial({ color: 0x262d38, roughness: 0.34, metalness: 0.86 })
  );
  const brassMat = track(
    new THREE.MeshStandardMaterial({ color: 0xd4a438, roughness: 0.24, metalness: 0.9 })
  );
  const cryoGlowMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0ea5e9,
      emissiveIntensity: 2.2,
      roughness: 0.2,
    })
  );
  const candyMat = track(
    new THREE.MeshStandardMaterial({ map: candyCaneTex, roughness: 0.42, metalness: 0.12 })
  );

  if (type === 'tranq_dart') {
    const barrel = new THREE.Mesh(track(new THREE.CylinderGeometry(0.028, 0.032, 0.44, 10)), darkSteelMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.04, -0.06);
    g.add(barrel);

    const grip = new THREE.Mesh(track(new THREE.BoxGeometry(0.055, 0.16, 0.085)), walnutMat);
    grip.position.set(0, -0.06, 0.12);
    grip.rotation.x = 0.28;
    g.add(grip);

    const vial = new THREE.Mesh(track(new THREE.CylinderGeometry(0.024, 0.024, 0.16, 8)), cryoGlowMat);
    vial.rotation.x = Math.PI / 2;
    vial.position.set(0, 0.085, -0.02);
    g.add(vial);

    const sight = new THREE.Mesh(track(new THREE.TorusGeometry(0.025, 0.007, 6, 12)), brassMat);
    sight.position.set(0, 0.09, -0.24);
    g.add(sight);

    const needle = new THREE.Mesh(track(new THREE.ConeGeometry(0.015, 0.1, 8)), cryoGlowMat);
    needle.rotation.x = -Math.PI / 2;
    needle.position.set(0, 0.04, -0.32);
    g.add(needle);
  } else if (type === 'cryo_blaster') {
    const stock = new THREE.Mesh(track(new THREE.BoxGeometry(0.075, 0.12, 0.34)), walnutMat);
    stock.position.set(0, -0.03, 0.16);
    stock.rotation.x = 0.12;
    g.add(stock);

    const mainTube = new THREE.Mesh(track(new THREE.CylinderGeometry(0.045, 0.04, 0.48, 12)), darkSteelMat);
    mainTube.rotation.x = Math.PI / 2;
    mainTube.position.set(0, 0.04, -0.08);
    g.add(mainTube);

    const bellMuzzle = new THREE.Mesh(track(new THREE.CylinderGeometry(0.072, 0.045, 0.14, 12)), brassMat);
    bellMuzzle.rotation.x = Math.PI / 2;
    bellMuzzle.position.set(0, 0.04, -0.36);
    g.add(bellMuzzle);

    const tank = new THREE.Mesh(track(new THREE.CylinderGeometry(0.038, 0.038, 0.22, 10)), cryoGlowMat);
    tank.rotation.x = Math.PI / 2;
    tank.position.set(0, -0.015, -0.1);
    g.add(tank);

    const ring = new THREE.Mesh(track(new THREE.TorusGeometry(0.052, 0.012, 6, 14)), brassMat);
    ring.position.set(0, 0.04, -0.22);
    g.add(ring);
  } else {
    // Heavy Candy Bat (Granny melee stun weapon)
    const shaft = new THREE.Mesh(track(new THREE.CylinderGeometry(0.058, 0.026, 0.78, 12)), candyMat);
    shaft.rotation.x = -0.35;
    shaft.position.set(0, 0.06, -0.1);
    g.add(shaft);

    const bandTop = new THREE.Mesh(track(new THREE.TorusGeometry(0.056, 0.013, 8, 14)), brassMat);
    bandTop.rotation.x = Math.PI / 2 - 0.35;
    bandTop.position.set(0, 0.25, -0.17);
    g.add(bandTop);

    const frostCore = new THREE.Mesh(track(new THREE.SphereGeometry(0.065, 10, 10)), cryoGlowMat);
    frostCore.position.set(0, 0.42, -0.24);
    g.add(frostCore);

    const pommel = new THREE.Mesh(track(new THREE.CylinderGeometry(0.036, 0.036, 0.05, 10)), darkSteelMat);
    pommel.rotation.x = -0.35;
    pommel.position.set(0, -0.3, 0.04);
    g.add(pommel);
  }

  return g;
}

export function createWeaponProp(
  id: number,
  type: 'tranq_dart' | 'cryo_blaster' | 'candy_bat',
  r: number,
  c: number,
  worldX: number,
  worldZ: number,
  contactShadowTex: THREE.Texture,
  candyCaneTex: THREE.Texture,
  disposables: { dispose: () => void }[]
): WeaponProp {
  const track = <T extends { dispose: () => void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const group = new THREE.Group();
  group.position.set(worldX, 0, worldZ);

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
  group.add(shadow);

  // Frost steel supply crate (bottom at y = 0)
  const crateMat = track(
    new THREE.MeshStandardMaterial({ color: 0x162436, roughness: 0.65, metalness: 0.35 })
  );
  const trimMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 1.5,
      roughness: 0.25,
      metalness: 0.6,
    })
  );
  const crate = new THREE.Mesh(track(new THREE.BoxGeometry(0.72, 0.48, 0.72)), crateMat);
  crate.position.y = 0.24;
  crate.castShadow = true;
  crate.receiveShadow = true;
  group.add(crate);

  const rim = new THREE.Mesh(track(new THREE.BoxGeometry(0.76, 0.06, 0.76)), trimMat);
  rim.position.y = 0.48;
  group.add(rim);

  const weaponMeshGroup = buildWeaponCompositeMesh(type, candyCaneTex, disposables);
  weaponMeshGroup.position.set(0, 1.05, 0);
  weaponMeshGroup.scale.setScalar(1.35);
  group.add(weaponMeshGroup);

  const light = new THREE.PointLight(0x38bdf8, 2.5, 9.5, 1.7);
  light.position.y = 1.25;
  group.add(light);

  return {
    id,
    type,
    r,
    c,
    collected: false,
    group,
    weaponMeshGroup,
    light,
  };
}

export interface BatteryProp {
  id: number;
  r: number;
  c: number;
  collected: boolean;
  group: THREE.Group;
  cellGroup: THREE.Group;
  light: THREE.PointLight;
}

export function createBatteryProp(
  id: number,
  r: number,
  c: number,
  worldX: number,
  worldZ: number,
  contactShadowTex: THREE.Texture,
  disposables: { dispose: () => void }[]
): BatteryProp {
  const track = <T extends { dispose: () => void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const group = new THREE.Group();
  group.position.set(worldX, 0, worldZ);

  const shadow = new THREE.Mesh(
    track(new THREE.PlaneGeometry(0.95, 0.95)),
    track(
      new THREE.MeshBasicMaterial({
        map: contactShadowTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.6,
      })
    )
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.015;
  group.add(shadow);

  // Floating rotating heavy-duty power cell
  const cellGroup = new THREE.Group();
  cellGroup.position.y = 0.78;
  group.add(cellGroup);

  const casingMat = track(
    new THREE.MeshStandardMaterial({ color: 0x16202a, roughness: 0.45, metalness: 0.72 })
  );
  const copperMat = track(
    new THREE.MeshStandardMaterial({ color: 0xd99b26, roughness: 0.22, metalness: 0.9 })
  );
  const emeraldGlowMat = track(
    new THREE.MeshStandardMaterial({
      color: 0x34d399,
      emissive: 0x10b981,
      emissiveIntensity: 2.3,
      roughness: 0.2,
    })
  );

  // Bottom dark casing
  const bottomCap = new THREE.Mesh(track(new THREE.CylinderGeometry(0.17, 0.17, 0.14, 14)), casingMat);
  bottomCap.position.y = -0.18;
  cellGroup.add(bottomCap);

  // Glowing emerald charge cylinder core
  const core = new THREE.Mesh(track(new THREE.CylinderGeometry(0.155, 0.155, 0.28, 14)), emeraldGlowMat);
  core.position.y = 0.03;
  cellGroup.add(core);

  // Top collar & brass positive terminal nub
  const topCap = new THREE.Mesh(track(new THREE.CylinderGeometry(0.17, 0.17, 0.1, 14)), casingMat);
  topCap.position.y = 0.22;
  cellGroup.add(topCap);

  const terminal = new THREE.Mesh(track(new THREE.CylinderGeometry(0.065, 0.065, 0.07, 12)), copperMat);
  terminal.position.y = 0.305;
  cellGroup.add(terminal);

  const ring = new THREE.Mesh(track(new THREE.TorusGeometry(0.18, 0.018, 6, 16)), copperMat);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.03;
  cellGroup.add(ring);

  const light = new THREE.PointLight(0x10b981, 2.1, 7.5, 1.8);
  light.position.y = 0.9;
  group.add(light);

  return {
    id,
    r,
    c,
    collected: false,
    group,
    cellGroup,
    light,
  };
}

export interface ElfTrapProp {
  id: number;
  r: number;
  c: number;
  triggered: boolean;
  group: THREE.Group;
  teethGroup: THREE.Group;
}

export function createElfTrapProp(
  id: number,
  r: number,
  c: number,
  worldX: number,
  worldZ: number,
  contactShadowTex: THREE.Texture,
  disposables: { dispose: () => void }[]
): ElfTrapProp {
  const track = <T extends { dispose: () => void }>(item: T): T => {
    disposables.push(item);
    return item;
  };

  const group = new THREE.Group();
  group.position.set(worldX, 0, worldZ);

  const shadow = new THREE.Mesh(
    track(new THREE.PlaneGeometry(0.9, 0.9)),
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
  group.add(shadow);

  const ironMat = track(
    new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.35, metalness: 0.85 })
  );
  const redBaitMat = track(
    new THREE.MeshStandardMaterial({
      color: 0xef4444,
      emissive: 0x991b1b,
      emissiveIntensity: 1.2,
      roughness: 0.25,
    })
  );

  const baseRing = new THREE.Mesh(track(new THREE.TorusGeometry(0.35, 0.03, 6, 16)), ironMat);
  baseRing.rotation.x = Math.PI / 2;
  baseRing.position.y = 0.03;
  group.add(baseRing);

  const teethGroup = new THREE.Group();
  teethGroup.position.y = 0.04;
  group.add(teethGroup);

  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2;
    const tooth = new THREE.Mesh(track(new THREE.ConeGeometry(0.035, 0.12, 4)), ironMat);
    tooth.position.set(Math.cos(angle) * 0.28, 0.06, Math.sin(angle) * 0.28);
    tooth.rotation.z = Math.cos(angle) * 0.4;
    tooth.rotation.x = -Math.sin(angle) * 0.4;
    teethGroup.add(tooth);
  }

  const bait = new THREE.Mesh(track(new THREE.SphereGeometry(0.08, 10, 10)), redBaitMat);
  bait.position.y = 0.08;
  group.add(bait);

  return {
    id,
    r,
    c,
    triggered: false,
    group,
    teethGroup,
  };
}


