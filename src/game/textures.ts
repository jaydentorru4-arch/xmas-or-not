import * as THREE from 'three';

export interface ProceduralTextures {
  hedgeColor: THREE.CanvasTexture;
  hedgeRoughness: THREE.CanvasTexture;
  snowFloorColor: THREE.CanvasTexture;
  snowFloorRoughness: THREE.CanvasTexture;
  candyCaneColor: THREE.CanvasTexture;
  snowflakeSprite: THREE.CanvasTexture;
  contactShadow: THREE.CanvasTexture;
  dispose: () => void;
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  return [canvas, ctx];
}

export function createProceduralTextures(maxAnisotropy: number): ProceduralTextures {
  // 1. Frostbitten Pine Hedge + Dark Timber Wall Texture
  const [hc, hctx] = makeCanvas(512, 512);
  hctx.fillStyle = '#0c1913';
  hctx.fillRect(0, 0, 512, 512);

  // Deep timber base slats near bottom
  hctx.fillStyle = '#14100d';
  hctx.fillRect(0, 410, 512, 102);
  for (let x = 0; x < 512; x += 64) {
    hctx.fillStyle = x % 128 === 0 ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.03)';
    hctx.fillRect(x, 410, 4, 102);
  }

  // Layered pine needles & dark foliage clusters
  for (let i = 0; i < 4200; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 435;
    const len = 6 + Math.random() * 14;
    const angle = (Math.random() - 0.5) * 1.4;
    const shade = Math.random();
    if (shade < 0.35) hctx.strokeStyle = '#08120d';
    else if (shade < 0.72) hctx.strokeStyle = '#11261b';
    else if (shade < 0.92) hctx.strokeStyle = '#1a3827';
    else hctx.strokeStyle = '#6c8594'; // frost-tipped needles

    hctx.lineWidth = 1.2 + Math.random() * 1.8;
    hctx.beginPath();
    hctx.moveTo(x, y);
    hctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    hctx.stroke();
  }

  // Heavy frost dusting at top edge of hedge
  const topFrost = hctx.createLinearGradient(0, 0, 0, 95);
  topFrost.addColorStop(0, 'rgba(218, 232, 245, 0.85)');
  topFrost.addColorStop(0.45, 'rgba(185, 206, 226, 0.35)');
  topFrost.addColorStop(1, 'rgba(185, 206, 226, 0)');
  hctx.fillStyle = topFrost;
  hctx.fillRect(0, 0, 512, 95);

  // Subtle grime & snow bank along base
  const baseSnow = hctx.createLinearGradient(0, 465, 0, 512);
  baseSnow.addColorStop(0, 'rgba(195, 212, 230, 0)');
  baseSnow.addColorStop(1, 'rgba(205, 220, 235, 0.5)');
  hctx.fillStyle = baseSnow;
  hctx.fillRect(0, 465, 512, 47);

  const hedgeColor = new THREE.CanvasTexture(hc);
  hedgeColor.colorSpace = THREE.SRGBColorSpace;
  hedgeColor.wrapS = THREE.RepeatWrapping;
  hedgeColor.wrapT = THREE.ClampToEdgeWrapping;
  hedgeColor.anisotropy = maxAnisotropy;

  // Hedge roughness map (linear space)
  const [hrc, hrctx] = makeCanvas(256, 256);
  hrctx.fillStyle = '#dcdcdc';
  hrctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1800; i++) {
    const v = Math.floor(150 + Math.random() * 100);
    hrctx.fillStyle = `rgb(${v},${v},${v})`;
    hrctx.fillRect(Math.random() * 256, Math.random() * 256, 4, 4);
  }
  const hedgeRoughness = new THREE.CanvasTexture(hrc);
  hedgeRoughness.wrapS = THREE.RepeatWrapping;
  hedgeRoughness.wrapT = THREE.ClampToEdgeWrapping;

  // 2. Snowy Frozen Cobblestone Floor
  const [fc, fctx] = makeCanvas(512, 512);
  fctx.fillStyle = '#18212d';
  fctx.fillRect(0, 0, 512, 512);

  // Cobble blocks
  const rows = 8;
  const cols = 8;
  const cw = 512 / cols;
  const ch = 512 / rows;
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * (cw * 0.5);
    for (let c = -1; c <= cols; c++) {
      const x = c * cw + offset + 3;
      const y = r * ch + 3;
      const tone = 28 + Math.floor(Math.random() * 22);
      fctx.fillStyle = `rgb(${tone}, ${tone + 6}, ${tone + 15})`;
      fctx.beginPath();
      fctx.roundRect(x, y, cw - 6, ch - 6, 8);
      fctx.fill();
    }
  }

  // Snow patches & icy sheen drifted over cobbles
  for (let i = 0; i < 160; i++) {
    const sx = Math.random() * 512;
    const sy = Math.random() * 512;
    const rad = 14 + Math.random() * 44;
    const grad = fctx.createRadialGradient(sx, sy, 2, sx, sy, rad);
    grad.addColorStop(0, 'rgba(216, 228, 242, 0.42)');
    grad.addColorStop(1, 'rgba(216, 228, 242, 0)');
    fctx.fillStyle = grad;
    fctx.beginPath();
    fctx.arc(sx, sy, rad, 0, Math.PI * 2);
    fctx.fill();
  }

  const snowFloorColor = new THREE.CanvasTexture(fc);
  snowFloorColor.colorSpace = THREE.SRGBColorSpace;
  snowFloorColor.wrapS = THREE.RepeatWrapping;
  snowFloorColor.wrapT = THREE.RepeatWrapping;
  snowFloorColor.repeat.set(17, 17);
  snowFloorColor.anisotropy = maxAnisotropy;

  // Floor roughness (ice patches shinier, snow rougher)
  const [frc, frctx] = makeCanvas(256, 256);
  frctx.fillStyle = '#b8b8b8';
  frctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 90; i++) {
    const v = Math.random() < 0.4 ? 65 : 225;
    frctx.fillStyle = `rgba(${v},${v},${v},0.45)`;
    frctx.beginPath();
    frctx.arc(Math.random() * 256, Math.random() * 256, 10 + Math.random() * 22, 0, Math.PI * 2);
    frctx.fill();
  }
  const snowFloorRoughness = new THREE.CanvasTexture(frc);
  snowFloorRoughness.wrapS = THREE.RepeatWrapping;
  snowFloorRoughness.wrapT = THREE.RepeatWrapping;
  snowFloorRoughness.repeat.set(17, 17);

  // 3. Weathered Candy-Cane Stripe Texture
  const [cc, cctx] = makeCanvas(256, 256);
  cctx.fillStyle = '#c8c0b4';
  cctx.fillRect(0, 0, 256, 256);
  cctx.fillStyle = '#7a1014';
  for (let i = -256; i < 512; i += 64) {
    cctx.beginPath();
    cctx.moveTo(i, 0);
    cctx.lineTo(i + 32, 0);
    cctx.lineTo(i + 288, 256);
    cctx.lineTo(i + 256, 256);
    cctx.closePath();
    cctx.fill();
  }
  // Grime speckles
  for (let i = 0; i < 600; i++) {
    cctx.fillStyle = 'rgba(10, 12, 16, 0.18)';
    cctx.fillRect(Math.random() * 256, Math.random() * 256, 3, 3);
  }
  const candyCaneColor = new THREE.CanvasTexture(cc);
  candyCaneColor.colorSpace = THREE.SRGBColorSpace;
  candyCaneColor.wrapS = THREE.RepeatWrapping;
  candyCaneColor.wrapT = THREE.RepeatWrapping;
  candyCaneColor.anisotropy = maxAnisotropy;

  // 4. Soft Snowflake Sprite
  const [sc, sctx] = makeCanvas(64, 64);
  const sgrad = sctx.createRadialGradient(32, 32, 1, 32, 32, 30);
  sgrad.addColorStop(0, 'rgba(240, 248, 255, 1)');
  sgrad.addColorStop(0.45, 'rgba(220, 235, 255, 0.65)');
  sgrad.addColorStop(1, 'rgba(220, 235, 255, 0)');
  sctx.fillStyle = sgrad;
  sctx.fillRect(0, 0, 64, 64);
  const snowflakeSprite = new THREE.CanvasTexture(sc);
  snowflakeSprite.colorSpace = THREE.SRGBColorSpace;

  // 5. Contact Shadow Plane
  const [shc, shctx] = makeCanvas(128, 128);
  const shgrad = shctx.createRadialGradient(64, 64, 4, 64, 64, 60);
  shgrad.addColorStop(0, 'rgba(0, 0, 0, 0.72)');
  shgrad.addColorStop(0.55, 'rgba(0, 0, 0, 0.35)');
  shgrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  shctx.fillStyle = shgrad;
  shctx.fillRect(0, 0, 128, 128);
  const contactShadow = new THREE.CanvasTexture(shc);

  return {
    hedgeColor,
    hedgeRoughness,
    snowFloorColor,
    snowFloorRoughness,
    candyCaneColor,
    snowflakeSprite,
    contactShadow,
    dispose: () => {
      hedgeColor.dispose();
      hedgeRoughness.dispose();
      snowFloorColor.dispose();
      snowFloorRoughness.dispose();
      candyCaneColor.dispose();
      snowflakeSprite.dispose();
      contactShadow.dispose();
    },
  };
}
