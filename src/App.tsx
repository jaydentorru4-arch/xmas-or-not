import { useEffect, useRef, useState } from 'react';
import { GameHUD } from './components/GameHUD';
import { MenuOverlays } from './components/MenuOverlays';
import { MazeEngine } from './game/MazeEngine';
import { DifficultyId, HudSnapshot } from './game/types';

const INITIAL_HUD: HudSnapshot = {
  phase: 'menu',
  difficulty: 'normal',
  ornamentsCollected: 0,
  ornamentsTotal: 5,
  exitUnlocked: false,
  stamina: 100,
  battery: 100,
  flashlightOn: true,
  elapsedSeconds: 0,
  santaDistance: 50,
  santaAlerted: false,
  pointerLocked: false,
  chimeCooldown: 0,
  chimeAngleDeg: null,
  chimeTargetLabel: '',
  statusBanner: null,
  muted: false,
  hudHidden: false,
  webglError: null,
};

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<MazeEngine | null>(null);
  const [hud, setHud] = useState<HudSnapshot>(INITIAL_HUD);
  const [selectedDifficulty, setSelectedDifficulty] = useState<DifficultyId>('normal');

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const engine = new MazeEngine(container, (snapshot) => {
      setHud(snapshot);
    });
    engineRef.current = engine;

    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const handleSelectDifficulty = (id: DifficultyId) => {
    setSelectedDifficulty(id);
    engineRef.current?.setDifficulty(id);
  };

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-[#050811]">
      {/* Isolated WebGL canvas container (never re-created on HUD updates) */}
      <div ref={mountRef} className="w-full h-full" />

      <GameHUD
        hud={hud}
        onToggleMute={() => engineRef.current?.toggleMute()}
        onPause={() => engineRef.current?.pauseGame()}
        onToggleFlashlight={() => engineRef.current?.toggleFlashlight()}
        onTriggerChime={() => engineRef.current?.triggerChimeSense()}
        onToggleHudHidden={() => engineRef.current?.toggleHudHidden()}
        onLockPointer={() => engineRef.current?.requestPointerLockSafe()}
      />

      <MenuOverlays
        hud={hud}
        selectedDifficulty={selectedDifficulty}
        onSelectDifficulty={handleSelectDifficulty}
        onStart={() => engineRef.current?.startNewGame(selectedDifficulty)}
        onResume={() => engineRef.current?.resumeGame()}
        onReturnMenu={() => engineRef.current?.returnToMenu()}
      />
    </main>
  );
}
