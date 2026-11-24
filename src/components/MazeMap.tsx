import React, { useEffect, useRef } from 'react';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { MazeMapState } from '../game/types';

interface MazeMapProps {
  mapState: MazeMapState | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  level: number;
}

function drawMazeToCanvas(
  canvas: HTMLCanvasElement,
  mapState: MazeMapState,
  pxSize: number,
  detailed: boolean
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== pxSize * dpr || canvas.height !== pxSize * dpr) {
    canvas.width = pxSize * dpr;
    canvas.height = pxSize * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const n = mapState.size;
  const cellPx = pxSize / n;

  // Floor background
  ctx.fillStyle = '#060a14';
  ctx.fillRect(0, 0, pxSize, pxSize);

  // Hedge walls
  ctx.fillStyle = '#1b283f';
  for (let r = 0; r < n; r++) {
    const row = mapState.grid[r];
    for (let c = 0; c < n; c++) {
      if (row[c] === 1) {
        ctx.fillRect(c * cellPx, r * cellPx, Math.ceil(cellPx), Math.ceil(cellPx));
      }
    }
  }

  // Exit Gate
  const ex = mapState.exitNormX * pxSize;
  const ey = mapState.exitNormZ * pxSize;
  const exitColor = mapState.exitUnlocked ? '#10b981' : '#f43f5e';
  ctx.fillStyle = exitColor;
  const exitBox = Math.max(6, cellPx * 1.15);
  ctx.fillRect(ex - exitBox / 2, ey - exitBox / 2, exitBox, exitBox);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(ex - exitBox / 2, ey - exitBox / 2, exitBox, exitBox);

  // Uncollected Ornaments (Gold)
  ctx.fillStyle = '#fbbf24';
  const ornR = Math.max(2.2, cellPx * 0.34);
  for (const o of mapState.ornaments) {
    ctx.beginPath();
    ctx.arc(o.normX * pxSize, o.normZ * pxSize, ornR, 0, Math.PI * 2);
    ctx.fill();
  }

  // Batteries (Emerald)
  ctx.fillStyle = '#34d399';
  const batS = Math.max(3.4, cellPx * 0.48);
  for (const b of mapState.batteries) {
    ctx.fillRect(b.normX * pxSize - batS / 2, b.normZ * pxSize - batS / 2, batS, batS);
  }

  // Weapons (Sky Blue Diamonds)
  ctx.fillStyle = '#38bdf8';
  const wepR = Math.max(3, cellPx * 0.42);
  for (const w of mapState.weapons) {
    const wx = w.normX * pxSize;
    const wy = w.normZ * pxSize;
    ctx.beginPath();
    ctx.moveTo(wx, wy - wepR);
    ctx.lineTo(wx + wepR, wy);
    ctx.lineTo(wx, wy + wepR);
    ctx.lineTo(wx - wepR, wy);
    ctx.closePath();
    ctx.fill();
  }

  // Other Players
  for (const p of mapState.otherPlayers) {
    if (!p.alive && !p.escaped) continue;
    const px = p.normX * pxSize;
    const py = p.normZ * pxSize;
    const pR = Math.max(3.5, cellPx * 0.46);
    ctx.fillStyle = p.coatColor;
    ctx.beginPath();
    ctx.arc(px, py, pR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.3;
    ctx.stroke();

    if (detailed) {
      ctx.font = '600 10px sans-serif';
      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'center';
      ctx.fillText(p.displayName.slice(0, 10), px, py - pR - 4);
    }
  }

  // Evil Santa Marker
  const sx = mapState.santaNormX * pxSize;
  const sy = mapState.santaNormZ * pxSize;
  const sR = Math.max(4.5, cellPx * 0.62);
  ctx.fillStyle = mapState.santaStunRemaining > 0 ? '#38bdf8' : '#ef4444';
  ctx.beginPath();
  ctx.arc(sx, sy, sR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#fef2f2';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (detailed) {
    ctx.font = '700 10px sans-serif';
    ctx.fillStyle = mapState.santaStunRemaining > 0 ? '#7dd3fc' : '#fca5a5';
    ctx.textAlign = 'center';
    ctx.fillText(mapState.santaStunRemaining > 0 ? 'STUN' : 'SANTA', sx, sy - sR - 4);

    ctx.fillStyle = mapState.exitUnlocked ? '#6ee7b7' : '#fda4af';
    ctx.fillText('EXIT', ex - 10, ey - exitBox / 2 - 4);
  }

  // Local Player Directional Arrow
  const lx = mapState.playerNormX * pxSize;
  const ly = mapState.playerNormZ * pxSize;
  const arrowR = Math.max(5.2, cellPx * 0.66);
  ctx.save();
  ctx.translate(lx, ly);
  ctx.rotate(-mapState.playerYaw);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#060913';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, -arrowR);
  ctx.lineTo(arrowR * 0.72, arrowR * 0.78);
  ctx.lineTo(0, arrowR * 0.36);
  ctx.lineTo(-arrowR * 0.72, arrowR * 0.78);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export const MazeMap: React.FC<MazeMapProps> = ({
  mapState,
  expanded,
  onToggleExpanded,
  level,
}) => {
  const miniRef = useRef<HTMLCanvasElement | null>(null);
  const fullRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!mapState) return;
    if (miniRef.current) {
      drawMazeToCanvas(miniRef.current, mapState, 148, false);
    }
    if (expanded && fullRef.current) {
      drawMazeToCanvas(fullRef.current, mapState, 380, true);
    }
  }, [mapState, expanded]);

  if (!mapState) return null;

  return (
    <>
      {/* Corner Minimap */}
      <div className="pointer-events-auto fixed top-16 right-5 flex flex-col bg-[#060913]/92 border border-white/15 rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={onToggleExpanded}
          title="Expand Tactical Map (Tab)"
          className="flex items-center justify-between px-2.5 py-1 text-[11px] font-medium text-slate-200 border-b border-white/10 hover:bg-white/5 transition-colors cursor-pointer"
        >
          <span>Map · Lv {level}</span>
          {expanded ? <Minimize2 className="w-3 h-3 text-slate-400" /> : <Maximize2 className="w-3 h-3 text-slate-400" />}
        </button>
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-label="Open full maze map"
          className="block p-1.5 cursor-pointer"
        >
          <canvas ref={miniRef} className="w-[148px] h-[148px] rounded-sm block" />
        </button>
        <div className="px-2 pb-1.5 flex items-center justify-between text-[10px] text-slate-400">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
            Santa
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-xs bg-emerald-400" />
            Exit
          </span>
          <span className="text-slate-500">Tab</span>
        </div>
      </div>

      {/* Expanded Tactical Maze Map */}
      {expanded && (
        <div className="pointer-events-auto fixed inset-0 z-20 flex items-center justify-center bg-[#040710]/80 px-4">
          <div className="bg-[#080d1a] border border-white/20 rounded-xl p-5 flex flex-col gap-3 max-w-[440px] w-full">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  North Pole Maze Map · Level {level} ({mapState.size}×{mapState.size})
                </h3>
                <p className="text-xs text-slate-400">
                  Live positions for you, teammates, Santa, Exit, ornaments, batteries, and weapons.
                </p>
              </div>
              <button
                type="button"
                onClick={onToggleExpanded}
                aria-label="Close map"
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-slate-900 border border-white/15 text-slate-300 hover:text-white cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex justify-center bg-[#050811] border border-white/10 rounded-lg p-2">
              <canvas ref={fullRef} className="w-[380px] h-[380px] max-w-full aspect-square rounded" />
            </div>

            <div className="grid grid-cols-3 gap-2 text-[11px] text-slate-300 pt-1">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-white inline-block shrink-0" />
                <span>You</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block shrink-0" />
                <span>Evil Santa</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-emerald-500 inline-block shrink-0" />
                <span>Exit Gate</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block shrink-0" />
                <span>Ornaments</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-xs bg-emerald-300 inline-block shrink-0" />
                <span>Batteries</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rotate-45 bg-sky-400 inline-block shrink-0" />
                <span>Weapons</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
