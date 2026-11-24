export type GamePhase = 'menu' | 'waiting' | 'playing' | 'paused' | 'caught' | 'escaped';

export type DifficultyId = 'normal' | 'nightmare';

export interface DifficultyConfig {
  id: DifficultyId;
  label: string;
  description: string;
  santaBaseSpeed: number;
  santaChaseSpeed: number;
  santaSightRange: number;
  fogDensity: number;
  ornamentCount: number;
}

export const DIFFICULTIES: Record<DifficultyId, DifficultyConfig> = {
  normal: {
    id: 'normal',
    label: 'Normal',
    description: '27×27 labyrinth, balanced mist, 6 cursed ornaments, 60s weapon drops.',
    santaBaseSpeed: 2.35,
    santaChaseSpeed: 3.85,
    santaSightRange: 16,
    fogDensity: 0.068,
    ornamentCount: 6,
  },
  nightmare: {
    id: 'nightmare',
    label: 'Nightmare',
    description: '27×27 labyrinth, thicker freezing fog, faster hunt, 7 ornaments.',
    santaBaseSpeed: 2.85,
    santaChaseSpeed: 4.35,
    santaSightRange: 20,
    fogDensity: 0.092,
    ornamentCount: 7,
  },
};

export type WeaponType = 'tranq_dart' | 'cryo_blaster' | 'candy_bat';

export interface WeaponSpec {
  id: WeaponType;
  label: string;
  shortHint: string;
  range: number;
  hitRadius: number;
  stunSeconds: number;
  kind: 'ranged' | 'melee';
}

export const WEAPON_SPECS: Record<WeaponType, WeaponSpec> = {
  tranq_dart: {
    id: 'tranq_dart',
    label: 'Tranquilizer Gun',
    shortHint: 'Long-range dart · Stuns Santa 30s',
    range: 22,
    hitRadius: 1.1,
    stunSeconds: 30,
    kind: 'ranged',
  },
  cryo_blaster: {
    id: 'cryo_blaster',
    label: 'Cryo Blunderbuss',
    shortHint: 'Wide frost blast · Stuns Santa 30s',
    range: 14,
    hitRadius: 1.7,
    stunSeconds: 30,
    kind: 'ranged',
  },
  candy_bat: {
    id: 'candy_bat',
    label: 'Heavy Candy Bat',
    shortHint: 'Close-range knockout · Stuns Santa 30s',
    range: 4.5,
    hitRadius: 1.9,
    stunSeconds: 30,
    kind: 'melee',
  },
};

export interface GridCoord {
  r: number;
  c: number;
}

export interface MazeData {
  size: number;
  cellSize: number;
  wallHeight: number;
  grid: number[][]; // 1 = wall, 0 = floor
  playerSpawn: GridCoord;
  santaSpawn: GridCoord;
  exitCell: GridCoord;
  ornaments: GridCoord[];
}

export interface SurvivorProfile {
  uid: string;
  displayName: string;
  coatColor: string;
  escapes: number;
  gamesPlayed: number;
}

export const COAT_COLORS = [
  { name: 'Crimson', hex: '#c82333' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Cobalt', hex: '#3b82f6' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Frost', hex: '#38bdf8' },
];

export interface GameRoomData {
  roomId: string;
  name: string;
  hostId: string;
  hostName: string;
  difficulty: DifficultyId;
  mazeSeed: number;
  status: 'waiting' | 'playing' | 'finished';
  collectedOrnaments: number[];
  collectedWeapons: number[];
  santaStunNonce: number;
  ornamentsTotal: number;
  exitUnlocked: boolean;
  isPublic: boolean;
  playerCount: number;
  updatedAtMs?: number;
}

export interface RoomPlayerData {
  uid: string;
  roomId: string;
  displayName: string;
  coatColor: string;
  x: number;
  z: number;
  yaw: number;
  flashlightOn: boolean;
  alive: boolean;
  escaped: boolean;
}

export interface SantaLiveData {
  x: number;
  z: number;
  yaw: number;
  speed: number;
  alerted: boolean;
  stunRemaining: number;
}

export interface ChatMessageData {
  id: string;
  senderId: string;
  senderName: string;
  coatColor: string;
  text: string;
  createdAtMs: number;
}

export interface HudSnapshot {
  phase: GamePhase;
  difficulty: DifficultyId;
  ornamentsCollected: number;
  ornamentsTotal: number;
  exitUnlocked: boolean;
  stamina: number; // 0..100
  battery: number; // 0..100
  flashlightOn: boolean;
  elapsedSeconds: number;
  santaDistance: number; // meters
  santaAngleDeg: number; // relative bearing from camera forward (-180..180, + = right, - = left)
  santaAlerted: boolean;
  santaStunRemaining: number; // seconds remaining of 30s stun
  playerHeadingDeg: number; // 0..360 compass heading
  exitAngleDeg: number; // relative bearing to exit (-180..180)
  exitDistance: number; // meters to exit
  nearestOrnamentAngleDeg: number | null;
  nearestOrnamentDistance: number | null;
  nearestWeaponAngleDeg: number | null;
  nearestWeaponDistance: number | null;
  equippedWeapon: WeaponType | null;
  nextWeaponSpawnIn: number;
  dodgeCooldown: number;
  pointerLocked: boolean;
  chimeCooldown: number; // seconds remaining
  chimeAngleDeg: number | null; // BFS next-step bearing during Chime Sense
  chimeTargetLabel: string;
  statusBanner: string | null;
  muted: boolean;
  hudHidden: boolean;
  webglError: string | null;
  isMultiplayer: boolean;
  roomId: string | null;
  isHost: boolean;
  alive: boolean;
  spectating: boolean;
  chatOpen: boolean;
}
