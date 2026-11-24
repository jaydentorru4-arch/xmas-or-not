import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HorrorAudio } from './audio';
import {
  CELL_SIZE,
  cellToWorld,
  findNextStepBFS,
  generateMaze,
  hasLineOfSight,
  worldToCell,
} from './maze';
import { RemoteSurvivorRig, createRemoteSurvivor } from './playerAvatar';
import { ExitGateProp, OrnamentProp, createExitGate, createOrnamentProp } from './props';
import { EvilSantaRig, createEvilSanta } from './santaModel';
import { ProceduralTextures, createProceduralTextures } from './textures';
import {
  DIFFICULTIES,
  DifficultyId,
  GamePhase,
  GridCoord,
  HudSnapshot,
  MazeData,
  RoomPlayerData,
  SantaLiveData,
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
  private remoteSantaTarget: SantaLiveData | null = null;
  private lastPlayerSyncMs = 0;
  private lastSantaSyncMs = 0;

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

    // Studio environment map for metallic ornaments, brass buckle, and gate iron
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    const envTex = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = envTex;
    this.scene.environmentIntensity = 0.35;
    this.disposables.push(envTex);
    pmremGenerator.dispose();

    this.camera = new THREE.PerspectiveCamera(74, width / height, 0.1, 145);
    this.camera.rotation.order = 'YXZ';

    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.textures = createProceduralTextures(maxAniso);

    // Moonlight rig
    const hemi = new THREE.HemisphereLight(0x466396, 0x090c14, 0.58);
    this.scene.add(hemi);

    const moonLight = new THREE.DirectionalLight(0x7898d8, 0.42);
    moonLight.position.set(18, 32, -14);
    this.scene.add(moonLight);

    // Subtle personal night-vision aura
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
    for (const rig of this.remotePlayers.values()) {
      rig.dispose();
    }
    this.remotePlayers.clear();
    this.ornaments = [];
    this.bulbInstanced = null;
    this.bulbBaseColors = [];
  }

  private buildNewLevel(seed?: number): void {
    this.clearMazeGroup();

    const diff = DIFFICULTIES[this.difficulty];
    this.fog.density = diff.fogDensity;
    this.mazeData = generateMaze(diff.ornamentCount, seed);

    const { size, cellSize, wallHeight, grid } = this.mazeData;
    const totalSpan = size * cellSize;

    // Extended snow ground plane (far beyond 27x27 maze perimeter)
    const groundGeo = new THREE.PlaneGeometry(totalSpan + 110, totalSpan + 110);
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

    // Walls (InstancedMesh)
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

    // String light bulbs along wall edges facing open corridors
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

    // Spawn Golden Star Ornaments
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

    // Spawn Exit Sleigh Gate at outer perimeter breach
    const exitW = cellToWorld(this.mazeData.exitCell.r, this.mazeData.exitCell.c, size, cellSize);
    this.exitGate = createExitGate(exitW.x, exitW.z, this.textures.candyCaneColor, this.disposables);
    this.exitGate.group.rotation.y = Math.PI / 2;
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

  public startNewGame(difficulty: DifficultyId): void {
    this.difficulty = difficulty;
    this.isMultiplayer = false;
    this.roomId = null;
    this.isHost = false;
    this.localUid = null;
    this.alive = true;
    this.spectating = false;
    this.chatOpen = false;
    this.mpCallbacks = {};
    this.remoteSantaTarget = null;

    this.audio.init();
    this.buildNewLevel();
    this.phase = 'playing';
    this.showBanner(`Collect ${this.mazeData.ornaments.length} cursed ornaments to unlock the Exit Gate.`);
    this.requestPointerLockSafe();
    this.pushHud();
  }

  public enterWaitingRoom(
    difficulty: DifficultyId,
    mazeSeed: number,
    roomId: string,
    isHost: boolean,
    localUid: string
  ): void {
    this.difficulty = difficulty;
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
    this.buildNewLevel(mazeSeed);
    this.pushHud();
  }

  public startMultiplayerSession(cfg: {
    difficulty: DifficultyId;
    mazeSeed: number;
    roomId: string;
    isHost: boolean;
    localUid: string;
    callbacks: MultiplayerEngineCallbacks;
  }): void {
    this.difficulty = cfg.difficulty;
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
    this.buildNewLevel(cfg.mazeSeed);
    this.phase = 'playing';
    this.showBanner(
      `Team up to collect ${this.mazeData.ornaments.length} ornaments and escape! Press T to chat.`
    );
    this.requestPointerLockSafe();

    // Immediately broadcast initial spawn position
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
      });
    }
    this.pushHud();
  }

  public applyRemotePlayers(players: RoomPlayerData[]): void {
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

    // If spectating and everyone has fallen or escaped, transition cleanly to caught
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

  public applyRoomOrnaments(collectedIds: number[], exitUnlocked: boolean): void {
    if (!this.isMultiplayer) return;
    const idSet = new Set(collectedIds);
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
      this.showBanner('All ornaments recovered! Follow the EXIT compass to escape!', 6.0);
    }
    this.pushHud();
  }

  public setChatOpen(open: boolean): void {
    this.chatOpen = open;
    if (open) {
      this.keys = {};
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
    this.alive = true;
    this.spectating = false;
    this.chatOpen = false;
    this.mpCallbacks = {};
    this.remoteSantaTarget = null;
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
    if (this.phase !== 'playing' || !this.alive) return;
    if (!this.flashlightOn && this.battery <= 4) {
      this.showBanner('Flashlight battery depleted. Wait for recharge.');
      return;
    }
    this.flashlightOn = !this.flashlightOn;
    this.audio.playFlashlightClick();
    this.pushHud();
  }

  public triggerChimeSense(): void {
    if (this.phase !== 'playing' || !this.alive || this.chimeCooldown > 0) return;
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
    if (this.chatOpen) return;
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
    this.draggingLook = true;
    this.lastPointerX = e.clientX;
    this.lastPointerY = e.clientY;
    if (!this.pointerLocked) {
      this.requestPointerLockSafe();
    }
  };

  private handlePointerMove = (e: PointerEvent) => {
    if (this.phase !== 'playing' || this.chatOpen) return;
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
      }
      this.santa.root.position.copy(this.santaPos);
      this.santa.root.rotation.y = this.santaYaw;
      this.santa.updateAnimation(nowSec, this.santaCurrentSpeed, this.santaAlerted);
      return Math.hypot(this.playerPos.x - this.santaPos.x, this.playerPos.z - this.santaPos.z);
    }

    const diff = DIFFICULTIES[this.difficulty];

    // Gather all alive survivor targets (local + remote)
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
      const effSight = c.flashlightOn ? diff.santaSightRange : diff.santaSightRange * 0.64;
      const sees =
        d <= effSight &&
        hasLineOfSight(this.mazeData.grid, this.santaPos.x, this.santaPos.z, c.x, c.z, CELL_SIZE);
      const hears = d < (c.sprinting ? 12.5 : 4.5);

      if (sees) canSeeAny = true;
      if (hears) canHearAny = true;

      // Prioritize visible targets, then closest distance
      const score = sees ? d * 0.65 : d;
      if (score < bestDist) {
        bestDist = score;
        nearestTarget = c;
      }
    }

    const distToTarget = Math.hypot(nearestTarget.x - this.santaPos.x, nearestTarget.z - this.santaPos.z);

    if (canSeeAny || canHearAny) {
      if (!this.santaAlerted && canSeeAny) {
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

    const rageBoost = 1 + this.ornamentsCollected * 0.055;
    const targetSpeed = (this.santaAlerted ? diff.santaChaseSpeed : diff.santaBaseSpeed) * rageBoost;
    this.santaCurrentSpeed = THREE.MathUtils.damp(this.santaCurrentSpeed, targetSpeed, 6, dt);

    const santaCell = worldToCell(this.santaPos.x, this.santaPos.z, this.mazeData.size, CELL_SIZE);
    const targetCell = worldToCell(nearestTarget.x, nearestTarget.z, this.mazeData.size, CELL_SIZE);

    let moveTargetX = nearestTarget.x;
    let moveTargetZ = nearestTarget.z;

    if (canSeeAny && distToTarget < 12) {
      moveTargetX = nearestTarget.x;
      moveTargetZ = nearestTarget.z;
    } else {
      let goalCell: GridCoord;
      if (this.santaAlerted || this.ornamentsCollected >= this.mazeData.ornaments.length - 1) {
        goalCell = targetCell;
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

    if (this.isMultiplayer && this.isHost && performance.now() - this.lastSantaSyncMs > 130) {
      this.lastSantaSyncMs = performance.now();
      this.mpCallbacks.onHostSantaSync?.({
        x: this.santaPos.x,
        z: this.santaPos.z,
        yaw: this.santaYaw,
        speed: this.santaCurrentSpeed,
        alerted: this.santaAlerted,
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
      this.chimeTargetLabel = 'Exit Gate Path';
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
          this.chimeTargetLabel = 'Ornament Path';
        }
      }
    }

    if (!goalCell) {
      this.chimeAngleDeg = null;
      return;
    }

    const nextStep = findNextStepBFS(this.mazeData.grid, playerCell, goalCell);
    if (nextStep && (nextStep.r !== playerCell.r || nextStep.c !== playerCell.c)) {
      const nw = cellToWorld(nextStep.r, nextStep.c, this.mazeData.size, CELL_SIZE);
      this.chimeAngleDeg = this.getRelativeAngleDeg(nw.x, nw.z);
    } else {
      this.chimeAngleDeg = this.getRelativeAngleDeg(fallbackX, fallbackZ);
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

  private updateBulbsAndProps(nowSec: number): void {
    for (const o of this.ornaments) {
      if (o.collected) continue;
      o.starGroup.rotation.y = nowSec * 1.4 + o.id;
      o.starGroup.position.y = 1.18 + Math.sin(nowSec * 2.4 + o.id) * 0.09;
      o.light.intensity = 2.2 + Math.sin(nowSec * 3.5 + o.id) * 0.45;
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
    this.updateBulbsAndProps(nowSec);

    if (this.statusBannerTimer > 0) {
      this.statusBannerTimer -= dt;
      if (this.statusBannerTimer <= 0) {
        this.statusBanner = null;
      }
    }

    // Update remote survivor animations whenever in maze
    if (this.isMultiplayer) {
      for (const rig of this.remotePlayers.values()) {
        rig.update(dt, nowSec);
      }
    }

    // Live Menu / Waiting Room Corridor Camera Orbit
    if (this.phase === 'menu' || this.phase === 'waiting') {
      const sway = Math.sin(nowSec * 0.28) * 0.35;
      this.camera.position.set(this.playerPos.x, EYE_HEIGHT + Math.sin(nowSec * 0.8) * 0.04, this.playerPos.z);
      this.camera.rotation.set(0.02, this.yaw + sway, 0, 'YXZ');
      this.updateFlashlightTransform(nowSec, 999);
      return;
    }

    // In solo mode, pausing freezes simulation; in multiplayer, world continues while menu is open
    if (this.phase === 'caught' || this.phase === 'escaped') {
      return;
    }
    if (this.phase === 'paused' && !this.isMultiplayer) {
      return;
    }

    // Jumpscare sequence before elimination or spectating
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
    if (this.chimeCooldown > 0) this.chimeCooldown = Math.max(0, this.chimeCooldown - dt);
    if (this.chimeDisplayTimer > 0) {
      this.chimeDisplayTimer = Math.max(0, this.chimeDisplayTimer - dt);
      if (this.chimeDisplayTimer > 0) this.updateChimeBearing();
      else this.chimeAngleDeg = null;
    }

    const controlsActive = this.phase === 'playing' && !this.chatOpen;

    // Keyboard turn fallback (Q/E or Left/Right Arrows)
    if (controlsActive) {
      const turnSpeed = 2.15;
      if (this.keys['KeyQ'] || this.keys['ArrowLeft']) this.yaw += turnSpeed * dt;
      if (this.keys['KeyE'] || this.keys['ArrowRight']) this.yaw -= turnSpeed * dt;
    }

    // Movement vector
    let forwardInput = 0;
    let strafeInput = 0;
    if (controlsActive) {
      if (this.keys['KeyW'] || this.keys['ArrowUp']) forwardInput += 1;
      if (this.keys['KeyS'] || this.keys['ArrowDown']) forwardInput -= 1;
      if (this.keys['KeyD']) strafeInput += 1;
      if (this.keys['KeyA']) strafeInput -= 1;
    }

    const wantsMove = forwardInput !== 0 || strafeInput !== 0;
    const wantsSprint =
      controlsActive && (this.keys['ShiftLeft'] || this.keys['ShiftRight']) && wantsMove && this.stamina > 2;
    const sprinting = wantsSprint && !this.spectating;

    // Tuned stamina: ~10.5s continuous sprint, rapid recharge
    if (sprinting) {
      this.stamina = Math.max(0, this.stamina - 9.5 * dt);
    } else {
      this.stamina = Math.min(100, this.stamina + (wantsMove ? 16 : 26) * dt);
    }

    if (this.spectating) {
      // Spectator free-roam glide above maze or follow alive teammate
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
    } else if (wantsMove) {
      const moveSpeed = sprinting ? 6.55 : 4.05;
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

    // Prevent walking through locked Exit Gate barrier at east perimeter
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

    // Update Evil Santa AI
    const santaDist = this.updateSantaAI(dt, nowSec, sprinting);

    // Subtle camera micro-tremor when Evil Santa stomps close
    let tremorX = 0;
    let tremorY = 0;
    if (!this.spectating && santaDist < 12) {
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

    // Smooth FOV widening when sprinting
    const targetFov = sprinting ? 81 : 74;
    if (Math.abs(this.currentFov - targetFov) > 0.05) {
      this.currentFov = THREE.MathUtils.damp(this.currentFov, targetFov, 8, dt);
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }

    // Flashlight battery & horror flicker
    if (this.flashlightOn && this.alive) {
      this.battery = Math.max(0, this.battery - 1.35 * dt);
      if (this.battery <= 0) {
        this.flashlightOn = false;
        this.audio.playFlashlightClick();
        this.showBanner('Flashlight battery drained!');
      }
    } else {
      this.battery = Math.min(100, this.battery + 4.4 * dt);
    }

    this.updateFlashlightTransform(nowSec, this.spectating ? 999 : santaDist);

    // Spatial Horror Audio
    this.audio.updateAmbience(
      nowSec,
      this.spectating ? 30 : santaDist,
      this.santaAlerted,
      !this.spectating && wantsMove,
      sprinting
    );

    if (this.alive && !this.spectating) {
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

      // Check Santa Catch -> Jumpscare!
      if (santaDist < 1.28) {
        this.jumpscareActive = true;
        this.jumpscareTimer = 0.68;
        this.audio.playJumpscare();
        return;
      }
    }

    // Periodic multiplayer player state broadcast
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

    // Throttled HUD update
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

    this.onHudUpdate({
      phase: this.phase,
      difficulty: this.difficulty,
      ornamentsCollected: this.ornamentsCollected,
      ornamentsTotal: this.mazeData ? this.mazeData.ornaments.length : DIFFICULTIES[this.difficulty].ornamentCount,
      exitUnlocked: this.exitUnlocked,
      stamina: this.stamina,
      battery: this.battery,
      flashlightOn: this.flashlightOn,
      elapsedSeconds: this.elapsedSeconds,
      santaDistance: santaDist,
      santaAngleDeg,
      santaAlerted: this.santaAlerted,
      playerHeadingDeg,
      exitAngleDeg,
      exitDistance,
      nearestOrnamentAngleDeg,
      nearestOrnamentDistance,
      pointerLocked: this.pointerLocked,
      chimeCooldown: this.chimeCooldown,
      chimeAngleDeg: this.chimeAngleDeg,
      chimeTargetLabel: this.chimeTargetLabel,
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
