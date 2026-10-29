/** All sounds are synthesized with the Web Audio API — no external files. */
export class GameAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private noiseBuf!: AudioBuffer;
  private engOsc!: OscillatorNode;
  private engOsc2!: OscillatorNode;
  private engFilter!: BiquadFilterNode;
  private engGain!: GainNode;
  private boostGain!: GainNode;
  private boostFilter!: BiquadFilterNode;
  private crowdGain!: GainNode;
  muted = false;

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // white noise buffer
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // engine hum
    this.engOsc = ctx.createOscillator();
    this.engOsc.type = 'sawtooth';
    this.engOsc2 = ctx.createOscillator();
    this.engOsc2.type = 'square';
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 400;
    this.engFilter.Q.value = 2;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    const o2g = ctx.createGain();
    o2g.gain.value = 0.35;
    this.engOsc.connect(this.engFilter);
    this.engOsc2.connect(o2g).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(this.master);
    this.engOsc.start();
    this.engOsc2.start();

    // boost whoosh (looping filtered noise)
    const bsrc = ctx.createBufferSource();
    bsrc.buffer = this.noiseBuf;
    bsrc.loop = true;
    this.boostFilter = ctx.createBiquadFilter();
    this.boostFilter.type = 'bandpass';
    this.boostFilter.frequency.value = 900;
    this.boostFilter.Q.value = 0.7;
    this.boostGain = ctx.createGain();
    this.boostGain.gain.value = 0;
    bsrc.connect(this.boostFilter).connect(this.boostGain).connect(this.master);
    bsrc.start();

    // crowd bed
    const csrc = ctx.createBufferSource();
    csrc.buffer = this.noiseBuf;
    csrc.loop = true;
    const cf = ctx.createBiquadFilter();
    cf.type = 'bandpass';
    cf.frequency.value = 600;
    cf.Q.value = 0.4;
    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0.025;
    csrc.connect(cf).connect(this.crowdGain).connect(this.master);
    csrc.start();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.55, this.ctx.currentTime, 0.05);
  }

  setEngine(speed: number, throttle: number, boosting: boolean, supersonic: boolean, active: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1, speed / 35);
    const f = 48 + s * 120 + Math.abs(throttle) * 12;
    this.engOsc.frequency.setTargetAtTime(f, t, 0.08);
    this.engOsc2.frequency.setTargetAtTime(f * 0.5, t, 0.08);
    this.engFilter.frequency.setTargetAtTime(260 + s * 900 + Math.abs(throttle) * 200, t, 0.1);
    this.engGain.gain.setTargetAtTime(active ? 0.05 + s * 0.06 + Math.abs(throttle) * 0.03 : 0, t, 0.1);
    this.boostGain.gain.setTargetAtTime(active && boosting ? 0.32 : 0, t, boosting ? 0.03 : 0.12);
    this.boostFilter.frequency.setTargetAtTime(supersonic ? 1700 : 900 + s * 500, t, 0.1);
  }

  private env(node: AudioNode, gain: number, attack: number, decay: number, when = 0) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    const t = ctx.currentTime + when;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g).connect(this.master);
    return t + attack + decay + 0.05;
  }

  private noise(freq: number, q: number, gain: number, attack: number, decay: number, type: BiquadFilterType = 'lowpass', when = 0) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    src.connect(f);
    const end = this.env(f, gain, attack, decay, when);
    src.start(ctx.currentTime + when, Math.random());
    src.stop(end);
    return f;
  }

  private tone(type: OscillatorType, f0: number, f1: number, gain: number, attack: number, decay: number, when = 0) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    const t = ctx.currentTime + when;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + attack + decay);
    const end = this.env(o, gain, attack, decay, when);
    o.start(t);
    o.stop(end);
  }

  hit(strength: number) {
    if (!this.ctx) return;
    const s = Math.min(1, strength / 40);
    this.tone('sine', 140 + s * 60, 45, 0.35 + s * 0.5, 0.004, 0.18 + s * 0.12);
    this.noise(1500 + s * 2500, 0.8, 0.15 + s * 0.35, 0.002, 0.07 + s * 0.08);
  }

  bump() {
    if (!this.ctx) return;
    this.tone('triangle', 90, 40, 0.4, 0.004, 0.2);
    this.noise(700, 1, 0.25, 0.002, 0.12);
  }

  jump() {
    if (!this.ctx) return;
    this.noise(500, 1.2, 0.08, 0.01, 0.12, 'bandpass');
  }

  pickup(big: boolean) {
    if (!this.ctx) return;
    this.tone('sine', big ? 520 : 760, big ? 1040 : 1100, big ? 0.16 : 0.08, 0.005, big ? 0.25 : 0.1);
  }

  beep(final: boolean) {
    if (!this.ctx) return;
    this.tone('square', final ? 880 : 440, final ? 880 : 440, 0.12, 0.005, final ? 0.6 : 0.25);
  }

  explosion(big = true) {
    if (!this.ctx) return;
    this.noise(big ? 900 : 1500, 0.5, big ? 0.9 : 0.6, 0.005, big ? 1.6 : 0.7);
    this.tone('sine', 110, 30, big ? 0.8 : 0.5, 0.005, big ? 1.2 : 0.5);
  }

  goalHorn() {
    if (!this.ctx) return;
    const notes = [220, 277.2, 329.6];
    for (const n of notes) {
      this.tone('sawtooth', n, n * 0.995, 0.09, 0.05, 1.9);
      this.tone('square', n / 2, n / 2, 0.05, 0.05, 1.9);
    }
    // crowd roar
    this.noise(800, 0.3, 0.45, 0.4, 3.5, 'bandpass');
    this.noise(2200, 0.4, 0.12, 0.3, 3, 'bandpass', 0.1);
  }

  whistle() {
    if (!this.ctx) return;
    this.tone('sine', 2100, 2000, 0.1, 0.01, 0.35);
    this.tone('sine', 2100, 2000, 0.1, 0.01, 0.6, 0.45);
  }
}
