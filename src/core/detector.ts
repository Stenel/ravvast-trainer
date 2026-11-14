import { renderTone } from './tone';

/** Окно анализа спектра (сэмплов), ~170 мс: нужно, чтобы различать соседние низкие поля (B2 и C3). */
export const WINDOW = 8192;
/** Шаг поиска ударов (сэмплов), ~5 мс. */
export const HOP = 256;
export const BANDS = 96;
/** Спектр считается с дополнением нулями: точнее положение пиков на низких частотах. */
const FFT_SIZE = 16384;
const F_MIN = 70;
const F_MAX = 1700;
const LOG_STEP = Math.log(F_MAX / F_MIN) / BANDS;

/** Минимальное сходство с шаблоном, чтобы удар считался узнанным. */
export const MIN_SIMILARITY = 0.55;
const PAIR_MIN_SIMILARITY = 0.7;
const PAIR_MARGIN = 0.08;
const PAIR_MEMBER_MIN = 0.48;
const DOMINANT_MIN_SIMILARITY = 0.35;
const DOMINANT_RATIO = 2.5;
/** Доля новой энергии в спектре, ниже которой «удар» считается ложным (биения, шум). */
const MIN_NOVELTY = 0.08;
/** Доля спектрального прироста относительно уже звучащего, с которой срабатывает поиск удара. */
const FLUX_GAIN = 0.12;

const ENERGY_HOPS = 4; // окно огибающей = 4 шага ≈ 21 мс
const HISTORY_HOPS = 16; // сравнение с максимумом за ~85 мс
const REFRACTORY_HOPS = 20;
// Второй путь поиска ударов — рост спектра: ловит новую ноту на фоне уже звучащих.
const FLUX_WINDOW = 2048;
const FLUX_LAG = 8; // сравниваем с кадрами 43–128 мс назад
const FLUX_SPAN = 24;
const FLUX_F_MAX = 3000;
const FLUX_FLOOR = 0.17;
/** На сколько сэмплов спектральный путь запаздывает относительно реального удара. */
const FLUX_BIAS = 512;
const FLUX_HANN = Float64Array.from({ length: FLUX_WINDOW }, (_, i) =>
  0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FLUX_WINDOW - 1)),
);
// Порог тишины низкий: микрофоны телефонов почти не слышат основной тон низких полей
// (E2 = 82 Гц), до распознавателя доходят только слабые обертоны.
const ENERGY_FLOOR = 0.0008 ** 2;
const BUFFER = 1 << 17;
const MASK = BUFFER - 1;

const HANN = Float64Array.from({ length: WINDOW }, (_, i) =>
  0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1)),
);

/** Быстрое преобразование Фурье на месте; длина — степень двойки. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Мощность сигнала в логарифмических полосах 70–1700 Гц для окна из WINDOW сэмплов. */
export function bandPowers(read: (i: number) => number, sampleRate: number): Float64Array {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  for (let i = 0; i < WINDOW; i++) re[i] = read(i) * HANN[i];
  fft(re, im);
  const out = new Float64Array(BANDS);
  const df = sampleRate / FFT_SIZE;
  for (let k = Math.ceil(F_MIN / df); k < FFT_SIZE / 2; k++) {
    const f = k * df;
    if (f >= F_MAX) break;
    out[Math.floor(Math.log(f / F_MIN) / LOG_STEP)] += re[k] * re[k] + im[k] * im[k];
  }
  return out;
}

function unit(v: Float64Array): Float64Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/** «Отпечаток» удара: новая энергия (после минус до), сжатая корнем, сглаженная и нормированная. */
export function toFeature(post: Float64Array, pre?: Float64Array): Float64Array {
  const d = new Float64Array(BANDS);
  for (let i = 0; i < BANDS; i++) d[i] = Math.sqrt(Math.max(0, post[i] - (pre ? pre[i] : 0)));
  const out = new Float64Array(BANDS);
  for (let i = 0; i < BANDS; i++) {
    out[i] = 0.5 * d[i] + 0.25 * (d[i - 1] ?? 0) + 0.25 * (d[i + 1] ?? 0);
  }
  return unit(out);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

export function averageTemplates(features: ArrayLike<number>[]): Float64Array {
  const out = new Float64Array(BANDS);
  for (const f of features) for (let i = 0; i < BANDS; i++) out[i] += f[i] ?? 0;
  return unit(out);
}

/** Шаблоны по номинальным частотам строя — работают без калибровки, но грубее. */
export function defaultTemplates(
  tongues: readonly { id: string; freq: number }[],
  sampleRate: number,
): Record<string, Float64Array> {
  const out: Record<string, Float64Array> = Object.create(null);
  for (const t of tongues) {
    const tone = renderTone(t.freq, WINDOW, sampleRate);
    out[t.id] = toFeature(bandPowers((i) => tone[i], sampleRate));
  }
  return out;
}

export type DetectorEvent =
  | {
      type: 'hit';
      id: number;
      /** Номер сэмпла, на котором начался удар. */
      frame: number;
      /** Узнанные поля (пусто — звук не похож ни на одно поле). */
      tongues: string[];
      /** Сходство с эталоном, 0..1. */
      clarity: number;
      levelDb: number;
      feature: Float64Array;
      /** Доля новой энергии в звуке, 0..1: мало — удар по ещё громко звучащему полю. */
      novelty: number;
      /** Три самых похожих поля — для диагностики. */
      scores: { id: string; similarity: number }[];
    }
  | { type: 'sustain'; id: number; ratio: number };

export interface DetectorOptions {
  sampleRate: number;
  templates: Record<string, ArrayLike<number>>;
  /** Во сколько раз энергия должна превысить недавний максимум. Меньше — чувствительнее. */
  ratio?: number;
}

interface Pending {
  id: number;
  frame: number;
  classified: boolean;
  wantSustain: boolean;
}

/** Потоковый распознаватель ударов: принимает сэмплы, возвращает события. */
export class HitDetector {
  private readonly sr: number;
  private readonly ratio: number;
  private readonly ids: string[];
  private readonly templates: ArrayLike<number>[];
  private readonly pairs: { a: number; b: number; t: Float64Array }[] = [];
  private readonly buf = new Float32Array(BUFFER);
  private written = 0;
  private hopStart = 0;
  private prevSample = 0;
  private readonly hopE: number[] = [];
  private readonly hopD: number[] = [];
  private readonly histE: number[] = [];
  private readonly histD: number[] = [];
  private readonly fluxRe = new Float64Array(FLUX_WINDOW);
  private readonly fluxIm = new Float64Array(FLUX_WINDOW);
  private readonly fluxHist: Float32Array[] = [];
  private refractory = 0;
  private pending: Pending[] = [];
  private nextId = 1;

  constructor(opts: DetectorOptions) {
    this.sr = opts.sampleRate;
    this.ratio = opts.ratio ?? 1.7;
    this.ids = Object.keys(opts.templates);
    this.templates = this.ids.map((id) => opts.templates[id]);
    for (let a = 0; a < this.ids.length; a++) {
      for (let b = a + 1; b < this.ids.length; b++) {
        this.pairs.push({ a, b, t: averageTemplates([this.templates[a], this.templates[b]]) });
      }
    }
  }

  push(samples: ArrayLike<number>): DetectorEvent[] {
    const events: DetectorEvent[] = [];
    for (let i = 0; i < samples.length; i++) {
      this.buf[this.written & MASK] = samples[i];
      this.written++;
      if (this.written - this.hopStart === HOP) {
        this.processHop();
        this.hopStart = this.written;
      }
    }
    this.flush(events);
    return events;
  }

  private at(frame: number): number {
    return frame < 0 || frame >= this.written ? 0 : this.buf[frame & MASK];
  }

  private processHop(): void {
    let e = 0;
    let d = 0;
    for (let f = this.hopStart; f < this.written; f++) {
      const x = this.buf[f & MASK];
      e += x * x;
      d += (x - this.prevSample) ** 2;
      this.prevSample = x;
    }
    this.hopE.push(e);
    this.hopD.push(d);
    if (this.hopE.length > ENERGY_HOPS) {
      this.hopE.shift();
      this.hopD.shift();
    }
    const n = this.hopE.length * HOP;
    const winE = this.hopE.reduce((a, b) => a + b, 0) / n;
    const winD = this.hopD.reduce((a, b) => a + b, 0) / n;

    const fluxHit = this.spectralFlux();

    if (this.refractory > 0) this.refractory--;
    else if (this.histE.length >= ENERGY_HOPS && winE > ENERGY_FLOOR) {
      const maxE = Math.max(...this.histE);
      const maxD = Math.max(...this.histD);
      const energyHit = winE > this.ratio * maxE || winD > this.ratio * 1.5 * maxD;
      if (energyHit || fluxHit) {
        this.pending.push({
          id: this.nextId++,
          frame: energyHit ? this.hopStart : Math.max(0, this.hopStart - FLUX_BIAS),
          classified: false,
          wantSustain: true,
        });
        this.refractory = REFRACTORY_HOPS;
      }
    }
    this.histE.push(winE);
    this.histD.push(winD);
    if (this.histE.length > HISTORY_HOPS) {
      this.histE.shift();
      this.histD.shift();
    }
  }

  /**
   * Есть ли в текущем кадре заметная новая энергия относительно спектра 43–128 мс назад.
   * Сравнение с максимумом за этот промежуток не даёт срабатывать на биениях звучащих нот.
   */
  private spectralFlux(): boolean {
    const re = this.fluxRe.fill(0);
    const im = this.fluxIm.fill(0);
    const start = this.written - FLUX_WINDOW;
    for (let i = 0; i < FLUX_WINDOW; i++) re[i] = this.at(start + i) * FLUX_HANN[i];
    fft(re, im);
    const df = this.sr / FLUX_WINDOW;
    const lo = Math.ceil(F_MIN / df);
    const hi = Math.floor(FLUX_F_MAX / df);
    const mags = new Float32Array(hi - lo + 1);
    for (let k = lo; k <= hi; k++) mags[k - lo] = Math.hypot(re[k], im[k]);

    let hit = false;
    if (this.fluxHist.length >= FLUX_SPAN) {
      let flux = 0;
      let base = 0;
      const ref = this.fluxHist.slice(0, FLUX_SPAN - FLUX_LAG + 1);
      for (let i = 0; i < mags.length; i++) {
        let m = 0;
        for (const frame of ref) if (frame[i] > m) m = frame[i];
        base += m * m;
        if (mags[i] > m) flux += (mags[i] - m) ** 2;
      }
      hit = flux > FLUX_FLOOR && flux > (this.ratio - 1) * FLUX_GAIN * base;
    }
    this.fluxHist.push(mags);
    if (this.fluxHist.length > FLUX_SPAN) this.fluxHist.shift();
    return hit;
  }

  private rms(from: number, to: number): number {
    let s = 0;
    for (let f = from; f < to; f++) s += this.at(f) ** 2;
    return Math.sqrt(s / Math.max(1, to - from));
  }

  private classify(p: Pending): DetectorEvent | null {
    const post = bandPowers((i) => this.at(p.frame + i), this.sr);
    const preStart = p.frame - HOP - WINDOW;
    const pre = bandPowers((i) => this.at(preStart + i), this.sr);
    let total = 0;
    let fresh = 0;
    for (let i = 0; i < BANDS; i++) {
      total += post[i];
      fresh += Math.max(0, post[i] - pre[i]);
    }
    if (total <= 0 || fresh / total < MIN_NOVELTY) return null;

    const feature = toFeature(post, pre);
    const scores = this.templates
      .map((t, i) => ({ i, id: this.ids[i], similarity: cosine(feature, t) }))
      .sort((a, b) => b.similarity - a.similarity);
    const best = scores.length ? scores[0].i : -1;
    const bestSim = scores.length ? Math.max(0, scores[0].similarity) : 0;
    // Повторный удар по ещё звучащему полю даёт неполный «отпечаток»: принимаем его,
    // если одно поле уверенно опережает все остальные.
    const second = scores.length > 1 ? Math.max(0, scores[1].similarity) : 0;
    const dominant = bestSim >= DOMINANT_MIN_SIMILARITY && bestSim >= DOMINANT_RATIO * second;
    let tongues: string[] =
      best >= 0 && (bestSim >= MIN_SIMILARITY || dominant) ? [this.ids[best]] : [];
    let clarity = bestSim;
    const single = new Float64Array(this.ids.length);
    for (const s of scores) single[s.i] = s.similarity;
    let pairSim = 0;
    for (const pair of this.pairs) {
      // Оба поля аккорда должны быть слышны и по отдельности: иначе одиночная нота
      // с обертоном в октаву (B2 → B3) принималась бы за аккорд.
      if (Math.min(single[pair.a], single[pair.b]) < PAIR_MEMBER_MIN) continue;
      const s = cosine(feature, pair.t);
      if (s >= PAIR_MIN_SIMILARITY && s > bestSim + PAIR_MARGIN && s > pairSim) {
        pairSim = s;
        clarity = s;
        tongues = [this.ids[pair.a], this.ids[pair.b]].sort();
      }
    }
    const level = this.rms(p.frame, p.frame + WINDOW);
    return {
      type: 'hit',
      id: p.id,
      frame: p.frame,
      tongues,
      clarity,
      levelDb: 20 * Math.log10(level + 1e-9),
      feature,
      novelty: fresh / total,
      scores: scores.slice(0, 3).map(({ id, similarity }) => ({ id, similarity })),
    };
  }

  private flush(events: DetectorEvent[]): void {
    const sustainEnd = Math.round(0.3 * this.sr);
    for (const p of this.pending) {
      if (!p.classified && this.written >= p.frame + WINDOW) {
        p.classified = true;
        const ev = this.classify(p);
        if (ev) events.push(ev);
        if (!ev || (ev.type === 'hit' && ev.tongues.length === 0)) p.wantSustain = false;
      }
      // Ждём чуть дольше конца окна: удар в самом его конце обнаруживается с запаздыванием.
      if (
        p.classified &&
        p.wantSustain &&
        this.written >= p.frame + sustainEnd + FLUX_BIAS + 2 * HOP
      ) {
        p.wantSustain = false;
        const interrupted = this.pending.some(
          (q) => q.frame > p.frame && q.frame < p.frame + sustainEnd,
        );
        if (!interrupted) {
          const head = this.rms(p.frame + Math.round(0.01 * this.sr), p.frame + Math.round(0.1 * this.sr));
          const tail = this.rms(p.frame + Math.round(0.2 * this.sr), p.frame + sustainEnd);
          if (head > 0) events.push({ type: 'sustain', id: p.id, ratio: tail / head });
        }
      }
    }
    this.pending = this.pending.filter(
      (p) => !p.classified || p.wantSustain || this.written < p.frame + sustainEnd,
    );
  }
}
