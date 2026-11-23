export type GamePhase = 'menu' | 'playing' | 'paused' | 'caught' | 'escaped';

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
    description: 'Stalking pace, balanced fog, 5 cursed ornaments.',
    santaBaseSpeed: 3.1,
    santaChaseSpeed: 4.95,
    santaSightRange: 18,
    fogDensity: 0.082,
    ornamentCount: 5,
  },
  nightmare: {
    id: 'nightmare',
    label: 'Nightmare',
    description: 'Relentless hunt, thicker freezing mist, razor-thin escapes.',
    santaBaseSpeed: 3.7,
    santaChaseSpeed: 5.55,
    santaSightRange: 23,
    fogDensity: 0.108,
    ornamentCount: 5,
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
  santaAlerted: boolean;
  pointerLocked: boolean;
  chimeCooldown: number; // seconds remaining
  chimeAngleDeg: number | null; // relative bearing to nearest objective in degrees (-180..180)
  chimeTargetLabel: string;
  statusBanner: string | null;
  muted: boolean;
  hudHidden: boolean;
  webglError: string | null;
}
