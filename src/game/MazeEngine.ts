import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HorrorAudio } from './audio';
import {
  CELL_SIZE,
  cellToWorld,
  createRng,
  findNextStepBFS,
  findPathBFS,
  generateMaze,
  hasLineOfSight,
  worldToCell,
} from './maze';
import { TinyElfRig, createTinyElf } from './elfModel';
import { RemoteSurvivorRig, createRemoteSurvivor } from './playerAvatar';
import {
  BatteryProp,
  ElfTrapProp,
  ExitGateProp,
  OrnamentProp,
  WeaponProp,
  buildWeaponCompositeMesh,
  createBatteryProp,
  createElfTrapProp,
  createExitGate,
  createOrnamentProp,
  createWeaponProp,
} from './props';
import { EvilSantaRig, createEvilSanta } from './santaModel';
import { ProceduralTextures, createProceduralTextures } from './textures';
import {
  DIFFICULTIES,
  DifficultyId,
  GamePhase,
  GridCoord,
  HudSnapshot,
  MapMarkerPlayer,
  MazeData,
  MazeMapState,
  RoomPlayerData,
  SantaLiveData,
  WEAPON_SPECS,
  WeaponType,
  getLevelScaling,
} from './types';

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
const WEAPON_SPAWN_INTERVAL = 60; // Every 1 minute
const WEAPON_TYPES: WeaponType[] = ['tranq_dart', 'cryo_blaster', 'candy_bat'];

export interface MultiplayerEngineCallbacks {
  onLocalPlayerSync?: (state: {
    x: number;
    z: number;
    yaw: number;
    flashlightOn: boolean;
    alive: boolean;
    escaped: boolean;
  }) => void;
  onHostSantaSync?: (state: SantaLiveData) => void;
  onCollectOrnament?: (ornamentId: number) => void;
  onCollectWeapon?: (weaponId: number) => void;
  onCollectBattery?: (batteryId: number) => void;
  onTriggerSantaStun?: () => void;
  onLocalEliminated?: () => void;
  onLocalEscaped?: () => void;
}

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
  private levelDisposables: { dispose: () => void }[] = [];

  private mazeGroup!: THREE.Group;
  private mazeData!: MazeData;
  private activeMazeSeed = 1337;
  private santa!: EvilSantaRig;
  private ornaments: OrnamentProp[] = [];
  private weapons: WeaponProp[] = [];
  private batteries: BatteryProp[] = [];
  private elfTraps: ElfTrapProp[] = [];
  private tinyElves: TinyElfRig[] = [];
  private elfHelper: TinyElfRig | null = null;
  private exitGate!: ExitGateProp;
  private snowPoints!: THREE.Points;
  private bulbInstanced: THREE.InstancedMesh | null = null;
  private bulbBaseColors: THREE.Color[] = [];

  // Chime 3D corridor breadcrumb trail
  private chimeTrailGroup!: THREE.Group;
  private chimeMarkers: THREE.Mesh[] = [];

  // First-person held weapon viewmodel & shot tracer
  private heldWeaponMount!: THREE.Group;
  private heldWeaponDisposables: { dispose: () => void }[] = [];
  private equippedWeapon: WeaponType | null = null;
  private weaponRecoilTimer = 0;
  private shotTracerLine!: THREE.Line;
  private shotTracerTimer = 0;

  private hemiLight!: THREE.HemisphereLight;
  private moonLight!: THREE.DirectionalLight;
  private flashlight!: THREE.SpotLight;
  private flashlightTarget!: THREE.Object3D;
  private playerAmbientGlow!: THREE.PointLight;
  private fog!: THREE.FogExp2;
  private visionFactor = 1;

  // Game State
  private phase: GamePhase = 'menu';
  private difficulty: DifficultyId = 'normal';
  private level = 1;
  private ornamentsCollected = 0;
  private exitUnlocked = false;
  private elapsedSeconds = 0;
  private nextWeaponWaveIndex = 0;
  private nextWeaponSpawnAt = WEAPON_SPAWN_INTERVAL;
  private playerTrapStunRemaining = 0;

  // Mobile Touch Input State
  private mobileMode = false;
  private touchMoveX = 0;
  private touchMoveZ = 0;
  private touchSprint = false;

  // Multiplayer State
  private isMultiplayer = false;
  private roomId: string | null = null;
  private isHost = false;
  private localUid: string | null = null;
  private alive = true;
  private spectating = false;
  private chatOpen = false;
  private mpCallbacks: MultiplayerEngineCallbacks = {};
  private remotePlayers = new Map<string, RemoteSurvivorRig>();
  private latestRoomPlayers: RoomPlayerData[] = [];
  private remoteSantaTarget: SantaLiveData | null = null;
  private lastPlayerSyncMs = 0;
  private lastSantaSyncMs = 0;
  private syncedCollectedWeapons = new Set<number>();
  private syncedCollectedBatteries = new Set<number>();
  private lastSeenStunNonce = 0;

  // Player kinematics & Dodge
  private playerPos = new THREE.Vector3(0, EYE_HEIGHT, 0);
  private yaw = 0;
  private pitch = 0;
  private stamina = 100;
  private battery = 100;
  private flashlightOn = true;
  private walkBobPhase = 0;
  private currentFov = 74;
  private dodgeCooldown = 0;
  private dodgeActiveTimer = 0;
  private dodgeDirX = 0;
  private dodgeDirZ = 0;

  // Santa AI & Stun state
  private santaPos = new THREE.Vector3();
  private santaYaw = 0;
  private santaVelX = 0;
  private santaVelZ = 0;
  private santaAlerted = false;
  private santaAlertTimer = 0;
  private santaLastKnownCell: GridCoord | null = null;
  private santaPatrolTarget: GridCoord | null = null;
  private santaCurrentSpeed = 0;
  private santaStunRemaining = 0;
  private jumpscareTimer = 0;
  private jumpscareActive = false;

  // Chime / Sense state
  private chimeCooldown = 0;
  private chimeDisplayTimer = 0;
  private chimeAngleDeg: number | null = null;
  private chimeTargetLabel = '';
  private chimeTargetDistance: number | null = null;

  // Status banner
  private statusBanner: string | null = null;
  private statusBannerTimer = 0;
  private hudHidden = false;

  // Input state
  private keys: Record<string, boolean> = {};
  private pointerLocked = false;
  private draggingLook = false;
  private pointerDownX = 0;
  private pointerDownY = 0;
  private pointerDownMs = 0;
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
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    this.container.appendChild(canvas);

    this.scene = new THREE.Scene();
    const bgHex = 0x050811;
    this.scene.background = new THREE.Color(bgHex);
    this.fog = new THREE.FogExp2(bgHex, DIFFICULTIES[this.difficulty].fogDensity);
    this.scene.fog = this.fog;

    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    const envTex = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = envTex;
    this.scene.environmentIntensity = 0.35;
    this.disposables.push(envTex);
    pmremGenerator.dispose();

    this.camera = new THREE.PerspectiveCamera(74, width / height, 0.1, 145);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.heldWeaponMount = new THREE.Group();
    this.heldWeaponMount.position.set(0.32, -0.26, -0.52);
    this.camera.add(this.heldWeaponMount);

    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.textures = createProceduralTextures(maxAniso);

    // Shot tracer line for ranged stun weapons
    const tracerGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);
    const tracerMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.9 });
    this.disposables.push(tracerGeo, tracerMat);
    this.shotTracerLine = new THREE.Line(tracerGeo, tracerMat);
    this.shotTracerLine.visible = false;
    this.scene.add(this.shotTracerLine);

    this.hemiLight = new THREE.HemisphereLight(0x466396, 0x090c14, 0.58);
    this.scene.add(this.hemiLight);

    this.moonLight = new THREE.DirectionalLight(0x7898d8, 0.42);
    this.moonLight.position.set(18, 32, -14);
    this.scene.add(this.moonLight);

    this.playerAmbientGlow = new THREE.PointLight(0x3a4d70, 0.82, 6.2, 1.7);
    this.scene.add(this.playerAmbientGlow);

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

    // 3D Golden Chime Path Breadcrumb Markers (up to 10 corridor steps)
    this.chimeTrailGroup = new THREE.Group();
    this.chimeTrailGroup.visible = false;
    const markerGeo = new THREE.OctahedronGeometry(0.18, 0);
    const markerMat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.9,
    });
    this.disposables.push(markerGeo, markerMat);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(markerGeo, markerMat);
      m.visible = false;
      this.chimeMarkers.push(m);
      this.chimeTrailGroup.add(m);
    }
    this.scene.add(this.chimeTrailGroup);

    this.buildSnowParticles();

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

  private clearHeldWeaponViewmodel(): void {
    while (this.heldWeaponMount && this.heldWeaponMount.children.length > 0) {
      this.heldWeaponMount.remove(this.heldWeaponMount.children[0]);
    }
    this.heldWeaponDisposables.forEach((d) => d.dispose());
    this.heldWeaponDisposables = [];
  }

  private setEquippedWeapon(type: WeaponType | null): void {
    this.equippedWeapon = type;
    this.clearHeldWeaponViewmodel();
    if (!type) return;

    const mesh = buildWeaponCompositeMesh(type, this.textures.candyCaneColor, this.heldWeaponDisposables);
    if (type === 'candy_bat') {
      mesh.rotation.set(0.18, -0.25, -0.22);
      mesh.position.set(0.05, -0.02, 0.04);
    } else {
      mesh.rotation.set(0.04, 0.08, 0);
    }
    this.heldWeaponMount.add(mesh);
  }

  private clearMazeGroup(): void {
    while (this.mazeGroup.children.length > 0) {
      this.mazeGroup.remove(this.mazeGroup.children[0]);
    }
    if (this.santa) {
      this.santa.dispose();
    }
    for (const rig of this.remotePlayers.values()) {
      rig.dispose();
    }
    this.remotePlayers.clear();
    for (const elf of this.tinyElves) {
      elf.dispose();
    }
    this.tinyElves = [];
    if (this.elfHelper) {
      this.elfHelper.dispose();
      this.elfHelper = null;
    }
    this.levelDisposables.forEach((d) => d.dispose());
    this.levelDisposables = [];
    this.ornaments = [];
    this.weapons = [];
    this.batteries = [];
    this.elfTraps = [];
    this.bulbInstanced = null;
    this.bulbBaseColors = [];
  }

  private spawnWeaponWave(waveIndex: number, announce: boolean): void {
    if (!this.mazeData) return;

    // Limit active uncollected weapons to 4 so map stays tidy
    const activeCount = this.weapons.filter((w) => !w.collected).length;
    if (activeCount >= 4) return;

    const { size, cellSize, grid } = this.mazeData;
    const rng = createRng(this.activeMazeSeed + waveIndex * 977 + 31);
    const openCells: GridCoord[] = [];
    for (let r = 1; r < size - 1; r++) {
      for (let c = 1; c < size - 1; c++) {
        if (grid[r][c] === 0) openCells.push({ r, c });
      }
    }

    const toSpawn = Math.min(2, 4 - activeCount);
    for (let slot = 0; slot < toSpawn; slot++) {
      const weaponId = waveIndex * 10 + slot;
      if (this.weapons.some((w) => w.id === weaponId) || this.syncedCollectedWeapons.has(weaponId)) {
        continue;
      }
      let chosen: GridCoord = openCells[Math.floor(rng() * openCells.length)] || this.mazeData.playerSpawn;
      for (let tries = 0; tries < 40; tries++) {
        const candidate = openCells[Math.floor(rng() * openCells.length)];
        if (!candidate) break;
        const w = cellToWorld(candidate.r, candidate.c, size, cellSize);
        const distPlayer = Math.hypot(w.x - this.playerPos.x, w.z - this.playerPos.z);
        const tooCloseToWeapon = this.weapons.some(
          (wp) => !wp.collected && Math.hypot(wp.group.position.x - w.x, wp.group.position.z - w.z) < 12
        );
        if (!tooCloseToWeapon && (waveIndex > 0 || distPlayer > 8)) {
          chosen = candidate;
          break;
        }
      }

      const wPos = cellToWorld(chosen.r, chosen.c, size, cellSize);
      const type = WEAPON_TYPES[(waveIndex * 2 + slot) % WEAPON_TYPES.length];
      const prop = createWeaponProp(
        weaponId,
        type,
        chosen.r,
        chosen.c,
        wPos.x,
        wPos.z,
        this.textures.contactShadow,
        this.textures.candyCaneColor,
        this.levelDisposables
      );
      this.weapons.push(prop);
      this.mazeGroup.add(prop.group);
    }

    if (announce) {
      this.audio.playWeaponPickup();
      this.showBanner('New weapons dropped in the maze! Find one to stun Santa for 30s.', 4.5);
    }
  }

  private buildNewLevel(seed?: number, levelOverride?: number): void {
    this.clearMazeGroup();
    this.setEquippedWeapon(null);
    if (levelOverride !== undefined) {
      this.level = Math.max(1, Math.min(50, Math.floor(levelOverride)));
    }

    const scaling = getLevelScaling(this.level, this.difficulty);
    this.fog.density = scaling.fogDensity;
    this.activeMazeSeed = seed ?? Math.floor(1 + Math.random() * 999999);
    this.mazeData = generateMaze(
      scaling.ornamentCount,
      this.activeMazeSeed,
      scaling.mazeSize,
      scaling.batteryCount
    );

    const { size, cellSize, wallHeight, grid } = this.mazeData;
    const totalSpan = size * cellSize;

    const groundGeo = new THREE.PlaneGeometry(totalSpan + 110, totalSpan + 110);
    const groundMat = new THREE.MeshStandardMaterial({
      map: this.textures.snowFloorColor,
      roughnessMap: this.textures.snowFloorRoughness,
      roughness: 0.85,
      metalness: 0.05,
    });
    this.levelDisposables.push(groundGeo, groundMat);
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.mazeGroup.add(ground);

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
    this.levelDisposables.push(wallGeo, wallMat);

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
            if (grid[r + o.dr]?.[c + o.dc] === 0 && (r * 7 + c * 13 + o.dr) % 3 === 0) {
              bulbPositions.push(new THREE.Vector3(x + o.ox, wallHeight * 0.68, z + o.oz));
            }
          }
        }
      }
    }

    if (bulbPositions.length > 0) {
      const bulbGeo = new THREE.SphereGeometry(0.075, 8, 8);
      const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      this.levelDisposables.push(bulbGeo, bulbMat);
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

    this.mazeData.ornaments.forEach((coord, idx) => {
      const { x, z } = cellToWorld(coord.r, coord.c, size, cellSize);
      const prop = createOrnamentProp(
        idx,
        coord.r,
        coord.c,
        x,
        z,
        this.textures.contactShadow,
        this.levelDisposables
      );
      this.ornaments.push(prop);
      this.mazeGroup.add(prop.group);
    });

    this.mazeData.batteries.forEach((coord, idx) => {
      const { x, z } = cellToWorld(coord.r, coord.c, size, cellSize);
      const prop = createBatteryProp(
        idx,
        coord.r,
        coord.c,
        x,
        z,
        this.textures.contactShadow,
        this.levelDisposables
      );
      this.batteries.push(prop);
      this.mazeGroup.add(prop.group);
    });

    this.mazeData.traps.forEach((coord, idx) => {
      const { x, z } = cellToWorld(coord.r, coord.c, size, cellSize);
      const prop = createElfTrapProp(
        idx,
        coord.r,
        coord.c,
        x,
        z,
        this.textures.contactShadow,
        this.levelDisposables
      );
      this.elfTraps.push(prop);
      this.mazeGroup.add(prop.group);
    });

    // Spawn Tiny Elves across the maze
    const elfCount = Math.min(8, 3 + Math.floor(this.level * 0.4));
    for (let i = 0; i < elfCount; i++) {
      const elfRig = createTinyElf(this.textures.contactShadow, false);
      const randCoord = this.mazeData.ornaments[i % this.mazeData.ornaments.length] || this.mazeData.playerSpawn;
      const ew = cellToWorld(randCoord.r, randCoord.c, size, cellSize);
      elfRig.root.position.set(ew.x, 0, ew.z);
      this.tinyElves.push(elfRig);
      this.mazeGroup.add(elfRig.root);
    }

    // Nightmare mode helper elf accompanying Evil Santa
    if (this.difficulty === 'nightmare') {
      const helper = createTinyElf(this.textures.contactShadow, true);
      const santaW = cellToWorld(this.mazeData.santaSpawn.r, this.mazeData.santaSpawn.c, size, cellSize);
      helper.root.position.set(santaW.x + 1.5, 0, santaW.z + 1.5);
      this.elfHelper = helper;
      this.mazeGroup.add(helper.root);
    }

    const exitW = cellToWorld(this.mazeData.exitCell.r, this.mazeData.exitCell.c, size, cellSize);
    this.exitGate = createExitGate(exitW.x, exitW.z, this.textures.candyCaneColor, this.levelDisposables);
    this.exitGate.group.rotation.y = Math.PI / 2;
    this.mazeGroup.add(this.exitGate.group);

    this.santa = createEvilSanta(this.textures.contactShadow, this.textures.candyCaneColor);
    const santaW = cellToWorld(this.mazeData.santaSpawn.r, this.mazeData.santaSpawn.c, size, cellSize);
    this.santaPos.set(santaW.x, 0, santaW.z);
    this.santa.root.position.copy(this.santaPos);
    this.mazeGroup.add(this.santa.root);

    const playerW = cellToWorld(this.mazeData.playerSpawn.r, this.mazeData.playerSpawn.c, size, cellSize);
    this.playerPos.set(playerW.x, EYE_HEIGHT, playerW.z);

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
    this.visionFactor = 1;
    this.playerTrapStunRemaining = 0;
    if (this.hemiLight) this.hemiLight.intensity = 0.58;
    if (this.moonLight) this.moonLight.intensity = 0.42;
    if (this.playerAmbientGlow) this.playerAmbientGlow.intensity = 0.82;
    this.dodgeCooldown = 0;
    this.dodgeActiveTimer = 0;
    this.santaAlerted = false;
    this.santaAlertTimer = 0;
    this.santaLastKnownCell = null;
    this.santaPatrolTarget = null;
    this.santaVelX = 0;
    this.santaVelZ = 0;
    this.santaCurrentSpeed = 0;
    this.santaStunRemaining = 0;
    this.jumpscareActive = false;
    this.jumpscareTimer = 0;
    this.chimeCooldown = 0;
    this.chimeDisplayTimer = 0;
    this.chimeAngleDeg = null;
    this.chimeTargetDistance = null;
    if (this.chimeTrailGroup) this.chimeTrailGroup.visible = false;
    this.syncedCollectedWeapons.clear();
    this.syncedCollectedBatteries.clear();
    this.lastSeenStunNonce = 0;
    this.nextWeaponWaveIndex = 1;
    this.nextWeaponSpawnAt = WEAPON_SPAWN_INTERVAL;

    // Spawn initial wave of 2 weapons on the maze floor right away, then every 60s
    this.spawnWeaponWave(0, false);

    if (this.isMultiplayer && this.latestRoomPlayers.length > 0) {
      this.applyRemotePlayers(this.latestRoomPlayers);
    }
  }

  private unlockExitGateVisuals(): void {
    this.exitUnlocked = true;
    if (!this.exitGate) return;
    this.exitGate.sigilMat.color.setHex(0x22ff99);
    this.exitGate.sigilMat.emissive.setHex(0x11ee77);
    this.exitGate.portalMat.color.setHex(0x0b3b2c);
    this.exitGate.portalMat.emissive.setHex(0x14d88c);
    this.exitGate.beaconMat.color.setHex(0x22ff99);
    this.exitGate.beaconMat.opacity = 0.28;
    this.exitGate.gateLight.color.setHex(0x22ff99);
  }

  public startNewGame(difficulty: DifficultyId, level = 1): void {
    this.difficulty = difficulty;
    this.level = Math.max(1, Math.min(50, Math.floor(level || 1)));
    this.isMultiplayer = false;
    this.roomId = null;
    this.isHost = false;
    this.localUid = null;
    this.latestRoomPlayers = [];
    this.alive = true;
    this.spectating = false;
    this.chatOpen = false;
    this.mpCallbacks = {};
    this.remoteSantaTarget = null;

    this.audio.init();
    this.buildNewLevel(undefined, this.level);
    this.phase = 'playing';
    this.showBanner(
      `Level ${this.level}: Collect ${this.mazeData.ornaments.length} ornaments. Grab weapons & batteries!`
    );
    this.requestPointerLockSafe();
    this.pushHud();
  }

  public enterWaitingRoom(
    difficulty: DifficultyId,
    level: number,
    mazeSeed: number,
    roomId: string,
    isHost: boolean,
    localUid: string
  ): void {
    this.difficulty = difficulty;
    this.level = Math.max(1, Math.min(50, Math.floor(level || 1)));
    this.isMultiplayer = true;
    this.roomId = roomId;
    this.isHost = isHost;
    this.localUid = localUid;
    this.alive = true;
    this.spectating = false;
    this.chatOpen = false;
    this.remoteSantaTarget = null;
    this.phase = 'waiting';
    this.exitPointerLockSafe();
    this.buildNewLevel(mazeSeed, this.level);
    this.pushHud();
  }

  public startMultiplayerSession(cfg: {
    difficulty: DifficultyId;
    level: number;
    mazeSeed: number;
    roomId: string;
    isHost: boolean;
    localUid: string;
    callbacks: MultiplayerEngineCallbacks;
  }): void {
    this.difficulty = cfg.difficulty;
    this.level = Math.max(1, Math.min(50, Math.floor(cfg.level || 1)));
    this.isMultiplayer = true;
    this.roomId = cfg.roomId;
    this.isHost = cfg.isHost;
    this.localUid = cfg.localUid;
    this.alive = true;
    this.spectating = false;
    this.chatOpen = false;
    this.mpCallbacks = cfg.callbacks;
    this.remoteSantaTarget = null;

    this.audio.init();
    this.buildNewLevel(cfg.mazeSeed, this.level);
    this.phase = 'playing';
    this.showBanner(
      `Level ${this.level}: Collect ${this.mazeData.ornaments.length} ornaments! Weapons drop every 60s.`
    );
    this.requestPointerLockSafe();

    this.mpCallbacks.onLocalPlayerSync?.({
      x: this.playerPos.x,
      z: this.playerPos.z,
      yaw: this.yaw,
      flashlightOn: this.flashlightOn,
      alive: true,
      escaped: false,
    });
    if (this.isHost) {
      this.mpCallbacks.onHostSantaSync?.({
        x: this.santaPos.x,
        z: this.santaPos.z,
        yaw: this.santaYaw,
        speed: 0,
        alerted: false,
        stunRemaining: 0,
      });
    }
    this.pushHud();
  }

  public applyRemotePlayers(players: RoomPlayerData[]): void {
    this.latestRoomPlayers = players;
    if (!this.isMultiplayer || !this.mazeGroup) return;

    const seen = new Set<string>();
    for (const p of players) {
      if (p.uid === this.localUid) continue;
      seen.add(p.uid);

      let rig = this.remotePlayers.get(p.uid);
      if (!rig) {
        const spawnW = this.mazeData
          ? cellToWorld(this.mazeData.playerSpawn.r, this.mazeData.playerSpawn.c, this.mazeData.size, CELL_SIZE)
          : { x: 0, z: 0 };
        const initial: RoomPlayerData =
          p.x === 0 && p.z === 0 ? { ...p, x: spawnW.x, z: spawnW.z } : p;
        rig = createRemoteSurvivor(initial, this.textures.contactShadow);
        this.remotePlayers.set(p.uid, rig);
        this.mazeGroup.add(rig.root);
      } else {
        rig.syncFromData(p);
      }
    }

    for (const [uid, rig] of this.remotePlayers.entries()) {
      if (!seen.has(uid)) {
        this.mazeGroup.remove(rig.root);
        rig.dispose();
        this.remotePlayers.delete(uid);
      }
    }

    if (this.phase === 'playing' && !this.alive && this.spectating) {
      const anyTeammateAlive = Array.from(this.remotePlayers.values()).some((r) => r.alive && !r.escaped);
      if (!anyTeammateAlive) {
        this.spectating = false;
        this.phase = 'caught';
        this.exitPointerLockSafe();
        this.pushHud();
      }
    }
  }

  public applyRemoteSantaState(santa: SantaLiveData): void {
    if (!this.isMultiplayer || this.isHost) return;
    if (!this.remoteSantaTarget && Math.hypot(santa.x - this.santaPos.x, santa.z - this.santaPos.z) > 12) {
      this.santaPos.set(santa.x, 0, santa.z);
      this.santaYaw = santa.yaw;
    }
    this.remoteSantaTarget = santa;
  }

  public applyRoomState(
    collectedOrnaments: number[],
    exitUnlocked: boolean,
    collectedWeapons: number[],
    collectedBatteries: number[],
    santaStunNonce: number
  ): void {
    if (!this.isMultiplayer) return;

    const idSet = new Set(collectedOrnaments);
    let newlyCollected = false;

    for (const o of this.ornaments) {
      if (idSet.has(o.id) && !o.collected) {
        o.collected = true;
        o.group.visible = false;
        newlyCollected = true;
      }
    }

    const totalCollected = this.ornaments.filter((o) => o.collected).length;
    if (newlyCollected && totalCollected > this.ornamentsCollected) {
      this.audio.playOrnamentPickup();
      if (!exitUnlocked) {
        const left = this.ornaments.length - totalCollected;
        this.showBanner(`Teammate recovered an ornament (${totalCollected}/${this.ornaments.length}). ${left} left.`);
      }
    }
    this.ornamentsCollected = totalCollected;

    if (exitUnlocked && !this.exitUnlocked) {
      this.unlockExitGateVisuals();
      this.audio.playExitUnlocked();
      this.showBanner('All ornaments recovered! Follow the EXIT compass or Map to escape!', 6.0);
    }

    for (const wid of collectedWeapons) {
      this.syncedCollectedWeapons.add(wid);
      const wp = this.weapons.find((w) => w.id === wid);
      if (wp && !wp.collected) {
        wp.collected = true;
        wp.group.visible = false;
      }
    }

    for (const bid of collectedBatteries) {
      this.syncedCollectedBatteries.add(bid);
      const bat = this.batteries.find((b) => b.id === bid);
      if (bat && !bat.collected) {
        bat.collected = true;
        bat.group.visible = false;
      }
    }

    if (santaStunNonce > this.lastSeenStunNonce) {
      this.lastSeenStunNonce = santaStunNonce;
      if (this.santaStunRemaining < 28) {
        this.santaStunRemaining = 30.0;
        this.santaAlerted = false;
        this.santaAlertTimer = 0;
        this.santaCurrentSpeed = 0;
        this.santaVelX = 0;
        this.santaVelZ = 0;
        this.audio.playSantaStunned();
        this.showBanner('Evil Santa stunned for 30 seconds!', 4.5);
      }
    }

    this.pushHud();
  }

  public setChatOpen(open: boolean): void {
    this.chatOpen = open;
    if (open) {
      this.keys = {};
      this.touchMoveX = 0;
      this.touchMoveZ = 0;
      this.draggingLook = false;
      this.exitPointerLockSafe();
    }
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
      this.keys = {};
      this.touchMoveX = 0;
      this.touchMoveZ = 0;
      this.touchSprint = false;
      this.draggingLook = false;
      this.exitPointerLockSafe();
      this.pushHud();
    }
  }

  public returnToMenu(): void {
    this.phase = 'menu';
    this.isMultiplayer = false;
    this.roomId = null;
    this.isHost = false;
    this.localUid = null;
    this.latestRoomPlayers = [];
    this.alive = true;
    this.spectating = false;
    this.chatOpen = false;
    this.touchMoveX = 0;
    this.touchMoveZ = 0;
    this.touchSprint = false;
    this.mpCallbacks = {};
    this.remoteSantaTarget = null;
    this.exitPointerLockSafe();
    this.buildNewLevel(undefined, this.level);
    this.pushHud();
  }

  public setDifficulty(difficulty: DifficultyId, level?: number): void {
    this.difficulty = difficulty;
    if (level !== undefined) {
      this.level = Math.max(1, Math.min(50, Math.floor(level)));
    }
    if (this.fog) {
      this.fog.density = getLevelScaling(this.level, difficulty).fogDensity;
    }
    this.pushHud();
  }

  public setSelectedLevel(level: number): void {
    this.level = Math.max(1, Math.min(50, Math.floor(level || 1)));
    if (this.fog) {
      this.fog.density = getLevelScaling(this.level, this.difficulty).fogDensity;
    }
    this.pushHud();
  }

  public setMobileMode(enabled: boolean): void {
    this.mobileMode = enabled;
    if (enabled) {
      this.exitPointerLockSafe();
    } else {
      this.touchMoveX = 0;
      this.touchMoveZ = 0;
      this.touchSprint = false;
    }
  }

  public unlockAudio(): void {
    this.audio.init();
  }

  public setTouchMoveVector(x: number, z: number): void {
    this.touchMoveX = x;
    this.touchMoveZ = z;
  }

  public setTouchSprint(sprinting: boolean): void {
    this.touchSprint = sprinting;
  }

  public applyTouchLookDelta(dx: number, dy: number): void {
    const sens = 0.0046;
    this.yaw -= dx * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * sens, -1.25, 1.25);
  }

  public toggleMute(): void {
    this.audio.setMuted(!this.audio.isMuted());
    this.pushHud();
  }

  public toggleFlashlight(): void {
    if (this.phase !== 'playing' || !this.alive) return;
    if (!this.flashlightOn && this.battery < 8) {
      this.showBanner(`Battery too low (${this.battery.toFixed(0)}%) — wait for 8% recharge or grab a battery.`, 2.4);
      return;
    }
    this.flashlightOn = !this.flashlightOn;
    this.audio.playFlashlightClick();
    this.pushHud();
  }

  public triggerChimeSense(): void {
    if (this.phase !== 'playing' || !this.alive || this.chimeCooldown > 0) return;
    this.chimeCooldown = 5.0;
    this.chimeDisplayTimer = 5.0;
    this.audio.playChimePulse();
    this.updateChimeBearing();
    this.pushHud();
  }

  public triggerDodge(): void {
    if (this.phase !== 'playing' || !this.alive || this.spectating) return;
    if (this.dodgeCooldown > 0 || this.stamina < 16) return;

    let fwd = 0;
    let strafe = 0;
    if (this.keys['KeyW'] || this.keys['ArrowUp']) fwd += 1;
    if (this.keys['KeyS'] || this.keys['ArrowDown']) fwd -= 1;
    if (this.keys['KeyD']) strafe += 1;
    if (this.keys['KeyA']) strafe -= 1;

    if (Math.abs(this.touchMoveZ) > 0.1 || Math.abs(this.touchMoveX) > 0.1) {
      fwd -= this.touchMoveZ;
      strafe += this.touchMoveX;
    }

    // Default quick dodge forward if stationary
    if (Math.abs(fwd) < 0.05 && Math.abs(strafe) < 0.05) {
      fwd = 1;
    }

    _vecForward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _vecRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _vecMove.set(0, 0, 0).addScaledVector(_vecForward, fwd).addScaledVector(_vecRight, strafe).normalize();

    this.dodgeDirX = _vecMove.x;
    this.dodgeDirZ = _vecMove.z;
    this.dodgeActiveTimer = 0.22;
    this.dodgeCooldown = 1.25;
    this.stamina = Math.max(0, this.stamina - 16);
    this.audio.playDodgeStep();
  }

  public useEquippedWeapon(): void {
    if (this.phase !== 'playing' || !this.alive || this.spectating || !this.equippedWeapon) return;

    const weaponType = this.equippedWeapon;
    const spec = WEAPON_SPECS[weaponType];
    const distToSanta = Math.hypot(this.santaPos.x - this.playerPos.x, this.santaPos.z - this.playerPos.z);

    // Don't waste melee Candy Bat if swung miles away from Santa
    if (spec.kind === 'melee' && distToSanta > spec.range + 1.2) {
      this.weaponRecoilTimer = 0.25;
      this.audio.playWeaponFire(weaponType);
      this.showBanner(`Too far for Heavy Candy Bat — get within ${spec.range}m of Santa!`, 2.4);
      return;
    }

    this.weaponRecoilTimer = 0.3;
    this.audio.playWeaponFire(weaponType);

    const aimAngle = Math.abs(this.getRelativeAngleDeg(this.santaPos.x, this.santaPos.z));
    const lateralMissDist = distToSanta * Math.sin(THREE.MathUtils.degToRad(Math.min(89, aimAngle)));
    const maxAngle = spec.kind === 'melee' ? 68 : 34;

    const losClear = hasLineOfSight(
      this.mazeData.grid,
      this.playerPos.x,
      this.playerPos.z,
      this.santaPos.x,
      this.santaPos.z,
      CELL_SIZE
    );

    const hitSanta =
      distToSanta <= spec.range &&
      (aimAngle <= maxAngle || lateralMissDist <= spec.hitRadius) &&
      losClear;

    // Show laser/frost tracer for ranged weapons
    if (spec.kind === 'ranged') {
      _vecForward.set(0, 0, -1).applyEuler(this.camera.rotation);
      const startPt = this.camera.position.clone().add(new THREE.Vector3(0, -0.14, 0));
      const endDist = hitSanta ? distToSanta : spec.range;
      const endPt = hitSanta
        ? new THREE.Vector3(this.santaPos.x, 1.5, this.santaPos.z)
        : startPt.clone().addScaledVector(_vecForward, endDist);
      const posAttr = this.shotTracerLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      posAttr.setXYZ(0, startPt.x, startPt.y, startPt.z);
      posAttr.setXYZ(1, endPt.x, endPt.y, endPt.z);
      posAttr.needsUpdate = true;
      this.shotTracerLine.visible = true;
      this.shotTracerTimer = 0.16;
    }

    // Consume single-use Granny charge
    this.setEquippedWeapon(null);

    if (hitSanta) {
      this.santaStunRemaining = spec.stunSeconds;
      this.santaAlerted = false;
      this.santaAlertTimer = 0;
      this.santaCurrentSpeed = 0;
      this.santaVelX = 0;
      this.santaVelZ = 0;
      this.audio.playSantaStunned();
      this.showBanner(`Direct hit with ${spec.label}! Santa stunned for 30 seconds!`, 5.0);

      if (this.isMultiplayer) {
        this.lastSeenStunNonce += 1;
        this.mpCallbacks.onTriggerSantaStun?.();
      }
    } else {
      this.showBanner(`${spec.label} missed! Find another weapon drop.`, 3.0);
    }

    this.pushHud(distToSanta);
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
    if (this.chatOpen || this.mobileMode) return;
    try {
      const canvas = this.renderer?.domElement;
      if (canvas && document.pointerLockElement !== canvas && canvas.requestPointerLock) {
        const res = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        if (res && typeof res.catch === 'function') {
          res.catch(() => {});
        }
      }
    } catch {
      // Pointer lock unsupported or denied in iframe
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

  private isTypingInInput(target: EventTarget | null): boolean {
    if (!target || !(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (this.chatOpen || this.isTypingInInput(e.target)) {
      return;
    }
    this.keys[e.code] = true;
    if (this.phase === 'playing') {
      if (e.code === 'KeyF') {
        this.toggleFlashlight();
      } else if (e.code === 'KeyC') {
        this.triggerChimeSense();
      } else if (e.code === 'KeyG') {
        this.useEquippedWeapon();
      } else if (e.code === 'Space') {
        e.preventDefault();
        this.triggerDodge();
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
    if (this.phase !== 'playing' || this.chatOpen) return;
    this.audio.init();
    if (this.mobileMode || e.pointerType === 'touch') {
      return;
    }
    this.draggingLook = true;
    this.pointerDownX = e.clientX;
    this.pointerDownY = e.clientY;
    this.pointerDownMs = performance.now();
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;

    if (e.button === 0 && this.pointerLocked && this.equippedWeapon) {
      this.useEquippedWeapon();
      return;
    }

    if (!this.pointerLocked) {
      this.requestPointerLockSafe();
    }
  };

  private handlePointerMove = (e: PointerEvent) => {
    if (this.phase !== 'playing' || this.chatOpen) return;
    if (this.mobileMode || e.pointerType === 'touch') return;
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

  private handlePointerUp = (e: PointerEvent) => {
    if (this.mobileMode || e.pointerType === 'touch') {
      this.draggingLook = false;
      return;
    }
    if (
      this.draggingLook &&
      !this.pointerLocked &&
      this.phase === 'playing' &&
      !this.chatOpen &&
      this.equippedWeapon &&
      e.button === 0
    ) {
      const moved = Math.hypot(e.clientX - this.pointerDownX, e.clientY - this.pointerDownY);
      const elapsed = performance.now() - this.pointerDownMs;
      if (moved < 6 && elapsed < 220) {
        this.useEquippedWeapon();
      }
    }
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

  private updateSantaAI(dt: number, nowSec: number, localSprinting: boolean): number {
    // Non-host multiplayer clients smoothly interpolate from Host's authoritative Santa
    if (this.isMultiplayer && !this.isHost) {
      if (this.remoteSantaTarget) {
        this.santaPos.x = THREE.MathUtils.damp(this.santaPos.x, this.remoteSantaTarget.x, 9, dt);
        this.santaPos.z = THREE.MathUtils.damp(this.santaPos.z, this.remoteSantaTarget.z, 9, dt);

        let deltaAngle = this.remoteSantaTarget.yaw - this.santaYaw;
        while (deltaAngle > Math.PI) deltaAngle -= Math.PI * 2;
        while (deltaAngle < -Math.PI) deltaAngle += Math.PI * 2;
        this.santaYaw += deltaAngle * Math.min(1, dt * 9);

        this.santaCurrentSpeed = this.remoteSantaTarget.speed;
        if (this.remoteSantaTarget.alerted && !this.santaAlerted) {
          this.audio.playEvilHoHo(0.7);
        }
        this.santaAlerted = this.remoteSantaTarget.alerted;
        if (this.remoteSantaTarget.stunRemaining > 0.2) {
          this.santaStunRemaining = this.remoteSantaTarget.stunRemaining;
        } else if (this.santaStunRemaining > 0) {
          this.santaStunRemaining = Math.max(0, this.santaStunRemaining - dt);
        }
      }
      this.santa.root.position.copy(this.santaPos);
      this.santa.root.rotation.y = this.santaYaw;
      this.santa.updateAnimation(nowSec, this.santaCurrentSpeed, this.santaAlerted, this.santaStunRemaining);
      return Math.hypot(this.playerPos.x - this.santaPos.x, this.playerPos.z - this.santaPos.z);
    }

    // Stunned state (30s Granny knockout)
    if (this.santaStunRemaining > 0) {
      const prevStun = this.santaStunRemaining;
      this.santaStunRemaining = Math.max(0, this.santaStunRemaining - dt);
      this.santaCurrentSpeed = 0;
      this.santaVelX = 0;
      this.santaVelZ = 0;
      this.santaAlerted = false;

      if (prevStun > 3.5 && this.santaStunRemaining <= 3.5) {
        this.showBanner('Santa is stirring... run!', 2.6);
      } else if (this.santaStunRemaining <= 0) {
        this.audio.playEvilHoHo(0.65);
        this.showBanner('Evil Santa woke up!', 3.0);
      }

      this.santa.root.position.copy(this.santaPos);
      this.santa.root.rotation.y = this.santaYaw;
      this.santa.updateAnimation(nowSec, 0, false, this.santaStunRemaining);

      if (this.isMultiplayer && this.isHost && performance.now() - this.lastSantaSyncMs > 130) {
        this.lastSantaSyncMs = performance.now();
        this.mpCallbacks.onHostSantaSync?.({
          x: this.santaPos.x,
          z: this.santaPos.z,
          yaw: this.santaYaw,
          speed: 0,
          alerted: false,
          stunRemaining: this.santaStunRemaining,
        });
      }

      return Math.hypot(this.playerPos.x - this.santaPos.x, this.playerPos.z - this.santaPos.z);
    }

    const scaling = getLevelScaling(this.level, this.difficulty);

    const candidates: { x: number; z: number; flashlightOn: boolean; sprinting: boolean }[] = [];
    if (this.alive && !this.spectating) {
      candidates.push({
        x: this.playerPos.x,
        z: this.playerPos.z,
        flashlightOn: this.flashlightOn,
        sprinting: localSprinting,
      });
    }
    if (this.isMultiplayer) {
      for (const rig of this.remotePlayers.values()) {
        if (rig.alive && !rig.escaped) {
          candidates.push({
            x: rig.targetX,
            z: rig.targetZ,
            flashlightOn: true,
            sprinting: false,
          });
        }
      }
    }

    let nearestTarget = candidates[0] || {
      x: this.playerPos.x,
      z: this.playerPos.z,
      flashlightOn: false,
      sprinting: false,
    };
    let bestDist = Infinity;
    let canSeeAny = false;
    let canHearAny = false;

    for (const c of candidates) {
      const d = Math.hypot(c.x - this.santaPos.x, c.z - this.santaPos.z);
      const effSight = c.flashlightOn ? scaling.santaSightRange : scaling.santaSightRange * 0.58;
      const sees =
        d <= effSight &&
        hasLineOfSight(this.mazeData.grid, this.santaPos.x, this.santaPos.z, c.x, c.z, CELL_SIZE);
      const hears = d < (c.sprinting ? 10.5 : 3.4);

      if (sees) canSeeAny = true;
      if (hears) canHearAny = true;

      const score = sees ? d * 0.65 : d;
      if (score < bestDist) {
        bestDist = score;
        nearestTarget = c;
      }
    }

    const distToTarget = Math.hypot(nearestTarget.x - this.santaPos.x, nearestTarget.z - this.santaPos.z);
    const santaCell = worldToCell(this.santaPos.x, this.santaPos.z, this.mazeData.size, CELL_SIZE);
    const targetCell = worldToCell(nearestTarget.x, nearestTarget.z, this.mazeData.size, CELL_SIZE);

    if (canSeeAny || canHearAny) {
      if (!this.santaAlerted && canSeeAny) {
        this.audio.playEvilHoHo(0.8);
      }
      this.santaAlerted = true;
      this.santaAlertTimer = 3.2; // Short memory after breaking LOS so players can juke him out
      this.santaLastKnownCell = { ...targetCell };
    } else if (this.santaAlerted) {
      this.santaAlertTimer -= dt;
      const reachedLastKnown =
        this.santaLastKnownCell &&
        santaCell.r === this.santaLastKnownCell.r &&
        santaCell.c === this.santaLastKnownCell.c;

      if (this.santaAlertTimer <= 0 || reachedLastKnown) {
        this.santaAlerted = false;
        this.santaLastKnownCell = null;
        this.santaPatrolTarget = this.pickRandomPatrolCell();
        if (!this.statusBanner && Math.hypot(this.playerPos.x - this.santaPos.x, this.playerPos.z - this.santaPos.z) < 22) {
          this.showBanner("You juked Santa and broke line of sight!", 2.5);
        }
      }
    }

    const rageBoost = 1 + Math.min(4, this.ornamentsCollected) * 0.025;
    const targetSpeed = (this.santaAlerted ? scaling.santaChaseSpeed : scaling.santaBaseSpeed) * rageBoost;
    this.santaCurrentSpeed = THREE.MathUtils.damp(this.santaCurrentSpeed, targetSpeed, 5, dt);

    let moveTargetX = nearestTarget.x;
    let moveTargetZ = nearestTarget.z;

    if (canSeeAny && distToTarget < 10.5) {
      moveTargetX = nearestTarget.x;
      moveTargetZ = nearestTarget.z;
    } else {
      let goalCell: GridCoord;
      if (this.santaAlerted && this.santaLastKnownCell) {
        // Chase last seen/heard cell rather than omniscient wall-hack tracking
        goalCell = this.santaLastKnownCell;
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
      } else {
        moveTargetX = nearestTarget.x;
        moveTargetZ = nearestTarget.z;
      }
    }

    const dx = moveTargetX - this.santaPos.x;
    const dz = moveTargetZ - this.santaPos.z;
    const len = Math.hypot(dx, dz);

    if (len > 0.05) {
      const desiredVx = (dx / len) * this.santaCurrentSpeed;
      const desiredVz = (dz / len) * this.santaCurrentSpeed;
      // Heavy momentum inertia so sharp turns & Space-dodges juke Santa out
      this.santaVelX = THREE.MathUtils.damp(this.santaVelX, desiredVx, 4.4, dt);
      this.santaVelZ = THREE.MathUtils.damp(this.santaVelZ, desiredVz, 4.4, dt);

      this.santaPos.x += this.santaVelX * dt;
      this.santaPos.z += this.santaVelZ * dt;
      this.resolveMazeCollisions(this.santaPos, 0.55);

      const desiredYaw = Math.atan2(this.santaVelX, this.santaVelZ);
      let deltaAngle = desiredYaw - this.santaYaw;
      while (deltaAngle > Math.PI) deltaAngle -= Math.PI * 2;
      while (deltaAngle < -Math.PI) deltaAngle += Math.PI * 2;
      this.santaYaw += deltaAngle * Math.min(1, dt * 5.2);
    }

    this.santa.root.position.copy(this.santaPos);
    this.santa.root.rotation.y = this.santaYaw;
    this.santa.updateAnimation(nowSec, this.santaCurrentSpeed, this.santaAlerted, 0);

    if (this.isMultiplayer && this.isHost && performance.now() - this.lastSantaSyncMs > 130) {
      this.lastSantaSyncMs = performance.now();
      this.mpCallbacks.onHostSantaSync?.({
        x: this.santaPos.x,
        z: this.santaPos.z,
        yaw: this.santaYaw,
        speed: this.santaCurrentSpeed,
        alerted: this.santaAlerted,
        stunRemaining: 0,
      });
    }

    return Math.hypot(this.playerPos.x - this.santaPos.x, this.playerPos.z - this.santaPos.z);
  }

  private getRelativeAngleDeg(targetX: number, targetZ: number): number {
    const fwdX = -Math.sin(this.yaw);
    const fwdZ = -Math.cos(this.yaw);
    const rightX = -fwdZ;
    const rightZ = fwdX;
    const toX = targetX - this.playerPos.x;
    const toZ = targetZ - this.playerPos.z;
    const dotFwd = toX * fwdX + toZ * fwdZ;
    const dotRight = toX * rightX + toZ * rightZ;
    return THREE.MathUtils.radToDeg(Math.atan2(dotRight, dotFwd));
  }

  private updateChimeBearing(): void {
    const playerCell = worldToCell(this.playerPos.x, this.playerPos.z, this.mazeData.size, CELL_SIZE);
    let goalCell: GridCoord | null = null;
    let fallbackX = 0;
    let fallbackZ = 0;

    if (this.exitUnlocked) {
      goalCell = this.mazeData.exitCell;
      const ew = cellToWorld(goalCell.r, goalCell.c, this.mazeData.size, CELL_SIZE);
      fallbackX = ew.x;
      fallbackZ = ew.z;
      this.chimeTargetLabel = 'Exit Gate';
    } else {
      let bestDist = Infinity;
      for (const o of this.ornaments) {
        if (o.collected) continue;
        const d = Math.hypot(o.group.position.x - this.playerPos.x, o.group.position.z - this.playerPos.z);
        if (d < bestDist) {
          bestDist = d;
          goalCell = { r: o.r, c: o.c };
          fallbackX = o.group.position.x;
          fallbackZ = o.group.position.z;
          this.chimeTargetLabel = 'Nearest Star';
        }
      }
    }

    if (!goalCell) {
      this.chimeAngleDeg = null;
      this.chimeTargetDistance = null;
      this.chimeTrailGroup.visible = false;
      return;
    }

    this.chimeTargetDistance = Math.hypot(fallbackX - this.playerPos.x, fallbackZ - this.playerPos.z);

    const path = findPathBFS(this.mazeData.grid, playerCell, goalCell, 10);
    if (path.length > 0) {
      const nw = cellToWorld(path[0].r, path[0].c, this.mazeData.size, CELL_SIZE);
      this.chimeAngleDeg = this.getRelativeAngleDeg(nw.x, nw.z);

      this.chimeTrailGroup.visible = this.chimeDisplayTimer > 0;
      for (let i = 0; i < this.chimeMarkers.length; i++) {
        const marker = this.chimeMarkers[i];
        if (i < path.length) {
          const pw = cellToWorld(path[i].r, path[i].c, this.mazeData.size, CELL_SIZE);
          marker.position.set(pw.x, 0.34, pw.z);
          marker.visible = true;
        } else {
          marker.visible = false;
        }
      }
    } else {
      this.chimeAngleDeg = this.getRelativeAngleDeg(fallbackX, fallbackZ);
      this.chimeTrailGroup.visible = false;
    }
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

  private updateBulbsAndProps(dt: number, nowSec: number): void {
    for (const o of this.ornaments) {
      if (o.collected) continue;
      o.starGroup.rotation.y = nowSec * 1.4 + o.id;
      o.starGroup.position.y = 1.18 + Math.sin(nowSec * 2.4 + o.id) * 0.09;
      o.light.intensity = 2.2 + Math.sin(nowSec * 3.5 + o.id) * 0.45;
    }

    for (const wp of this.weapons) {
      if (wp.collected) continue;
      wp.weaponMeshGroup.rotation.y = nowSec * 1.6 + wp.id;
      wp.weaponMeshGroup.position.y = 1.05 + Math.sin(nowSec * 2.8 + wp.id) * 0.08;
      wp.light.intensity = 2.1 + Math.sin(nowSec * 4.0 + wp.id) * 0.4;
    }

    for (const bat of this.batteries) {
      if (bat.collected) continue;
      bat.cellGroup.rotation.y = nowSec * 1.9 + bat.id;
      bat.cellGroup.position.y = 0.78 + Math.sin(nowSec * 3.0 + bat.id) * 0.08;
      bat.light.intensity = 1.9 + Math.sin(nowSec * 4.2 + bat.id) * 0.45;
    }

    for (const elf of this.tinyElves) {
      elf.update(dt, nowSec, this.playerPos.x, this.playerPos.z, this.mazeData.grid, CELL_SIZE, this.mazeData.size);
    }
    if (this.elfHelper) {
      this.elfHelper.update(dt, nowSec, this.santaPos.x, this.santaPos.z, this.mazeData.grid, CELL_SIZE, this.mazeData.size);
    }

    if (this.chimeTrailGroup && this.chimeTrailGroup.visible) {
      for (let i = 0; i < this.chimeMarkers.length; i++) {
        const m = this.chimeMarkers[i];
        if (!m.visible) continue;
        m.rotation.y = nowSec * 3.2 + i * 0.5;
        m.position.y = 0.34 + Math.sin(nowSec * 5.0 - i * 0.65) * 0.1;
      }
    }

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

    if (this.exitGate) {
      this.exitGate.portalMat.opacity = this.exitUnlocked
        ? 0.65 + Math.sin(nowSec * 5) * 0.15
        : 0.38 + Math.sin(nowSec * 2) * 0.08;
    }
  }

  private stepSimulation(dt: number, nowSec: number): void {
    this.updateSnow(dt);
    this.updateBulbsAndProps(dt, nowSec);

    if (this.shotTracerTimer > 0) {
      this.shotTracerTimer -= dt;
      if (this.shotTracerTimer <= 0) {
        this.shotTracerLine.visible = false;
      }
    }

    if (this.statusBannerTimer > 0) {
      this.statusBannerTimer -= dt;
      if (this.statusBannerTimer <= 0) {
        this.statusBanner = null;
      }
    }

    if (this.isMultiplayer) {
      for (const rig of this.remotePlayers.values()) {
        rig.update(dt, nowSec);
      }
    }

    if (this.phase === 'menu' || this.phase === 'waiting') {
      const sway = Math.sin(nowSec * 0.28) * 0.35;
      this.camera.position.set(this.playerPos.x, EYE_HEIGHT + Math.sin(nowSec * 0.8) * 0.04, this.playerPos.z);
      this.camera.rotation.set(0.02, this.yaw + sway, 0, 'YXZ');
      this.updateFlashlightTransform(nowSec, 999);
      return;
    }

    if (this.phase === 'caught' || this.phase === 'escaped') {
      return;
    }
    if (this.phase === 'paused' && !this.isMultiplayer) {
      return;
    }

    if (this.jumpscareActive) {
      this.jumpscareTimer -= dt;
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
        this.alive = false;
        this.flashlightOn = false;
        this.setEquippedWeapon(null);

        if (this.isMultiplayer) {
          this.mpCallbacks.onLocalPlayerSync?.({
            x: this.playerPos.x,
            z: this.playerPos.z,
            yaw: this.yaw,
            flashlightOn: false,
            alive: false,
            escaped: false,
          });
          this.mpCallbacks.onLocalEliminated?.();

          const anyTeammateAlive = Array.from(this.remotePlayers.values()).some((r) => r.alive && !r.escaped);
          if (anyTeammateAlive) {
            this.spectating = true;
            this.phase = 'playing';
            this.showBanner('Santa caught you! Spectating surviving teammates...', 5.0);
            this.pushHud();
            return;
          }
        }

        this.phase = 'caught';
        this.exitPointerLockSafe();
        this.pushHud();
      }
      return;
    }

    // Active gameplay tick
    this.elapsedSeconds += dt;
    if (this.elapsedSeconds >= this.nextWeaponSpawnAt) {
      this.spawnWeaponWave(this.nextWeaponWaveIndex, true);
      this.nextWeaponWaveIndex += 1;
      this.nextWeaponSpawnAt += WEAPON_SPAWN_INTERVAL;
    }

    if (this.chimeCooldown > 0) this.chimeCooldown = Math.max(0, this.chimeCooldown - dt);
    if (this.dodgeCooldown > 0) this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    if (this.weaponRecoilTimer > 0) this.weaponRecoilTimer = Math.max(0, this.weaponRecoilTimer - dt);

    if (this.chimeDisplayTimer > 0) {
      this.chimeDisplayTimer = Math.max(0, this.chimeDisplayTimer - dt);
      if (this.chimeDisplayTimer > 0) {
        this.updateChimeBearing();
      } else {
        this.chimeAngleDeg = null;
        this.chimeTargetDistance = null;
        this.chimeTrailGroup.visible = false;
      }
    }

    const controlsActive = this.phase === 'playing' && !this.chatOpen;

    if (controlsActive) {
      const turnSpeed = 2.15;
      if (this.keys['KeyQ'] || this.keys['ArrowLeft']) this.yaw += turnSpeed * dt;
      if (this.keys['KeyE'] || this.keys['ArrowRight']) this.yaw -= turnSpeed * dt;
    }

    let forwardInput = 0;
    let strafeInput = 0;
    if (controlsActive) {
      if (this.keys['KeyW'] || this.keys['ArrowUp']) forwardInput += 1;
      if (this.keys['KeyS'] || this.keys['ArrowDown']) forwardInput -= 1;
      if (this.keys['KeyD']) strafeInput += 1;
      if (this.keys['KeyA']) strafeInput -= 1;

      // Add touch joystick vector inputs
      if (Math.abs(this.touchMoveZ) > 0.05 || Math.abs(this.touchMoveX) > 0.05) {
        forwardInput -= this.touchMoveZ; // forward is negative Z in screen space
        strafeInput += this.touchMoveX;
      }
    }

    if (this.playerTrapStunRemaining > 0) {
      this.playerTrapStunRemaining = Math.max(0, this.playerTrapStunRemaining - dt);
      forwardInput = 0;
      strafeInput = 0;
    }

    const touchMagnitude = Math.hypot(this.touchMoveX, this.touchMoveZ);
    const wantsMove = Math.abs(forwardInput) > 0.01 || Math.abs(strafeInput) > 0.01;
    const wantsSprint =
      controlsActive &&
      (this.keys['ShiftLeft'] ||
        this.keys['ShiftRight'] ||
        this.touchSprint ||
        touchMagnitude > 0.92) &&
      wantsMove &&
      this.stamina > 2;
    const sprinting = wantsSprint && !this.spectating;

    if (sprinting) {
      this.stamina = Math.max(0, this.stamina - 9.5 * dt);
    } else {
      this.stamina = Math.min(100, this.stamina + (wantsMove ? 16 : 26) * dt);
    }

    if (this.spectating) {
      if (wantsMove) {
        _vecForward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
        _vecRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        _vecMove
          .set(0, 0, 0)
          .addScaledVector(_vecForward, forwardInput)
          .addScaledVector(_vecRight, strafeInput)
          .normalize()
          .multiplyScalar(7.5 * dt);
        this.playerPos.x += _vecMove.x;
        this.playerPos.z += _vecMove.z;
      } else {
        const aliveTeammate = Array.from(this.remotePlayers.values()).find((r) => r.alive && !r.escaped);
        if (aliveTeammate) {
          this.playerPos.x = THREE.MathUtils.damp(this.playerPos.x, aliveTeammate.root.position.x, 4, dt);
          this.playerPos.z = THREE.MathUtils.damp(this.playerPos.z, aliveTeammate.root.position.z, 4, dt);
        }
      }
    } else if (this.dodgeActiveTimer > 0) {
      this.dodgeActiveTimer = Math.max(0, this.dodgeActiveTimer - dt);
      const dashSpeed = 11.4;
      this.playerPos.x += this.dodgeDirX * dashSpeed * dt;
      this.playerPos.z += this.dodgeDirZ * dashSpeed * dt;
      this.resolveMazeCollisions(this.playerPos, PLAYER_RADIUS);
      this.walkBobPhase += dt * 16;
    } else if (wantsMove) {
      const moveSpeed = sprinting ? 6.75 : 4.15;
      const inputMag = Math.min(1, Math.hypot(forwardInput, strafeInput));
      _vecForward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      _vecRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      _vecMove
        .set(0, 0, 0)
        .addScaledVector(_vecForward, forwardInput)
        .addScaledVector(_vecRight, strafeInput)
        .normalize()
        .multiplyScalar(moveSpeed * inputMag * dt);

      this.playerPos.x += _vecMove.x;
      this.playerPos.z += _vecMove.z;
      this.resolveMazeCollisions(this.playerPos, PLAYER_RADIUS);

      this.walkBobPhase += dt * (sprinting ? 14 : 9.5) * inputMag;
    }

    if (!this.spectating && !this.exitUnlocked && this.exitGate) {
      const gateX = this.exitGate.group.position.x;
      const gateZ = this.exitGate.group.position.z;
      if (Math.abs(this.playerPos.z - gateZ) < CELL_SIZE * 0.7 && this.playerPos.x > gateX - 0.9) {
        this.playerPos.x = gateX - 0.9;
        if (!this.statusBanner) {
          this.showBanner(
            `Exit Gate sealed — recover all ${this.mazeData.ornaments.length} ornaments (${this.ornamentsCollected}/${this.mazeData.ornaments.length}).`,
            2.6
          );
        }
      }
    }

    const santaDist = this.updateSantaAI(dt, nowSec, sprinting);

    let tremorX = 0;
    let tremorY = 0;
    if (!this.spectating && this.santaStunRemaining <= 0 && santaDist < 12) {
      const strength = Math.pow(1 - santaDist / 12, 2) * 0.028;
      const stompPulse = Math.max(0, Math.sin(nowSec * (this.santaAlerted ? 9.5 : 5.4)));
      tremorX = (Math.random() - 0.5) * strength * stompPulse;
      tremorY = (Math.random() - 0.5) * strength * stompPulse;
    }

    const camEyeY = this.spectating ? 3.25 : EYE_HEIGHT;
    const bobOffset = !this.spectating && wantsMove ? Math.sin(this.walkBobPhase) * (sprinting ? 0.065 : 0.038) : 0;
    this.camera.position.set(this.playerPos.x + tremorX, camEyeY + bobOffset + tremorY, this.playerPos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.playerAmbientGlow.position.set(this.playerPos.x, camEyeY, this.playerPos.z);

    // Animate held 1st-person weapon viewmodel
    if (this.heldWeaponMount && this.equippedWeapon) {
      const recoilKick = this.weaponRecoilTimer > 0 ? Math.sin((this.weaponRecoilTimer / 0.3) * Math.PI) : 0;
      const swayX = wantsMove ? Math.cos(this.walkBobPhase * 0.5) * 0.014 : Math.sin(nowSec * 1.8) * 0.004;
      const swayY = wantsMove ? Math.abs(Math.sin(this.walkBobPhase)) * 0.015 : Math.cos(nowSec * 1.4) * 0.004;
      this.heldWeaponMount.position.set(0.32 + swayX, -0.26 - swayY + recoilKick * 0.05, -0.52 + recoilKick * 0.14);
      this.heldWeaponMount.rotation.set(recoilKick * 0.35, 0, 0);
    }

    const targetFov = sprinting || this.dodgeActiveTimer > 0 ? 81 : 74;
    if (Math.abs(this.currentFov - targetFov) > 0.05) {
      this.currentFov = THREE.MathUtils.damp(this.currentFov, targetFov, 8, dt);
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    if (this.flashlightOn && this.alive) {
      this.battery = Math.max(0, this.battery - 1.45 * dt);
      if (this.battery <= 0) {
        this.flashlightOn = false;
        this.audio.playFlashlightClick();
        this.showBanner('Flashlight dead! Vision darkened — recharging every ms, or grab a green Battery.', 4.5);
      }
    } else {
      // Continuous millisecond recharge whenever flashlight is off / depleted
      this.battery = Math.min(100, this.battery + 9.0 * dt);
    }

    const targetVision = (this.flashlightOn && this.battery > 0) || this.spectating ? 1.0 : 0.14;
    this.visionFactor = THREE.MathUtils.damp(this.visionFactor, targetVision, 5.5, dt);
    if (this.hemiLight) this.hemiLight.intensity = 0.14 + 0.44 * this.visionFactor;
    if (this.moonLight) this.moonLight.intensity = 0.1 + 0.32 * this.visionFactor;
    this.playerAmbientGlow.intensity = 0.12 + 0.7 * this.visionFactor;

    this.updateFlashlightTransform(nowSec, this.spectating || this.santaStunRemaining > 0 ? 999 : santaDist);

    this.audio.updateAmbience(
      nowSec,
      this.spectating ? 30 : santaDist,
      this.santaAlerted,
      !this.spectating && wantsMove,
      sprinting,
      this.santaStunRemaining > 0
    );

    if (this.alive && !this.spectating) {
      // Elf Trap collision check (5s stun)
      if (this.playerTrapStunRemaining <= 0) {
        for (const trap of this.elfTraps) {
          if (trap.triggered) continue;
          const d = Math.hypot(trap.group.position.x - this.playerPos.x, trap.group.position.z - this.playerPos.z);
          if (d < 1.15) {
            trap.triggered = true;
            trap.teethGroup.rotation.x = 0.85;
            this.playerTrapStunRemaining = 5.0;
            this.audio.playJumpscare();
            this.showBanner('Mischievous elf trap triggered! Stunned for 5 seconds!', 4.5);
          }
        }
      }

      // Battery pickup check
      for (const bat of this.batteries) {
        if (bat.collected) continue;
        const d = Math.hypot(bat.group.position.x - this.playerPos.x, bat.group.position.z - this.playerPos.z);
        if (d < 1.35) {
          bat.collected = true;
          bat.group.visible = false;
          this.syncedCollectedBatteries.add(bat.id);
          this.battery = Math.min(100, this.battery + 45);
          if (!this.flashlightOn) {
            this.flashlightOn = true;
          }
          this.audio.playBatteryPickup();
          this.showBanner('Battery cell collected (+45% flashlight charge)!', 2.8);
          if (this.isMultiplayer) {
            this.mpCallbacks.onCollectBattery?.(bat.id);
          }
        }
      }

      // Weapon pickup check
      for (const wp of this.weapons) {
        if (wp.collected) continue;
        const d = Math.hypot(wp.group.position.x - this.playerPos.x, wp.group.position.z - this.playerPos.z);
        if (d < 1.35) {
          if (this.equippedWeapon !== null) {
            if (!this.statusBanner) {
              this.showBanner(
                `Already holding ${WEAPON_SPECS[this.equippedWeapon].label}. Click or press G to use it!`,
                2.2
              );
            }
            continue;
          }
          wp.collected = true;
          wp.group.visible = false;
          this.syncedCollectedWeapons.add(wp.id);
          this.setEquippedWeapon(wp.type);
          this.audio.playWeaponPickup();
          const spec = WEAPON_SPECS[wp.type];
          this.showBanner(`Picked up ${spec.label}! Left-Click or press G to stun Santa 30s.`, 4.5);
          if (this.isMultiplayer) {
            this.mpCallbacks.onCollectWeapon?.(wp.id);
          }
        }
      }

      // Check Ornament Pickups
      for (const o of this.ornaments) {
        if (o.collected) continue;
        const d = Math.hypot(o.group.position.x - this.playerPos.x, o.group.position.z - this.playerPos.z);
        if (d < 1.35) {
          o.collected = true;
          o.group.visible = false;
          this.ornamentsCollected++;
          this.battery = Math.min(100, this.battery + 25);
          this.stamina = Math.min(100, this.stamina + 35);
          this.audio.playOrnamentPickup();

          if (this.isMultiplayer) {
            this.mpCallbacks.onCollectOrnament?.(o.id);
          }

          if (this.ornamentsCollected >= this.mazeData.ornaments.length) {
            this.unlockExitGateVisuals();
            this.audio.playExitUnlocked();
            this.showBanner(
              `All ${this.mazeData.ornaments.length} ornaments recovered! Follow the EXIT compass to escape!`,
              6.0
            );
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
        if (distExit < 1.8 || this.playerPos.x >= this.exitGate.group.position.x - 0.3) {
          this.phase = 'escaped';
          this.audio.playVictory();
          this.exitPointerLockSafe();
          if (this.isMultiplayer) {
            this.mpCallbacks.onLocalPlayerSync?.({
              x: this.playerPos.x,
              z: this.playerPos.z,
              yaw: this.yaw,
              flashlightOn: this.flashlightOn,
              alive: true,
              escaped: true,
            });
            this.mpCallbacks.onLocalEscaped?.();
          }
          this.pushHud(santaDist);
          return;
        }
      }

      // Check Santa Catch -> Jumpscare (only if Santa is NOT stunned!)
      if (this.santaStunRemaining <= 0 && santaDist < 1.24) {
        this.jumpscareActive = true;
        this.jumpscareTimer = 0.68;
        this.audio.playJumpscare();
        return;
      }
    }

    if (this.isMultiplayer && performance.now() - this.lastPlayerSyncMs > 120) {
      this.lastPlayerSyncMs = performance.now();
      this.mpCallbacks.onLocalPlayerSync?.({
        x: this.playerPos.x,
        z: this.playerPos.z,
        yaw: this.yaw,
        flashlightOn: this.flashlightOn,
        alive: this.alive,
        escaped: false,
      });
    }

    const hudIntervalMs = !this.flashlightOn && this.battery < 99.9 ? 32 : 55;
    if (performance.now() - this.lastHudPushMs > hudIntervalMs) {
      this.pushHud(santaDist);
    }
  }

  private updateFlashlightTransform(nowSec: number, santaDist: number): void {
    _vecForward.set(0, 0, -1).applyEuler(this.camera.rotation);
    this.flashlight.position.copy(this.camera.position);
    this.flashlight.position.y -= 0.12;
    _vecTarget.copy(this.camera.position).addScaledVector(_vecForward, 8);
    this.flashlightTarget.position.copy(_vecTarget);

    if (!this.flashlightOn && !this.spectating) {
      this.flashlight.intensity = 0;
      return;
    }

    if (this.spectating) {
      this.flashlight.intensity = 4.0;
      return;
    }

    let baseIntensity = 7.4;
    if (this.battery < 18) {
      baseIntensity *= 0.55 + (this.battery / 18) * 0.45;
    }
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

    const santaAngleDeg = this.santaPos
      ? this.getRelativeAngleDeg(this.santaPos.x, this.santaPos.z)
      : 0;

    const fwdX = -Math.sin(this.yaw);
    const fwdZ = -Math.cos(this.yaw);
    const rawHeading = THREE.MathUtils.radToDeg(Math.atan2(fwdX, -fwdZ));
    const playerHeadingDeg = (rawHeading + 360) % 360;

    let exitAngleDeg = 0;
    let exitDistance = 0;
    if (this.exitGate) {
      const gx = this.exitGate.group.position.x;
      const gz = this.exitGate.group.position.z;
      exitAngleDeg = this.getRelativeAngleDeg(gx, gz);
      exitDistance = Math.hypot(gx - this.playerPos.x, gz - this.playerPos.z);
    }

    let nearestOrnamentAngleDeg: number | null = null;
    let nearestOrnamentDistance: number | null = null;
    let bestOrnDist = Infinity;
    for (const o of this.ornaments) {
      if (o.collected) continue;
      const d = Math.hypot(o.group.position.x - this.playerPos.x, o.group.position.z - this.playerPos.z);
      if (d < bestOrnDist) {
        bestOrnDist = d;
        nearestOrnamentDistance = d;
        nearestOrnamentAngleDeg = this.getRelativeAngleDeg(o.group.position.x, o.group.position.z);
      }
    }

    let nearestWeaponAngleDeg: number | null = null;
    let nearestWeaponDistance: number | null = null;
    let bestWepDist = Infinity;
    for (const wp of this.weapons) {
      if (wp.collected) continue;
      const d = Math.hypot(wp.group.position.x - this.playerPos.x, wp.group.position.z - this.playerPos.z);
      if (d < bestWepDist) {
        bestWepDist = d;
        nearestWeaponDistance = d;
        nearestWeaponAngleDeg = this.getRelativeAngleDeg(wp.group.position.x, wp.group.position.z);
      }
    }

    let nearestBatteryDistance: number | null = null;
    let bestBatDist = Infinity;
    for (const bat of this.batteries) {
      if (bat.collected) continue;
      const d = Math.hypot(bat.group.position.x - this.playerPos.x, bat.group.position.z - this.playerPos.z);
      if (d < bestBatDist) {
        bestBatDist = d;
        nearestBatteryDistance = d;
      }
    }

    let mapState: MazeMapState | null = null;
    if (this.phase === 'playing' && this.mazeData) {
      const { size, cellSize, grid } = this.mazeData;
      const half = ((size - 1) * cellSize) / 2;
      const toNorm = (wx: number, wz: number) => ({
        normX: Math.max(0, Math.min(1, ((wx + half) / cellSize + 0.5) / size)),
        normZ: Math.max(0, Math.min(1, ((wz + half) / cellSize + 0.5) / size)),
      });

      const pNorm = toNorm(this.playerPos.x, this.playerPos.z);
      const sNorm = toNorm(this.santaPos.x, this.santaPos.z);
      const eNorm = this.exitGate
        ? toNorm(this.exitGate.group.position.x, this.exitGate.group.position.z)
        : { normX: 0.96, normZ: 0.96 };

      const otherPlayers: MapMarkerPlayer[] = [];
      for (const [uid, rig] of this.remotePlayers.entries()) {
        const rn = toNorm(rig.root.position.x, rig.root.position.z);
        otherPlayers.push({
          uid,
          displayName: rig.displayName,
          coatColor: rig.coatColorHex,
          normX: rn.normX,
          normZ: rn.normZ,
          alive: rig.alive,
          escaped: rig.escaped,
        });
      }

      mapState = {
        mazeSeed: this.activeMazeSeed,
        size,
        grid,
        playerNormX: pNorm.normX,
        playerNormZ: pNorm.normZ,
        playerYaw: this.yaw,
        santaNormX: sNorm.normX,
        santaNormZ: sNorm.normZ,
        santaAlerted: this.santaAlerted,
        santaStunRemaining: this.santaStunRemaining,
        exitNormX: eNorm.normX,
        exitNormZ: eNorm.normZ,
        exitUnlocked: this.exitUnlocked,
        ornaments: this.ornaments
          .filter((o) => !o.collected)
          .map((o) => toNorm(o.group.position.x, o.group.position.z)),
        batteries: this.batteries
          .filter((b) => !b.collected)
          .map((b) => toNorm(b.group.position.x, b.group.position.z)),
        weapons: this.weapons
          .filter((w) => !w.collected)
          .map((w) => toNorm(w.group.position.x, w.group.position.z)),
        otherPlayers,
      };
    }

    this.onHudUpdate({
      phase: this.phase,
      difficulty: this.difficulty,
      level: this.level,
      ornamentsCollected: this.ornamentsCollected,
      ornamentsTotal: this.mazeData
        ? this.mazeData.ornaments.length
        : getLevelScaling(this.level, this.difficulty).ornamentCount,
      exitUnlocked: this.exitUnlocked,
      stamina: this.stamina,
      battery: this.battery,
      flashlightOn: this.flashlightOn,
      darknessOverlay: Number(((1 - this.visionFactor) * 0.72).toFixed(3)),
      elapsedSeconds: this.elapsedSeconds,
      santaDistance: santaDist,
      santaAngleDeg,
      santaAlerted: this.santaAlerted,
      santaStunRemaining: this.santaStunRemaining,
      playerHeadingDeg,
      exitAngleDeg,
      exitDistance,
      nearestOrnamentAngleDeg,
      nearestOrnamentDistance,
      nearestWeaponAngleDeg,
      nearestWeaponDistance,
      nearestBatteryDistance,
      equippedWeapon: this.equippedWeapon,
      nextWeaponSpawnIn: Math.max(0, this.nextWeaponSpawnAt - this.elapsedSeconds),
      dodgeCooldown: this.dodgeCooldown,
      pointerLocked: this.pointerLocked,
      chimeCooldown: this.chimeCooldown,
      chimeAngleDeg: this.chimeAngleDeg,
      chimeTargetLabel: this.chimeTargetLabel,
      chimeTargetDistance: this.chimeTargetDistance,
      statusBanner: this.statusBanner,
      muted: this.audio.isMuted(),
      hudHidden: this.hudHidden,
      webglError: null,
      isMultiplayer: this.isMultiplayer,
      roomId: this.roomId,
      isHost: this.isHost,
      alive: this.alive,
      spectating: this.spectating,
      chatOpen: this.chatOpen,
      mapState,
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
    this.clearHeldWeaponViewmodel();
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
