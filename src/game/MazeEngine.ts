import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HorrorAudio } from './audio';
import {
  CELL_SIZE,
  WALL_HEIGHT,
  cellToWorld,
  findNextStepBFS,
  generateMaze,
  hasLineOfSight,
  worldToCell,
} from './maze';
import { ExitGateProp, OrnamentProp, createExitGate, createOrnamentProp } from './props';
import { EvilSantaRig, createEvilSanta } from './santaModel';
import { ProceduralTextures, createProceduralTextures } from './textures';
import { DIFFICULTIES, DifficultyId, GamePhase, GridCoord, HudSnapshot, MazeData } from './types';

// Reusable math objects (zero per-frame GC)
const _vecForward = new THREE.Vector3();
const _vecRight = new THREE.Vector3();
const _vecMove = new THREE.Vector3();
const _vecTarget = new THREE.Vector3();
const _dummy = new THREE.Object3D();
const _tempColor = new THREE.Color();

const PLAYER_RADIUS = 0.45;
const EYE_HEIGHT = 1.68;
const SNOW_COUNT = 850;
const SNOW_VOLUME = 36;

export class MazeEngine {
  private container: HTMLElement;
  private onHudUpdate: (hud: HudSnapshot) => void;

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private isSoftwareGl = false;
  private frameId = 0;
  private disposed = false;

  private textures!: ProceduralTextures;
  private audio = new HorrorAudio();
  private disposables: { dispose: () => void }[] = [];

  private mazeGroup!: THREE.Group;
  private mazeData!: MazeData;
  private santa!: EvilSantaRig;
  private ornaments: OrnamentProp[] = [];
  private exitGate!: ExitGateProp;
  private snowPoints!: THREE.Points;
  private bulbInstanced: THREE.InstancedMesh | null = null;
  private bulbBaseColors: THREE.Color[] = [];

  private flashlight!: THREE.SpotLight;
  private flashlightTarget!: THREE.Object3D;
  private playerAmbientGlow!: THREE.PointLight;
  private fog!: THREE.FogExp2;

  // Game State
  private phase: GamePhase = 'menu';
  private difficulty: DifficultyId = 'normal';
  private ornamentsCollected = 0;
  private exitUnlocked = false;
  private elapsedSeconds = 0;

  // Player kinematics
  private playerPos = new THREE.Vector3(0, EYE_HEIGHT, 0);
  private yaw = 0;
  private pitch = 0;
  private stamina = 100;
  private battery = 100;
  private flashlightOn = true;
  private walkBobPhase = 0;
  private currentFov = 74;

  // Santa AI state
  private santaPos = new THREE.Vector3();
  private santaYaw = 0;
  private santaAlerted = false;
  private santaAlertTimer = 0;
  private santaPatrolTarget: GridCoord | null = null;
  private santaCurrentSpeed = 0;
  private jumpscareTimer = 0;
  private jumpscareActive = false;

  // Chime / Sense state
  private chimeCooldown = 0;
  private chimeDisplayTimer = 0;
  private chimeAngleDeg: number | null = null;
  private chimeTargetLabel = '';

  // Status banner
  private statusBanner: string | null = null;
  private statusBannerTimer = 0;
  private hudHidden = false;

  // Input state
  private keys: Record<string, boolean> = {};
  private pointerLocked = false;
  private draggingLook = false;
  private lastPointerX = 0;
  private lastPointerY = 0;

  private lastFrameMs = performance.now();
  private lastHudPushMs = 0;

  constructor(container: HTMLElement, onHudUpdate: (hud: HudSnapshot) => void) {
    this.container = container;
    this.onHudUpdate = onHudUpdate;
    this.initScene();
  }

  private detectSoftwareGl(): boolean {
    try {
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl2');
      if (!gl) return true;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
      const gpu = String(gl.getParameter(param));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
    } catch {
      return true;
    }
  }

  private initScene(): void {
    this.isSoftwareGl = this.detectSoftwareGl();

    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: !this.isSoftwareGl,
        powerPreference: 'high-performance',
      });
    } catch {
      this.pushHud(undefined, {
        webglError: 'WebGL is unavailable in this browser context. Please enable hardware acceleration to play.',
      });
      return;
    }

    const width = Math.max(1, this.container.clientWidth || window.innerWidth);
    const height = Math.max(1, this.container.clientHeight || window.innerHeight);

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    this.container.appendChild(canvas);

    this.scene = new THREE.Scene();
    const bgHex = 0x050811;
    this.scene.background = new THREE.Color(bgHex);
    this.fog = new THREE.FogExp2(bgHex, DIFFICULTIES[this.difficulty].fogDensity);
    this.scene.fog = this.fog;

    // Mandatory studio environment map for metallic ornaments, brass buckle, and gate iron
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    const envTex = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = envTex;
    this.scene.environmentIntensity = 0.35;
    this.disposables.push(envTex);
    pmremGenerator.dispose();

    this.camera = new THREE.PerspectiveCamera(74, width / height, 0.1, 90);
    this.camera.rotation.order = 'YXZ';

    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.textures = createProceduralTextures(maxAniso);

    // Warm/cool moonlight rig
    const hemi = new THREE.HemisphereLight(0x466396, 0x090c14, 0.58);
    this.scene.add(hemi);

    const moonLight = new THREE.DirectionalLight(0x7898d8, 0.42);
    moonLight.position.set(18, 32, -14);
    this.scene.add(moonLight);

    // Subtle personal night-vision aura so pitch-black corners stay readable
    this.playerAmbientGlow = new THREE.PointLight(0x3a4d70, 0.7, 5.5, 1.8);
    this.scene.add(this.playerAmbientGlow);

    // Player Handheld Flashlight
    this.flashlight = new THREE.SpotLight(0xfff1d4, 7.2, 26, Math.PI / 5.4, 0.62, 1.55);
    this.flashlight.castShadow = !this.isSoftwareGl;
    this.flashlight.shadow.mapSize.width = 1024;
    this.flashlight.shadow.mapSize.height = 1024;
    this.flashlight.shadow.camera.near = 0.25;
    this.flashlight.shadow.camera.far = 26;
    this.flashlight.shadow.bias = -0.0005;

    this.flashlightTarget = new THREE.Object3D();
    this.scene.add(this.flashlight);
    this.scene.add(this.flashlightTarget);
    this.flashlight.target = this.flashlightTarget;

    // Snowfall particles
    this.buildSnowParticles();

    // Build initial maze for live menu backdrop
    this.mazeGroup = new THREE.Group();
    this.scene.add(this.mazeGroup);
    this.buildNewLevel();

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    this.bindEvents();
    this.lastFrameMs = performance.now();
    this.tick();
  }

  private buildSnowParticles(): void {
    const positions = new Float32Array(SNOW_COUNT * 3);
    for (let i = 0; i < SNOW_COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * SNOW_VOLUME;
      positions[i * 3 + 1] = Math.random() * 10;
      positions[i * 3 + 2] = (Math.random() - 0.5) * SNOW_VOLUME;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.16,
      map: this.textures.snowflakeSprite,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.disposables.push(geo, mat);
    this.snowPoints = new THREE.Points(geo, mat);
    this.snowPoints.frustumCulled = false;
    this.scene.add(this.snowPoints);
  }

  private clearMazeGroup(): void {
    while (this.mazeGroup.children.length > 0) {
      this.mazeGroup.remove(this.mazeGroup.children[0]);
    }
    if (this.santa) {
      this.santa.dispose();
    }
    this.ornaments = [];
    this.bulbInstanced = null;
    this.bulbBaseColors = [];
  }

  private buildNewLevel(): void {
    this.clearMazeGroup();

    const diff = DIFFICULTIES[this.difficulty];
    this.fog.density = diff.fogDensity;
    this.mazeData = generateMaze(diff.ornamentCount);

    const { size, cellSize, wallHeight, grid } = this.mazeData;
    const totalSpan = size * cellSize;

    // Extended snow ground plane (far beyond maze perimeter so there is never an empty void)
    const groundGeo = new THREE.PlaneGeometry(totalSpan + 90, totalSpan + 90);
    const groundMat = new THREE.MeshStandardMaterial({
      map: this.textures.snowFloorColor,
      roughnessMap: this.textures.snowFloorRoughness,
      roughness: 0.85,
      metalness: 0.05,
    });
    this.disposables.push(groundGeo, groundMat);
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.mazeGroup.add(ground);

    // Count walls for InstancedMesh
    const wallCoords: GridCoord[] = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (grid[r][c] === 1) {
          wallCoords.push({ r, c });
        }
      }
    }

    const wallGeo = new THREE.BoxGeometry(cellSize, wallHeight, cellSize);
    const wallMat = new THREE.MeshStandardMaterial({
      map: this.textures.hedgeColor,
      roughnessMap: this.textures.hedgeRoughness,
      roughness: 0.9,
      metalness: 0.02,
    });
    this.disposables.push(wallGeo, wallMat);

    const wallInstanced = new THREE.InstancedMesh(wallGeo, wallMat, wallCoords.length);
    wallInstanced.castShadow = !this.isSoftwareGl;
    wallInstanced.receiveShadow = true;

    wallCoords.forEach((wc, idx) => {
      const { x, z } = cellToWorld(wc.r, wc.c, size, cellSize);
      _dummy.position.set(x, wallHeight / 2, z);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.set(1, 1, 1);
      _dummy.updateMatrix();
      wallInstanced.setMatrixAt(idx, _dummy.matrix);
    });
    wallInstanced.instanceMatrix.needsUpdate = true;
    wallInstanced.computeBoundingSphere();
    this.mazeGroup.add(wallInstanced);

    // String light bulbs along wall edges facing open corridors (InstancedMesh)
    const bulbPositions: THREE.Vector3[] = [];
    const bulbPalette = [
      new THREE.Color(0xff2222),
      new THREE.Color(0xffaa22),
      new THREE.Color(0x22cc55),
    ];
    for (let r = 1; r < size - 1; r++) {
      for (let c = 1; c < size - 1; c++) {
        if (grid[r][c] === 1 && (r + c) % 2 === 0) {
          const { x, z } = cellToWorld(r, c, size, cellSize);
          const offsets = [
            { dr: -1, dc: 0, ox: 0, oz: -cellSize * 0.51 },
            { dr: 1, dc: 0, ox: 0, oz: cellSize * 0.51 },
            { dr: 0, dc: -1, ox: -cellSize * 0.51, oz: 0 },
            { dr: 0, dc: 1, ox: cellSize * 0.51, oz: 0 },
          ];
          for (const o of offsets) {
            if (grid[r + o.dr]?.[c + o.dc] === 0 && Math.random() < 0.45) {
              bulbPositions.push(new THREE.Vector3(x + o.ox, wallHeight * 0.68, z + o.oz));
            }
          }
        }
      }
    }

    if (bulbPositions.length > 0) {
      const bulbGeo = new THREE.SphereGeometry(0.075, 8, 8);
      const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      this.disposables.push(bulbGeo, bulbMat);
      this.bulbInstanced = new THREE.InstancedMesh(bulbGeo, bulbMat, bulbPositions.length);
      bulbPositions.forEach((bp, i) => {
        _dummy.position.copy(bp);
        _dummy.scale.set(1, 1, 1);
        _dummy.updateMatrix();
        this.bulbInstanced!.setMatrixAt(i, _dummy.matrix);
        const col = bulbPalette[i % bulbPalette.length].clone();
        this.bulbBaseColors.push(col);
        this.bulbInstanced!.setColorAt(i, col);
      });
      this.bulbInstanced.instanceMatrix.needsUpdate = true;
      if (this.bulbInstanced.instanceColor) this.bulbInstanced.instanceColor.needsUpdate = true;
      this.bulbInstanced.computeBoundingSphere();
      this.mazeGroup.add(this.bulbInstanced);
    }

    // Spawn 5 Golden Star Ornaments
    this.mazeData.ornaments.forEach((coord, idx) => {
      const { x, z } = cellToWorld(coord.r, coord.c, size, cellSize);
      const prop = createOrnamentProp(
        idx,
        coord.r,
        coord.c,
        x,
        z,
        this.textures.contactShadow,
        this.disposables
      );
      this.ornaments.push(prop);
      this.mazeGroup.add(prop.group);
    });

    // Spawn Exit Sleigh Gate
    const exitW = cellToWorld(this.mazeData.exitCell.r, this.mazeData.exitCell.c, size, cellSize);
    this.exitGate = createExitGate(exitW.x, exitW.z, this.textures.candyCaneColor, this.disposables);
    // Orient gate toward open adjacent corridor if possible
    const ec = this.mazeData.exitCell;
    if (grid[ec.r]?.[ec.c - 1] === 0 || grid[ec.r]?.[ec.c + 1] === 0) {
      this.exitGate.group.rotation.y = Math.PI / 2;
    }
    this.mazeGroup.add(this.exitGate.group);

    // Spawn Evil Santa
    this.santa = createEvilSanta(this.textures.contactShadow, this.textures.candyCaneColor);
    const santaW = cellToWorld(this.mazeData.santaSpawn.r, this.mazeData.santaSpawn.c, size, cellSize);
    this.santaPos.set(santaW.x, 0, santaW.z);
    this.santa.root.position.copy(this.santaPos);
    this.mazeGroup.add(this.santa.root);

    // Place Player at spawn & face an open corridor
    const playerW = cellToWorld(this.mazeData.playerSpawn.r, this.mazeData.playerSpawn.c, size, cellSize);
    this.playerPos.set(playerW.x, EYE_HEIGHT, playerW.z);

    // Look down open neighbor cell
    const ps = this.mazeData.playerSpawn;
    if (grid[ps.r]?.[ps.c + 1] === 0) this.yaw = -Math.PI / 2;
    else if (grid[ps.r + 1]?.[ps.c] === 0) this.yaw = Math.PI;
    else this.yaw = 0;
    this.pitch = 0;

    // Reset gameplay stats
    this.ornamentsCollected = 0;
    this.exitUnlocked = false;
    this.elapsedSeconds = 0;
    this.stamina = 100;
    this.battery = 100;
    this.flashlightOn = true;
    this.santaAlerted = false;
    this.santaAlertTimer = 0;
    this.santaPatrolTarget = null;
    this.jumpscareActive = false;
    this.jumpscareTimer = 0;
    this.chimeCooldown = 0;
    this.chimeDisplayTimer = 0;
    this.chimeAngleDeg = null;
  }

  public startNewGame(difficulty: DifficultyId): void {
    this.difficulty = difficulty;
    this.audio.init();
    this.buildNewLevel();
    this.phase = 'playing';
    this.showBanner('Collect 5 cursed ornaments to unlock the Exit Gate.');
    this.requestPointerLockSafe();
    this.pushHud();
  }

  public resumeGame(): void {
    if (this.phase === 'paused') {
      this.audio.init();
      this.phase = 'playing';
      this.requestPointerLockSafe();
      this.pushHud();
    }
  }

  public pauseGame(): void {
    if (this.phase === 'playing') {
      this.phase = 'paused';
      this.exitPointerLockSafe();
      this.pushHud();
    }
  }

  public returnToMenu(): void {
    this.phase = 'menu';
    this.exitPointerLockSafe();
    this.buildNewLevel();
    this.pushHud();
  }

  public setDifficulty(difficulty: DifficultyId): void {
    this.difficulty = difficulty;
    if (this.fog) {
      this.fog.density = DIFFICULTIES[difficulty].fogDensity;
    }
    this.pushHud();
  }

  public toggleMute(): void {
    this.audio.setMuted(!this.audio.isMuted());
    this.pushHud();
  }

  public toggleFlashlight(): void {
    if (this.phase !== 'playing') return;
    if (!this.flashlightOn && this.battery <= 4) {
      this.showBanner('Flashlight battery depleted. Wait for recharge.');
      return;
    }
    this.flashlightOn = !this.flashlightOn;
    this.audio.playFlashlightClick();
    this.pushHud();
  }

  public triggerChimeSense(): void {
    if (this.phase !== 'playing' || this.chimeCooldown > 0) return;
    this.chimeCooldown = 5.5;
    this.chimeDisplayTimer = 4.2;
    this.audio.playChimePulse();
    this.updateChimeBearing();
    this.pushHud();
  }

  public toggleHudHidden(): void {
    this.hudHidden = !this.hudHidden;
    this.pushHud();
  }

  private showBanner(msg: string, duration = 4.0): void {
    this.statusBanner = msg;
    this.statusBannerTimer = duration;
  }

  public requestPointerLockSafe(): void {
    try {
      const canvas = this.renderer?.domElement;
      if (canvas && document.pointerLockElement !== canvas && canvas.requestPointerLock) {
        const res = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        if (res && typeof res.catch === 'function') {
          res.catch(() => {});
        }
      }
    } catch {
      // Pointer lock unsupported or denied in iframe; drag-look and Q/E remain active
    }
  }

  private exitPointerLockSafe(): void {
    try {
      if (document.pointerLockElement && document.exitPointerLock) {
        document.exitPointerLock();
      }
    } catch {
      // ignore
    }
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    this.keys[e.code] = true;
    if (this.phase === 'playing') {
      if (e.code === 'KeyF') {
        this.toggleFlashlight();
      } else if (e.code === 'KeyC') {
        this.triggerChimeSense();
      } else if (e.code === 'KeyM') {
        this.toggleMute();
      } else if (e.code === 'KeyH') {
        this.toggleHudHidden();
      } else if (e.code === 'KeyP' || (e.code === 'Escape' && !this.pointerLocked)) {
        this.pauseGame();
      }
    } else if (this.phase === 'paused' && (e.code === 'KeyP' || e.code === 'Escape')) {
      this.resumeGame();
    }
  };

  private handleKeyUp = (e: KeyboardEvent) => {
    this.keys[e.code] = false;
  };

  private handlePointerLockChange = () => {
    const locked = document.pointerLockElement === this.renderer?.domElement;
    this.pointerLocked = locked;
    this.pushHud();
  };

  private handlePointerDown = (e: PointerEvent) => {
    if (this.phase !== 'playing') return;
    this.audio.init();
    this.draggingLook = true;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;
    if (!this.pointerLocked) {
      this.requestPointerLockSafe();
    }
  };

  private handlePointerMove = (e: PointerEvent) => {
    if (this.phase !== 'playing') return;
    const sensitivity = 0.0022;
    if (this.pointerLocked) {
      this.yaw -= e.movementX * sensitivity;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * sensitivity, -1.25, 1.25);
    } else if (this.draggingLook) {
      const dx = e.clientX - this.lastPointerX;
      const dy = e.clientY - this.lastPointerY;
      this.lastPointerX = e.clientX;
      this.lastPointerY = e.clientY;
      this.yaw -= dx * sensitivity * 1.4;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dy * sensitivity * 1.4, -1.25, 1.25);
    }
  };

  private handlePointerUp = () => {
    this.draggingLook = false;
  };

  private handleResize = () => {
    if (!this.renderer || !this.camera) return;
    const width = Math.max(1, this.container.clientWidth || window.innerWidth);
    const height = Math.max(1, this.container.clientHeight || window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
  };

  private handleContextLost = (e: Event) => {
    e.preventDefault();
    this.pushHud(undefined, { webglError: 'WebGL rendering context was lost. Waiting to restore...' });
  };

  private handleContextRestored = () => {
    this.pushHud(undefined, { webglError: null });
  };

  private bindEvents(): void {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('resize', this.handleResize);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
  }

  private unbindEvents(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('resize', this.handleResize);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    const canvas = this.renderer?.domElement;
    if (canvas) {
      canvas.removeEventListener('pointerdown', this.handlePointerDown);
      canvas.removeEventListener('webglcontextlost', this.handleContextLost);
      canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    }
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
  }

  private resolveMazeCollisions(pos: THREE.Vector3, radius: number): void {
    const { size, cellSize, grid } = this.mazeData;
    const halfMaze = ((size - 1) * cellSize) / 2;
    const halfWall = cellSize / 2;

    const minC = Math.max(0, Math.floor((pos.x + halfMaze - radius) / cellSize));
    const maxC = Math.min(size - 1, Math.ceil((pos.x + halfMaze + radius) / cellSize));
    const minR = Math.max(0, Math.floor((pos.z + halfMaze - radius) / cellSize));
    const maxR = Math.min(size - 1, Math.ceil((pos.z + halfMaze + radius) / cellSize));

    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        if (grid[r][c] !== 1) continue;
        const wx = c * cellSize - halfMaze;
        const wz = r * cellSize - halfMaze;

        const closestX = THREE.MathUtils.clamp(pos.x, wx - halfWall, wx + halfWall);
        const closestZ = THREE.MathUtils.clamp(pos.z, wz - halfWall, wz + halfWall);

        const dx = pos.x - closestX;
        const dz = pos.z - closestZ;
        const distSq = dx * dx + dz * dz;

        if (distSq < radius * radius) {
          const dist = Math.sqrt(distSq);
          if (dist > 0.0001) {
            const overlap = radius - dist;
            pos.x += (dx / dist) * overlap;
            pos.z += (dz / dist) * overlap;
          } else {
            // Fallback push out along shortest axis
            const penX = halfWall + radius - Math.abs(pos.x - wx);
            const penZ = halfWall + radius - Math.abs(pos.z - wz);
            if (penX < penZ) {
              pos.x += pos.x >= wx ? penX : -penX;
            } else {
              pos.z += pos.z >= wz ? penZ : -penZ;
            }
          }
        }
      }
    }
  }

  private pickRandomPatrolCell(): GridCoord {
    const { size, grid } = this.mazeData;
    for (let tries = 0; tries < 40; tries++) {
      const r = 1 + Math.floor(Math.random() * (size - 2));
      const c = 1 + Math.floor(Math.random() * (size - 2));
      if (grid[r][c] === 0) return { r, c };
    }
    return { ...this.mazeData.playerSpawn };
  }

  private updateSantaAI(dt: number, nowSec: number, playerSprinting: boolean): number {
    const diff = DIFFICULTIES[this.difficulty];
    const distToPlayer = Math.hypot(this.playerPos.x - this.santaPos.x, this.playerPos.z - this.santaPos.z);

    // Check line of sight and hearing
    const effectiveSight = this.flashlightOn ? diff.santaSightRange : diff.santaSightRange * 0.64;
    const canSee =
      distToPlayer <= effectiveSight &&
      hasLineOfSight(this.mazeData.grid, this.santaPos.x, this.santaPos.z, this.playerPos.x, this.playerPos.z, CELL_SIZE);
    const canHear = distToPlayer < (playerSprinting ? 12.5 : 4.5);

    if (canSee || canHear) {
      if (!this.santaAlerted && canSee) {
        this.audio.playEvilHoHo(0.85);
      }
      this.santaAlerted = true;
      this.santaAlertTimer = 6.5;
    } else if (this.santaAlertTimer > 0) {
      this.santaAlertTimer -= dt;
      if (this.santaAlertTimer <= 0) {
        this.santaAlerted = false;
      }
    }

    // Escalate Santa speed with each collected ornament
    const rageBoost = 1 + this.ornamentsCollected * 0.065;
    const targetSpeed = (this.santaAlerted ? diff.santaChaseSpeed : diff.santaBaseSpeed) * rageBoost;
    this.santaCurrentSpeed = THREE.MathUtils.damp(this.santaCurrentSpeed, targetSpeed, 6, dt);

    const santaCell = worldToCell(this.santaPos.x, this.santaPos.z, this.mazeData.size, CELL_SIZE);
    const playerCell = worldToCell(this.playerPos.x, this.playerPos.z, this.mazeData.size, CELL_SIZE);

    let moveTargetX = this.playerPos.x;
    let moveTargetZ = this.playerPos.z;

    if (canSee && distToPlayer < 12) {
      // Direct sprint down corridor
      moveTargetX = this.playerPos.x;
      moveTargetZ = this.playerPos.z;
    } else {
      let goalCell: GridCoord;
      if (this.santaAlerted || this.ornamentsCollected >= 4) {
        goalCell = playerCell;
      } else {
        if (
          !this.santaPatrolTarget ||
          (santaCell.r === this.santaPatrolTarget.r && santaCell.c === this.santaPatrolTarget.c)
        ) {
          this.santaPatrolTarget = this.pickRandomPatrolCell();
        }
        goalCell = this.santaPatrolTarget;
      }

      const nextStep = findNextStepBFS(this.mazeData.grid, santaCell, goalCell);
      if (nextStep) {
        const w = cellToWorld(nextStep.r, nextStep.c, this.mazeData.size, CELL_SIZE);
        moveTargetX = w.x;
        moveTargetZ = w.z;
      }
    }

    const dx = moveTargetX - this.santaPos.x;
    const dz = moveTargetZ - this.santaPos.z;
    const len = Math.hypot(dx, dz);

    if (len > 0.05) {
      const vx = (dx / len) * this.santaCurrentSpeed;
      const vz = (dz / len) * this.santaCurrentSpeed;
      this.santaPos.x += vx * dt;
      this.santaPos.z += vz * dt;
      this.resolveMazeCollisions(this.santaPos, 0.55);

      const desiredYaw = Math.atan2(dx, dz);
      let deltaAngle = desiredYaw - this.santaYaw;
      while (deltaAngle > Math.PI) deltaAngle -= Math.PI * 2;
      while (deltaAngle < -Math.PI) deltaAngle += Math.PI * 2;
      this.santaYaw += deltaAngle * Math.min(1, dt * 8);
    }

    this.santa.root.position.copy(this.santaPos);
    this.santa.root.rotation.y = this.santaYaw;
    this.santa.updateAnimation(nowSec, this.santaCurrentSpeed, this.santaAlerted);

    return Math.hypot(this.playerPos.x - this.santaPos.x, this.playerPos.z - this.santaPos.z);
  }

  private updateChimeBearing(): void {
    let targetX = 0;
    let targetZ = 0;
    let found = false;

    if (this.exitUnlocked) {
      const ew = cellToWorld(this.mazeData.exitCell.r, this.mazeData.exitCell.c, this.mazeData.size, CELL_SIZE);
      targetX = ew.x;
      targetZ = ew.z;
      this.chimeTargetLabel = 'Exit Gate';
      found = true;
    } else {
      let bestDist = Infinity;
      for (const o of this.ornaments) {
        if (o.collected) continue;
        const d = Math.hypot(o.group.position.x - this.playerPos.x, o.group.position.z - this.playerPos.z);
        if (d < bestDist) {
          bestDist = d;
          targetX = o.group.position.x;
          targetZ = o.group.position.z;
          this.chimeTargetLabel = 'Nearest Ornament';
          found = true;
        }
      }
    }

    if (!found) {
      this.chimeAngleDeg = null;
      return;
    }

    // Camera forward vector projected to XZ: (-sin(yaw), -cos(yaw))
    const fwdX = -Math.sin(this.yaw);
    const fwdZ = -Math.cos(this.yaw);
    const toX = targetX - this.playerPos.x;
    const toZ = targetZ - this.playerPos.z;
    const angleToTarget = Math.atan2(toX, toZ);
    const angleFwd = Math.atan2(fwdX, fwdZ);
    let rel = angleFwd - angleToTarget;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    this.chimeAngleDeg = THREE.MathUtils.radToDeg(rel);
  }

  private updateSnow(dt: number): void {
    const posAttr = this.snowPoints.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = posAttr.array as Float32Array;
    const cx = this.camera.position.x;
    const cz = this.camera.position.z;
    const half = SNOW_VOLUME / 2;

    for (let i = 0; i < SNOW_COUNT; i++) {
      const ix = i * 3;
      arr[ix] += Math.sin(this.lastFrameMs * 0.001 + i) * 0.35 * dt;
      arr[ix + 1] -= (1.5 + (i % 5) * 0.25) * dt;
      arr[ix + 2] += Math.cos(this.lastFrameMs * 0.0008 + i) * 0.35 * dt;

      if (arr[ix + 1] < 0) arr[ix + 1] = 9.5;
      if (arr[ix] < cx - half) arr[ix] += SNOW_VOLUME;
      else if (arr[ix] > cx + half) arr[ix] -= SNOW_VOLUME;
      if (arr[ix + 2] < cz - half) arr[ix + 2] += SNOW_VOLUME;
      else if (arr[ix + 2] > cz + half) arr[ix + 2] -= SNOW_VOLUME;
    }
    posAttr.needsUpdate = true;
  }

  private updateBulbsAndProps(nowSec: number): void {
    // Animate floating ornaments
    for (const o of this.ornaments) {
      if (o.collected) continue;
      o.starGroup.rotation.y = nowSec * 1.4 + o.id;
      o.starGroup.position.y = 1.18 + Math.sin(nowSec * 2.4 + o.id) * 0.09;
      o.light.intensity = 2.2 + Math.sin(nowSec * 3.5 + o.id) * 0.45;
    }

    // Subtle festive string-light shimmer
    if (this.bulbInstanced && this.bulbBaseColors.length > 0) {
      const count = this.bulbBaseColors.length;
      for (let i = 0; i < count; i++) {
        const flicker = 0.55 + 0.45 * Math.sin(nowSec * 3.2 + i * 1.7);
        _tempColor.copy(this.bulbBaseColors[i]).multiplyScalar(0.5 + flicker * 0.7);
        this.bulbInstanced.setColorAt(i, _tempColor);
      }
      if (this.bulbInstanced.instanceColor) {
        this.bulbInstanced.instanceColor.needsUpdate = true;
      }
    }

    // Exit gate shimmer
    if (this.exitGate) {
      this.exitGate.portalMat.opacity = this.exitUnlocked
        ? 0.65 + Math.sin(nowSec * 5) * 0.15
        : 0.38 + Math.sin(nowSec * 2) * 0.08;
    }
  }

  private stepSimulation(dt: number, nowSec: number): void {
    this.updateSnow(dt);
    this.updateBulbsAndProps(nowSec);

    if (this.statusBannerTimer > 0) {
      this.statusBannerTimer -= dt;
      if (this.statusBannerTimer <= 0) {
        this.statusBanner = null;
      }
    }

    // Live Menu Camera Orbit inside the snowy corridor
    if (this.phase === 'menu') {
      const sway = Math.sin(nowSec * 0.28) * 0.35;
      this.camera.position.set(this.playerPos.x, EYE_HEIGHT + Math.sin(nowSec * 0.8) * 0.04, this.playerPos.z);
      this.camera.rotation.set(0.02, this.yaw + sway, 0, 'YXZ');
      this.updateFlashlightTransform(nowSec, 999);
      return;
    }

    if (this.phase === 'paused' || this.phase === 'caught' || this.phase === 'escaped') {
      return;
    }

    // Jumpscare sequence before showing Game Over
    if (this.jumpscareActive) {
      this.jumpscareTimer -= dt;
      // Lock camera onto Evil Santa's glowing eyes with violent shake
      const lookY = 2.15;
      this.camera.position.set(
        this.playerPos.x + (Math.random() - 0.5) * 0.14,
        EYE_HEIGHT + (Math.random() - 0.5) * 0.14,
        this.playerPos.z + (Math.random() - 0.5) * 0.14
      );
      this.camera.lookAt(this.santaPos.x, lookY, this.santaPos.z);
      this.flashlight.position.copy(this.camera.position);
      this.flashlightTarget.position.set(this.santaPos.x, lookY, this.santaPos.z);
      this.flashlight.intensity = 10;

      if (this.jumpscareTimer <= 0) {
        this.jumpscareActive = false;
        this.phase = 'caught';
        this.exitPointerLockSafe();
        this.pushHud();
      }
      return;
    }

    // Active gameplay tick
    this.elapsedSeconds += dt;
    if (this.chimeCooldown > 0) this.chimeCooldown = Math.max(0, this.chimeCooldown - dt);
    if (this.chimeDisplayTimer > 0) {
      this.chimeDisplayTimer = Math.max(0, this.chimeDisplayTimer - dt);
      if (this.chimeDisplayTimer > 0) this.updateChimeBearing();
      else this.chimeAngleDeg = null;
    }

    // Keyboard turn fallback (Q/E or Left/Right Arrows)
    const turnSpeed = 2.15;
    if (this.keys['KeyQ'] || this.keys['ArrowLeft']) this.yaw += turnSpeed * dt;
    if (this.keys['KeyE'] || this.keys['ArrowRight']) this.yaw -= turnSpeed * dt;

    // Movement vector
    let forwardInput = 0;
    let strafeInput = 0;
    if (this.keys['KeyW'] || this.keys['ArrowUp']) forwardInput += 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown']) forwardInput -= 1;
    if (this.keys['KeyD']) strafeInput += 1;
    if (this.keys['KeyA']) strafeInput -= 1;

    const wantsMove = forwardInput !== 0 || strafeInput !== 0;
    const wantsSprint = (this.keys['ShiftLeft'] || this.keys['ShiftRight']) && wantsMove && this.stamina > 2;
    const sprinting = wantsSprint;

    if (sprinting) {
      this.stamina = Math.max(0, this.stamina - 24 * dt);
    } else {
      this.stamina = Math.min(100, this.stamina + (wantsMove ? 11 : 18) * dt);
    }

    const moveSpeed = sprinting ? 6.45 : 3.95;

    if (wantsMove) {
      _vecForward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      _vecRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      _vecMove
        .set(0, 0, 0)
        .addScaledVector(_vecForward, forwardInput)
        .addScaledVector(_vecRight, strafeInput)
        .normalize()
        .multiplyScalar(moveSpeed * dt);

      this.playerPos.x += _vecMove.x;
      this.playerPos.z += _vecMove.z;
      this.resolveMazeCollisions(this.playerPos, PLAYER_RADIUS);

      this.walkBobPhase += dt * (sprinting ? 14 : 9.5);
    }

    // Smooth FOV widening when sprinting
    const targetFov = sprinting ? 81 : 74;
    if (Math.abs(this.currentFov - targetFov) > 0.05) {
      this.currentFov = THREE.MathUtils.damp(this.currentFov, targetFov, 8, dt);
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    // Apply camera position + head-bob
    const bobOffset = wantsMove ? Math.sin(this.walkBobPhase) * (sprinting ? 0.065 : 0.038) : 0;
    this.camera.position.set(this.playerPos.x, EYE_HEIGHT + bobOffset, this.playerPos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.playerAmbientGlow.position.set(this.playerPos.x, EYE_HEIGHT, this.playerPos.z);

    // Flashlight battery & horror flicker
    if (this.flashlightOn) {
      this.battery = Math.max(0, this.battery - 1.55 * dt);
      if (this.battery <= 0) {
        this.flashlightOn = false;
        this.audio.playFlashlightClick();
        this.showBanner('Flashlight battery drained!');
      }
    } else {
      this.battery = Math.min(100, this.battery + 3.8 * dt);
    }

    // Update Evil Santa AI
    const santaDist = this.updateSantaAI(dt, nowSec, sprinting);
    this.updateFlashlightTransform(nowSec, santaDist);

    // Spatial Horror Audio
    this.audio.updateAmbience(nowSec, santaDist, this.santaAlerted, wantsMove, sprinting);

    // Check Ornament Pickups
    for (const o of this.ornaments) {
      if (o.collected) continue;
      const d = Math.hypot(o.group.position.x - this.playerPos.x, o.group.position.z - this.playerPos.z);
      if (d < 1.35) {
        o.collected = true;
        o.group.visible = false;
        this.ornamentsCollected++;
        this.battery = Math.min(100, this.battery + 22);
        this.audio.playOrnamentPickup();

        if (this.ornamentsCollected >= this.mazeData.ornaments.length) {
          this.exitUnlocked = true;
          this.exitGate.sigilMat.color.setHex(0x22ff99);
          this.exitGate.sigilMat.emissive.setHex(0x11ee77);
          this.exitGate.portalMat.color.setHex(0x0b3b2c);
          this.exitGate.portalMat.emissive.setHex(0x14d88c);
          this.exitGate.gateLight.color.setHex(0x22ff99);
          this.audio.playExitUnlocked();
          this.showBanner('All 5 ornaments recovered! Reach the glowing green Exit Gate!', 6.0);
        } else {
          const left = this.mazeData.ornaments.length - this.ornamentsCollected;
          this.showBanner(`Ornament recovered (${this.ornamentsCollected}/${this.mazeData.ornaments.length}). ${left} remaining.`);
        }
      }
    }

    // Check Exit Gate Victory
    if (this.exitUnlocked) {
      const distExit = Math.hypot(
        this.exitGate.group.position.x - this.playerPos.x,
        this.exitGate.group.position.z - this.playerPos.z
      );
      if (distExit < 1.6) {
        this.phase = 'escaped';
        this.audio.playVictory();
        this.exitPointerLockSafe();
        this.pushHud(santaDist);
        return;
      }
    }

    // Check Santa Catch -> Jumpscare!
    if (santaDist < 1.28) {
      this.jumpscareActive = true;
      this.jumpscareTimer = 0.68;
      this.audio.playJumpscare();
      return;
    }

    // Throttled HUD update (~15fps is crisp for meters without spamming React renders)
    if (performance.now() - this.lastHudPushMs > 65) {
      this.pushHud(santaDist);
    }
  }

  private updateFlashlightTransform(nowSec: number, santaDist: number): void {
    _vecForward.set(0, 0, -1).applyEuler(this.camera.rotation);
    this.flashlight.position.copy(this.camera.position);
    this.flashlight.position.y -= 0.12;
    _vecTarget.copy(this.camera.position).addScaledVector(_vecForward, 8);
    this.flashlightTarget.position.copy(_vecTarget);

    if (!this.flashlightOn) {
      this.flashlight.intensity = 0;
      return;
    }

    let baseIntensity = 7.4;
    if (this.battery < 18) {
      baseIntensity *= 0.55 + (this.battery / 18) * 0.45;
    }
    // Horror flicker when Evil Santa gets close
    if (santaDist < 12) {
      const proximity = 1 - santaDist / 12;
      const glitch = Math.sin(nowSec * 37) * Math.cos(nowSec * 23);
      if (glitch > 0.55 - proximity * 0.45) {
        baseIntensity *= 0.18;
      }
    }
    this.flashlight.intensity = baseIntensity;
  }

  private pushHud(santaDistOverride?: number, overrides?: Partial<HudSnapshot>): void {
    this.lastHudPushMs = performance.now();
    const santaDist =
      santaDistOverride ??
      (this.santaPos
        ? Math.hypot(this.playerPos.x - this.santaPos.x, this.playerPos.z - this.santaPos.z)
        : 99);

    this.onHudUpdate({
      phase: this.phase,
      difficulty: this.difficulty,
      ornamentsCollected: this.ornamentsCollected,
      ornamentsTotal: this.mazeData ? this.mazeData.ornaments.length : 5,
      exitUnlocked: this.exitUnlocked,
      stamina: this.stamina,
      battery: this.battery,
      flashlightOn: this.flashlightOn,
      elapsedSeconds: this.elapsedSeconds,
      santaDistance: santaDist,
      santaAlerted: this.santaAlerted,
      pointerLocked: this.pointerLocked,
      chimeCooldown: this.chimeCooldown,
      chimeAngleDeg: this.chimeAngleDeg,
      chimeTargetLabel: this.chimeTargetLabel,
      statusBanner: this.statusBanner,
      muted: this.audio.isMuted(),
      hudHidden: this.hudHidden,
      webglError: null,
      ...overrides,
    });
  }

  private afterDraw(cb: () => void): void {
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (!gl || !gl.fenceSync) {
      this.frameId = window.setTimeout(cb, 80);
      return;
    }
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const poll = () => {
      if (this.disposed) return;
      const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
      if (state === gl.UNSIGNALED) {
        this.frameId = window.setTimeout(poll, 5);
      } else {
        if (sync) gl.deleteSync(sync);
        this.frameId = window.setTimeout(cb, 80);
      }
    };
    this.frameId = window.setTimeout(poll, 5);
  }

  private tick = () => {
    if (this.disposed) return;
    const nowMs = performance.now();
    const dt = Math.min(0.08, Math.max(0.001, (nowMs - this.lastFrameMs) / 1000));
    this.lastFrameMs = nowMs;
    const nowSec = nowMs / 1000;

    this.stepSimulation(dt, nowSec);
    this.renderer.render(this.scene, this.camera);

    if (this.isSoftwareGl) {
      this.afterDraw(this.tick);
    } else {
      this.frameId = requestAnimationFrame(this.tick);
    }
  };

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    clearTimeout(this.frameId);
    this.unbindEvents();
    this.audio.dispose();
    this.clearMazeGroup();
    if (this.textures) this.textures.dispose();
    this.disposables.forEach((d) => d.dispose());
    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement.parentNode === this.container) {
        this.container.removeChild(this.renderer.domElement);
      }
    }
  }
}
