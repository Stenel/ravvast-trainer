/** Модель звука язычка: основной тон и две гармоники с экспоненциальным затуханием. */
export const PARTIALS = [
  { ratio: 1, gain: 1, decay: 3.2 },
  { ratio: 2, gain: 0.5, decay: 2.0 },
  { ratio: 3, gain: 0.18, decay: 1.2 },
] as const;

export const ATTACK_SEC = 0.006;
/** Во сколько раз падает амплитуда за время decay. */
const DECAY_FLOOR = 1e-4;

export interface VoicePartial {
  ratio: number;
  gain: number;
  /** Секунды до затухания на 80 дБ. */
  decay: number;
}

/** Спектры сняты микрофоном телефона, а он почти не слышит низ: основной тон поднимаем. */
const MIN_FUNDAMENTAL_GAIN = 0.6;
const MIN_PARTIAL_DECAY = 0.8;

/**
 * Составляющие звука поля для синтезатора. В отличие от шаблонов распознавания здесь
 * важно, как звук слышит человек: долгий сустейн основного тона (у низких полей дольше),
 * обертоны гаснут тем быстрее, чем они выше.
 */
export function voicePartials(
  freq: number,
  spectrum?: readonly (readonly [number, number])[],
): VoicePartial[] {
  const sustain = Math.min(10, Math.max(5, 10 - 2.5 * Math.log2(freq / 82.4)));
  const source: (readonly [number, number])[] = spectrum
    ? spectrum.map(([r, g]) => [r, g] as const)
    : PARTIALS.map((p) => [p.ratio, p.gain] as const);
  if (!source.some(([r]) => r === 1)) source.unshift([1, MIN_FUNDAMENTAL_GAIN]);
  const raw = source.map(([ratio, gain]) => ({
    ratio,
    gain: ratio === 1 ? Math.max(gain, MIN_FUNDAMENTAL_GAIN) : gain,
    decay: Math.max(MIN_PARTIAL_DECAY, sustain / ratio ** 0.8),
  }));
  // Суммарная громкость не должна зависеть от числа составляющих.
  const norm = 1 / Math.max(1, 0.6 * raw.reduce((s, p) => s + p.gain, 0));
  return raw.map((p) => ({ ...p, gain: p.gain * norm }));
}

/**
 * Рендерит один удар в массив сэмплов. Используется для шаблонов распознавания
 * «по умолчанию» (до калибровки) и в тестах распознавателя.
 */
export function renderTone(
  freq: number,
  length: number,
  sampleRate: number,
  amp = 1,
  decayScale = 1,
  /** Измеренный спектр поля: пары [номер гармоники, относительная амплитуда]. */
  spectrum?: readonly (readonly [number, number])[],
): Float32Array {
  const out = new Float32Array(Math.max(0, length));
  const k = Math.log(1 / DECAY_FLOOR);
  const partials = spectrum
    ? spectrum.map(([ratio, gain]) => ({ ratio, gain, decay: PARTIALS[0].decay }))
    : PARTIALS;
  for (const p of partials) {
    const w = (2 * Math.PI * freq * p.ratio) / sampleRate;
    const rate = k / (p.decay * decayScale * sampleRate);
    const attack = ATTACK_SEC * sampleRate;
    for (let i = 0; i < out.length; i++) {
      const env = i < attack ? i / attack : Math.exp(-(i - attack) * rate);
      out[i] += amp * 0.5 * p.gain * env * Math.sin(w * i);
    }
  }
  return out;
}
