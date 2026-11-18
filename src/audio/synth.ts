import { voicePartials } from '../core/tone';

/**
 * Синтез звука поля по измеренному спектру настоящего инструмента: неравномерные обертоны,
 * долгий сустейн, короткий призвук удара и лёгкая реверберация корпуса.
 */

export interface SynthTongue {
  id: string;
  freq: number;
  partials?: readonly (readonly [number, number])[];
}

const ATTACK_SEC = 0.004;
/** Призвук удара пальцем: короткий шум около 1 кГц (виден в записях настоящих ударов). */
const STRIKE_HZ = 1000;
const STRIKE_SEC = 0.05;
const REVERB_SEC = 1.8;
const REVERB_WET = 0.22;
/** Повторный удар по звучащему полю гасит прежний звук: у поля одно колебание. */
const RESTRIKE_FADE_SEC = 0.03;

interface Voice {
  out: GainNode;
  sources: AudioScheduledSourceNode[];
}

export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private voices = new Map<string, Voice>();

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
      const ctx = new Ctor();
      this.ctx = ctx;
      const compressor = ctx.createDynamicsCompressor();
      compressor.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(compressor);

      const rate = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, Math.ceil(rate * STRIKE_SEC), rate);
      const n = this.noise.getChannelData(0);
      for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;

      // Импульс реверберации — затухающий шум, отдельно для каждого канала.
      const len = Math.ceil(rate * REVERB_SEC);
      const impulse = ctx.createBuffer(2, len, rate);
      for (let ch = 0; ch < 2; ch++) {
        const d = impulse.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
      }
      const reverb = ctx.createConvolver();
      reverb.buffer = impulse;
      const wet = ctx.createGain();
      wet.gain.value = REVERB_WET;
      this.master.connect(reverb).connect(wet).connect(compressor);
    }
    // На iOS после звонка состояние бывает 'interrupted', а не 'suspended'.
    const state: string = this.ctx.state;
    if (state !== 'running' && state !== 'closed') void this.ctx.resume().catch(() => undefined);
    return this.ctx;
  }

  play(tongue: SynthTongue, velocity = 1): void {
    const ctx = this.ensure();
    if (!ctx || !this.master || !(tongue.freq > 0)) return;
    const t0 = ctx.currentTime;

    const prev = this.voices.get(tongue.id);
    if (prev) {
      prev.out.gain.setTargetAtTime(0, t0, RESTRIKE_FADE_SEC);
      for (const s of prev.sources) {
        try {
          s.stop(t0 + RESTRIKE_FADE_SEC * 8);
        } catch {
          // источник уже остановлен
        }
      }
    }

    const out = ctx.createGain();
    out.connect(this.master);
    const voice: Voice = { out, sources: [] };
    this.voices.set(tongue.id, voice);

    let longest: OscillatorNode | null = null;
    let longestDecay = 0;
    for (const p of voicePartials(tongue.freq, tongue.partials)) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = tongue.freq * p.ratio;
      const peak = Math.max(0.0002, 0.5 * p.gain * velocity);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + ATTACK_SEC);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + p.decay);
      osc.connect(gain).connect(out);
      osc.start(t0);
      osc.stop(t0 + p.decay + 0.05);
      voice.sources.push(osc);
      if (p.decay > longestDecay) {
        longestDecay = p.decay;
        longest = osc;
      }
    }

    if (this.noise) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = STRIKE_HZ;
      band.Q.value = 1.2;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.12 * velocity, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + STRIKE_SEC);
      src.connect(band).connect(gain).connect(out);
      src.start(t0);
      voice.sources.push(src);
    }

    if (longest) {
      longest.onended = () => {
        out.disconnect();
        if (this.voices.get(tongue.id) === voice) this.voices.delete(tongue.id);
      };
    }
  }
}
