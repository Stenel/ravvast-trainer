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
const PAIR_MEMBER_MIN = 0.6;
const DOMINANT_MIN_SIMILARITY = 0.35;
const DOMINANT_RATIO = 2.5;
/** Доля новой энергии в спектре, ниже которой «удар» считается ложным (биения, шум). */
const MIN_NOVELTY = 0.18;
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
// Адаптивный порог: удар должен быть заметно громче фона. Фон — минимум энергии за ~30 с.
const NOISE_BUCKET_HOPS = 375; // ~2 с
const NOISE_BUCKETS = 15;
/** Порог не поднимается выше этой доли от недавних громких ударов (иначе глушил бы тихие ноты). */
const PEAK_FRACTION = 0.02;
/** Доля энергии в 10 самых сильных полосах: у ноты она высокая, у шума — низкая. */
const MIN_TONALITY = 0.5;
const TONALITY_BANDS = 10;
// Призвук от приглушения: в течение ECHO_SECONDS после удара звук тише его на ECHO_DROP_DB
// и с долей новой энергии ниже ECHO_MAX_NOVELTY ударом не считается.
const ECHO_SECONDS = 3;
const ECHO_DROP_DB = 10;
const ECHO_MAX_NOVELTY = 0.8;
/** Звук не громче фона на столько дБ и с долей нового ниже порога ударом не считается. */
const FAINT_MARGIN_DB = 8;
const FAINT_MAX_NOVELTY = 0.6;
/**
 * Всё, что выше, на входе срезается (фильтр 8-го порядка): у полей там нет ничего нужного,
 * а тик метронома (5,5 кГц и выше) из динамика иначе принимался бы за начало удара.
 */
export const INPUT_LOWPASS_HZ = 2200;
const LOWPASS_Q = [0.50979558, 0.60134489, 0.89997622, 2.56291545];
const BUFFER = 1 << 17;
const MASK = BUFFER - 1;

const HANN = Float64Array.from({ length: WINDOW }, (_, i) =>
  0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1)),
);

/**
 * Заготовка БПФ для одной длины: перестановка индексов и поворотные множители.
 * Множители этапа с половиной блока half лежат в cos/sin с позиции half − 1 и получены
 * той же рекуррентой, что и раньше в цикле, — результат совпадает бит в бит.
 */
interface FftPlan {
  n: number;
  /** rev[i] — индекс i с обратным порядком бит. */
  rev: Int32Array;
  cos: Float64Array;
  sin: Float64Array;
}

const fftPlans = new Map<number, FftPlan>();

function fftPlan(n: number): FftPlan {
  let plan = fftPlans.get(n);
  if (plan) return plan;
  const rev = new Int32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    rev[i] = j;
  }
  const cos = new Float64Array(Math.max(0, n - 1));
  const sin = new Float64Array(Math.max(0, n - 1));
  for (let half = 1; half < n; half <<= 1) {
    const ang = (-2 * Math.PI) / (half * 2);
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    let cr = 1;
    let ci = 0;
    for (let k = 0; k < half; k++) {
      cos[half - 1 + k] = cr;
      sin[half - 1 + k] = ci;
      const ncr = cr * wr - ci * wi;
      ci = cr * wi + ci * wr;
      cr = ncr;
    }
  }
  plan = { n, rev, cos, sin };
  fftPlans.set(n, plan);
  return plan;
}

const FLUX_PLAN = fftPlan(FLUX_WINDOW);

/**
 * Этапы «бабочек» над данными, уже переставленными в порядке plan.rev.
 * Если задан maxBin, верны будут только линии спектра 0..maxBin: на последних этапах
 * (половина блока больше maxBin) считаются лишь те значения, от которых они зависят, —
 * теми же действиями, так что сами линии не меняются ни на бит.
 */
function butterflies(re: Float64Array, im: Float64Array, plan: FftPlan, maxBin = plan.n): void {
  const { n, cos, sin } = plan;
  let half = 1;
  // Пока оба соседних этапа считаются целиком, они выполняются за один проход по данным:
  // те же четыре «бабочки» на четвёрку значений, но вдвое меньше чтений и записей.
  for (; half * 2 < n && half * 2 <= maxBin; half <<= 2) {
    const len = half << 2;
    const o1 = half - 1;
    const o2 = 2 * half - 1;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const p0 = i + k;
        const p1 = p0 + half;
        const p2 = p1 + half;
        const p3 = p2 + half;
        // Этап half: пары (p0, p1) и (p2, p3).
        const cr = cos[o1 + k];
        const ci = sin[o1 + k];
        let xr = re[p1];
        let xi = im[p1];
        let tr = xr * cr - xi * ci;
        let ti = xr * ci + xi * cr;
        let ar = re[p0];
        let ai = im[p0];
        const r0 = ar + tr;
        const i0 = ai + ti;
        const r1 = ar - tr;
        const i1 = ai - ti;
        xr = re[p3];
        xi = im[p3];
        tr = xr * cr - xi * ci;
        ti = xr * ci + xi * cr;
        ar = re[p2];
        ai = im[p2];
        const r2 = ar + tr;
        const i2 = ai + ti;
        const r3 = ar - tr;
        const i3 = ai - ti;
        // Этап 2·half: пары (p0, p2) и (p1, p3), у второй множитель сдвинут на half.
        const dr = cos[o2 + k];
        const di = sin[o2 + k];
        tr = r2 * dr - i2 * di;
        ti = r2 * di + i2 * dr;
        re[p2] = r0 - tr;
        im[p2] = i0 - ti;
        re[p0] = r0 + tr;
        im[p0] = i0 + ti;
        const er = cos[o2 + half + k];
        const ei = sin[o2 + half + k];
        tr = r3 * er - i3 * ei;
        ti = r3 * ei + i3 * er;
        re[p3] = r1 - tr;
        im[p3] = i1 - ti;
        re[p1] = r1 + tr;
        im[p1] = i1 + ti;
      }
    }
  }
  for (; half < n; half <<= 1) {
    const len = half << 1;
    const off = half - 1;
    if (half > maxBin) {
      // Нужны только первые maxBin + 1 значений каждого блока.
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k <= maxBin; k++) {
          const a = i + k;
          const b = a + half;
          const cr = cos[off + k];
          const ci = sin[off + k];
          const xr = re[b];
          const xi = im[b];
          re[a] += xr * cr - xi * ci;
          im[a] += xr * ci + xi * cr;
        }
      }
      continue;
    }
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const cr = cos[off + k];
        const ci = sin[off + k];
        const xr = re[b];
        const xi = im[b];
        const tr = xr * cr - xi * ci;
        const ti = xr * ci + xi * cr;
        const ar = re[a];
        const ai = im[a];
        re[b] = ar - tr;
        im[b] = ai - ti;
        re[a] = ar + tr;
        im[a] = ai + ti;
      }
    }
  }
}

/** Быстрое преобразование Фурье на месте; длина — степень двойки. */
export function fft(re: Float64Array, im: Float64Array): void {
  const plan = fftPlan(re.length);
  const { n, rev } = plan;
  for (let i = 1; i < n; i++) {
    const j = rev[i];
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  butterflies(re, im, plan);
}

/** Мощность сигнала в логарифмических полосах 70–1700 Гц для окна из WINDOW сэмплов. */
export function bandPowers(read: (i: number) => number, sampleRate: number): Float64Array {
  const s = takeScratch();
  const rev = BAND_PLAN.rev;
  for (let i = 0; i < WINDOW; i++) s.re[rev[i]] = read(i) * HANN[i];
  return finishBands(s, sampleRate);
}

/** То же для готового окна из WINDOW сэмплов — без вызова функции на каждый сэмпл. */
function windowBandPowers(win: ArrayLike<number>, sampleRate: number): Float64Array {
  const s = takeScratch();
  const rev = BAND_PLAN.rev;
  for (let i = 0; i < WINDOW; i++) s.re[rev[i]] = win[i] * HANN[i];
  return finishBands(s, sampleRate);
}

const BAND_PLAN = fftPlan(FFT_SIZE);

interface Scratch {
  re: Float64Array;
  im: Float64Array;
}

// Запас рабочих буферов БПФ. Буфер забирается на время расчёта, поэтому вложенный вызов
// (например, из read) получит свой собственный и ничего не испортит.
const scratchPool: Scratch[] = [];

/** Обнулённая пара буферов длиной FFT_SIZE. */
function takeScratch(): Scratch {
  const s = scratchPool.pop();
  if (!s) return { re: new Float64Array(FFT_SIZE), im: new Float64Array(FFT_SIZE) };
  s.re.fill(0);
  s.im.fill(0);
  return s;
}

interface BandMap {
  /** Первая учитываемая спектральная линия. */
  first: number;
  /** Номер полосы для линий first, first + 1, … */
  band: Int16Array;
}

const bandMaps = new Map<number, BandMap>();

function bandMap(sampleRate: number): BandMap {
  let map = bandMaps.get(sampleRate);
  if (map) return map;
  const df = sampleRate / FFT_SIZE;
  const first = Math.ceil(F_MIN / df);
  const band: number[] = [];
  for (let k = first; k < FFT_SIZE / 2; k++) {
    const f = k * df;
    if (f >= F_MAX) break;
    band.push(Math.floor(Math.log(f / F_MIN) / LOG_STEP));
  }
  map = { first, band: Int16Array.from(band) };
  bandMaps.set(sampleRate, map);
  return map;
}

/** Считает спектр окна, уже разложенного в s.re в порядке обратных бит, и возвращает буфер в запас. */
function finishBands(s: Scratch, sampleRate: number): Float64Array {
  const { re, im } = s;
  const { first, band } = bandMap(sampleRate);
  butterflies(re, im, BAND_PLAN, first + band.length - 1);
  const out = new Float64Array(BANDS);
  for (let j = 0; j < band.length; j++) {
    const k = first + j;
    out[band[j]] += re[k] * re[k] + im[k] * im[k];
  }
  scratchPool.push(s);
  return out;
}

function unit(v: Float64Array): Float64Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/** Полосы слабее этой доли от самой сильной считаются остатками и шумом. */
const FEATURE_GATE = 0.003; // −25 дБ
/**
 * Полосы выше ~965 Гц в сравнении не участвуют: на записи с телефона там у сильных ударов
 * любого поля одни и те же призвуки (около 1010 и 1060 Гц), а всё, чем поля различаются,
 * лежит ниже (до 950 Гц у E3).
 */
const FEATURE_BANDS = 79;

/**
 * «Отпечаток» удара: новая энергия (после минус до) по полосам, сильно сжатая,
 * сглаженная и нормированная. Сильное сжатие (степень 1/4) нужно, чтобы слабый, но
 * присутствующий основной тон низких полей (82 Гц у E2 в микрофоне телефона на 12–15 дБ
 * тише третьей гармоники) заметно влиял на сравнение — по нему E2 отличается от B3.
 */
export function toFeature(post: Float64Array, pre?: Float64Array): Float64Array {
  const d = new Float64Array(BANDS);
  let max = 0;
  for (let i = 0; i < FEATURE_BANDS; i++) {
    d[i] = Math.max(0, post[i] - (pre ? pre[i] : 0));
    if (d[i] > max) max = d[i];
  }
  for (let i = 0; i < BANDS; i++) d[i] = d[i] < FEATURE_GATE * max ? 0 : d[i] ** 0.25;
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

/** Разделитель в ключе шаблона: «0~1» — ещё один вариант звучания поля «0». */
export const VARIANT_MARK = '~';

type Spectrum = readonly (readonly [number, number])[];

/**
 * Шаблоны по номинальным частотам строя — работают без калибровки, но грубее.
 * У поля с altPartials шаблонов несколько: ключи «id», «id~1», «id~2»…
 */
export function defaultTemplates(
  tongues: readonly { id: string; freq: number; partials?: Spectrum; altPartials?: readonly Spectrum[] }[],
  sampleRate: number,
): Record<string, Float64Array> {
  const out: Record<string, Float64Array> = Object.create(null);
  const template = (freq: number, spectrum?: Spectrum) => {
    const tone = renderTone(freq, WINDOW, sampleRate, 1, 1, spectrum);
    return toFeature(bandPowers((i) => tone[i], sampleRate));
  };
  for (const t of tongues) {
    out[t.id] = template(t.freq, t.partials);
    (t.altPartials ?? []).forEach((s, k) => {
      out[`${t.id}${VARIANT_MARK}${k + 1}`] = template(t.freq, s);
    });
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
  /** Во сколько раз (по мощности) удар должен превышать фоновый шум. По умолчанию 8 (~9 дБ). */
  noiseFactor?: number;
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
  /** Для каждого поля — основной шаблон и варианты звучания. */
  private readonly templates: ArrayLike<number>[][];
  private readonly pairs: { a: number; b: number; t: Float64Array }[] = [];
  private readonly buf = new Float32Array(BUFFER);
  private written = 0;
  private hopStart = 0;
  private prevSample = 0;
  // Кольца фиксированной длины: *Pos — место следующей записи, *Count — сколько заполнено.
  private readonly hopE = new Float64Array(ENERGY_HOPS);
  private readonly hopD = new Float64Array(ENERGY_HOPS);
  private hopPos = 0;
  private hopCount = 0;
  private readonly histE = new Float64Array(HISTORY_HOPS);
  private readonly histD = new Float64Array(HISTORY_HOPS);
  private histPos = 0;
  private histCount = 0;
  private readonly fluxRe = new Float64Array(FLUX_WINDOW);
  private readonly fluxIm = new Float64Array(FLUX_WINDOW);
  private readonly fluxLo: number;
  private readonly fluxBins: number;
  /** Кольцо последних FLUX_SPAN кадров спектра; fluxPos — самый старый (он же следующий на запись). */
  private readonly fluxRing: Float32Array[] = [];
  private fluxSpare: Float32Array;
  private readonly fluxMax: Float32Array;
  private fluxPos = 0;
  private fluxCount = 0;
  private refractory = 0;
  private readonly noiseFactor: number;
  private readonly bucketMin = new Float64Array(NOISE_BUCKETS);
  private readonly bucketMax = new Float64Array(NOISE_BUCKETS);
  private bucketPos = 0;
  private bucketCount = 0;
  private curMin = Infinity;
  private curMax = 0;
  private bucketHops = 0;
  private readonly win = new Float32Array(WINDOW);
  private readonly top = new Float64Array(TONALITY_BANDS);
  private pending: Pending[] = [];
  private nextId = 1;
  private lastStrike: { frame: number; levelDb: number } | null = null;
  /** Звенья входного фильтра: по пять коэффициентов (b0, b1, b2, a1, a2) и по два состояния. */
  private readonly lp = new Float64Array(LOWPASS_Q.length * 5);
  private readonly lpState = new Float64Array(LOWPASS_Q.length * 2);

  constructor(opts: DetectorOptions) {
    this.sr = opts.sampleRate;
    const w0 = (2 * Math.PI * Math.min(INPUT_LOWPASS_HZ, this.sr * 0.45)) / this.sr;
    LOWPASS_Q.forEach((q, k) => {
      const alpha = Math.sin(w0) / (2 * q);
      const a0 = 1 + alpha;
      const b1 = (1 - Math.cos(w0)) / a0;
      this.lp.set([b1 / 2, b1, b1 / 2, (-2 * Math.cos(w0)) / a0, (1 - alpha) / a0], k * 5);
    });
    this.ratio = opts.ratio ?? 1.7;
    this.noiseFactor = opts.noiseFactor ?? 8;
    const df = this.sr / FLUX_WINDOW;
    this.fluxLo = Math.ceil(F_MIN / df);
    this.fluxBins = Math.floor(FLUX_F_MAX / df) - this.fluxLo + 1;
    for (let i = 0; i < FLUX_SPAN; i++) this.fluxRing.push(new Float32Array(this.fluxBins));
    this.fluxSpare = new Float32Array(this.fluxBins);
    this.fluxMax = new Float32Array(this.fluxBins);
    // Ключи «id~N» — варианты звучания того же поля: сводим их к одному полю.
    const byId = new Map<string, ArrayLike<number>[]>();
    for (const key of Object.keys(opts.templates)) {
      const id = key.split(VARIANT_MARK)[0];
      const list = byId.get(id) ?? [];
      // Основной шаблон (ключ без метки) всегда первый: по нему строятся аккорды.
      if (key === id) list.unshift(opts.templates[key]);
      else list.push(opts.templates[key]);
      byId.set(id, list);
    }
    this.ids = [...byId.keys()];
    this.templates = this.ids.map((id) => byId.get(id) as ArrayLike<number>[]);
    for (let a = 0; a < this.ids.length; a++) {
      for (let b = a + 1; b < this.ids.length; b++) {
        this.pairs.push({ a, b, t: averageTemplates([this.templates[a][0], this.templates[b][0]]) });
      }
    }
  }

  push(samples: ArrayLike<number>): DetectorEvent[] {
    const events: DetectorEvent[] = [];
    const c = this.lp;
    const s = this.lpState;
    for (let i = 0; i < samples.length; i++) {
      let y = samples[i];
      for (let k = 0, j = 0; k < c.length; k += 5, j += 2) {
        const x = y;
        y = c[k] * x + s[j];
        s[j] = c[k + 1] * x - c[k + 3] * y + s[j + 1];
        s[j + 1] = c[k + 2] * x - c[k + 4] * y;
      }
      this.buf[this.written & MASK] = y;
      this.written++;
      if (this.written - this.hopStart === HOP) {
        this.processHop();
        this.hopStart = this.written;
      }
    }
    this.flush(events);
    return events;
  }

  private processHop(): void {
    const buf = this.buf;
    let e = 0;
    let d = 0;
    let prev = this.prevSample;
    for (let f = this.hopStart; f < this.written; f++) {
      const x = buf[f & MASK];
      const dx = x - prev;
      e += x * x;
      d += dx * dx;
      prev = x;
    }
    this.prevSample = prev;
    const hopE = this.hopE;
    const hopD = this.hopD;
    hopE[this.hopPos] = e;
    hopD[this.hopPos] = d;
    this.hopPos = (this.hopPos + 1) % ENERGY_HOPS;
    if (this.hopCount < ENERGY_HOPS) this.hopCount++;
    // Складываем от самого старого шага к новому: порядок влияет на округление.
    let sumE = 0;
    let sumD = 0;
    for (let j = this.hopCount; j > 0; j--) {
      const idx = (this.hopPos - j + ENERGY_HOPS) % ENERGY_HOPS;
      sumE += hopE[idx];
      sumD += hopD[idx];
    }
    const n = this.hopCount * HOP;
    const winE = sumE / n;
    const winD = sumD / n;

    const fluxHit = this.spectralFlux();

    const gate = this.updateGate(winE);

    const histE = this.histE;
    const histD = this.histD;
    if (this.refractory > 0) this.refractory--;
    else if (this.histCount >= ENERGY_HOPS && winE > gate) {
      // Как Math.max: NaN в истории даёт NaN (сравнения с ним ложны).
      let maxE = -Infinity;
      let maxD = -Infinity;
      for (let j = 0; j < this.histCount; j++) {
        const he = histE[j];
        const hd = histD[j];
        if (he > maxE || he !== he) maxE = he;
        if (hd > maxD || hd !== hd) maxD = hd;
      }
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
    histE[this.histPos] = winE;
    histD[this.histPos] = winD;
    this.histPos = (this.histPos + 1) % HISTORY_HOPS;
    if (this.histCount < HISTORY_HOPS) this.histCount++;
  }

  /** Текущий уровень фонового шума (мощность), по минимуму за последние ~30 с. */
  get noiseEnergy(): number {
    let m = this.curMin;
    for (let j = 0; j < this.bucketCount; j++) if (this.bucketMin[j] < m) m = this.bucketMin[j];
    return Number.isFinite(m) ? m : 0;
  }

  /** Обновляет оценку фона и возвращает порог энергии, ниже которого удары не ищутся. */
  private updateGate(winE: number): number {
    if (this.histCount >= ENERGY_HOPS) {
      if (winE < this.curMin) this.curMin = winE;
      if (winE > this.curMax) this.curMax = winE;
      if (++this.bucketHops >= NOISE_BUCKET_HOPS) {
        this.bucketMin[this.bucketPos] = this.curMin;
        this.bucketMax[this.bucketPos] = this.curMax;
        this.bucketPos = (this.bucketPos + 1) % NOISE_BUCKETS;
        if (this.bucketCount < NOISE_BUCKETS) this.bucketCount++;
        this.curMin = Infinity;
        this.curMax = 0;
        this.bucketHops = 0;
      }
    }
    const noise = this.noiseEnergy;
    let peak = this.curMax;
    for (let j = 0; j < this.bucketCount; j++) if (this.bucketMax[j] > peak) peak = this.bucketMax[j];
    // Во время плотной игры «минимум» — это ещё звучащие ноты, а не фон; тогда порог
    // ограничиваем долей от недавних громких ударов, чтобы не терять тихие ноты.
    const adaptive = Math.min(this.noiseFactor * noise, PEAK_FRACTION * peak);
    return Math.max(ENERGY_FLOOR, adaptive);
  }

  /**
   * Есть ли в текущем кадре заметная новая энергия относительно спектра 43–128 мс назад.
   * Сравнение с максимумом за этот промежуток не даёт срабатывать на биениях звучащих нот.
   */
  private spectralFlux(): boolean {
    const re = this.fluxRe;
    const im = this.fluxIm.fill(0);
    const buf = this.buf;
    const rev = FLUX_PLAN.rev;
    const start = this.written - FLUX_WINDOW;
    // Окно сразу кладётся в порядке обратных бит — отдельная перестановка не нужна.
    for (let i = 0; i < FLUX_WINDOW; i++) {
      const f = start + i;
      re[rev[i]] = f < 0 ? 0 : buf[f & MASK] * FLUX_HANN[i];
    }
    const lo = this.fluxLo;
    const bins = this.fluxBins;
    butterflies(re, im, FLUX_PLAN, lo + bins - 1);
    const mags = this.fluxSpare;
    for (let i = 0; i < bins; i++) mags[i] = Math.hypot(re[lo + i], im[lo + i]);

    const ring = this.fluxRing;
    let hit = false;
    if (this.fluxCount >= FLUX_SPAN) {
      // Максимум по полосам за FLUX_SPAN − FLUX_LAG + 1 самых старых кадров кольца.
      const max = this.fluxMax.fill(0);
      for (let j = 0; j <= FLUX_SPAN - FLUX_LAG; j++) {
        const frame = ring[(this.fluxPos + j) % FLUX_SPAN];
        for (let i = 0; i < bins; i++) if (frame[i] > max[i]) max[i] = frame[i];
      }
      let flux = 0;
      let base = 0;
      for (let i = 0; i < bins; i++) {
        const m = max[i];
        base += m * m;
        if (mags[i] > m) flux += (mags[i] - m) ** 2;
      }
      hit = flux > FLUX_FLOOR && flux > (this.ratio - 1) * FLUX_GAIN * base;
    } else this.fluxCount++;
    // Новый кадр встаёт на место самого старого, а тот становится запасным буфером.
    this.fluxSpare = ring[this.fluxPos];
    ring[this.fluxPos] = mags;
    this.fluxPos = (this.fluxPos + 1) % FLUX_SPAN;
    return hit;
  }

  private rms(from: number, to: number): number {
    const buf = this.buf;
    const written = this.written;
    let s = 0;
    for (let f = from; f < to; f++) {
      const x = f < 0 || f >= written ? 0 : buf[f & MASK];
      s += x * x;
    }
    return Math.sqrt(s / Math.max(1, to - from));
  }

  /** Копирует WINDOW сэмплов с кадра start в общий буфер окна (за пределами записи — нули). */
  private copyWindow(start: number): Float32Array {
    const buf = this.buf;
    const written = this.written;
    const win = this.win;
    for (let i = 0; i < WINDOW; i++) {
      const f = start + i;
      win[i] = f < 0 || f >= written ? 0 : buf[f & MASK];
    }
    return win;
  }

  private classify(p: Pending): DetectorEvent | null {
    const post = windowBandPowers(this.copyWindow(p.frame), this.sr);
    const pre = windowBandPowers(this.copyWindow(p.frame - HOP - WINDOW), this.sr);
    let total = 0;
    let fresh = 0;
    for (let i = 0; i < BANDS; i++) {
      total += post[i];
      fresh += Math.max(0, post[i] - pre[i]);
    }
    if (total <= 0 || fresh / total < MIN_NOVELTY) return null;

    const feature = toFeature(post, pre);
    const scores = this.templates
      .map((variants, i) => {
        let similarity = -Infinity;
        for (const t of variants) similarity = Math.max(similarity, cosine(feature, t));
        return { i, id: this.ids[i], similarity };
      })
      .sort((a, b) => b.similarity - a.similarity);
    const best = scores.length ? scores[0].i : -1;
    const bestSim = scores.length ? Math.max(0, scores[0].similarity) : 0;
    // Повторный удар по ещё звучащему полю даёт неполный «отпечаток»: принимаем его,
    // если одно поле уверенно опережает все остальные.
    const second = scores.length > 1 ? Math.max(0, scores[1].similarity) : 0;
    // Шум размазан по всем полосам, нота сосредоточена в нескольких: шумоподобный звук
    // не считаем ударом, даже если он случайно похож на какой-то шаблон.
    // Отбираем TONALITY_BANDS наибольших долей вставками (top упорядочен по убыванию)
    // и складываем их в том же порядке, что и после полной сортировки.
    const top = this.top.fill(-1);
    for (let i = 0; i < BANDS; i++) {
      const x = feature[i] * feature[i];
      if (x > top[TONALITY_BANDS - 1]) {
        let j = TONALITY_BANDS - 1;
        for (; j > 0 && x > top[j - 1]; j--) top[j] = top[j - 1];
        top[j] = x;
      }
    }
    let tonality = 0;
    for (let i = 0; i < TONALITY_BANDS; i++) tonality += top[i];
    const tonal = tonality >= MIN_TONALITY;
    const dominant =
      tonal &&
      fresh / total >= 0.2 &&
      bestSim >= DOMINANT_MIN_SIMILARITY &&
      bestSim >= DOMINANT_RATIO * second;
    let tongues: string[] =
      best >= 0 && ((tonal && bestSim >= MIN_SIMILARITY) || dominant) ? [this.ids[best]] : [];
    let clarity = bestSim;
    const single = new Float64Array(this.ids.length);
    for (const s of scores) single[s.i] = s.similarity;
    let pairSim = 0;
    for (const pair of this.pairs) {
      // Оба поля аккорда должны быть слышны и по отдельности: иначе одиночная нота
      // с обертоном в октаву (B2 → B3) принималась бы за аккорд.
      if (!tonal || Math.min(single[pair.a], single[pair.b]) < PAIR_MEMBER_MIN) continue;
      const s = cosine(feature, pair.t);
      if (s >= PAIR_MIN_SIMILARITY && s > bestSim + PAIR_MARGIN && s > pairSim) {
        pairSim = s;
        clarity = s;
        tongues = [this.ids[pair.a], this.ids[pair.b]].sort();
      }
    }
    const levelDb = 20 * Math.log10(this.rms(p.frame, p.frame + WINDOW) + 1e-9);
    // Касание звучащего поля (приглушение ладонью) даёт тихий призвук, похожий на то же
    // или соседнее поле. От настоящего удара его отличают сразу два признака: он намного
    // тише недавнего удара и в нём заметная доля старого звука.
    const last = this.lastStrike;
    if (
      last &&
      p.frame - last.frame < ECHO_SECONDS * this.sr &&
      levelDb < last.levelDb - ECHO_DROP_DB &&
      fresh / total < ECHO_MAX_NOVELTY
    ) {
      return null;
    }
    // Звук почти на уровне фона и без резкой новой энергии — шорох или гул, а не удар:
    // настоящий тихий удар всё равно даёт почти целиком «новый» спектр.
    const noise = this.noiseEnergy;
    if (
      noise > 0 &&
      levelDb < 10 * Math.log10(noise) + FAINT_MARGIN_DB &&
      fresh / total < FAINT_MAX_NOVELTY
    ) {
      return null;
    }
    if (tongues.length > 0) this.lastStrike = { frame: p.frame, levelDb };
    return {
      type: 'hit',
      id: p.id,
      frame: p.frame,
      tongues,
      clarity,
      levelDb,
      feature,
      novelty: fresh / total,
      scores: scores.slice(0, 3).map(({ id, similarity }) => ({ id, similarity })),
    };
  }

  private flush(events: DetectorEvent[]): void {
    if (this.pending.length === 0) return;
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
