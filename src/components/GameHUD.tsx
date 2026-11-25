import React from 'react';
import {
  Bell,
  ChevronDown,
  ChevronUp,
  Compass,
  Crosshair,
  Flashlight,
  Map as MapIcon,
  MessageSquare,
  Pause,
  Star,
  Users,
  Volume2,
  VolumeX,
  Wind,
} from 'lucide-react';
import { HudSnapshot, WEAPON_SPECS } from '../game/types';
import { MazeMap } from './MazeMap';
import { MobileControls } from './MobileControls';

interface GameHUDProps {
  hud: HudSnapshot;
  teammateCount: number;
  mapExpanded: boolean;
  showMobileControls: boolean;
  mobileSprinting: boolean;
  onToggleMapExpanded: () => void;
  onToggleMute: () => void;
  onPause: () => void;
  onToggleFlashlight: () => void;
  onTriggerChime: () => void;
  onUseWeapon: () => void;
  onDodge: () => void;
  onToggleHudHidden: () => void;
  onLockPointer: () => void;
  onToggleChat: () => void;
  onUnlockAudio: () => void;
  onMobileMove: (x: number, z: number) => void;
  onMobileLook: (dx: number, dy: number) => void;
  onToggleMobileSprint: (sprinting: boolean) => void;
}

function formatTime(sec: number): string {
  const whole = Math.max(0, Math.floor(sec));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function normalizeDeltaDeg(deg: number): number {
  let d = ((deg + 180) % 360 + 360) % 360 - 180;
  if (d === -180) d = 180;
  return d;
}

function describeDirection(relDeg: number): string {
  const abs = Math.abs(relDeg);
  if (abs <= 35) return 'Ahead';
  if (abs >= 145) return 'Behind';
  return relDeg > 0 ? 'Right' : 'Left';
}

const CARDINALS = [
  { label: 'N', deg: 0 },
  { label: 'NE', deg: 45 },
  { label: 'E', deg: 90 },
  { label: 'SE', deg: 135 },
  { label: 'S', deg: 180 },
  { label: 'SW', deg: 225 },
  { label: 'W', deg: 270 },
  { label: 'NW', deg: 315 },
];

const COMPASS_HALF_FOV = 75;

function angleToPercent(relDeg: number): number {
  const clamped = Math.max(-COMPASS_HALF_FOV, Math.min(COMPASS_HALF_FOV, relDeg));
  return 50 + (clamped / COMPASS_HALF_FOV) * 46;
}

export const GameHUD: React.FC<GameHUDProps> = ({
  hud,
  teammateCount,
  mapExpanded,
  showMobileControls,
  mobileSprinting,
  onToggleMapExpanded,
  onToggleMute,
  onPause,
  onToggleFlashlight,
  onTriggerChime,
  onUseWeapon,
  onDodge,
  onToggleHudHidden,
  onLockPointer,
  onToggleChat,
  onUnlockAudio,
  onMobileMove,
  onMobileLook,
  onToggleMobileSprint,
}) => {
  if (hud.phase !== 'playing') return null;

  const isStunned = hud.santaStunRemaining > 0;
  const terror =
    hud.spectating || isStunned ? 0 : Math.max(0, Math.min(1, (20 - hud.santaDistance) / 17.5));
  const rad = (hud.santaAngleDeg * Math.PI) / 180;
  const frontWeight = Math.max(0, Math.cos(rad));
  const backWeight = Math.max(0, -Math.cos(rad));
  const rightWeight = Math.max(0, Math.sin(rad));
  const leftWeight = Math.max(0, -Math.sin(rad));

  const threatPct = isStunned
    ? Math.max(0, Math.min(100, (hud.santaStunRemaining / 30) * 100))
    : Math.max(0, Math.min(100, ((26 - hud.santaDistance) / 24) * 100));
  const santaDistRound = Math.round(hud.santaDistance);
  const santaDir = describeDirection(hud.santaAngleDeg);

  let threatLabel = 'Quiet · Snow drifting';
  let threatTextClass = 'text-slate-400';
  let threatBarClass = 'bg-slate-600';

  if (hud.spectating) {
    threatLabel = 'Spectating surviving teammates';
    threatTextClass = 'text-sky-300 font-medium';
    threatBarClass = 'bg-sky-500';
  } else if (isStunned) {
    threatLabel = `Santa stunned · ${Math.ceil(hud.santaStunRemaining)}s`;
    threatTextClass = 'text-sky-300 font-semibold';
    threatBarClass = 'bg-sky-400';
  } else if (hud.santaDistance < 8.5 || (hud.santaAlerted && hud.santaDistance < 14)) {
    threatLabel = `Santa hunting (${santaDir} · ${santaDistRound}m)`;
    threatTextClass = 'text-red-400 font-semibold';
    threatBarClass = 'bg-red-500';
  } else if (hud.santaDistance < 16) {
    threatLabel = `Santa approaching (${santaDir} · ${santaDistRound}m)`;
    threatTextClass = 'text-orange-300 font-medium';
    threatBarClass = 'bg-orange-400';
  } else if (hud.santaDistance < 25) {
    threatLabel = `Sleigh bells distant (${santaDir} · ${santaDistRound}m)`;
    threatTextClass = 'text-amber-300';
    threatBarClass = 'bg-amber-400';
  }

  const exitPct = angleToPercent(hud.exitAngleDeg);
  const ornamentPct =
    hud.nearestOrnamentAngleDeg !== null ? angleToPercent(hud.nearestOrnamentAngleDeg) : null;
  const weaponPct =
    !hud.equippedWeapon && hud.nearestWeaponAngleDeg !== null
      ? angleToPercent(hud.nearestWeaponAngleDeg)
      : null;

  return (
    <div className="fixed inset-0 z-10 pointer-events-none">
      {/* Flashlight Depleted / Off Darkness Overlay */}
      {hud.darknessOverlay > 0.01 && (
        <div
          className="absolute inset-0 pointer-events-none transition-opacity duration-100"
          style={{
            background: `radial-gradient(circle at 50% 50%, rgba(2,4,10,${(hud.darknessOverlay * 0.72).toFixed(
              3
            )}) 10%, rgba(2,4,10,${Math.min(0.92, hud.darknessOverlay * 1.18).toFixed(3)}) 100%)`,
          }}
        />
      )}

      {/* Subtle frost edge vignette */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(circle at 50% 50%, rgba(5,8,17,0) 58%, rgba(16,28,48,0.48) 100%)',
        }}
      />

      {/* Directional Crimson Threat Glow */}
      {terror > 0.02 && (
        <>
          <div
            className="absolute inset-0 pointer-events-none transition-opacity duration-150"
            style={{
              opacity: terror * 0.72,
              background:
                'radial-gradient(circle at 50% 50%, rgba(120,0,12,0) 46%, rgba(155,8,20,0.62) 100%)',
            }}
          />
          {leftWeight > 0.1 && (
            <div
              className="absolute inset-y-0 left-0 w-24 pointer-events-none"
              style={{
                opacity: terror * leftWeight * 0.95,
                background: 'linear-gradient(to right, rgba(220,20,35,0.65), transparent)',
              }}
            />
          )}
          {rightWeight > 0.1 && (
            <div
              className="absolute inset-y-0 right-0 w-24 pointer-events-none"
              style={{
                opacity: terror * rightWeight * 0.95,
                background: 'linear-gradient(to left, rgba(220,20,35,0.65), transparent)',
              }}
            />
          )}
          {backWeight > 0.1 && (
            <div
              className="absolute inset-x-0 bottom-0 h-24 pointer-events-none"
              style={{
                opacity: terror * backWeight * 0.95,
                background: 'linear-gradient(to top, rgba(220,20,35,0.68), transparent)',
              }}
            />
          )}
          {frontWeight > 0.1 && (
            <div
              className="absolute inset-x-0 top-0 h-20 pointer-events-none"
              style={{
                opacity: terror * frontWeight * 0.85,
                background: 'linear-gradient(to bottom, rgba(220,20,35,0.58), transparent)',
              }}
            />
          )}
        </>
      )}

      {/* Top Row */}
      <div className="relative z-20 flex items-start justify-between px-3 sm:px-5 pt-2.5 sm:pt-4 gap-3 pointer-events-none">
        {/* Top-Left Objective Readout (+ Mobile Stamina & Compact Compass) */}
        <div className="flex flex-col gap-1.5 max-w-[calc(100vw-130px)] sm:max-w-none">
          <div className="pointer-events-auto flex flex-col gap-1 bg-[#060913]/88 border border-white/12 rounded-lg px-3 sm:px-4 py-1.5 sm:py-2.5 shrink-0">
            <div className="flex items-center gap-2 sm:gap-2.5 text-xs sm:text-sm font-medium text-slate-100 whitespace-nowrap">
              <span className="text-[11px] sm:text-xs font-mono-tabular font-semibold text-red-300">Lv {hud.level}</span>
              <span aria-hidden="true" className="text-slate-600">
                ·
              </span>
              <span className={hud.exitUnlocked ? 'text-emerald-400 font-semibold' : 'text-amber-300 font-semibold'}>
                {hud.exitUnlocked
                  ? 'Exit Unlocked'
                  : `Stars ${hud.ornamentsCollected}/${hud.ornamentsTotal}`}
              </span>
              <span aria-hidden="true" className="text-slate-500">
                ·
              </span>
              <span className="font-mono-tabular text-slate-300">{formatTime(hud.elapsedSeconds)}</span>
              {hud.isMultiplayer && (
                <>
                  <span aria-hidden="true" className="text-slate-500">
                    ·
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs text-sky-300">
                    <Users className="w-3.5 h-3.5" />
                    <span>{teammateCount}</span>
                  </span>
                </>
              )}
            </div>
            <div className="text-[11px] sm:text-xs text-slate-400 truncate">
              {hud.spectating
                ? showMobileControls
                  ? 'Use stick to fly or watch team'
                  : 'WASD to free-fly or watch teammates'
                : hud.exitUnlocked
                  ? `Follow EXIT marker (${Math.round(hud.exitDistance)}m)`
                  : hud.nearestOrnamentDistance !== null
                    ? `Star ${Math.round(hud.nearestOrnamentDistance)}m · ${
                        hud.nearestBatteryDistance !== null
                          ? `Bat ${Math.round(hud.nearestBatteryDistance)}m · `
                          : ''
                      }${
                        hud.equippedWeapon
                          ? WEAPON_SPECS[hud.equippedWeapon].label
                          : `Drop ${Math.ceil(hud.nextWeaponSpawnIn)}s`
                      }`
                    : `Exit ${Math.round(hud.exitDistance)}m`}
            </div>

            {showMobileControls && (
              <div className="flex items-center gap-2 pt-0.5">
                <span className="text-[10px] text-slate-400">Stamina</span>
                <div className="flex-1 max-w-[96px] h-1.5 bg-slate-800 rounded-sm overflow-hidden">
                  <div
                    className={`h-full transition-all duration-100 ${
                      hud.stamina < 25 ? 'bg-red-500' : 'bg-sky-400'
                    }`}
                    style={{ width: `${Math.round(hud.stamina)}%` }}
                  />
                </div>
                <span className="text-[10px] font-mono-tabular text-slate-300">
                  {Math.round(hud.stamina)}%
                </span>
              </div>
            )}
          </div>

          {/* Mobile Compact Exit & Threat Strip (nested under left card so it never collides with minimap) */}
          <div className="sm:hidden flex items-center gap-2 bg-[#060913]/90 border border-white/15 rounded-lg px-2.5 py-1 text-[11px] whitespace-nowrap w-fit max-w-full overflow-hidden">
            <span className={hud.exitUnlocked ? 'text-emerald-300 font-semibold' : 'text-red-300 font-semibold'}>
              EXIT {describeDirection(hud.exitAngleDeg)} {Math.round(hud.exitDistance)}m
            </span>
            <span aria-hidden="true" className="text-slate-600">
              ·
            </span>
            <span className={`truncate ${threatTextClass}`}>{threatLabel}</span>
          </div>
        </div>

        {/* Top-Center: Exit Compass & Santa Proximity */}
        <div className="hidden sm:flex flex-col items-center gap-1.5 w-[340px] max-w-[44vw]">
          <div className="relative w-full h-10 bg-[#060913]/90 border border-white/15 rounded-lg overflow-hidden">
            <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-px bg-white/30" />

            {CARDINALS.map((c) => {
              const rel = normalizeDeltaDeg(c.deg - hud.playerHeadingDeg);
              if (Math.abs(rel) > COMPASS_HALF_FOV) return null;
              const leftPct = 50 + (rel / COMPASS_HALF_FOV) * 46;
              return (
                <div
                  key={c.label}
                  className="absolute top-1 -translate-x-1/2 text-[10px] font-mono-tabular font-medium text-slate-400"
                  style={{ left: `${leftPct}%` }}
                >
                  {c.label}
                </div>
              );
            })}

            {!hud.exitUnlocked && ornamentPct !== null && (
              <div
                className="absolute bottom-1 -translate-x-1/2 flex items-center gap-0.5 text-amber-300"
                style={{ left: `${ornamentPct}%` }}
                title="Nearest Ornament"
              >
                <Star className="w-3 h-3 fill-amber-300" />
              </div>
            )}

            {weaponPct !== null && (
              <div
                className="absolute bottom-1 -translate-x-1/2 flex items-center gap-0.5 text-sky-300"
                style={{ left: `${weaponPct}%` }}
                title="Nearest Stun Weapon"
              >
                <Crosshair className="w-3 h-3" />
              </div>
            )}

            <div
              className={`absolute bottom-1 -translate-x-1/2 flex items-center gap-1 px-1 text-[11px] font-mono-tabular font-semibold whitespace-nowrap ${
                hud.exitUnlocked ? 'text-emerald-300' : 'text-red-300'
              }`}
              style={{ left: `${exitPct}%` }}
            >
              <Compass className="w-3 h-3 shrink-0" />
              <span>EXIT {Math.round(hud.exitDistance)}m</span>
            </div>
          </div>

          <div className="w-full flex items-center justify-between gap-3 bg-[#060913]/88 border border-white/12 rounded-md px-3 py-1">
            <span className={`text-xs whitespace-nowrap truncate ${threatTextClass}`}>
              {threatLabel}
            </span>
            <div className="w-16 h-1.5 bg-slate-800 rounded-sm overflow-hidden shrink-0">
              <div
                className={`h-full transition-all duration-150 ${threatBarClass}`}
                style={{ width: `${Math.round(hud.spectating ? 100 : threatPct)}%` }}
              />
            </div>
          </div>
        </div>

        {/* Top-Right Controls */}
        <div className="pointer-events-auto flex items-center gap-1.5 sm:gap-2 shrink-0">
          {!showMobileControls && !hud.pointerLocked && !hud.chatOpen && (
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
            className="flex items-center justify-center w-9 h-9 sm:w-10 sm:h-10 text-slate-200 bg-[#060913]/88 border border-white/15 rounded-lg hover:bg-[#0e1528] transition-colors cursor-pointer"
          >
            {hud.muted ? <VolumeX className="w-4 h-4 text-red-400" /> : <Volume2 className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={onPause}
            aria-label="Pause game"
            className="flex items-center gap-1.5 px-2.5 sm:px-3.5 h-9 sm:h-10 text-xs font-medium text-slate-100 bg-[#060913]/88 border border-white/15 rounded-lg hover:bg-[#0e1528] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Pause className="w-3.5 h-3.5" />
            <span>{hud.isMultiplayer ? 'Menu' : 'Pause'}</span>
          </button>
        </div>
      </div>

      {/* Center Reticle & Chime Sense Corridor Turn Arrow */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="relative flex items-center justify-center">
          <div className="w-1.5 h-1.5 rounded-full bg-white/80" />
          {hud.chimeAngleDeg !== null && (
            <div
              className="absolute w-24 h-24 flex items-start justify-center transition-transform duration-75"
              style={{ transform: `rotate(${hud.chimeAngleDeg}deg)` }}
            >
              <div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-b-[11px] border-b-amber-300" />
            </div>
          )}
        </div>
      </div>

      {/* Live Minimap & Expandable Tactical Maze Map */}
      <MazeMap
        mapState={hud.mapState}
        expanded={mapExpanded}
        onToggleExpanded={onToggleMapExpanded}
        level={hud.level}
      />

      {/* Transient Event Subtitle Banner */}
      {(hud.statusBanner || hud.chimeAngleDeg !== null) && (
        <div className="absolute top-28 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 pointer-events-none max-w-md px-4 text-center">
          {hud.statusBanner && (
            <div className="bg-[#060913]/90 border border-white/15 rounded-lg px-4 py-2 text-sm text-slate-100">
              {hud.statusBanner}
            </div>
          )}
          {hud.chimeAngleDeg !== null && (
            <div className="bg-[#060913]/92 border border-amber-400/45 rounded-lg px-3.5 py-1.5 text-xs font-medium text-amber-200 whitespace-nowrap">
              Follow Golden Trail {describeDirection(hud.chimeAngleDeg)} → {hud.chimeTargetLabel}
              {hud.chimeTargetDistance !== null ? ` (${Math.round(hud.chimeTargetDistance)}m)` : ''}
            </div>
          )}
        </div>
      )}

      {/* Mobile Touch Controls (auto-enabled on mobile devices) */}
      {showMobileControls && !hud.chatOpen && !mapExpanded && (
        <MobileControls
          alive={hud.alive}
          spectating={hud.spectating}
          isMultiplayer={hud.isMultiplayer}
          flashlightOn={hud.flashlightOn}
          battery={hud.battery}
          chimeCooldown={hud.chimeCooldown}
          dodgeCooldown={hud.dodgeCooldown}
          equippedWeapon={hud.equippedWeapon}
          nearestWeaponDistance={hud.nearestWeaponDistance}
          nextWeaponSpawnIn={hud.nextWeaponSpawnIn}
          sprinting={mobileSprinting}
          onUnlockAudio={onUnlockAudio}
          onToggleFlashlight={onToggleFlashlight}
          onTriggerChime={onTriggerChime}
          onUseWeapon={onUseWeapon}
          onDodge={onDodge}
          onToggleMap={onToggleMapExpanded}
          onToggleChat={onToggleChat}
          onMoveInput={onMobileMove}
          onLookInput={onMobileLook}
          onToggleSprint={onToggleMobileSprint}
        />
      )}

      {/* Collapsible Desktop Bottom Control Dock */}
      {!showMobileControls && (
        <div
          className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-20 flex flex-col items-center transition-transform duration-200 ${
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

          <div className="pointer-events-auto flex flex-wrap sm:flex-nowrap items-center gap-2.5 sm:gap-3 px-4 sm:px-5 py-3 bg-[#060913]/90 border border-white/15 rounded-xl max-w-[96vw]">
            <div className="flex items-center gap-2.5 min-w-[122px]">
              <span className="text-xs font-medium text-slate-300 whitespace-nowrap">Stamina</span>
              <div className="w-20 h-2 bg-slate-800 rounded-sm overflow-hidden">
                <div
                  className={`h-full transition-all duration-100 ${
                    hud.stamina < 25 ? 'bg-red-500' : 'bg-sky-400'
                  }`}
                  style={{ width: `${Math.round(hud.stamina)}%` }}
                />
              </div>
            </div>

            <div className="hidden sm:block w-px h-5 bg-white/12" aria-hidden="true" />

            <button
              type="button"
              onClick={onToggleFlashlight}
              disabled={!hud.alive}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                hud.flashlightOn
                  ? 'bg-amber-500/18 border-amber-400/45 text-amber-200'
                  : 'bg-slate-900/90 border-emerald-400/30 text-emerald-300 hover:text-white'
              }`}
            >
              <Flashlight className="w-3.5 h-3.5" />
              <span>{hud.flashlightOn ? 'Light (F)' : 'Charging (F)'}</span>
              <span className="font-mono-tabular text-slate-200">{hud.battery.toFixed(1)}%</span>
            </button>

            <button
              type="button"
              onClick={onTriggerChime}
              disabled={hud.chimeCooldown > 0 || !hud.alive}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                hud.chimeCooldown > 0 || !hud.alive
                  ? 'bg-slate-900/60 border-white/10 text-slate-500 cursor-not-allowed'
                  : 'bg-slate-900/90 border-white/15 text-slate-200 hover:bg-slate-800 cursor-pointer'
              }`}
            >
              <Bell className="w-3.5 h-3.5" />
              <span>
                {hud.chimeCooldown > 0
                  ? `Chime (${Math.ceil(hud.chimeCooldown)}s)`
                  : 'Chime (C)'}
              </span>
            </button>

            <button
              type="button"
              onClick={onDodge}
              disabled={hud.dodgeCooldown > 0 || !hud.alive || hud.spectating}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                hud.dodgeCooldown > 0 || !hud.alive || hud.spectating
                  ? 'bg-slate-900/60 border-white/10 text-slate-500 cursor-not-allowed'
                  : 'bg-slate-900/90 border-white/15 text-slate-200 hover:bg-slate-800 cursor-pointer'
              }`}
            >
              <Wind className="w-3.5 h-3.5" />
              <span>
                {hud.dodgeCooldown > 0
                  ? `Dodge (${hud.dodgeCooldown.toFixed(1)}s)`
                  : 'Dodge (Space)'}
              </span>
            </button>

            {hud.equippedWeapon ? (
              <button
                type="button"
                onClick={onUseWeapon}
                disabled={!hud.alive || hud.spectating}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-sky-500/20 border-sky-400/55 text-sky-200 hover:bg-sky-500/30 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Crosshair className="w-3.5 h-3.5" />
                <span>{WEAPON_SPECS[hud.equippedWeapon].label} (Click/G)</span>
              </button>
            ) : (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border bg-slate-900/60 border-white/10 text-xs text-slate-400 whitespace-nowrap shrink-0">
                <Crosshair className="w-3.5 h-3.5 text-sky-400/80" />
                <span>
                  {hud.nearestWeaponDistance !== null
                    ? `Weapon ${Math.round(hud.nearestWeaponDistance)}m`
                    : `Drop ${Math.ceil(hud.nextWeaponSpawnIn)}s`}
                </span>
              </div>
            )}

            <button
              type="button"
              onClick={onToggleMapExpanded}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                mapExpanded
                  ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-200'
                  : 'bg-slate-900/90 border-white/15 text-slate-200 hover:bg-slate-800'
              }`}
            >
              <MapIcon className="w-3.5 h-3.5" />
              <span>Map (Tab)</span>
            </button>

            {hud.isMultiplayer && (
              <button
                type="button"
                onClick={onToggleChat}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  hud.chatOpen
                    ? 'bg-sky-500/20 border-sky-400/50 text-sky-200'
                    : 'bg-slate-900/90 border-white/15 text-slate-200 hover:bg-slate-800'
                }`}
              >
                <MessageSquare className="w-3.5 h-3.5" />
                <span>Chat (T)</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
