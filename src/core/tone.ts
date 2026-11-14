/** Модель звука язычка: основной тон и две гармоники с экспоненциальным затуханием. */
export const PARTIALS = [
  { ratio: 1, gain: 1, decay: 3.2 },
  { ratio: 2, gain: 0.5, decay: 2.0 },
  { ratio: 3, gain: 0.18, decay: 1.2 },
] as const;

export const ATTACK_SEC = 0.006;
/** Во сколько раз падает амплитуда за время decay. */
const DECAY_FLOOR = 1e-4;

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
