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
    description: '27×27 labyrinth, balanced mist, 6 cursed ornaments.',
    santaBaseSpeed: 3.15,
    santaChaseSpeed: 4.9,
    santaSightRange: 19,
    fogDensity: 0.068,
    ornamentCount: 6,
  },
  nightmare: {
    id: 'nightmare',
    label: 'Nightmare',
    description: '27×27 labyrinth, relentless hunt, thicker freezing fog, 7 ornaments.',
    santaBaseSpeed: 3.75,
    santaChaseSpeed: 5.5,
    santaSightRange: 24,
    fogDensity: 0.092,
    ornamentCount: 7,
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
  playerHeadingDeg: number; // 0..360 compass heading
  exitAngleDeg: number; // relative bearing to exit (-180..180)
  exitDistance: number; // meters to exit
  nearestOrnamentAngleDeg: number | null;
  nearestOrnamentDistance: number | null;
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
