import React, { useRef, useState } from 'react';
import {
  Bell,
  Crosshair,
  Flashlight,
  Map as MapIcon,
  Wind,
} from 'lucide-react';
import { WeaponType, WEAPON_SPECS } from '../game/types';

interface MobileControlsProps {
  alive: boolean;
  spectating: boolean;
  flashlightOn: boolean;
  battery: number;
  chimeCooldown: number;
  dodgeCooldown: number;
  equippedWeapon: WeaponType | null;
  nearestWeaponDistance: number | null;
  nextWeaponSpawnIn: number;
  onToggleFlashlight: () => void;
  onTriggerChime: () => void;
  onUseWeapon: () => void;
  onDodge: () => void;
  onToggleMap: () => void;
  onMoveInput: (x: number, z: number) => void;
  onLookInput: (dx: number, dy: number) => void;
  sprinting: boolean;
  onToggleSprint: (sprinting: boolean) => void;
}

export const MobileControls: React.FC<MobileControlsProps> = ({
  alive,
  spectating,
  flashlightOn,
  battery,
  chimeCooldown,
  dodgeCooldown,
  equippedWeapon,
  nearestWeaponDistance,
  nextWeaponSpawnIn,
  onToggleFlashlight,
  onTriggerChime,
  onUseWeapon,
  onDodge,
  onToggleMap,
  onMoveInput,
  onLookInput,
  sprinting,
  onToggleSprint,
}) => {
  const joystickRef = useRef<HTMLDivElement | null>(null);
  const [joystickActive, setJoystickActive] = useState(false);
  const [stickPos, setStickPos] = useState({ x: 0, y: 0 });
  const touchIdRef = useRef<number | null>(null);

  const lookTouchRef = useRef<{ id: number; x: number; y: number } | null>(null);

  const handleJoystickStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (joystickActive || !alive) return;
    const touch = e.changedTouches[0];
    touchIdRef.current = touch.identifier;
    setJoystickActive(true);
    updateJoystick(touch.clientX, touch.clientY);
  };

  const handleJoystickMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!joystickActive) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier === touchIdRef.current) {
        updateJoystick(touch.clientX, touch.clientY);
        break;
      }
    }
  };

  const handleJoystickEnd = (e: React.TouchEvent<HTMLEvent> | React.TouchEvent<HTMLDivElement>) => {
    for (let i = 0; i < (e as React.TouchEvent).changedTouches.length; i++) {
      const touch = (e as React.TouchEvent).changedTouches[i];
      if (touch.identifier === touchIdRef.current) {
        setJoystickActive(false);
        setStickPos({ x: 0, y: 0 });
        touchIdRef.current = null;
        onMoveInput(0, 0);
        break;
      }
    }
  };

  const updateJoystick = (clientX: number, clientY: number) => {
    if (!joystickRef.current) return;
    const rect = joystickRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const maxRadius = rect.width / 2;

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
    // Map to Z forward/backward and X left/right
    onMoveInput(normX, normY);
  };

  const handleLookTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (lookTouchRef.current || !alive) return;
    const touch = e.changedTouches[0];
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
      const touch = e.changedTouches[i];
      if (touch.identifier === lookTouchRef.current.id) {
        lookTouchRef.current = null;
        break;
      }
    }
  };

  if (!alive && spectating) return null;

  return (
    <div className="fixed inset-0 z-15 pointer-events-none select-none">
      {/* Right-side look/camera drag capture zone */}
      <div
        className="absolute top-0 right-0 w-1/2 h-3/4 pointer-events-auto"
        onTouchStart={handleLookTouchStart}
        onTouchMove={handleLookTouchMove}
        onTouchEnd={handleLookTouchEnd}
      />

      {/* Bottom-Left Virtual Joystick Pad */}
      <div className="absolute bottom-6 left-6 pointer-events-auto flex items-center justify-center">
        <div
          ref={joystickRef}
          onTouchStart={handleJoystickStart}
          onTouchMove={handleJoystickMove}
          onTouchEnd={handleJoystickEnd}
          className="relative w-32 h-32 rounded-full bg-[#060913]/65 border-2 border-white/20 backdrop-blur-xs flex items-center justify-center touch-none"
        >
          <div
            className="absolute w-14 h-14 rounded-full bg-red-600/80 border-2 border-white/55 shadow-lg pointer-events-none transition-transform duration-75"
            style={{
              transform: `translate(${stickPos.x}px, ${stickPos.y}px)`,
            }}
          />
        </div>
      </div>

      {/* Bottom-Right Action Buttons */}
      <div className="absolute bottom-6 right-6 pointer-events-auto flex items-end gap-2.5">
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggleMap}
              className="w-12 h-12 rounded-xl bg-[#060913]/85 border border-white/20 text-slate-200 flex items-center justify-center shadow-lg active:scale-95 cursor-pointer"
              title="Toggle Map"
            >
              <MapIcon className="w-5 h-5 text-emerald-400" />
            </button>
            <button
              type="button"
              onClick={onToggleFlashlight}
              disabled={!alive}
              className={`w-12 h-12 rounded-xl border text-xs font-medium flex flex-col items-center justify-center shadow-lg active:scale-95 cursor-pointer ${
                flashlightOn
                  ? 'bg-amber-500/25 border-amber-400/60 text-amber-200'
                  : 'bg-[#060913]/85 border-emerald-400/40 text-emerald-300'
              }`}
              title="Toggle Flashlight"
            >
              <Flashlight className="w-4 h-4" />
              <span className="text-[10px] font-mono-tabular">{Math.round(battery)}%</span>
            </button>
            <button
              type="button"
              onClick={onTriggerChime}
              disabled={chimeCooldown > 0}
              className="w-12 h-12 rounded-xl bg-[#060913]/85 border border-white/20 text-amber-300 flex flex-col items-center justify-center shadow-lg active:scale-95 cursor-pointer disabled:opacity-50"
              title="Chime Sensor"
            >
              <Bell className="w-4 h-4" />
              <span className="text-[9px] font-mono-tabular">
                {chimeCooldown > 0 ? `${Math.ceil(chimeCooldown)}s` : 'Chime'}
              </span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onDodge}
              disabled={dodgeCooldown > 0}
              className="w-12 h-12 rounded-xl bg-[#060913]/85 border border-white/20 text-sky-300 flex flex-col items-center justify-center shadow-lg active:scale-95 cursor-pointer disabled:opacity-50"
              title="Dodge"
            >
              <Wind className="w-4 h-4" />
              <span className="text-[9px] font-mono-tabular">
                {dodgeCooldown > 0 ? `${dodgeCooldown.toFixed(1)}s` : 'Dodge'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => onToggleSprint(!sprinting)}
              className={`w-14 h-12 rounded-xl border text-xs font-semibold flex items-center justify-center shadow-lg active:scale-95 cursor-pointer ${
                sprinting
                  ? 'bg-sky-500/30 border-sky-400 text-sky-200'
                  : 'bg-[#060913]/85 border-white/20 text-slate-200'
              }`}
            >
              {sprinting ? 'Sprint' : 'Walk'}
            </button>

            {equippedWeapon ? (
              <button
                type="button"
                onClick={onUseWeapon}
                className="w-16 h-12 rounded-xl bg-sky-500/30 border border-sky-400 text-sky-200 text-xs font-bold flex flex-col items-center justify-center shadow-lg active:scale-95 cursor-pointer"
                title="Use Weapon"
              >
                <Crosshair className="w-4 h-4" />
                <span className="text-[9px] truncate">Use</span>
              </button>
            ) : (
              <div className="w-16 h-12 rounded-xl bg-[#060913]/85 border border-white/15 text-slate-400 text-[10px] flex flex-col items-center justify-center px-1 text-center">
                <span>{nearestWeaponDistance !== null ? `${Math.round(nearestWeaponDistance)}m` : `Drop ${Math.ceil(nextWeaponSpawnIn)}s`}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
