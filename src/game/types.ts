export type GamePhase = 'menu' | 'waiting' | 'playing' | 'paused' | 'caught' | 'escaped';

export type DifficultyId = 'normal' | 'nightmare';

export type HatStyle = 'hood' | 'beanie' | 'santa_hat' | 'ushanka';

export const HAT_STYLES: { id: HatStyle; label: string }[] = [
  { id: 'hood', label: 'Winter Hood' },
  { id: 'beanie', label: 'Knit Beanie' },
  { id: 'santa_hat', label: 'Festive Cap' },
  { id: 'ushanka', label: 'Fur Ushanka' },
];

export const COAT_COLORS = [
  { name: 'Crimson', hex: '#c82333' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Cobalt', hex: '#3b82f6' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Frost', hex: '#38bdf8' },
];

export const SCARF_COLORS = [
  { name: 'Snow', hex: '#e2e8f0' },
  { name: 'Scarlet', hex: '#ef4444' },
  { name: 'Pine', hex: '#10b981' },
  { name: 'Gold', hex: '#f59e0b' },
  { name: 'Ice', hex: '#38bdf8' },
  { name: 'Plum', hex: '#a855f7' },
];

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
    description: 'Balanced freezing mist, steady hunt, 60s weapon drops & batteries.',
    santaBaseSpeed: 2.3,
    santaChaseSpeed: 3.75,
    santaSightRange: 16,
    fogDensity: 0.064,
    ornamentCount: 5,
  },
  nightmare: {
    id: 'nightmare',
    label: 'Nightmare',
    description: 'Thicker fog, sharper Santa senses, more cursed ornaments.',
    santaBaseSpeed: 2.75,
    santaChaseSpeed: 4.2,
    santaSightRange: 19,
    fogDensity: 0.086,
    ornamentCount: 6,
  },
};

export interface LevelScaling {
  level: number;
  mazeSize: number; // always odd (23..35)
  ornamentCount: number;
  batteryCount: number;
  santaBaseSpeed: number;
  santaChaseSpeed: number;
  santaSightRange: number;
  fogDensity: number;
  label: string;
}

export function getLevelScaling(level: number, difficulty: DifficultyId): LevelScaling {
  const lvl = Math.max(1, Math.min(50, Math.floor(level || 1)));
  const base = DIFFICULTIES[difficulty];
  // Odd maze sizes growing from 23x23 at Lv1 up to 35x35 at Lv7+
  const sizeSteps = [23, 25, 27, 29, 31, 33, 35];
  const mazeSize = sizeSteps[Math.min(sizeSteps.length - 1, lvl - 1)];
  const ornamentCount = Math.min(11, base.ornamentCount + Math.floor((lvl - 1) * 0.7));
  const batteryCount = Math.min(10, 5 + Math.floor((lvl - 1) * 0.6));
  const speedBonus = Math.min(0.85, (lvl - 1) * 0.11);
  const sightBonus = Math.min(5.0, (lvl - 1) * 0.65);
  const fogBonus = Math.min(0.022, (lvl - 1) * 0.0028);

  const tierNames = [
    'Snowdrift Hollow',
    'Frostbite Hedge',
    'Midnight Pines',
    'Black Ice Thicket',
    'Krampus Crossing',
    'Polar Abyss',
  ];
  const tierName = tierNames[Math.min(tierNames.length - 1, Math.floor((lvl - 1) / 2))];

  return {
    level: lvl,
    mazeSize,
    ornamentCount,
    batteryCount,
    santaBaseSpeed: Number((base.santaBaseSpeed + speedBonus).toFixed(2)),
    santaChaseSpeed: Number((base.santaChaseSpeed + speedBonus).toFixed(2)),
    santaSightRange: Number((base.santaSightRange + sightBonus).toFixed(1)),
    fogDensity: Number((base.fogDensity + fogBonus).toFixed(4)),
    label: `Lv ${lvl} · ${tierName}`,
  };
}

export function xpForNextLevel(level: number): number {
  const lvl = Math.max(1, Math.floor(level || 1));
  return 100 + (lvl - 1) * 75;
}

export function applyXpGain(
  currentLevel: number,
  currentXp: number,
  earnedXp: number
): { level: number; xp: number; leveledUp: boolean } {
  let lvl = Math.max(1, Math.min(50, Math.floor(currentLevel || 1)));
  let xp = Math.max(0, Math.floor((currentXp || 0) + earnedXp));
  const startLvl = lvl;

  while (lvl < 50 && xp >= xpForNextLevel(lvl)) {
    xp -= xpForNextLevel(lvl);
    lvl += 1;
  }

  return { level: lvl, xp, leveledUp: lvl > startLvl };
}

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
  batteries: GridCoord[];
  traps: GridCoord[];
}

export interface SurvivorProfile {
  uid: string;
  displayName: string;
  coatColor: string;
  scarfColor: string;
  hatStyle: HatStyle;
  friendCode: string;
  level: number;
  xp: number;
  escapes: number;
  gamesPlayed: number;
}

export type FriendStatus = 'pending_sent' | 'pending_received' | 'accepted';

export interface FriendRecord {
  ownerUid: string;
  friendUid: string;
  displayName: string;
  coatColor: string;
  scarfColor: string;
  hatStyle: HatStyle;
  friendCode: string;
  level: number;
  status: FriendStatus;
}

export interface GameRoomData {
  roomId: string;
  name: string;
  hostId: string;
  hostName: string;
  difficulty: DifficultyId;
  level: number;
  mazeSeed: number;
  status: 'waiting' | 'playing' | 'finished';
  collectedOrnaments: number[];
  collectedWeapons: number[];
  collectedBatteries: number[];
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
  scarfColor: string;
  hatStyle: HatStyle;
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

export interface MapMarkerPlayer {
  uid: string;
  displayName: string;
  coatColor: string;
  normX: number; // 0..1 across maze grid
  normZ: number;
  alive: boolean;
  escaped: boolean;
}

export interface MazeMapState {
  mazeSeed: number;
  size: number;
  grid: number[][];
  playerNormX: number;
  playerNormZ: number;
  playerYaw: number;
  santaNormX: number;
  santaNormZ: number;
  santaAlerted: boolean;
  santaStunRemaining: number;
  exitNormX: number;
  exitNormZ: number;
  exitUnlocked: boolean;
  ornaments: { normX: number; normZ: number }[];
  batteries: { normX: number; normZ: number }[];
  weapons: { normX: number; normZ: number }[];
  otherPlayers: MapMarkerPlayer[];
}

export interface HudSnapshot {
  phase: GamePhase;
  difficulty: DifficultyId;
  level: number;
  ornamentsCollected: number;
  ornamentsTotal: number;
  exitUnlocked: boolean;
  stamina: number; // 0..100
  battery: number; // 0..100
  flashlightOn: boolean;
  darknessOverlay: number; // 0..0.75 when flashlight off/depleted
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
  nearestBatteryDistance: number | null;
  equippedWeapon: WeaponType | null;
  nextWeaponSpawnIn: number;
  dodgeCooldown: number;
  pointerLocked: boolean;
  chimeCooldown: number; // seconds remaining
  chimeAngleDeg: number | null; // BFS next-step bearing during Chime Sense
  chimeTargetLabel: string;
  chimeTargetDistance: number | null;
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
  mapState: MazeMapState | null;
}
