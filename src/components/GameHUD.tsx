import React from 'react';
import {
  Bell,
  ChevronDown,
  ChevronUp,
  Flashlight,
  Pause,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { HudSnapshot } from '../game/types';

interface GameHUDProps {
  hud: HudSnapshot;
  onToggleMute: () => void;
  onPause: () => void;
  onToggleFlashlight: () => void;
  onTriggerChime: () => void;
  onToggleHudHidden: () => void;
  onLockPointer: () => void;
}

function formatTime(sec: number): string {
  const whole = Math.max(0, Math.floor(sec));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const GameHUD: React.FC<GameHUDProps> = ({
  hud,
  onToggleMute,
  onPause,
  onToggleFlashlight,
  onTriggerChime,
  onToggleHudHidden,
  onLockPointer,
}) => {
  if (hud.phase !== 'playing') return null;

  // Terror intensity scales from 0 (dist >= 16m) to 1 (dist <= 2.5m)
  const terror = Math.max(0, Math.min(1, (16 - hud.santaDistance) / 13.5));
  const dangerText =
    hud.santaDistance < 7.5
      ? 'Santa is right behind you'
      : hud.santaDistance < 14
        ? 'Heavy footsteps nearby'
        : null;

  return (
    <div className="fixed inset-0 z-10 pointer-events-none">
      {/* Subtle frost edge vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(circle at 50% 50%, rgba(5,8,17,0) 58%, rgba(16,28,48,0.48) 100%)',
        }}
      />

      {/* Dynamic crimson terror vignette when Santa closes in */}
      {terror > 0.02 && (
        <div
          className="absolute inset-0 pointer-events-none transition-opacity duration-150"
          style={{
            opacity: terror * 0.85,
            background:
              'radial-gradient(circle at 50% 50%, rgba(120,0,12,0) 42%, rgba(155,8,20,0.68) 100%)',
          }}
        />
      )}

      {/* Top Row: Objective (Left) & Actions (Right) */}
      <div className="absolute top-0 left-0 right-0 flex items-start justify-between px-5 pt-4 gap-4">
        <div className="pointer-events-auto flex flex-col gap-1 bg-[#060913]/85 border border-white/12 rounded-lg px-4 py-2.5">
          <div className="flex items-center gap-3 text-sm font-medium text-slate-100 whitespace-nowrap">
            <span className={hud.exitUnlocked ? 'text-emerald-400 font-semibold' : 'text-amber-300 font-semibold'}>
              {hud.exitUnlocked
                ? 'Exit Gate Unlocked'
                : `Ornaments ${hud.ornamentsCollected} / ${hud.ornamentsTotal}`}
            </span>
            <span aria-hidden="true" className="text-slate-500">
              ·
            </span>
            <span className="font-mono-tabular text-slate-300">{formatTime(hud.elapsedSeconds)}</span>
            <span aria-hidden="true" className="text-slate-500">
              ·
            </span>
            <span className="text-xs text-slate-400 capitalize">{hud.difficulty}</span>
          </div>
          {dangerText && (
            <div className="text-xs font-medium text-red-400">
              {dangerText}
            </div>
          )}
        </div>

        <div className="pointer-events-auto flex items-center gap-2 shrink-0">
          {!hud.pointerLocked && (
            <button
              type="button"
              onClick={onLockPointer}
              className="px-3 py-2 text-xs font-medium text-slate-200 bg-[#060913]/88 border border-white/15 rounded-lg hover:bg-[#0e1528] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Lock Mouse
            </button>
          )}
          <button
            type="button"
            onClick={onToggleMute}
            aria-label={hud.muted ? 'Unmute audio' : 'Mute audio'}
            className="flex items-center justify-center w-10 h-10 text-slate-200 bg-[#060913]/88 border border-white/15 rounded-lg hover:bg-[#0e1528] transition-colors cursor-pointer"
          >
            {hud.muted ? <VolumeX className="w-4 h-4 text-red-400" /> : <Volume2 className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={onPause}
            aria-label="Pause game"
            className="flex items-center gap-2 px-3.5 h-10 text-xs font-medium text-slate-100 bg-[#060913]/88 border border-white/15 rounded-lg hover:bg-[#0e1528] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Pause className="w-3.5 h-3.5" />
            <span>Pause</span>
          </button>
        </div>
      </div>

      {/* Center Reticle & Chime Sense Bearing */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="relative flex items-center justify-center">
          <div className="w-1.5 h-1.5 rounded-full bg-white/80" />
          {hud.chimeAngleDeg !== null && (
            <div
              className="absolute w-24 h-24 flex items-start justify-center transition-transform duration-75"
              style={{ transform: `rotate(${-hud.chimeAngleDeg}deg)` }}
            >
              <div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-b-[11px] border-b-amber-300" />
            </div>
          )}
        </div>
      </div>

      {/* Transient Event Subtitle Banner */}
      {(hud.statusBanner || hud.chimeAngleDeg !== null) && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 pointer-events-none max-w-md px-4 text-center">
          {hud.statusBanner && (
            <div className="bg-[#060913]/90 border border-white/15 rounded-lg px-4 py-2 text-sm text-slate-100">
              {hud.statusBanner}
            </div>
          )}
          {hud.chimeAngleDeg !== null && (
            <div className="bg-[#060913]/85 border border-amber-400/35 rounded-lg px-3 py-1 text-xs font-medium text-amber-200 whitespace-nowrap">
              Chime resonance: {hud.chimeTargetLabel}
            </div>
          )}
        </div>
      )}

      {/* Collapsible Bottom Control Dock (Zero Center Occlusion) */}
      <div
        className={`fixed bottom-5 left-1/2 -translate-x-1/2 flex flex-col items-center transition-transform duration-200 ${
          hud.hudHidden ? 'translate-y-[calc(100%-34px)]' : 'translate-y-0'
        }`}
      >
        <button
          type="button"
          onClick={onToggleHudHidden}
          className="pointer-events-auto flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-slate-300 bg-[#060913]/90 border border-b-0 border-white/15 rounded-t-lg hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          {hud.hudHidden ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          <span>{hud.hudHidden ? 'Show Controls' : 'Hide Controls'}</span>
        </button>

        <div className="pointer-events-auto flex flex-wrap sm:flex-nowrap items-center gap-4 px-5 py-3 bg-[#060913]/90 border border-white/15 rounded-xl max-w-[94vw]">
          {/* Stamina Meter */}
          <div className="flex items-center gap-2.5 min-w-[140px]">
            <span className="text-xs font-medium text-slate-300 whitespace-nowrap">Stamina</span>
            <div className="w-24 h-2 bg-slate-800 rounded-sm overflow-hidden">
              <div
                className={`h-full transition-all duration-100 ${
                  hud.stamina < 25 ? 'bg-red-500' : 'bg-sky-400'
                }`}
                style={{ width: `${Math.round(hud.stamina)}%` }}
              />
            </div>
          </div>

          <div className="hidden sm:block w-px h-5 bg-white/12" aria-hidden="true" />

          {/* Flashlight Button + Battery */}
          <button
            type="button"
            onClick={onToggleFlashlight}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              hud.flashlightOn
                ? 'bg-amber-500/18 border-amber-400/45 text-amber-200'
                : 'bg-slate-900/90 border-white/12 text-slate-300 hover:text-white'
            }`}
          >
            <Flashlight className="w-3.5 h-3.5" />
            <span>Flashlight (F)</span>
            <span className="font-mono-tabular text-slate-300">{Math.round(hud.battery)}%</span>
          </button>

          {/* Chime Sense Button */}
          <button
            type="button"
            onClick={onTriggerChime}
            disabled={hud.chimeCooldown > 0}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              hud.chimeCooldown > 0
                ? 'bg-slate-900/60 border-white/10 text-slate-500 cursor-not-allowed'
                : 'bg-slate-900/90 border-white/15 text-slate-200 hover:bg-slate-800 cursor-pointer'
            }`}
          >
            <Bell className="w-3.5 h-3.5" />
            <span>
              {hud.chimeCooldown > 0
                ? `Chime (${Math.ceil(hud.chimeCooldown)}s)`
                : 'Chime Sense (C)'}
            </span>
          </button>

          <div className="hidden md:block w-px h-5 bg-white/12" aria-hidden="true" />

          <div className="hidden md:flex items-center gap-2 text-xs text-slate-400 whitespace-nowrap">
            <span>WASD Move</span>
            <span aria-hidden="true">·</span>
            <span>Drag / Q-E Look</span>
            <span aria-hidden="true">·</span>
            <span>Shift Sprint</span>
          </div>
        </div>
      </div>
    </div>
  );
};
