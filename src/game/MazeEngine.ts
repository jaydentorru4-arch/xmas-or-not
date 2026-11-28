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
    stunned: boolean;
    equippedWeapon: WeaponType | '';
    shotCount: number;
    lastShotHit: boolean;
  }) => void;
  onHostSantaSync?: (state: SantaLiveData) => void;
  onCollectOrnament?: (ornamentId: number) => void;
  onCollectWeapon?: (weaponId: number) => void;
  onCollectBattery?: (batteryId: number) => void;
  onTriggerTrap?: (trapId: number) => void;
  onAdvanceWeaponWave?: (waveIndex: number) => void;
  onClaimHost?: () => void;
  onTriggerSantaStun?: () => void;
  onReviveTeammate?: (targetUid: string) => void;
  onLocalEliminated?: () => void;
  onLocalEscaped?: () => void;
}

interface SantaAgent {
  index: number;
  rig: EvilSantaRig;
  pos: THREE.Vector3;
  yaw: number;
  velX: number;
  velZ: number;
  alerted: boolean;
  alertTimer: number;
  lastKnownCell: GridCoord | null;
  patrolTarget: GridCoord | null;
  currentSpeed: number;
  stunRemaining: number;
  stuckTimer: number;
  stuckCount: number;
  forceBfsTimer: number;
  lastProgressPos: THREE.Vector3;
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
  private santas: SantaAgent[] = [];
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
  private lastRemoteSantaAtMs = 0;
  private lastHostClaimAttemptMs = 0;
  private lastPlayerSyncMs = 0;
  private lastSyncedPlayerPos = new THREE.Vector3(999, 0, 999);
  private lastSyncedYaw = 999;
  private lastSyncedStateKey = '';
  private lastSantaSyncMs = 0;
  private syncedCollectedWeapons = new Set<number>();
  private syncedCollectedBatteries = new Set<number>();
  private syncedTriggeredTraps = new Set<number>();
  private lastSeenStunNonce = 0;
  private localShotCount = 0;
  private lastShotHit = false;
  private hiddenHostTimerId: number | null = null;
  private fallenPos = new THREE.Vector3();
  private lastSeenReviveCount = 0;
  private reviveGraceTimer = 0;
  private lastReviveClickMs = 0;
  private lastShotStunHandledMs = 0;

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

  // Santa Jumpscare state
  private jumpscareTimer = 0;
  private jumpscareActive = false;
  private jumpscareSantaIndex = 0;

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
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 1.5));
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
    this.flashlight.shadow.mapSize.width = 512;
    this.flashlight.shadow.mapSize.height = 512;
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
    for (const s of this.santas) {
      s.rig.dispose();
    }
    this.santas = [];
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

    const { size, cellSize, grid, playerSpawn } = this.mazeData;
    const rng = createRng(this.activeMazeSeed + waveIndex * 977 + 31);
    const openCells: GridCoord[] = [];
    for (let r = 1; r < size - 1; r++) {
      for (let c = 1; c < size - 1; c++) {
        if (grid[r][c] === 0 && (r !== playerSpawn.r || c !== playerSpawn.c)) {
          openCells.push({ r, c });
        }
      }
    }
    if (openCells.length === 0) return;

    const spawnW = cellToWorld(playerSpawn.r, playerSpawn.c, size, cellSize);
    for (let slot = 0; slot < 2; slot++) {
      const weaponId = waveIndex * 10 + slot;
      if (this.weapons.some((w) => w.id === weaponId)) {
        continue;
      }

      let chosen: GridCoord = openCells[Math.floor(rng() * openCells.length)] || playerSpawn;
      for (let tries = 0; tries < 40; tries++) {
        const candidate = openCells[Math.floor(rng() * openCells.length)];
        if (!candidate) break;
        const w = cellToWorld(candidate.r, candidate.c, size, cellSize);
        const distFromStart = Math.hypot(w.x - spawnW.x, w.z - spawnW.z);
        const tooCloseToWeapon = this.weapons.some(
          (wp) => Math.hypot(wp.group.position.x - w.x, wp.group.position.z - w.z) < 10
        );
        if (!tooCloseToWeapon && (waveIndex > 0 || distFromStart > 8)) {
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
      if (this.syncedCollectedWeapons.has(weaponId)) {
        prop.collected = true;
        prop.group.visible = false;
      }
      this.weapons.push(prop);
      this.mazeGroup.add(prop.group);
    }

    if (announce && !this.syncedCollectedWeapons.has(waveIndex * 10)) {
      this.audio.playWeaponPickup();
      this.showBanner('New weapons dropped in the maze! Find one to stun Santa for 30s.', 4.5);
    }
  }

  private buildNewLevel(seed?: number, levelOverride?: number): void {
    this.clearMazeGroup();
    this.setEquippedWeapon(null);
    if (levelOverride !== undefined) {
      this.level = Math.max(1, Math.min(99, Math.floor(levelOverride)));
    }

    const scaling = getLevelScaling(this.level, this.difficulty);
    this.fog.density = scaling.fogDensity;
    this.activeMazeSeed = seed ?? Math.floor(1 + Math.random() * 999999);
    this.mazeData = generateMaze(
      scaling.ornamentCount,
      this.activeMazeSeed,
      scaling.mazeSize,
      scaling.batteryCount,
      scaling.santaCount
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

    // Spawn Tiny Elves across the maze deterministically so all multiplayer clients match
    const elfCount = Math.min(8, 3 + Math.floor(this.level * 0.4));
    for (let i = 0; i < elfCount; i++) {
      const elfRig = createTinyElf(
        this.textures.contactShadow,
        false,
        this.activeMazeSeed + 505 + i * 73
      );
      const randCoord = this.mazeData.ornaments[i % this.mazeData.ornaments.length] || this.mazeData.playerSpawn;
      const ew = cellToWorld(randCoord.r, randCoord.c, size, cellSize);
      elfRig.root.position.set(ew.x, 0, ew.z);
      this.tinyElves.push(elfRig);
      this.mazeGroup.add(elfRig.root);
    }

    // Nightmare & Insane mode helper elf accompanying Evil Santa
    if (this.difficulty === 'nightmare' || this.difficulty === 'insane') {
      const helper = createTinyElf(this.textures.contactShadow, true, this.activeMazeSeed + 909);
      const santaW = cellToWorld(this.mazeData.santaSpawn.r, this.mazeData.santaSpawn.c, size, cellSize);
      helper.root.position.set(santaW.x, 0, santaW.z);
      this.elfHelper = helper;
      this.mazeGroup.add(helper.root);
    }

    const exitW = cellToWorld(this.mazeData.exitCell.r, this.mazeData.exitCell.c, size, cellSize);
    this.exitGate = createExitGate(exitW.x, exitW.z, this.textures.candyCaneColor, this.levelDisposables);
    this.exitGate.group.rotation.y = Math.PI / 2;
    this.mazeGroup.add(this.exitGate.group);

    this.santas = this.mazeData.santaSpawns.map((coord, index) => {
      const rig = createEvilSanta(this.textures.contactShadow, this.textures.candyCaneColor);
      const sw = cellToWorld(coord.r, coord.c, size, cellSize);
      const pos = new THREE.Vector3(sw.x, 0, sw.z);
      rig.root.position.copy(pos);
      this.mazeGroup.add(rig.root);
      return {
        index,
        rig,
        pos,
        yaw: 0,
        velX: 0,
        velZ: 0,
        alerted: false,
        alertTimer: 0,
        lastKnownCell: null,
        patrolTarget: null,
        currentSpeed: 0,
        stunRemaining: 0,
        stuckTimer: 0,
        stuckCount: 0,
        forceBfsTimer: 0,
        lastProgressPos: pos.clone(),
      };
    });

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
    this.jumpscareActive = false;
    this.jumpscareTimer = 0;
    this.jumpscareSantaIndex = 0;
    this.chimeCooldown = 0;
    this.chimeDisplayTimer = 0;
    this.chimeAngleDeg = null;
    this.chimeTargetDistance = null;
    if (this.chimeTrailGroup) this.chimeTrailGroup.visible = false;
    this.syncedCollectedWeapons.clear();
    this.syncedCollectedBatteries.clear();
    this.syncedTriggeredTraps.clear();
    this.lastSeenStunNonce = 0;
    this.localShotCount = 0;
    this.lastShotHit = false;
    this.fallenPos.copy(this.playerPos);
    this.lastSeenReviveCount = 0;
    this.reviveGraceTimer = 0;
    this.lastReviveClickMs = 0;
    this.lastShotStunHandledMs = 0;
    this.lastSyncedPlayerPos.set(999, 0, 999);
    this.lastSyncedYaw = 999;
    this.lastSyncedStateKey = '';
    this.nextWeaponWaveIndex = 1;
    this.nextWeaponSpawnAt = WEAPON_SPAWN_INTERVAL;

    // Spawn initial wave of 2 weapons deterministically
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
    this.level = Math.max(1, Math.min(99, Math.floor(level || 1)));
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
    const santaNote =
      this.santas.length > 1 ? ` Beware: ${this.santas.length} Evil Santas patrol this maze!` : '';
    this.showBanner(
      `Level ${this.level}: Collect ${this.mazeData.ornaments.length} ornaments.${santaNote}`
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
    this.level = Math.max(1, Math.min(99, Math.floor(level || 1)));
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

  private pushLocalPlayerSync(force = false): void {
    if (!this.isMultiplayer) return;
    const now = performance.now();
    const stunned = this.playerTrapStunRemaining > 0;
    const eqWep: WeaponType | '' = this.equippedWeapon || '';
    const stateKey = `${this.flashlightOn}|${this.alive}|${this.phase === 'escaped'}|${stunned}|${eqWep}|${this.localShotCount}`;

    // When downed or escaped, freeze synced coords at fallenPos and skip periodic keepalive writes
    // so we never clobber a teammate's revive write or burn Firestore quota while spectating.
    const syncX = this.alive ? this.playerPos.x : this.fallenPos.x;
    const syncZ = this.alive ? this.playerPos.z : this.fallenPos.z;
    const moved =
      this.alive &&
      this.phase === 'playing' &&
      (Math.hypot(syncX - this.lastSyncedPlayerPos.x, syncZ - this.lastSyncedPlayerPos.z) > 0.16 ||
        Math.abs(this.yaw - this.lastSyncedYaw) > 0.1);
    const stateChanged = stateKey !== this.lastSyncedStateKey;
    const dueKeepalive = this.alive && this.phase === 'playing' && now - this.lastPlayerSyncMs > 2500;
    const dueMove = moved && now - this.lastPlayerSyncMs > 260;

    if (!force && !stateChanged && !dueMove && !dueKeepalive) {
      return;
    }

    this.lastPlayerSyncMs = now;
    this.lastSyncedPlayerPos.set(syncX, EYE_HEIGHT, syncZ);
    this.lastSyncedYaw = this.yaw;
    this.lastSyncedStateKey = stateKey;

    this.mpCallbacks.onLocalPlayerSync?.({
      x: syncX,
      z: syncZ,
      yaw: this.yaw,
      flashlightOn: this.flashlightOn,
      alive: this.alive,
      escaped: this.phase === 'escaped',
      stunned,
      equippedWeapon: eqWep,
      shotCount: this.localShotCount,
      lastShotHit: this.lastShotHit,
    });
  }

  private buildSantaSyncPayload(): SantaLiveData {
    const primary = this.santas[0];
    const extras = this.santas.slice(1, 3).map((s) => ({
      x: s.pos.x,
      z: s.pos.z,
      yaw: s.yaw,
      speed: s.currentSpeed,
      alerted: s.alerted,
      stunRemaining: s.stunRemaining,
    }));
    return {
      x: primary ? primary.pos.x : 0,
      z: primary ? primary.pos.z : 0,
      yaw: primary ? primary.yaw : 0,
      speed: primary ? primary.currentSpeed : 0,
      alerted: primary ? primary.alerted : false,
      stunRemaining: primary ? primary.stunRemaining : 0,
      extras,
    };
  }

  public setRoomHostStatus(isHost: boolean): void {
    if (this.isHost === isHost) return;
    this.isHost = isHost;
    if (isHost) {
      this.remoteSantaTarget = null;
      for (const s of this.santas) {
        s.lastProgressPos.copy(s.pos);
        s.stuckTimer = 0;
        s.stuckCount = 0;
        s.forceBfsTimer = 0;
      }
    }
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
    this.level = Math.max(1, Math.min(99, Math.floor(cfg.level || 1)));
    this.isMultiplayer = true;
    this.roomId = cfg.roomId;
    this.isHost = cfg.isHost;
    this.localUid = cfg.localUid;
    this.alive = true;
    this.spectating = false;
    this.chatOpen = false;
    this.mpCallbacks = cfg.callbacks;
    this.remoteSantaTarget = null;
    this.lastRemoteSantaAtMs = Date.now();

    this.audio.init();
    this.buildNewLevel(cfg.mazeSeed, this.level);
    this.phase = 'playing';
    const santaNote =
      this.santas.length > 1 ? ` ${this.santas.length} Evil Santas active!` : ' Weapons drop every 60s.';
    this.showBanner(
      `Level ${this.level}: Collect ${this.mazeData.ornaments.length} ornaments!${santaNote}`
    );
    this.requestPointerLockSafe();

    this.pushLocalPlayerSync(true);
    if (this.isHost) {
      this.mpCallbacks.onHostSantaSync?.(this.buildSantaSyncPayload());
    }
    this.pushHud();
  }

  public applyRemotePlayers(players: RoomPlayerData[]): void {
    this.latestRoomPlayers = players;
    if (!this.isMultiplayer || !this.mazeGroup) return;

    const seen = new Set<string>();
    for (const p of players) {
      if (p.uid === this.localUid) {
        const revCount = Number(p.reviveCount || 0);
        if (this.phase === 'playing' && !this.alive && (p.alive || revCount > this.lastSeenReviveCount)) {
          this.lastSeenReviveCount = revCount;
          this.alive = true;
          this.spectating = false;
          this.jumpscareActive = false;
          this.playerTrapStunRemaining = 0;
          this.reviveGraceTimer = 3.5;
          this.playerPos.set(this.fallenPos.x, EYE_HEIGHT, this.fallenPos.z);
          this.resolveMazeCollisions(this.playerPos, PLAYER_RADIUS);
          this.flashlightOn = true;
          this.battery = Math.max(this.battery, 60);
          this.stamina = Math.max(this.stamina, 80);
          this.audio.playOrnamentPickup();
          const by = p.revivedBy ? ` by ${p.revivedBy}` : '';
          this.showBanner(`Revived${by}! 3.5s grace shield — move!`, 4.5);
          this.pushLocalPlayerSync(true);
          this.pushHud();
        } else if (revCount > this.lastSeenReviveCount) {
          this.lastSeenReviveCount = revCount;
        }
        continue;
      }
      seen.add(p.uid);

      let rig = this.remotePlayers.get(p.uid);
      if (!rig) {
        const spawnW = this.mazeData
          ? cellToWorld(this.mazeData.playerSpawn.r, this.mazeData.playerSpawn.c, this.mazeData.size, CELL_SIZE)
          : { x: 0, z: 0 };
        const initial: RoomPlayerData =
          p.x === 0 && p.z === 0 ? { ...p, x: spawnW.x, z: spawnW.z } : p;
        rig = createRemoteSurvivor(initial, this.textures.contactShadow, this.textures.candyCaneColor);
        this.remotePlayers.set(p.uid, rig);
        this.mazeGroup.add(rig.root);
      } else {
        const events = rig.syncFromData(p);
        if (this.phase === 'playing') {
          if (events.justCaught) {
            this.audio.playJumpscare();
            this.showBanner(`${p.displayName} is downed! Go revive them (R)!`, 4.5);
          } else if (events.justRevived) {
            this.audio.playOrnamentPickup();
            this.showBanner(`${p.displayName} was revived!`, 3.5);
          } else if (events.justEscaped) {
            this.audio.playOrnamentPickup();
            this.showBanner(`${p.displayName} escaped through the Exit Gate!`, 4.5);
          } else if (events.justStunned) {
            this.showBanner(`${p.displayName} stepped in an Elf Trap (5s stun)!`, 3.5);
          } else if (events.justShot) {
            this.audio.playWeaponFire('tranq_dart');
            if (events.shotHit) {
              // Match the Santa aligned with the shooter's aim and line-of-sight (fallback to nearest)
              const aimFwdX = -Math.sin(rig.targetYaw);
              const aimFwdZ = -Math.cos(rig.targetYaw);
              let targetSanta: SantaAgent | null = null;
              let bestScore = Infinity;
              let fallbackSanta: SantaAgent | null = null;
              let fallbackDist = Infinity;

              for (const s of this.santas) {
                const dx = s.pos.x - rig.targetX;
                const dz = s.pos.z - rig.targetZ;
                const d = Math.hypot(dx, dz);
                if (d < fallbackDist) {
                  fallbackDist = d;
                  fallbackSanta = s;
                }
                const losClear =
                  this.mazeData &&
                  hasLineOfSight(this.mazeData.grid, rig.targetX, rig.targetZ, s.pos.x, s.pos.z, CELL_SIZE);
                if (!losClear) continue;
                const dot = d > 0.01 ? (dx * aimFwdX + dz * aimFwdZ) / d : 1;
                const aimPenalty = Math.max(0, 1 - dot) * 14;
                const stunPenalty = s.stunRemaining > 0 ? 10 : 0;
                const score = d + aimPenalty + stunPenalty;
                if (score < bestScore) {
                  bestScore = score;
                  targetSanta = s;
                }
              }

              targetSanta = targetSanta || fallbackSanta;
              if (targetSanta) {
                this.lastShotStunHandledMs = performance.now();
                targetSanta.stunRemaining = 30.0;
                targetSanta.alerted = false;
                targetSanta.alertTimer = 0;
                targetSanta.currentSpeed = 0;
                targetSanta.velX = 0;
                targetSanta.velZ = 0;
                targetSanta.stuckTimer = 0;
                targetSanta.stuckCount = 0;
                targetSanta.forceBfsTimer = 0;
                this.audio.playSantaStunned();
                this.showBanner(`${p.displayName} stunned an Evil Santa for 30s!`, 4.0);
                if (this.isHost) {
                  this.lastSantaSyncMs = performance.now();
                  this.mpCallbacks.onHostSantaSync?.(this.buildSantaSyncPayload());
                }
              }
            } else {
              this.showBanner(`${p.displayName} fired a stun weapon!`, 2.5);
            }
          }
        }
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
    if (!Number.isFinite(santa.x) || !Number.isFinite(santa.z)) return;
    this.lastRemoteSantaAtMs = santa.updatedAtMs || Date.now();
    if (!this.remoteSantaTarget) {
      const primary = this.santas[0];
      if (primary && Math.hypot(santa.x - primary.pos.x, santa.z - primary.pos.z) > 10) {
        primary.pos.set(santa.x, 0, santa.z);
        this.resolveMazeCollisions(primary.pos, 0.55);
        primary.yaw = Number.isFinite(santa.yaw) ? santa.yaw : primary.yaw;
      }
      if (Array.isArray(santa.extras)) {
        santa.extras.forEach((ex, i) => {
          const agent = this.santas[i + 1];
          if (
            agent &&
            Number.isFinite(ex.x) &&
            Number.isFinite(ex.z) &&
            Math.hypot(ex.x - agent.pos.x, ex.z - agent.pos.z) > 10
          ) {
            agent.pos.set(ex.x, 0, ex.z);
            this.resolveMazeCollisions(agent.pos, 0.55);
            agent.yaw = Number.isFinite(ex.yaw) ? ex.yaw : agent.yaw;
          }
        });
      }
    }
    this.remoteSantaTarget = santa;
  }

  public applyRoomState(
    collectedOrnaments: number[],
    exitUnlocked: boolean,
    collectedWeapons: number[],
    collectedBatteries: number[],
    triggeredTraps: number[],
    weaponWave: number,
    santaStunNonce: number
  ): void {
    if (!this.isMultiplayer) return;

    const idSet = new Set(collectedOrnaments);
    let newlyCollected = false;
    let changed = false;

    for (const o of this.ornaments) {
      if (idSet.has(o.id) && !o.collected) {
        o.collected = true;
        o.group.visible = false;
        newlyCollected = true;
        changed = true;
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
      changed = true;
    }

    // Ensure any weapon wave triggered on host/room is spawned identically on all clients
    const maxCollectedWave = collectedWeapons.reduce((acc, wid) => Math.max(acc, Math.floor(wid / 10)), 0);
    const targetWave = Math.max(weaponWave, maxCollectedWave);
    while (this.nextWeaponWaveIndex <= targetWave) {
      this.spawnWeaponWave(this.nextWeaponWaveIndex, !this.isHost);
      this.nextWeaponWaveIndex += 1;
      this.nextWeaponSpawnAt = this.nextWeaponWaveIndex * WEAPON_SPAWN_INTERVAL;
      changed = true;
    }

    for (const wid of collectedWeapons) {
      this.syncedCollectedWeapons.add(wid);
      const wp = this.weapons.find((w) => w.id === wid);
      if (wp && !wp.collected) {
        wp.collected = true;
        wp.group.visible = false;
        changed = true;
      }
    }

    for (const bid of collectedBatteries) {
      this.syncedCollectedBatteries.add(bid);
      const bat = this.batteries.find((b) => b.id === bid);
      if (bat && !bat.collected) {
        bat.collected = true;
        bat.group.visible = false;
        changed = true;
      }
    }

    for (const tid of triggeredTraps) {
      this.syncedTriggeredTraps.add(tid);
      const trap = this.elfTraps.find((t) => t.id === tid);
      if (trap && !trap.triggered) {
        trap.triggered = true;
        trap.teethGroup.rotation.x = 0.85;
        changed = true;
      }
    }

    if (santaStunNonce > this.lastSeenStunNonce) {
      this.lastSeenStunNonce = santaStunNonce;
      const recentlyHandledByShot = performance.now() - this.lastShotStunHandledMs < 1500;
      if (!recentlyHandledByShot) {
        const target = this.santas.find((s) => s.stunRemaining <= 0) || this.santas[0];
        if (target) {
          target.stunRemaining = 30.0;
          target.alerted = false;
          target.alertTimer = 0;
          target.currentSpeed = 0;
          target.velX = 0;
          target.velZ = 0;
          target.stuckTimer = 0;
          target.stuckCount = 0;
          target.forceBfsTimer = 0;
          this.audio.playSantaStunned();
          this.showBanner('Evil Santa stunned for 30 seconds!', 4.5);
        }
      }
      changed = true;
    }

    if (changed) {
      this.pushHud();
    }
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
      this.level = Math.max(1, Math.min(99, Math.floor(level)));
    }
    if (this.fog) {
      this.fog.density = getLevelScaling(this.level, difficulty).fogDensity;
    }
    this.pushHud();
  }

  public setSelectedLevel(level: number): void {
    this.level = Math.max(1, Math.min(99, Math.floor(level || 1)));
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
    this.pushLocalPlayerSync(true);
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

    let minDistAny = Infinity;
    let bestHitSanta: SantaAgent | null = null;
    let bestHitDist = Infinity;

    for (const s of this.santas) {
      const d = Math.hypot(s.pos.x - this.playerPos.x, s.pos.z - this.playerPos.z);
      if (d < minDistAny) minDistAny = d;

      const aimAngle = Math.abs(this.getRelativeAngleDeg(s.pos.x, s.pos.z));
      const lateralMissDist = d * Math.sin(THREE.MathUtils.degToRad(Math.min(89, aimAngle)));
      const maxAngle = spec.kind === 'melee' ? 68 : 34;

      const losClear = hasLineOfSight(
        this.mazeData.grid,
        this.playerPos.x,
        this.playerPos.z,
        s.pos.x,
        s.pos.z,
        CELL_SIZE
      );

      const hitsThis =
        d <= spec.range &&
        (aimAngle <= maxAngle || lateralMissDist <= spec.hitRadius) &&
        losClear;

      if (hitsThis && d < bestHitDist) {
        bestHitDist = d;
        bestHitSanta = s;
      }
    }

    // Don't waste melee Candy Bat if swung miles away from every Santa
    if (spec.kind === 'melee' && minDistAny > spec.range + 1.2) {
      this.weaponRecoilTimer = 0.25;
      this.audio.playWeaponFire(weaponType);
      this.showBanner(`Too far for Heavy Candy Bat — get within ${spec.range}m of Santa!`, 2.4);
      return;
    }

    this.weaponRecoilTimer = 0.3;
    this.audio.playWeaponFire(weaponType);

    const hitSanta = bestHitSanta !== null;

    // Show laser/frost tracer for ranged weapons
    if (spec.kind === 'ranged') {
      _vecForward.set(0, 0, -1).applyEuler(this.camera.rotation);
      const startPt = this.camera.position.clone().add(new THREE.Vector3(0, -0.14, 0));
      const endPt = bestHitSanta
        ? new THREE.Vector3(bestHitSanta.pos.x, 1.5, bestHitSanta.pos.z)
        : startPt.clone().addScaledVector(_vecForward, spec.range);
      const posAttr = this.shotTracerLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      posAttr.setXYZ(0, startPt.x, startPt.y, startPt.z);
      posAttr.setXYZ(1, endPt.x, endPt.y, endPt.z);
      posAttr.needsUpdate = true;
      this.shotTracerLine.visible = true;
      this.shotTracerTimer = 0.16;
    }

    // Consume single-use weapon charge & record shot for multiplayer visibility
    this.setEquippedWeapon(null);
    this.localShotCount += 1;
    this.lastShotHit = hitSanta;

    if (bestHitSanta) {
      this.lastShotStunHandledMs = performance.now();
      bestHitSanta.stunRemaining = spec.stunSeconds;
      bestHitSanta.alerted = false;
      bestHitSanta.alertTimer = 0;
      bestHitSanta.currentSpeed = 0;
      bestHitSanta.velX = 0;
      bestHitSanta.velZ = 0;
      bestHitSanta.stuckTimer = 0;
      bestHitSanta.stuckCount = 0;
      bestHitSanta.forceBfsTimer = 0;
      this.audio.playSantaStunned();
      const labelSuffix = this.santas.length > 1 ? ` #${bestHitSanta.index + 1}` : '';
      this.showBanner(`Direct hit with ${spec.label}! Santa${labelSuffix} stunned for 30 seconds!`, 5.0);

      if (this.isMultiplayer) {
        this.lastSeenStunNonce += 1;
        this.mpCallbacks.onTriggerSantaStun?.();
        if (this.isHost) {
          this.lastSantaSyncMs = performance.now();
          this.mpCallbacks.onHostSantaSync?.(this.buildSantaSyncPayload());
        }
      }
    } else {
      this.showBanner(`${spec.label} missed! Find another weapon drop.`, 3.0);
    }

    this.pushLocalPlayerSync(true);
    this.pushHud();
  }

  private getNearbyFallenTeammate(): { uid: string; displayName: string; distance: number } | null {
    if (!this.isMultiplayer || !this.alive || this.spectating) return null;
    let best: { uid: string; displayName: string; distance: number } | null = null;
    for (const rig of this.remotePlayers.values()) {
      if (rig.alive || rig.escaped) continue;
      const d = Math.hypot(rig.targetX - this.playerPos.x, rig.targetZ - this.playerPos.z);
      if (d <= 2.9 && (!best || d < best.distance)) {
        best = { uid: rig.uid, displayName: rig.displayName, distance: d };
      }
    }
    return best;
  }

  public reviveNearbyTeammate(): void {
    if (this.phase !== 'playing' || !this.isMultiplayer || !this.alive || this.spectating) return;
    if (this.playerTrapStunRemaining > 0) {
      this.showBanner('Cannot revive while trapped!', 2.0);
      return;
    }
    const now = performance.now();
    if (now - this.lastReviveClickMs < 900) return;

    const target = this.getNearbyFallenTeammate();
    if (!target) return;

    this.lastReviveClickMs = now;
    this.audio.playOrnamentPickup();
    this.showBanner(`Reviving ${target.displayName}...`, 2.5);
    this.mpCallbacks.onReviveTeammate?.(target.uid);
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
      } else if (e.code === 'KeyR') {
        this.reviveNearbyTeammate();
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
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 1.5));
  };

  private handleContextLost = (e: Event) => {
    e.preventDefault();
    this.pushHud(undefined, { webglError: 'WebGL rendering context was lost. Waiting to restore...' });
  };

  private handleContextRestored = () => {
    this.pushHud(undefined, { webglError: null });
  };

  private handleVisibilityChange = () => {
    if (document.hidden && this.isMultiplayer && this.isHost && this.phase === 'playing') {
      if (this.hiddenHostTimerId === null) {
        this.hiddenHostTimerId = window.setInterval(() => {
          if (!document.hidden || !this.isMultiplayer || !this.isHost || this.disposed) {
            if (this.hiddenHostTimerId !== null) {
              clearInterval(this.hiddenHostTimerId);
              this.hiddenHostTimerId = null;
            }
            return;
          }
          const hasActive = Array.from(this.remotePlayers.values()).some((r) => r.alive && !r.escaped);
          if (hasActive) {
            this.updateSantaAI(0.28, performance.now() / 1000, false);
          }
        }, 280);
      }
    } else if (this.hiddenHostTimerId !== null) {
      clearInterval(this.hiddenHostTimerId);
      this.hiddenHostTimerId = null;
    }
  };

  private bindEvents(): void {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('resize', this.handleResize);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
  }

  private unbindEvents(): void {
    if (this.hiddenHostTimerId !== null) {
      clearInterval(this.hiddenHostTimerId);
      this.hiddenHostTimerId = null;
    }
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('resize', this.handleResize);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    const canvas = this.renderer?.domElement;
    if (canvas) {
      canvas.removeEventListener('pointerdown', this.handlePointerDown);
      canvas.removeEventListener('webglcontextlost', this.handleContextLost);
      canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    }
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
  }

  private resolveMazeCollisions(
    pos: THREE.Vector3,
    radius: number,
    vel?: { vx: number; vz: number }
  ): void {
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
          let nx = 0;
          let nz = 0;
          if (dist > 0.0001) {
            const overlap = radius - dist;
            nx = dx / dist;
            nz = dz / dist;
            pos.x += nx * overlap;
            pos.z += nz * overlap;
          } else {
            const penX = halfWall + radius - Math.abs(pos.x - wx);
            const penZ = halfWall + radius - Math.abs(pos.z - wz);
            if (penX < penZ) {
              nx = pos.x >= wx ? 1 : -1;
              pos.x += nx * penX;
            } else {
              nz = pos.z >= wz ? 1 : -1;
              pos.z += nz * penZ;
            }
          }
          if (vel) {
            const vn = vel.vx * nx + vel.vz * nz;
            if (vn < 0) {
              vel.vx -= vn * nx;
              vel.vz -= vn * nz;
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

  private clampToWalkableCell(cell: GridCoord): GridCoord {
    const { size, grid, santaSpawn } = this.mazeData;
    const r0 = Math.max(0, Math.min(size - 1, cell.r));
    const c0 = Math.max(0, Math.min(size - 1, cell.c));
    if (grid[r0]?.[c0] === 0) return { r: r0, c: c0 };

    for (let radius = 1; radius <= 3; radius++) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const nr = r0 + dr;
          const nc = c0 + dc;
          if (nr >= 0 && nr < size && nc >= 0 && nc < size && grid[nr][nc] === 0) {
            return { r: nr, c: nc };
          }
        }
      }
    }
    return { ...santaSpawn };
  }

  private hasClearCorridor(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    halfWidth = 0.64
  ): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.08) return true;
    const grid = this.mazeData.grid;
    if (!hasLineOfSight(grid, ax, az, bx, bz, CELL_SIZE)) return false;

    const px = (-dz / dist) * halfWidth;
    const pz = (dx / dist) * halfWidth;
    return (
      hasLineOfSight(grid, ax + px, az + pz, bx + px, bz + pz, CELL_SIZE) &&
      hasLineOfSight(grid, ax - px, az - pz, bx - px, bz - pz, CELL_SIZE)
    );
  }

  private pickOpenNeighborCell(cell: GridCoord): GridCoord {
    const { size, grid } = this.mazeData;
    const dirs = [
      { dr: -1, dc: 0 },
      { dr: 1, dc: 0 },
      { dr: 0, dc: -1 },
      { dr: 0, dc: 1 },
    ];
    for (const d of dirs) {
      const nr = cell.r + d.dr;
      const nc = cell.c + d.dc;
      if (nr >= 0 && nr < size && nc >= 0 && nc < size && grid[nr][nc] === 0) {
        return { r: nr, c: nc };
      }
    }
    return cell;
  }

  private pickSpreadPatrolCell(agent: SantaAgent): GridCoord {
    const { size, grid } = this.mazeData;
    let fallback = this.pickRandomPatrolCell();
    let bestScore = -1;
    for (let tries = 0; tries < 10; tries++) {
      const r = 1 + Math.floor(Math.random() * (size - 2));
      const c = 1 + Math.floor(Math.random() * (size - 2));
      if (grid[r][c] !== 0) continue;
      if (this.santas.length <= 1) return { r, c };
      const cw = cellToWorld(r, c, size, CELL_SIZE);
      let minOtherDist = Infinity;
      for (const other of this.santas) {
        if (other.index === agent.index) continue;
        const d = Math.hypot(cw.x - other.pos.x, cw.z - other.pos.z);
        if (d < minOtherDist) minOtherDist = d;
      }
      if (minOtherDist > bestScore) {
        bestScore = minOtherDist;
        fallback = { r, c };
      }
    }
    return fallback;
  }

  private getPrimaryThreatSanta(): SantaAgent | null {
    if (this.santas.length === 0) return null;
    let bestActive: SantaAgent | null = null;
    let bestActiveDist = Infinity;
    let bestAny: SantaAgent | null = null;
    let bestAnyDist = Infinity;
    for (const s of this.santas) {
      const d = Math.hypot(this.playerPos.x - s.pos.x, this.playerPos.z - s.pos.z);
      if (d < bestAnyDist) {
        bestAnyDist = d;
        bestAny = s;
      }
      if (s.stunRemaining <= 0 && d < bestActiveDist) {
        bestActiveDist = d;
        bestActive = s;
      }
    }
    return bestActive || bestAny;
  }

  private getMinActiveSantaDistance(): { minActiveDist: number; closestActive: SantaAgent | null; anyAlerted: boolean } {
    let minActiveDist = 999;
    let closestActive: SantaAgent | null = null;
    let anyAlerted = false;
    for (const s of this.santas) {
      if (s.stunRemaining > 0) continue;
      if (s.alerted) anyAlerted = true;
      const d = Math.hypot(this.playerPos.x - s.pos.x, this.playerPos.z - s.pos.z);
      if (d < minActiveDist) {
        minActiveDist = d;
        closestActive = s;
      }
    }
    return { minActiveDist, closestActive, anyAlerted };
  }

  private updateSantaAI(dt: number, nowSec: number, localSprinting: boolean): number {
    if (this.santas.length === 0) return 999;

    // Non-host multiplayer clients follow Host Santas along maze corridors (never straight through walls)
    if (this.isMultiplayer && !this.isHost) {
      const staleMs = Date.now() - this.lastRemoteSantaAtMs;
      if (this.remoteSantaTarget && staleMs < 2400) {
        const ageSec = Math.min(0.28, Math.max(0, staleMs / 1000));
        for (let i = 0; i < this.santas.length; i++) {
          const s = this.santas[i];
          const src = i === 0 ? this.remoteSantaTarget : this.remoteSantaTarget.extras?.[i - 1];
          if (!src || !Number.isFinite(src.x) || !Number.isFinite(src.z)) {
            s.rig.root.position.copy(s.pos);
            s.rig.root.rotation.y = s.yaw;
            s.rig.updateAnimation(nowSec, 0, false, s.stunRemaining);
            continue;
          }

          let goalX = src.x;
          let goalZ = src.z;
          if (src.speed > 0.3 && src.stunRemaining <= 0) {
            const extX = src.x + Math.sin(src.yaw) * src.speed * ageSec;
            const extZ = src.z + Math.cos(src.yaw) * src.speed * ageSec;
            if (hasLineOfSight(this.mazeData.grid, src.x, src.z, extX, extZ, CELL_SIZE)) {
              goalX = extX;
              goalZ = extZ;
            }
          }

          const distToGoal = Math.hypot(goalX - s.pos.x, goalZ - s.pos.z);
          if (distToGoal > 8.5) {
            s.pos.set(goalX, 0, goalZ);
            this.resolveMazeCollisions(s.pos, 0.55);
          } else if (
            distToGoal > 0.65 &&
            !hasLineOfSight(this.mazeData.grid, s.pos.x, s.pos.z, goalX, goalZ, CELL_SIZE)
          ) {
            const santaCell = this.clampToWalkableCell(
              worldToCell(s.pos.x, s.pos.z, this.mazeData.size, CELL_SIZE)
            );
            const goalCell = this.clampToWalkableCell(
              worldToCell(goalX, goalZ, this.mazeData.size, CELL_SIZE)
            );
            const nextStep = findNextStepBFS(this.mazeData.grid, santaCell, goalCell);
            let steerX = goalX;
            let steerZ = goalZ;
            if (nextStep) {
              const curW = cellToWorld(santaCell.r, santaCell.c, this.mazeData.size, CELL_SIZE);
              const nextW = cellToWorld(nextStep.r, nextStep.c, this.mazeData.size, CELL_SIZE);
              const distToCurCenter = Math.hypot(curW.x - s.pos.x, curW.z - s.pos.z);
              if (
                distToCurCenter > 0.5 &&
                !this.hasClearCorridor(s.pos.x, s.pos.z, nextW.x, nextW.z, 0.58)
              ) {
                steerX = curW.x;
                steerZ = curW.z;
              } else {
                steerX = nextW.x;
                steerZ = nextW.z;
              }
            }
            const sdx = steerX - s.pos.x;
            const sdz = steerZ - s.pos.z;
            const sLen = Math.hypot(sdx, sdz);
            if (sLen > 0.02) {
              const catchupSpeed = Math.max(src.speed * 1.2, 5.8);
              const stepDist = Math.min(sLen, catchupSpeed * dt);
              s.pos.x += (sdx / sLen) * stepDist;
              s.pos.z += (sdz / sLen) * stepDist;
            }
            this.resolveMazeCollisions(s.pos, 0.55);
          } else {
            s.pos.x = THREE.MathUtils.damp(s.pos.x, goalX, 12, dt);
            s.pos.z = THREE.MathUtils.damp(s.pos.z, goalZ, 12, dt);
            this.resolveMazeCollisions(s.pos, 0.55);
          }

          let deltaAngle = src.yaw - s.yaw;
          while (deltaAngle > Math.PI) deltaAngle -= Math.PI * 2;
          while (deltaAngle < -Math.PI) deltaAngle += Math.PI * 2;
          s.yaw += deltaAngle * Math.min(1, dt * 11);

          s.currentSpeed = src.speed;
          if (src.alerted && !s.alerted) {
            this.audio.playEvilHoHo(0.7);
          }
          s.alerted = src.alerted;
          if (src.stunRemaining <= 0 && src.speed > 0.35) {
            s.stunRemaining = 0;
          } else if (src.stunRemaining > 0.2) {
            s.stunRemaining = src.stunRemaining;
          } else if (s.stunRemaining > 0) {
            s.stunRemaining = Math.max(0, s.stunRemaining - dt);
          }

          s.rig.root.position.copy(s.pos);
          s.rig.root.rotation.y = s.yaw;
          s.rig.updateAnimation(nowSec, s.currentSpeed, s.alerted, s.stunRemaining);
        }

        return this.getMinActiveSantaDistance().minActiveDist;
      }

      // Host disconnected or throttled (> 2.4s stale): attempt host claim and keep Santas moving locally
      if (staleMs >= 3200 && performance.now() - this.lastHostClaimAttemptMs > 3000) {
        this.lastHostClaimAttemptMs = performance.now();
        this.mpCallbacks.onClaimHost?.();
      }
    }

    const scaling = getLevelScaling(this.level, this.difficulty);

    const candidates: { x: number; z: number; flashlightOn: boolean; sprinting: boolean }[] = [];
    if (this.alive && !this.spectating && this.phase === 'playing') {
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
            flashlightOn: rig.flashlightOn,
            sprinting: false,
          });
        }
      }
    }

    for (const s of this.santas) {
      s.forceBfsTimer = Math.max(0, s.forceBfsTimer - dt);

      // Stunned state (30s knockout)
      if (s.stunRemaining > 0) {
        const prevStun = s.stunRemaining;
        s.stunRemaining = Math.max(0, s.stunRemaining - dt);
        s.currentSpeed = 0;
        s.velX = 0;
        s.velZ = 0;
        s.alerted = false;
        s.stuckTimer = 0;
        s.stuckCount = 0;
        s.forceBfsTimer = 0;

        if (prevStun > 3.5 && s.stunRemaining <= 3.5) {
          this.showBanner('Santa is stirring... run!', 2.6);
        } else if (s.stunRemaining <= 0) {
          this.audio.playEvilHoHo(0.65);
          this.showBanner('Evil Santa woke up!', 3.0);
        }

        s.rig.root.position.copy(s.pos);
        s.rig.root.rotation.y = s.yaw;
        s.rig.updateAnimation(nowSec, 0, false, s.stunRemaining);
        continue;
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
        const d = Math.hypot(c.x - s.pos.x, c.z - s.pos.z);
        const effSight = c.flashlightOn ? scaling.santaSightRange : scaling.santaSightRange * 0.58;
        const sees =
          d <= effSight &&
          hasLineOfSight(this.mazeData.grid, s.pos.x, s.pos.z, c.x, c.z, CELL_SIZE);
        const hears = d < (c.sprinting ? 10.5 : 3.4);

        if (sees) canSeeAny = true;
        if (hears) canHearAny = true;

        const score = sees ? d * 0.65 : d;
        if (score < bestDist) {
          bestDist = score;
          nearestTarget = c;
        }
      }

      const distToTarget = Math.hypot(nearestTarget.x - s.pos.x, nearestTarget.z - s.pos.z);
      const santaCell = this.clampToWalkableCell(
        worldToCell(s.pos.x, s.pos.z, this.mazeData.size, CELL_SIZE)
      );
      const targetCell = this.clampToWalkableCell(
        worldToCell(nearestTarget.x, nearestTarget.z, this.mazeData.size, CELL_SIZE)
      );

      if (canSeeAny || canHearAny) {
        if (!s.alerted && canSeeAny) {
          this.audio.playEvilHoHo(0.8);
        }
        s.alerted = true;
        s.alertTimer = 3.2;
        s.lastKnownCell = { ...targetCell };
      } else if (s.alerted) {
        s.alertTimer -= dt;
        const reachedLastKnown =
          s.lastKnownCell &&
          santaCell.r === s.lastKnownCell.r &&
          santaCell.c === s.lastKnownCell.c;

        if (s.alertTimer <= 0 || reachedLastKnown) {
          s.alerted = false;
          s.lastKnownCell = null;
          s.patrolTarget = this.pickSpreadPatrolCell(s);
          if (!this.statusBanner && Math.hypot(this.playerPos.x - s.pos.x, this.playerPos.z - s.pos.z) < 22) {
            this.showBanner('You juked Santa and broke line of sight!', 2.5);
          }
        }
      }

      const rageBoost = 1 + Math.min(4, this.ornamentsCollected) * 0.025;
      const targetSpeed = (s.alerted ? scaling.santaChaseSpeed : scaling.santaBaseSpeed) * rageBoost;
      s.currentSpeed = THREE.MathUtils.damp(s.currentSpeed, targetSpeed, 6, dt);

      let moveTargetX = nearestTarget.x;
      let moveTargetZ = nearestTarget.z;

      const directCorridorClear =
        s.forceBfsTimer <= 0 &&
        canSeeAny &&
        distToTarget < 10.5 &&
        this.hasClearCorridor(s.pos.x, s.pos.z, nearestTarget.x, nearestTarget.z, 0.64);

      if (directCorridorClear) {
        moveTargetX = nearestTarget.x;
        moveTargetZ = nearestTarget.z;
      } else {
        let goalCell: GridCoord;
        if (s.alerted && s.lastKnownCell) {
          goalCell = this.clampToWalkableCell(s.lastKnownCell);
        } else {
          if (
            !s.patrolTarget ||
            (santaCell.r === s.patrolTarget.r && santaCell.c === s.patrolTarget.c)
          ) {
            s.patrolTarget = this.pickSpreadPatrolCell(s);
          }
          goalCell = this.clampToWalkableCell(s.patrolTarget);
        }

        // Guard against stalled goalCell === santaCell
        if (goalCell.r === santaCell.r && goalCell.c === santaCell.c) {
          if (s.alerted && canSeeAny) {
            moveTargetX = nearestTarget.x;
            moveTargetZ = nearestTarget.z;
          } else {
            if (s.alerted) {
              s.alerted = false;
              s.lastKnownCell = null;
            }
            s.patrolTarget = this.pickSpreadPatrolCell(s);
            goalCell = this.clampToWalkableCell(s.patrolTarget);
          }
        }

        if (!(goalCell.r === santaCell.r && goalCell.c === santaCell.c)) {
          const path = findPathBFS(this.mazeData.grid, santaCell, goalCell, 6);
          if (path && path.length > 0) {
            const p0 = path[0];
            const p0W = cellToWorld(p0.r, p0.c, this.mazeData.size, CELL_SIZE);
            const curW = cellToWorld(santaCell.r, santaCell.c, this.mazeData.size, CELL_SIZE);
            const distToCurCenter = Math.hypot(curW.x - s.pos.x, curW.z - s.pos.z);

            let chosenW = p0W;
            if (path.length >= 2) {
              const p1W = cellToWorld(path[1].r, path[1].c, this.mazeData.size, CELL_SIZE);
              if (this.hasClearCorridor(s.pos.x, s.pos.z, p1W.x, p1W.z, 0.64)) {
                chosenW = p1W;
              }
            }

            // Center toward current cell before turning a sharp corner so Santa never snags on wall edges
            if (
              chosenW === p0W &&
              distToCurCenter > 0.52 &&
              !this.hasClearCorridor(s.pos.x, s.pos.z, p0W.x, p0W.z, 0.6)
            ) {
              moveTargetX = curW.x;
              moveTargetZ = curW.z;
            } else {
              moveTargetX = chosenW.x;
              moveTargetZ = chosenW.z;
            }
          } else {
            const neighbor = this.pickOpenNeighborCell(santaCell);
            const nw = cellToWorld(neighbor.r, neighbor.c, this.mazeData.size, CELL_SIZE);
            moveTargetX = nw.x;
            moveTargetZ = nw.z;
            s.patrolTarget = this.pickSpreadPatrolCell(s);
          }
        }
      }

      const dx = moveTargetX - s.pos.x;
      const dz = moveTargetZ - s.pos.z;
      const len = Math.hypot(dx, dz);

      if (len > 0.05) {
        const desiredVx = (dx / len) * s.currentSpeed;
        const desiredVz = (dz / len) * s.currentSpeed;
        s.velX = THREE.MathUtils.damp(s.velX, desiredVx, 11.5, dt);
        s.velZ = THREE.MathUtils.damp(s.velZ, desiredVz, 11.5, dt);

        s.pos.x += s.velX * dt;
        s.pos.z += s.velZ * dt;
        const santaVel = { vx: s.velX, vz: s.velZ };
        this.resolveMazeCollisions(s.pos, 0.55, santaVel);
        s.velX = santaVel.vx;
        s.velZ = santaVel.vz;

        const speedMag = Math.hypot(s.velX, s.velZ);
        const desiredYaw = speedMag > 0.25 ? Math.atan2(s.velX, s.velZ) : Math.atan2(dx, dz);
        let deltaAngle = desiredYaw - s.yaw;
        while (deltaAngle > Math.PI) deltaAngle -= Math.PI * 2;
        while (deltaAngle < -Math.PI) deltaAngle += Math.PI * 2;
        s.yaw += deltaAngle * Math.min(1, dt * 8.0);
      }

      // Stuck watchdog: if Santa stalls against a corner for > 0.55s, force BFS and cleanly re-center
      s.stuckTimer += dt;
      if (s.stuckTimer >= 0.55) {
        const progressed = Math.hypot(
          s.pos.x - s.lastProgressPos.x,
          s.pos.z - s.lastProgressPos.z
        );
        if (progressed < 0.22 && s.currentSpeed > 0.35) {
          s.stuckCount += 1;
          s.forceBfsTimer = 1.4;
          const safeW = cellToWorld(santaCell.r, santaCell.c, this.mazeData.size, CELL_SIZE);
          if (s.stuckCount >= 2) {
            s.pos.set(safeW.x, 0, safeW.z);
            s.stuckCount = 0;
          } else {
            s.pos.x = THREE.MathUtils.lerp(s.pos.x, safeW.x, 0.65);
            s.pos.z = THREE.MathUtils.lerp(s.pos.z, safeW.z, 0.65);
          }
          s.velX = 0;
          s.velZ = 0;
          s.patrolTarget = this.pickSpreadPatrolCell(s);
          if (s.alerted && !canSeeAny) {
            s.alerted = false;
            s.lastKnownCell = null;
          }
        } else {
          s.stuckCount = 0;
        }
        s.lastProgressPos.copy(s.pos);
        s.stuckTimer = 0;
      }

      s.rig.root.position.copy(s.pos);
      s.rig.root.rotation.y = s.yaw;
      s.rig.updateAnimation(nowSec, s.currentSpeed, s.alerted, 0);
    }

    // Separate multiple Santas (Lv 50+ / Lv 99) so they don't stack into one mesh
    if (this.santas.length > 1) {
      for (let i = 0; i < this.santas.length; i++) {
        for (let j = i + 1; j < this.santas.length; j++) {
          const a = this.santas[i];
          const b = this.santas[j];
          if (a.stunRemaining > 0 || b.stunRemaining > 0) continue;
          const sdx = b.pos.x - a.pos.x;
          const sdz = b.pos.z - a.pos.z;
          const dist = Math.hypot(sdx, sdz);
          if (dist < 1.6) {
            const nx = dist > 0.01 ? sdx / dist : 1;
            const nz = dist > 0.01 ? sdz / dist : 0;
            const push = (1.6 - dist) * 0.5;
            a.pos.x -= nx * push;
            a.pos.z -= nz * push;
            b.pos.x += nx * push;
            b.pos.z += nz * push;
            this.resolveMazeCollisions(a.pos, 0.55);
            this.resolveMazeCollisions(b.pos, 0.55);
            a.rig.root.position.copy(a.pos);
            b.rig.root.position.copy(b.pos);
          }
        }
      }
    }

    if (this.isMultiplayer && this.isHost && performance.now() - this.lastSantaSyncMs > 260) {
      this.lastSantaSyncMs = performance.now();
      this.mpCallbacks.onHostSantaSync?.(this.buildSantaSyncPayload());
    }

    return this.getMinActiveSantaDistance().minActiveDist;
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
      o.glowMat.emissiveIntensity = 1.35 + Math.sin(nowSec * 3.5 + o.id) * 0.4;
    }

    for (const wp of this.weapons) {
      if (wp.collected) continue;
      wp.weaponMeshGroup.rotation.y = nowSec * 1.6 + wp.id;
      wp.weaponMeshGroup.position.y = 1.05 + Math.sin(nowSec * 2.8 + wp.id) * 0.08;
      wp.glowMat.emissiveIntensity = 1.4 + Math.sin(nowSec * 4.0 + wp.id) * 0.45;
    }

    for (const bat of this.batteries) {
      if (bat.collected) continue;
      bat.cellGroup.rotation.y = nowSec * 1.9 + bat.id;
      bat.cellGroup.position.y = 0.78 + Math.sin(nowSec * 3.0 + bat.id) * 0.08;
      bat.glowMat.emissiveIntensity = 1.95 + Math.sin(nowSec * 4.2 + bat.id) * 0.5;
    }

    const elfTargets: { x: number; z: number }[] = [];
    if (this.phase === 'playing' && this.alive && !this.spectating) {
      elfTargets.push({ x: this.playerPos.x, z: this.playerPos.z });
    }
    if (this.isMultiplayer) {
      for (const rig of this.remotePlayers.values()) {
        if (rig.alive && !rig.escaped) {
          elfTargets.push({ x: rig.targetX, z: rig.targetZ });
        }
      }
    }

    for (const elf of this.tinyElves) {
      elf.update(dt, nowSec, elfTargets, null, this.mazeData.grid, CELL_SIZE, this.mazeData.size);
    }
    if (this.elfHelper && this.santas.length > 0) {
      let nearestToElf = this.santas[0];
      let bestElfDist = Infinity;
      for (const s of this.santas) {
        const d = Math.hypot(s.pos.x - this.elfHelper.root.position.x, s.pos.z - this.elfHelper.root.position.z);
        if (d < bestElfDist) {
          bestElfDist = d;
          nearestToElf = s;
        }
      }
      const spotted = this.elfHelper.update(
        dt,
        nowSec,
        elfTargets,
        { x: nearestToElf.pos.x, z: nearestToElf.pos.z },
        this.mazeData.grid,
        CELL_SIZE,
        this.mazeData.size
      );
      if (spotted && nearestToElf.stunRemaining <= 0 && (!this.isMultiplayer || this.isHost)) {
        nearestToElf.alerted = true;
        nearestToElf.alertTimer = Math.max(nearestToElf.alertTimer, 3.0);
        nearestToElf.lastKnownCell = this.clampToWalkableCell(
          worldToCell(spotted.x, spotted.z, this.mazeData.size, CELL_SIZE)
        );
      }
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
      if (this.isMultiplayer && this.isHost) {
        const hasActiveTeammates = Array.from(this.remotePlayers.values()).some((r) => r.alive && !r.escaped);
        if (hasActiveTeammates) {
          this.elapsedSeconds += dt;
          if (this.elapsedSeconds >= this.nextWeaponSpawnAt) {
            this.spawnWeaponWave(this.nextWeaponWaveIndex, false);
            this.mpCallbacks.onAdvanceWeaponWave?.(this.nextWeaponWaveIndex);
            this.nextWeaponWaveIndex += 1;
            this.nextWeaponSpawnAt += WEAPON_SPAWN_INTERVAL;
          }
          this.updateSantaAI(dt, nowSec, false);
        }
      }
      return;
    }
    if (this.phase === 'paused' && !this.isMultiplayer) {
      return;
    }

    if (this.jumpscareActive) {
      this.jumpscareTimer -= dt;
      const lookY = 2.15;
      const jsSanta = this.santas[this.jumpscareSantaIndex] || this.santas[0];
      const lookX = jsSanta ? jsSanta.pos.x : this.playerPos.x;
      const lookZ = jsSanta ? jsSanta.pos.z : this.playerPos.z;
      this.camera.position.set(
        this.playerPos.x + (Math.random() - 0.5) * 0.14,
        EYE_HEIGHT + (Math.random() - 0.5) * 0.14,
        this.playerPos.z + (Math.random() - 0.5) * 0.14
      );
      this.camera.lookAt(lookX, lookY, lookZ);
      this.flashlight.position.copy(this.camera.position);
      this.flashlightTarget.position.set(lookX, lookY, lookZ);
      this.flashlight.intensity = 10;

      if (this.jumpscareTimer <= 0) {
        this.jumpscareActive = false;
        this.fallenPos.copy(this.playerPos);
        this.alive = false;
        this.flashlightOn = false;
        this.setEquippedWeapon(null);

        if (this.isMultiplayer) {
          this.pushLocalPlayerSync(true);
          this.mpCallbacks.onLocalEliminated?.();

          const anyTeammateAlive = Array.from(this.remotePlayers.values()).some((r) => r.alive && !r.escaped);
          if (anyTeammateAlive) {
            this.spectating = true;
            this.phase = 'playing';
            this.showBanner('Santa downed you! Teammates can revive you — spectating...', 5.0);
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
      if (!this.isMultiplayer || this.isHost) {
        this.spawnWeaponWave(this.nextWeaponWaveIndex, true);
        if (this.isMultiplayer && this.isHost) {
          this.mpCallbacks.onAdvanceWeaponWave?.(this.nextWeaponWaveIndex);
        }
        this.nextWeaponWaveIndex += 1;
        this.nextWeaponSpawnAt += WEAPON_SPAWN_INTERVAL;
      }
    }

    if (this.chimeCooldown > 0) this.chimeCooldown = Math.max(0, this.chimeCooldown - dt);
    if (this.dodgeCooldown > 0) this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    if (this.weaponRecoilTimer > 0) this.weaponRecoilTimer = Math.max(0, this.weaponRecoilTimer - dt);
    if (this.reviveGraceTimer > 0) this.reviveGraceTimer = Math.max(0, this.reviveGraceTimer - dt);

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
    const activeThreat = this.getMinActiveSantaDistance();

    let tremorX = 0;
    let tremorY = 0;
    if (!this.spectating && activeThreat.minActiveDist < 12) {
      const strength = Math.pow(1 - activeThreat.minActiveDist / 12, 2) * 0.028;
      const stompPulse = Math.max(0, Math.sin(nowSec * (activeThreat.anyAlerted ? 9.5 : 5.4)));
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

    this.updateFlashlightTransform(nowSec, this.spectating ? 999 : santaDist);

    this.audio.updateAmbience(
      nowSec,
      this.spectating ? 30 : santaDist,
      activeThreat.anyAlerted,
      !this.spectating && wantsMove,
      sprinting,
      activeThreat.closestActive === null
    );

    if (this.alive && !this.spectating) {
      // Elf Trap collision check (5s stun, synced across all players)
      if (this.playerTrapStunRemaining <= 0) {
        for (const trap of this.elfTraps) {
          if (trap.triggered) continue;
          const d = Math.hypot(trap.group.position.x - this.playerPos.x, trap.group.position.z - this.playerPos.z);
          if (d < 1.15) {
            trap.triggered = true;
            trap.teethGroup.rotation.x = 0.85;
            this.syncedTriggeredTraps.add(trap.id);
            this.playerTrapStunRemaining = 5.0;
            this.audio.playJumpscare();
            this.showBanner('Mischievous elf trap triggered! Stunned for 5 seconds!', 4.5);
            if (this.isMultiplayer) {
              this.mpCallbacks.onTriggerTrap?.(trap.id);
              this.pushLocalPlayerSync(true);
            }
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
            this.pushLocalPlayerSync(true);
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
            this.pushLocalPlayerSync(true);
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
            this.pushLocalPlayerSync(true);
            this.mpCallbacks.onLocalEscaped?.();
          }
          this.pushHud(santaDist);
          return;
        }
      }

      // Check Santa Catch -> Jumpscare (only if that Santa is NOT stunned & no revive grace!)
      if (this.reviveGraceTimer <= 0) {
        const catcher = this.santas.find(
          (s) => s.stunRemaining <= 0 && Math.hypot(this.playerPos.x - s.pos.x, this.playerPos.z - s.pos.z) < 1.24
        );
        if (catcher) {
          this.jumpscareSantaIndex = catcher.index;
          this.jumpscareActive = true;
          this.jumpscareTimer = 0.68;
          this.audio.playJumpscare();
          return;
        }
      }
    }

    if (this.isMultiplayer) {
      this.pushLocalPlayerSync(false);
    }

    const hudIntervalMs = 100;
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
    const threatSanta = this.getPrimaryThreatSanta();
    const santaDist =
      santaDistOverride ??
      (threatSanta
        ? Math.hypot(this.playerPos.x - threatSanta.pos.x, this.playerPos.z - threatSanta.pos.z)
        : 99);

    const santaAngleDeg = threatSanta
      ? this.getRelativeAngleDeg(threatSanta.pos.x, threatSanta.pos.z)
      : 0;
    const santaAlerted = threatSanta ? threatSanta.alerted : false;
    const santaStunRemaining = threatSanta ? threatSanta.stunRemaining : 0;

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
      const sNorm = threatSanta ? toNorm(threatSanta.pos.x, threatSanta.pos.z) : { normX: 0.5, normZ: 0.5 };
      const santas = this.santas.map((s) => {
        const sn = toNorm(s.pos.x, s.pos.z);
        return {
          normX: sn.normX,
          normZ: sn.normZ,
          alerted: s.alerted,
          stunRemaining: s.stunRemaining,
        };
      });
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
          stunned: rig.stunned,
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
        santaAlerted,
        santaStunRemaining,
        santas,
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

    const nearbyReviveTarget = this.getNearbyFallenTeammate();
    let fallenTeammatesCount = 0;
    if (this.isMultiplayer) {
      for (const rig of this.remotePlayers.values()) {
        if (!rig.alive && !rig.escaped) {
          fallenTeammatesCount += 1;
        }
      }
    }

    this.onHudUpdate({
      phase: this.phase,
      difficulty: this.difficulty,
      level: this.level,
      santaCount: this.santas.length || getLevelScaling(this.level, this.difficulty).santaCount,
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
      santaAlerted,
      santaStunRemaining,
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
      nearbyReviveTarget,
      fallenTeammatesCount,
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
