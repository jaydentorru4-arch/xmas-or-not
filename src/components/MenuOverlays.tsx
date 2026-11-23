import React from 'react';
import { DIFFICULTIES, DifficultyId, HudSnapshot } from '../game/types';

interface MenuOverlaysProps {
  hud: HudSnapshot;
  selectedDifficulty: DifficultyId;
  onSelectDifficulty: (id: DifficultyId) => void;
  onStart: () => void;
  onResume: () => void;
  onReturnMenu: () => void;
}

function formatTime(sec: number): string {
  const whole = Math.max(0, Math.floor(sec));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const MenuOverlays: React.FC<MenuOverlaysProps> = ({
  hud,
  selectedDifficulty,
  onSelectDifficulty,
  onStart,
  onResume,
  onReturnMenu,
}) => {
  if (hud.webglError) {
    return (
      <div className="fixed inset-0 z-30 flex items-center justify-center bg-[#050811] px-6">
        <div className="max-w-md w-full bg-[#0b1020] border border-white/15 rounded-xl p-8 text-center">
          <h1 className="font-display text-2xl font-bold text-slate-100 mb-3">
            3D Rendering Unavailable
          </h1>
          <p className="text-sm text-slate-300 leading-relaxed mb-6">{hud.webglError}</p>
        </div>
      </div>
    );
  }

  if (hud.phase === 'playing') return null;

  if (hud.phase === 'menu') {
    return (
      <div className="fixed inset-0 z-20 flex items-center justify-center bg-gradient-to-t from-[#050811]/92 via-[#050811]/68 to-[#050811]/78 px-6 py-8">
        <div className="max-w-xl w-full bg-[#080d1a]/94 border border-white/15 rounded-xl p-8 sm:p-10">
          <p className="text-xs font-medium tracking-wide text-red-400 mb-2">
            First-Person Labyrinth Survival
          </p>
          <h1 className="font-display text-4xl sm:text-5xl font-bold text-slate-50 tracking-tight mb-4 [text-wrap:balance]">
            Hollow Eve
          </h1>
          <p className="text-base text-slate-300 leading-relaxed mb-7">
            Trapped inside a frostbitten North Pole hedge maze at midnight, you must recover five
            cursed star ornaments to unseal the exit gate—before Evil Santa hunts you down in the
            dark.
          </p>

          {/* Difficulty Selector */}
          <div className="mb-7">
            <div className="text-xs font-medium text-slate-400 mb-2.5">Difficulty</div>
            <div className="grid grid-cols-2 gap-2 p-1 bg-[#050811] border border-white/10 rounded-lg">
              {(['normal', 'nightmare'] as DifficultyId[]).map((id) => {
                const cfg = DIFFICULTIES[id];
                const active = selectedDifficulty === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onSelectDifficulty(id)}
                    className={`px-4 py-2.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                      active
                        ? 'bg-red-700 text-white'
                        : 'text-slate-300 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    {cfg.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-2.5 text-xs text-slate-400">
              {DIFFICULTIES[selectedDifficulty].description}
            </p>
          </div>

          <button
            type="button"
            onClick={onStart}
            className="w-full py-3.5 px-6 bg-red-700 hover:bg-red-600 text-white text-base font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            Enter the Maze
          </button>

          <div className="mt-6 pt-5 border-t border-white/10 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-xs text-slate-400">
            <span>WASD / Arrows Move</span>
            <span aria-hidden="true">·</span>
            <span>Mouse or Drag Look</span>
            <span aria-hidden="true">·</span>
            <span>Shift Sprint</span>
            <span aria-hidden="true">·</span>
            <span>F Flashlight</span>
            <span aria-hidden="true">·</span>
            <span>C Chime Sense</span>
          </div>
        </div>
      </div>
    );
  }

  if (hud.phase === 'paused') {
    return (
      <div className="fixed inset-0 z-20 flex items-center justify-center bg-[#050811]/82 px-6">
        <div className="max-w-sm w-full bg-[#080d1a]/96 border border-white/15 rounded-xl p-8 text-center">
          <h2 className="font-display text-3xl font-bold text-slate-100 mb-2">Paused</h2>
          <p className="text-sm text-slate-400 mb-6">
            Ornaments {hud.ornamentsCollected} / {hud.ornamentsTotal} · {formatTime(hud.elapsedSeconds)}
          </p>
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={onResume}
              className="w-full py-3 px-5 bg-red-700 hover:bg-red-600 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              Resume
            </button>
            <button
              type="button"
              onClick={onStart}
              className="w-full py-3 px-5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              Restart Maze
            </button>
            <button
              type="button"
              onClick={onReturnMenu}
              className="w-full py-2.5 px-5 text-slate-300 hover:text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              Main Menu
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (hud.phase === 'caught') {
    return (
      <div className="fixed inset-0 z-20 flex items-center justify-center bg-[#180306]/88 px-6">
        <div className="max-w-md w-full bg-[#0c0609]/96 border border-red-500/35 rounded-xl p-8 text-center">
          <p className="text-xs font-medium text-red-400 mb-2">Claimed by the North Pole</p>
          <h2 className="font-display text-4xl font-bold text-red-100 mb-3">
            Santa Found You
          </h2>
          <p className="text-sm text-slate-300 mb-6">
            You recovered {hud.ornamentsCollected} of {hud.ornamentsTotal} ornaments in{' '}
            <span className="font-mono-tabular text-slate-100">{formatTime(hud.elapsedSeconds)}</span>.
          </p>
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              type="button"
              onClick={onStart}
              className="flex-1 py-3 px-5 bg-red-700 hover:bg-red-600 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              Play Again
            </button>
            <button
              type="button"
              onClick={onReturnMenu}
              className="flex-1 py-3 px-5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              Main Menu
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Escaped / Victory
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-[#041410]/86 px-6">
      <div className="max-w-md w-full bg-[#071210]/96 border border-emerald-400/35 rounded-xl p-8 text-center">
        <p className="text-xs font-medium text-emerald-400 mb-2">Labyrinth Cleared</p>
        <h2 className="font-display text-4xl font-bold text-emerald-50 mb-3">
          You Escaped
        </h2>
        <p className="text-sm text-slate-300 mb-6">
          All {hud.ornamentsTotal} ornaments recovered on <span className="capitalize">{hud.difficulty}</span>{' '}
          in <span className="font-mono-tabular text-emerald-200">{formatTime(hud.elapsedSeconds)}</span>.
        </p>
        <div className="flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            onClick={onStart}
            className="flex-1 py-3 px-5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            Play Again
          </button>
          <button
            type="button"
            onClick={onReturnMenu}
            className="flex-1 py-3 px-5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            Main Menu
          </button>
        </div>
      </div>
    </div>
  );
};
