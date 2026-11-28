import * as THREE from 'three';

export interface EvilSantaRig {
  root: THREE.Group;
  bodyPivot: THREE.Group;
  headGroup: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  auraLight: THREE.PointLight;
  eyeLeft: THREE.Mesh;
  eyeRight: THREE.Mesh;
  stunStarsGroup: THREE.Group;
  updateAnimation: (time: number, speed: number, alerted: boolean, stunRemaining?: number) => void;
  dispose: () => void;
}

export function createEvilSanta(
  contactShadowTex: THREE.Texture,
  candyCaneTex: THREE.Texture
): EvilSantaRig {
  const root = new THREE.Group();
  const disposables: { dispose: () => void }[] = [];
  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    disposables.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    disposables.push(m);
    return m;
  };

  // Materials with calibrated PBR roughness/metalness deltas >= 0.25
  const crimsonCoatMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x6b0b10,
      roughness: 0.88,
      metalness: 0.05,
    })
  );
  const furTrimMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xc9c2b2,
      roughness: 0.96,
      metalness: 0.0,
    })
  );
  const darkLeatherMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x161210,
      roughness: 0.42,
      metalness: 0.15,
    })
  );
  const tarnishedBrassMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xa68132,
      roughness: 0.28,
      metalness: 0.88,
    })
  );
  const paleSkinMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x8f9994,
      roughness: 0.72,
      metalness: 0.02,
    })
  );
  const eyeGlowMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xff2200,
      emissive: 0xff1100,
      emissiveIntensity: 3.4,
      roughness: 0.2,
    })
  );
  const ironHookMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x3b4048,
      map: candyCaneTex,
      roughness: 0.38,
      metalness: 0.82,
    })
  );
  const stunStarMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x38bdf8,
      emissiveIntensity: 2.2,
      roughness: 0.2,
    })
  );

  // Grounded contact shadow disc at y = 0.015
  const shadowMat = trackMat(
    new THREE.MeshBasicMaterial({
      map: contactShadowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.8,
    })
  );
  const shadowPlane = new THREE.Mesh(trackGeo(new THREE.PlaneGeometry(1.75, 1.75)), shadowMat);
  shadowPlane.rotation.x = -Math.PI / 2;
  shadowPlane.position.y = 0.015;
  root.add(shadowPlane);

  // Body pivot for limping/breathing/knockout slump
  const bodyPivot = new THREE.Group();
  root.add(bodyPivot);

  // 1. Articulated Legs + Heavy Boots (bottom at y = 0)
  const makeLeg = (side: -1 | 1): THREE.Group => {
    const legGroup = new THREE.Group();
    legGroup.position.set(side * 0.22, 0.78, 0);

    const trouser = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.14, 0.12, 0.56, 10)), crimsonCoatMat);
    trouser.position.y = -0.26;
    trouser.castShadow = true;
    legGroup.add(trouser);

    const boot = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.24, 0.26, 0.36)), darkLeatherMat);
    boot.position.set(0, -0.65, 0.05);
    boot.castShadow = true;
    legGroup.add(boot);

    return legGroup;
  };
  const leftLeg = makeLeg(-1);
  const rightLeg = makeLeg(1);
  bodyPivot.add(leftLeg, rightLeg);

  // 2. Primary Silhouette: Heavy Tattered Coat Torso & Bell Skirt
  const skirt = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.36, 0.54, 0.82, 12)), crimsonCoatMat);
  skirt.position.y = 1.05;
  skirt.castShadow = true;
  bodyPivot.add(skirt);

  const hemFur = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(0.52, 0.075, 8, 16)), furTrimMat);
  hemFur.rotation.x = Math.PI / 2;
  hemFur.position.y = 0.66;
  bodyPivot.add(hemFur);

  const chest = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.42, 0.38, 0.76, 12)), crimsonCoatMat);
  chest.position.y = 1.74;
  chest.scale.set(1.12, 1, 0.88);
  chest.castShadow = true;
  bodyPivot.add(chest);

  const belt = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.39, 0.39, 0.14, 14)), darkLeatherMat);
  belt.position.y = 1.44;
  belt.scale.set(1.1, 1, 0.9);
  bodyPivot.add(belt);

  const buckle = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.22, 0.18, 0.08)), tarnishedBrassMat);
  buckle.position.set(0, 1.44, 0.36);
  bodyPivot.add(buckle);

  const collar = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(0.36, 0.1, 8, 14)), furTrimMat);
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 2.08;
  bodyPivot.add(collar);

  // 3. Hunched Head, Glowing Crimson Eyes, Jagged Beard & Crooked Hat
  const headGroup = new THREE.Group();
  headGroup.position.set(0, 2.26, 0.08);
  bodyPivot.add(headGroup);

  const cranium = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.25, 14, 12)), paleSkinMat);
  cranium.scale.set(0.95, 1.08, 1.02);
  cranium.castShadow = true;
  headGroup.add(cranium);

  const brow = new THREE.Mesh(trackGeo(new THREE.BoxGeometry(0.34, 0.08, 0.16)), paleSkinMat);
  brow.position.set(0, 0.06, 0.19);
  brow.rotation.x = 0.25;
  headGroup.add(brow);

  const eyeGeo = trackGeo(new THREE.SphereGeometry(0.038, 8, 8));
  const eyeLeft = new THREE.Mesh(eyeGeo, eyeGlowMat);
  eyeLeft.position.set(-0.085, 0.03, 0.225);
  const eyeRight = new THREE.Mesh(eyeGeo, eyeGlowMat);
  eyeRight.position.set(0.085, 0.03, 0.225);
  headGroup.add(eyeLeft, eyeRight);

  const beardMain = new THREE.Mesh(trackGeo(new THREE.ConeGeometry(0.23, 0.48, 7)), furTrimMat);
  beardMain.rotation.x = Math.PI;
  beardMain.position.set(0, -0.22, 0.15);
  headGroup.add(beardMain);

  const mustacheL = new THREE.Mesh(trackGeo(new THREE.ConeGeometry(0.06, 0.18, 5)), furTrimMat);
  mustacheL.rotation.z = Math.PI * 0.38;
  mustacheL.position.set(-0.09, -0.05, 0.24);
  const mustacheR = new THREE.Mesh(trackGeo(new THREE.ConeGeometry(0.06, 0.18, 5)), furTrimMat);
  mustacheR.rotation.z = -Math.PI * 0.38;
  mustacheR.position.set(0.09, -0.05, 0.24);
  headGroup.add(mustacheL, mustacheR);

  const hatBand = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(0.24, 0.065, 8, 14)), furTrimMat);
  hatBand.rotation.x = Math.PI / 2;
  hatBand.position.set(0, 0.16, 0);
  headGroup.add(hatBand);

  const hatCone = new THREE.Mesh(trackGeo(new THREE.ConeGeometry(0.22, 0.46, 10)), crimsonCoatMat);
  hatCone.position.set(0.04, 0.36, -0.04);
  hatCone.rotation.z = -0.28;
  hatCone.rotation.x = -0.22;
  headGroup.add(hatCone);

  const hatBell = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.06, 8, 8)), tarnishedBrassMat);
  hatBell.position.set(0.17, 0.54, -0.14);
  headGroup.add(hatBell);

  // Orbiting dizzy stars when stunned (Granny-style knockout)
  const stunStarsGroup = new THREE.Group();
  stunStarsGroup.position.set(0, 0.65, 0);
  stunStarsGroup.visible = false;
  const dizzyGeo = trackGeo(new THREE.OctahedronGeometry(0.075, 0));
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3;
    const star = new THREE.Mesh(dizzyGeo, stunStarMat);
    star.position.set(Math.cos(a) * 0.42, 0, Math.sin(a) * 0.42);
    stunStarsGroup.add(star);
  }
  headGroup.add(stunStarsGroup);

  // 4. Articulated Arms + Rusted Candy-Cane Hook Staff
  const makeArm = (side: -1 | 1): THREE.Group => {
    const arm = new THREE.Group();
    arm.position.set(side * 0.5, 1.98, 0.02);

    const sleeve = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.11, 0.13, 0.68, 9)), crimsonCoatMat);
    sleeve.position.y = -0.3;
    sleeve.castShadow = true;
    arm.add(sleeve);

    const cuff = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(0.12, 0.045, 7, 12)), furTrimMat);
    cuff.rotation.x = Math.PI / 2;
    cuff.position.y = -0.62;
    arm.add(cuff);

    const glove = new THREE.Mesh(trackGeo(new THREE.SphereGeometry(0.1, 8, 8)), darkLeatherMat);
    glove.position.y = -0.7;
    arm.add(glove);

    return arm;
  };
  const leftArm = makeArm(-1);
  const rightArm = makeArm(1);
  bodyPivot.add(leftArm, rightArm);

  const hookCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, -0.72, 0.75),
    new THREE.Vector3(0, -0.72, 0.0),
    new THREE.Vector3(0, -0.72, -0.85),
    new THREE.Vector3(0, -0.45, -1.12),
    new THREE.Vector3(0, -0.25, -0.92),
  ]);
  const hookGeo = trackGeo(new THREE.TubeGeometry(hookCurve, 18, 0.042, 8, false));
  const hookStaff = new THREE.Mesh(hookGeo, ironHookMat);
  hookStaff.castShadow = true;
  rightArm.add(hookStaff);

  const auraLight = new THREE.PointLight(0xff1e00, 3.2, 13.5, 1.5);
  auraLight.position.set(0, 1.95, 0.45);
  bodyPivot.add(auraLight);

  const updateAnimation = (time: number, speed: number, alerted: boolean, stunRemaining = 0) => {
    if (stunRemaining > 0) {
      // Granny-style knocked-out slump pose with dizzy orbiting stars (kept above snow plane)
      stunStarsGroup.visible = true;
      stunStarsGroup.rotation.y = time * 3.6;

      bodyPivot.position.y = -0.32;
      bodyPivot.rotation.x = 1.08;
      bodyPivot.rotation.z = 0.12;
      leftLeg.rotation.x = -0.85;
      rightLeg.rotation.x = -0.55;
      leftArm.rotation.x = -0.55;
      rightArm.rotation.x = -0.35;
      headGroup.rotation.x = 0.36 + Math.sin(time * 2.2) * 0.08;
      headGroup.rotation.z = Math.sin(time * 1.9) * 0.22;

      const wakingSoon = stunRemaining < 4.0;
      auraLight.intensity = wakingSoon && Math.sin(time * 16) > 0 ? 1.8 : 0.15;
      eyeGlowMat.emissiveIntensity = wakingSoon && Math.sin(time * 16) > 0 ? 2.4 : 0.15;
      return;
    }

    stunStarsGroup.visible = false;
    bodyPivot.rotation.x = 0;

    const strideFreq = alerted ? 8.2 : 4.8;
    const isMoving = speed > 0.1;
    const phase = time * strideFreq;

    if (isMoving) {
      const swing = alerted ? 0.56 : 0.34;
      leftLeg.rotation.x = Math.sin(phase) * swing;
      rightLeg.rotation.x = -Math.sin(phase) * swing;

      leftArm.rotation.x = alerted ? -1.15 + Math.sin(phase) * 0.22 : -Math.sin(phase) * 0.35;
      rightArm.rotation.x = alerted ? -0.48 + Math.cos(phase) * 0.25 : Math.sin(phase) * 0.25;

      bodyPivot.position.y = Math.abs(Math.sin(phase)) * (alerted ? 0.11 : 0.05);
      bodyPivot.rotation.z = Math.sin(phase) * (alerted ? 0.08 : 0.04);
      headGroup.rotation.z = Math.sin(phase * 0.5) * 0.12;
      headGroup.rotation.x = alerted ? 0.18 : 0.06;
    } else {
      leftLeg.rotation.x = 0;
      rightLeg.rotation.x = 0;
      leftArm.rotation.x = -0.15 + Math.sin(time * 2) * 0.05;
      rightArm.rotation.x = -0.2;
      bodyPivot.position.y = Math.sin(time * 2.2) * 0.03;
      bodyPivot.rotation.z = 0;
      headGroup.rotation.z = Math.sin(time * 1.1) * 0.08;
      headGroup.rotation.x = 0.04;
    }

    const pulse = alerted
      ? 4.6 + Math.sin(time * 18) * 1.1 + Math.cos(time * 7) * 0.6
      : 2.8 + Math.sin(time * 4) * 0.4;
    auraLight.intensity = pulse;
    eyeGlowMat.emissiveIntensity = alerted ? 4.8 : 3.0;
  };

  const dispose = () => {
    disposables.forEach((d) => d.dispose());
  };

  return {
    root,
    bodyPivot,
    headGroup,
    leftArm,
    rightArm,
    leftLeg,
    rightLeg,
    auraLight,
    eyeLeft,
    eyeRight,
    stunStarsGroup,
    updateAnimation,
    dispose,
  };
}
