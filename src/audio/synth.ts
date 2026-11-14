/** Простой синтез звука язычкового барабана: основной тон и две гармоники с затуханием. */
const PARTIALS = [
  { ratio: 1, gain: 1, decay: 3.2 },
  { ratio: 2, gain: 0.5, decay: 2.0 },
  { ratio: 3, gain: 0.18, decay: 1.2 },
];

export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  /**
   * Разблокирует звук. Вызывается на любой клик/отпускание пальца: касание (pointerdown)
   * на сенсорных экранах само не считается жестом, разрешающим звук.
   */
  unlock(): void {
    this.ensure();
  }

  private ensure(): AudioContext | null {
    if (!this.ctx) {
      const Ctor = window.AudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      const compressor = this.ctx.createDynamicsCompressor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.45;
      this.master.connect(compressor).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  play(freq: number, velocity = 1): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || !(freq > 0)) return;
    const t0 = ctx.currentTime;
    for (const p of PARTIALS) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq * p.ratio;
      const peak = Math.max(0.0002, 0.5 * p.gain * velocity);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + p.decay);
      osc.connect(gain).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + p.decay + 0.05);
    }
  }
}
