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
