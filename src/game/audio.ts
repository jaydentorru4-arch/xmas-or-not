export class HorrorAudio {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  private initialized = false;

  private lastHeartbeatTime = 0;
  private lastSantaStepTime = 0;
  private lastPlayerStepTime = 0;
  private lastGrowlTime = 0;

  public init(): void {
    if (this.initialized) {
      if (this.ctx && this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return;
    }

    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.muted ? 0 : 0.72;
      this.masterGain.connect(this.ctx.destination);

      // Shared white/pink noise buffer (3 seconds)
      const len = this.ctx.sampleRate * 3;
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99765 * b0 + white * 0.099046;
        b1 = 0.963 * b1 + white * 0.2965164;
        b2 = 0.57 * b2 + white * 1.0526913;
        data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.15;
      }

      // Looping eerie freezing wind
      const windSource = this.ctx.createBufferSource();
      windSource.buffer = this.noiseBuffer;
      windSource.loop = true;

      this.windFilter = this.ctx.createBiquadFilter();
      this.windFilter.type = 'bandpass';
      this.windFilter.frequency.value = 340;
      this.windFilter.Q.value = 2.6;

      this.windGain = this.ctx.createGain();
      this.windGain.gain.value = 0.14;

      // Slow LFO modulating wind pitch
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 0.12;
      const lfoGain = this.ctx.createGain();
      lfoGain.gain.value = 180;
      lfo.connect(lfoGain);
      lfoGain.connect(this.windFilter.frequency);
      lfo.start();

      windSource.connect(this.windFilter);
      this.windFilter.connect(this.windGain);
      this.windGain.connect(this.masterGain);
      windSource.start();

      this.initialized = true;
    } catch {
      // AudioContext blocked or unavailable
    }
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.72, this.ctx.currentTime, 0.05);
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public updateAmbience(
    nowSec: number,
    santaDist: number,
    santaAlerted: boolean,
    playerMoving: boolean,
    sprinting: boolean,
    santaStunned = false
  ): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    if (this.ctx.state === 'suspended') return;

    // 1. Player snow footsteps
    if (playerMoving) {
      const interval = sprinting ? 0.3 : 0.46;
      if (nowSec - this.lastPlayerStepTime >= interval) {
        this.lastPlayerStepTime = nowSec;
        this.playSnowStep(sprinting ? 0.12 : 0.07);
      }
    }

    if (santaStunned) return;

    // 2. Heartbeat scaling with Santa proximity (< 20m)
    if (santaDist < 20) {
      const closeness = Math.max(0, 1 - santaDist / 20);
      const bpm = 64 + closeness * 96;
      const beatInterval = 60 / bpm;
      if (nowSec - this.lastHeartbeatTime >= beatInterval) {
        this.lastHeartbeatTime = nowSec;
        this.playHeartbeat(0.08 + closeness * 0.34);
      }
    }

    // 3. Santa heavy stomps + rusted sleigh bells (< 26m)
    if (santaDist < 26) {
      const closeness = Math.max(0, 1 - santaDist / 26);
      const stepInterval = santaAlerted ? 0.42 : 0.68;
      if (nowSec - this.lastSantaStepTime >= stepInterval) {
        this.lastSantaStepTime = nowSec;
        this.playSantaStompAndBells(closeness);
      }
    }

    // 4. Creepy deep Santa growl occasionally when alerted & fairly close
    if (santaAlerted && santaDist < 16 && nowSec - this.lastGrowlTime > 7.5) {
      this.lastGrowlTime = nowSec;
      this.playEvilHoHo(Math.max(0.15, 1 - santaDist / 18));
    }
  }

  private playSnowStep(volume: number): void {
    if (!this.ctx || !this.masterGain || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = 1.1 + Math.random() * 0.3;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 1200;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.exponentialRampToValueAtTime(volume, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.masterGain);
    src.start(t, Math.random() * 1.5, 0.15);
  }

  private playHeartbeat(volume: number): void {
    if (!this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime;
    [0, 0.16].forEach((offset, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(idx === 0 ? 58 : 48, t + offset);
      osc.frequency.exponentialRampToValueAtTime(26, t + offset + 0.14);

      gain.gain.setValueAtTime(0.001, t + offset);
      gain.gain.exponentialRampToValueAtTime(volume * (idx === 0 ? 1 : 0.72), t + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.16);

      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t + offset);
      osc.stop(t + offset + 0.18);
    });
  }

  private playSantaStompAndBells(closeness: number): void {
    if (!this.ctx || !this.masterGain) return;
    const t = this.ctx.currentTime;
    const vol = closeness * closeness * 0.52;

    // Heavy boot thud
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(75, t);
    osc.frequency.exponentialRampToValueAtTime(24, t + 0.22);
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.01, vol), t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.25);

    // Rusted metallic sleigh-bell jingles
    const bellFreqs = [2110, 2670, 3380, 4190];
    bellFreqs.forEach((f, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const bOsc = this.ctx.createOscillator();
      const bGain = this.ctx.createGain();
      bOsc.type = 'sine';
      bOsc.frequency.value = f + (Math.random() - 0.5) * 90;
      const delay = idx * 0.014;
      bGain.gain.setValueAtTime(0.001, t + delay);
      bGain.gain.exponentialRampToValueAtTime(Math.max(0.005, closeness * 0.06), t + delay + 0.01);
      bGain.gain.exponentialRampToValueAtTime(0.0005, t + delay + 0.18);
      bOsc.connect(bGain);
      bGain.connect(this.masterGain);
      bOsc.start(t + delay);
      bOsc.stop(t + delay + 0.2);
    });
  }

  public playEvilHoHo(intensity = 0.7): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const t = this.ctx.currentTime;
    // Three descending menacing guttural syllables
    [0, 0.36, 0.74].forEach((offset, i) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();

      osc.type = 'sawtooth';
      const base = 92 - i * 11;
      osc.frequency.setValueAtTime(base, t + offset);
      osc.frequency.exponentialRampToValueAtTime(base * 0.72, t + offset + 0.28);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(420, t + offset);
      filter.frequency.exponentialRampToValueAtTime(160, t + offset + 0.28);

      gain.gain.setValueAtTime(0.001, t + offset);
      gain.gain.exponentialRampToValueAtTime(0.16 * intensity, t + offset + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, t + offset + 0.3);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t + offset);
      osc.stop(t + offset + 0.32);
    });
  }

  public playOrnamentPickup(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const t = this.ctx.currentTime;
    // Eerie minor-key Carol of the Bells 4-note music box motif (E5, D#5, E5, C5)
    const notes = [659.25, 622.25, 659.25, 523.25];
    notes.forEach((freq, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t + idx * 0.11;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.55);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(start);
      osc.stop(start + 0.58);
    });
  }

  public playChimePulse(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const t = this.ctx.currentTime;
    [1046.5, 1567.98].forEach((freq, i) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, t + i * 0.04);
      gain.gain.exponentialRampToValueAtTime(0.14, t + i * 0.04 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.04 + 0.85);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t + i * 0.04);
      osc.stop(t + i * 0.04 + 0.9);
    });
  }

  public playFlashlightClick(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1400, t);
    osc.frequency.exponentialRampToValueAtTime(320, t + 0.03);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.04);
  }

  public playExitUnlocked(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const t = this.ctx.currentTime;
    [220, 261.63, 329.63, 440].forEach((freq, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      gain.gain.setValueAtTime(0.001, t + idx * 0.08);
      gain.gain.exponentialRampToValueAtTime(0.14, t + idx * 0.08 + 0.06);
      gain.gain.exponentialRampToValueAtTime(0.001, t + idx * 0.08 + 1.1);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t + idx * 0.08);
      osc.stop(t + idx * 0.08 + 1.15);
    });
  }

  public playJumpscare(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const t = this.ctx.currentTime;
    // Dissonant horror cluster + heavy sub drop
    [110, 116.54, 233.08, 466.16, 659.25].forEach((freq) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.85, t + 0.75);
      gain.gain.setValueAtTime(0.24, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.85);
    });
  }

  public playVictory(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const t = this.ctx.currentTime;
    [392, 493.88, 587.33, 783.99].forEach((freq, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const start = t + idx * 0.12;
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.exponentialRampToValueAtTime(0.2, start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.9);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(start);
      osc.stop(start + 0.95);
    });
  }

  public playWeaponPickup(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const t = this.ctx.currentTime;
    [523.25, 783.99].forEach((freq, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const s = t + idx * 0.06;
      gain.gain.setValueAtTime(0.001, s);
      gain.gain.exponentialRampToValueAtTime(0.18, s + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, s + 0.22);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(s);
      osc.stop(s + 0.25);
    });
  }

  public playWeaponFire(kind: 'tranq_dart' | 'cryo_blaster' | 'candy_bat'): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    if (kind === 'tranq_dart') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(920, t);
      osc.frequency.exponentialRampToValueAtTime(220, t + 0.14);
      gain.gain.setValueAtTime(0.22, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    } else if (kind === 'cryo_blaster') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(280, t);
      osc.frequency.exponentialRampToValueAtTime(55, t + 0.28);
      gain.gain.setValueAtTime(0.26, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    } else {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(340, t);
      osc.frequency.exponentialRampToValueAtTime(90, t + 0.15);
      gain.gain.setValueAtTime(0.24, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    }

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.32);
  }

  public playSantaStunned(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const t = this.ctx.currentTime;
    // Heavy knockout thud + descending Santa groan
    [130, 96, 62].forEach((freq, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sawtooth';
      const s = t + idx * 0.08;
      osc.frequency.setValueAtTime(freq, s);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.42, s + 0.45);
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 380;
      gain.gain.setValueAtTime(0.24, s);
      gain.gain.exponentialRampToValueAtTime(0.001, s + 0.5);
      osc.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      osc.start(s);
      osc.stop(s + 0.55);
    });
  }

  public playDodgeStep(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    this.playSnowStep(0.18);
  }

  public dispose(): void {
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
    this.initialized = false;
  }
}
