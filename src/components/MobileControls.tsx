import React, { useEffect, useRef, useState } from 'react';
import {
  Bell,
  Crosshair,
  Flashlight,
  HeartPulse,
  Map as MapIcon,
  MessageSquare,
  Wind,
} from 'lucide-react';
import { WeaponType, WEAPON_SPECS } from '../game/types';

interface MobileControlsProps {
  alive: boolean;
  spectating: boolean;
  isMultiplayer: boolean;
  flashlightOn: boolean;
  battery: number;
  chimeCooldown: number;
  dodgeCooldown: number;
  equippedWeapon: WeaponType | null;
  nearestWeaponDistance: number | null;
  nextWeaponSpawnIn: number;
  nearbyReviveTarget: { uid: string; displayName: string; distance: number } | null;
  sprinting: boolean;
  onUnlockAudio: () => void;
  onToggleFlashlight: () => void;
  onTriggerChime: () => void;
  onUseWeapon: () => void;
  onReviveTeammate: () => void;
  onDodge: () => void;
  onToggleMap: () => void;
  onToggleChat: () => void;
  onMoveInput: (x: number, z: number) => void;
  onLookInput: (dx: number, dy: number) => void;
  onToggleSprint: (sprinting: boolean) => void;
}

export const MobileControls: React.FC<MobileControlsProps> = ({
  alive,
  spectating,
  isMultiplayer,
  flashlightOn,
  battery,
  chimeCooldown,
  dodgeCooldown,
  equippedWeapon,
  nearestWeaponDistance,
  nextWeaponSpawnIn,
  nearbyReviveTarget,
  sprinting,
  onUnlockAudio,
  onToggleFlashlight,
  onTriggerChime,
  onUseWeapon,
  onReviveTeammate,
  onDodge,
  onToggleMap,
  onToggleChat,
  onMoveInput,
  onLookInput,
  onToggleSprint,
}) => {
  const joystickRef = useRef<HTMLDivElement | null>(null);
  const [joystickActive, setJoystickActive] = useState(false);
  const [stickPos, setStickPos] = useState({ x: 0, y: 0 });
  const touchIdRef = useRef<number | null>(null);
  const mouseJoyActiveRef = useRef(false);

  const lookTouchRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const mouseLookRef = useRef<{ active: boolean; x: number; y: number }>({
    active: false,
    x: 0,
    y: 0,
  });

  useEffect(() => {
    return () => {
      onMoveInput(0, 0);
    };
  }, [onMoveInput]);

  const updateJoystick = (clientX: number, clientY: number) => {
    if (!joystickRef.current) return;
    const rect = joystickRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const maxRadius = Math.max(24, rect.width / 2 - 8);

    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const dist = Math.hypot(dx, dy);
    const clampedDist = Math.min(dist, maxRadius);
    const angle = Math.atan2(dy, dx);

    const nx = Math.cos(angle) * clampedDist;
    const ny = Math.sin(angle) * clampedDist;

    setStickPos({ x: nx, y: ny });

    const normX = nx / maxRadius;
    const normY = ny / maxRadius;
    const mag = Math.hypot(normX, normY);
    if (mag < 0.08) {
      onMoveInput(0, 0);
    } else {
      onMoveInput(normX, normY);
    }
  };

  const resetJoystick = () => {
    setJoystickActive(false);
    setStickPos({ x: 0, y: 0 });
    touchIdRef.current = null;
    mouseJoyActiveRef.current = false;
    onMoveInput(0, 0);
  };

  const handleJoystickTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    e.stopPropagation();
    onUnlockAudio();
    if (touchIdRef.current !== null || (!alive && !spectating)) return;
    const touch = e.changedTouches[0];
    if (!touch) return;
    touchIdRef.current = touch.identifier;
    setJoystickActive(true);
    updateJoystick(touch.clientX, touch.clientY);
  };

  const handleJoystickTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (touchIdRef.current === null) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier === touchIdRef.current) {
        updateJoystick(touch.clientX, touch.clientY);
        break;
      }
    }
  };

  const handleJoystickTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (touchIdRef.current === null) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === touchIdRef.current) {
        resetJoystick();
        break;
      }
    }
  };

  // Mouse fallback for testing touch UI in desktop browsers / emulators
  const handleJoystickPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    e.stopPropagation();
    onUnlockAudio();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    mouseJoyActiveRef.current = true;
    setJoystickActive(true);
    updateJoystick(e.clientX, e.clientY);
  };

  const handleJoystickPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' || !mouseJoyActiveRef.current) return;
    e.stopPropagation();
    updateJoystick(e.clientX, e.clientY);
  };

  const handleJoystickPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' || !mouseJoyActiveRef.current) return;
    e.stopPropagation();
    resetJoystick();
  };

  const handleLookTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    onUnlockAudio();
    if (lookTouchRef.current) return;
    const touch = e.changedTouches[0];
    if (!touch) return;
    lookTouchRef.current = { id: touch.identifier, x: touch.clientX, y: touch.clientY };
  };

  const handleLookTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!lookTouchRef.current) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier === lookTouchRef.current.id) {
        const dx = touch.clientX - lookTouchRef.current.x;
        const dy = touch.clientY - lookTouchRef.current.y;
        lookTouchRef.current.x = touch.clientX;
        lookTouchRef.current.y = touch.clientY;
        onLookInput(dx, dy);
        break;
      }
    }
  };

  const handleLookTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!lookTouchRef.current) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === lookTouchRef.current.id) {
        lookTouchRef.current = null;
        break;
      }
    }
  };

  // Mouse fallback on look pad for desktop emulator testing
  const handleLookPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    onUnlockAudio();
    mouseLookRef.current = { active: true, x: e.clientX, y: e.clientY };
  };

  const handleLookPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch' || !mouseLookRef.current.active) return;
    const dx = e.clientX - mouseLookRef.current.x;
    const dy = e.clientY - mouseLookRef.current.y;
    mouseLookRef.current.x = e.clientX;
    mouseLookRef.current.y = e.clientY;
    onLookInput(dx, dy);
  };

  const handleLookPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    mouseLookRef.current.active = false;
  };

  const triggerAction = (fn: () => void) => (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    onUnlockAudio();
    fn();
  };

  return (
    <div className="fixed inset-0 z-10 pointer-events-none select-none touch-none">
      {/* Full-viewport look/camera drag zone (behind HUD & thumb controls) */}
      <div
        className="absolute inset-0 pointer-events-auto touch-none"
        onTouchStart={handleLookTouchStart}
        onTouchMove={handleLookTouchMove}
        onTouchEnd={handleLookTouchEnd}
        onTouchCancel={handleLookTouchEnd}
        onPointerDown={handleLookPointerDown}
        onPointerMove={handleLookPointerMove}
        onPointerUp={handleLookPointerUp}
        onPointerCancel={handleLookPointerUp}
      />

      {/* Bottom-Left Virtual Thumbstick */}
      <div
        className="absolute left-4 sm:left-6 z-20 pointer-events-auto flex flex-col items-center gap-1.5 touch-none"
        style={{ bottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        <div
          ref={joystickRef}
          onTouchStart={handleJoystickTouchStart}
          onTouchMove={handleJoystickTouchMove}
          onTouchEnd={handleJoystickTouchEnd}
          onTouchCancel={handleJoystickTouchEnd}
          onPointerDown={handleJoystickPointerDown}
          onPointerMove={handleJoystickPointerMove}
          onPointerUp={handleJoystickPointerUp}
          onPointerCancel={handleJoystickPointerUp}
          aria-label="Movement thumbstick"
          className={`relative w-28 h-28 sm:w-32 sm:h-32 rounded-full border-2 backdrop-blur-xs flex items-center justify-center touch-none transition-colors ${
            joystickActive
              ? 'bg-[#0b1224]/75 border-red-400/60'
              : 'bg-[#060913]/65 border-white/25'
          }`}
        >
          <div className="w-16 h-16 rounded-full border border-white/10 pointer-events-none" />
          <div
            className="absolute w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-red-600/85 border-2 border-white/70 shadow-lg pointer-events-none"
            style={{
              transform: `translate(${stickPos.x}px, ${stickPos.y}px)`,
            }}
          />
        </div>
        <span className="text-[10px] font-medium text-slate-300/80 bg-[#060913]/75 px-2 py-0.5 rounded">
          {spectating ? 'Fly Stick' : 'Move · Edge Sprint'}
        </span>
      </div>

      {/* Bottom-Right Action Controls */}
      <div
        className="absolute right-4 sm:right-6 z-20 pointer-events-auto flex flex-col items-end gap-2 touch-none"
        style={{ bottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        {nearbyReviveTarget && alive && !spectating && (
          <button
            type="button"
            onPointerDown={triggerAction(onReviveTeammate)}
            className="px-4 py-2.5 rounded-xl bg-emerald-600/90 border-2 border-emerald-300 text-white text-xs font-bold flex items-center gap-2 shadow-lg active:scale-95 touch-none cursor-pointer"
          >
            <HeartPulse className="w-4 h-4 shrink-0" />
            <span>Revive {nearbyReviveTarget.displayName}</span>
          </button>
        )}

        {equippedWeapon && alive && !spectating && (
          <button
            type="button"
            onPointerDown={triggerAction(onUseWeapon)}
            className="px-4 py-2.5 rounded-xl bg-sky-500/35 border-2 border-sky-300 text-sky-100 text-xs font-bold flex items-center gap-2 shadow-lg active:scale-95 touch-none cursor-pointer"
          >
            <Crosshair className="w-4 h-4 shrink-0" />
            <span>Use {WEAPON_SPECS[equippedWeapon].label}</span>
          </button>
        )}

        <div className="flex items-center gap-2">
          {isMultiplayer && (
            <button
              type="button"
              onPointerDown={triggerAction(onToggleChat)}
              aria-label="Open team chat"
              className="w-11 h-11 rounded-xl bg-[#060913]/85 border border-white/20 text-sky-300 flex flex-col items-center justify-center shadow-lg active:scale-95 touch-none cursor-pointer"
            >
              <MessageSquare className="w-4 h-4" />
              <span className="text-[9px] font-medium">Chat</span>
            </button>
          )}
          <button
            type="button"
            onPointerDown={triggerAction(onToggleMap)}
            aria-label="Toggle map"
            className="w-11 h-11 rounded-xl bg-[#060913]/85 border border-white/20 text-emerald-300 flex flex-col items-center justify-center shadow-lg active:scale-95 touch-none cursor-pointer"
          >
            <MapIcon className="w-4 h-4" />
            <span className="text-[9px] font-medium">Map</span>
          </button>
          <button
            type="button"
            onPointerDown={triggerAction(onToggleFlashlight)}
            disabled={!alive}
            aria-label="Toggle flashlight"
            className={`w-12 h-11 rounded-xl border text-xs font-medium flex flex-col items-center justify-center shadow-lg active:scale-95 touch-none cursor-pointer disabled:opacity-45 ${
              flashlightOn
                ? 'bg-amber-500/25 border-amber-400/70 text-amber-200'
                : 'bg-[#060913]/85 border-emerald-400/50 text-emerald-300'
            }`}
          >
            <Flashlight className="w-4 h-4" />
            <span className="text-[9px] font-mono-tabular">{Math.round(battery)}%</span>
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onPointerDown={triggerAction(onTriggerChime)}
            disabled={chimeCooldown > 0 || !alive}
            aria-label="Trigger chime path guide"
            className="w-12 h-12 rounded-xl bg-[#060913]/85 border border-white/20 text-amber-300 flex flex-col items-center justify-center shadow-lg active:scale-95 touch-none cursor-pointer disabled:opacity-45"
          >
            <Bell className="w-4 h-4" />
            <span className="text-[9px] font-mono-tabular">
              {chimeCooldown > 0 ? `${Math.ceil(chimeCooldown)}s` : 'Chime'}
            </span>
          </button>

          <button
            type="button"
            onPointerDown={triggerAction(onDodge)}
            disabled={dodgeCooldown > 0 || !alive || spectating}
            aria-label="Quick dodge"
            className="w-12 h-12 rounded-xl bg-[#060913]/85 border border-white/20 text-sky-300 flex flex-col items-center justify-center shadow-lg active:scale-95 touch-none cursor-pointer disabled:opacity-45"
          >
            <Wind className="w-4 h-4" />
            <span className="text-[9px] font-mono-tabular">
              {dodgeCooldown > 0 ? `${dodgeCooldown.toFixed(1)}s` : 'Dodge'}
            </span>
          </button>

          <button
            type="button"
            onPointerDown={triggerAction(() => onToggleSprint(!sprinting))}
            disabled={!alive || spectating}
            aria-label="Toggle sprint"
            className={`w-14 h-12 rounded-xl border text-xs font-semibold flex flex-col items-center justify-center shadow-lg active:scale-95 touch-none cursor-pointer disabled:opacity-45 ${
              sprinting
                ? 'bg-sky-500/35 border-sky-300 text-sky-100'
                : 'bg-[#060913]/85 border-white/20 text-slate-200'
            }`}
          >
            <span>{sprinting ? 'Sprint' : 'Walk'}</span>
            <span className="text-[9px] opacity-75">{sprinting ? 'ON' : 'Tap'}</span>
          </button>

          {!equippedWeapon && (
            <div className="w-14 h-12 rounded-xl bg-[#060913]/85 border border-white/15 text-slate-300 text-[10px] flex flex-col items-center justify-center px-1 text-center leading-tight">
              <Crosshair className="w-3.5 h-3.5 text-sky-400/80 mb-0.5" />
              <span className="font-mono-tabular">
                {nearestWeaponDistance !== null
                  ? `${Math.round(nearestWeaponDistance)}m`
                  : `${Math.ceil(nextWeaponSpawnIn)}s`}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
