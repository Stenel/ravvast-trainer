import type { Composition, CompositionNote, Dynamic, Scale } from './types';

/** Поле для упражнений на ритм: центральное, а если его нет — самое низкое. */
function pulseTongue(scale: Scale): string {
  const centre = scale.tongues.find((t) => t.center);
  return (centre ?? [...scale.tongues].sort((a, b) => a.freq - b.freq)[0]).id;
}

function drill(
  scale: Scale,
  slug: string,
  title: string,
  level: 1 | 2 | 3,
  bpm: number,
  notes: CompositionNote[],
): Composition {
  return { id: `drill:${slug}`, title, scale: scale.id, bpm, level, notes };
}

/** Повторяет рисунок долей (в пределах такта длиной bar) нужное число раз. */
function pattern(tongue: string, beats: readonly number[], bar: number, bars: number): CompositionNote[] {
  const notes: CompositionNote[] = [];
  for (let b = 0; b < bars; b++) {
    beats.forEach((beat, i) => {
      const next = beats[i + 1] ?? bar;
      notes.push({ tongue, beat: b * bar + beat, duration: next - beat });
    });
  }
  return notes;
}

/**
 * Упражнения на ритм: одно поле, ничего не нужно искать руками — всё внимание на время.
 * Результат виден на ленте прохода и в строке «Ровность ритма».
 */
export function rhythmDrills(scale: Scale): Composition[] {
  const t = pulseTongue(scale);
  return [
    drill(scale, 'pulse-60', 'Ровный пульс, 60 уд/мин', 1, 60, pattern(t, [0], 1, 32)),
    drill(scale, 'pulse-80', 'Ровный пульс, 80 уд/мин', 1, 80, pattern(t, [0], 1, 32)),
    drill(scale, 'pulse-100', 'Ровный пульс, 100 уд/мин', 2, 100, pattern(t, [0], 1, 40)),
    drill(scale, 'pulse-rest', 'Три удара и пауза', 2, 72, pattern(t, [0, 1, 2], 4, 10)),
    drill(scale, 'pulse-long', 'Длинные и короткие', 2, 72, pattern(t, [0, 2, 3], 4, 10)),
    drill(scale, 'pulse-eighths', 'Четверти и восьмые', 3, 66, pattern(t, [0, 1, 2, 2.5, 3], 4, 8)),
  ];
}

/** Упражнения на динамику: тихие и громкие удары по одному и тому же полю. */
export function dynamicsDrills(scale: Scale): Composition[] {
  const t = pulseTongue(scale);
  const withDyn = (notes: CompositionNote[], dyn: (i: number) => Dynamic): CompositionNote[] =>
    notes.map((n, i) => ({ ...n, dyn: dyn(i) }));
  const ring = scale.tongues.filter((x) => !x.center).sort((a, b) => a.angle - b.angle);
  // По кругу: каждое поле сначала громко, потом тихо.
  const around: CompositionNote[] = [];
  ring.forEach((tongue, i) => {
    around.push({ tongue: tongue.id, beat: i * 4, duration: 2, dyn: 'loud' });
    around.push({ tongue: tongue.id, beat: i * 4 + 2, duration: 2, dyn: 'soft' });
  });
  return [
    drill(
      scale,
      'dyn-pairs',
      'Громко — тихо',
      1,
      60,
      withDyn(pattern(t, [0], 2, 24), (i) => (i % 2 === 0 ? 'loud' : 'soft')),
    ),
    drill(
      scale,
      'dyn-accent',
      'Акцент на первую долю',
      2,
      66,
      withDyn(pattern(t, [0], 1, 32), (i) => (i % 4 === 0 ? 'loud' : 'soft')),
    ),
    ...(ring.length >= 4 ? [drill(scale, 'dyn-ring', 'Громко и тихо по кругу', 2, 60, around)] : []),
  ];
}

export interface TimingSpread {
  /** Среднее смещение, мс: плюс — в среднем позже, минус — раньше. */
  meanMs: number;
  /** Разброс вокруг среднего, мс: чем меньше, тем ровнее ритм. */
  spreadMs: number;
  hits: number;
}

/** Ровность ритма по отклонениям сыгранных нот (в секундах; null — пропуск). */
export function timingSpread(offsets: readonly (number | null)[]): TimingSpread | null {
  const xs = offsets.filter((x): x is number => x !== null && Number.isFinite(x));
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length;
  return {
    meanMs: Math.round(mean * 1000),
    spreadMs: Math.round(Math.sqrt(variance) * 1000),
    hits: xs.length,
  };
}

export interface DynamicsHit {
  tongue: string;
  dyn: Dynamic;
  levelDb: number;
}

export interface DynamicsReport {
  /** Насколько громкие удары в среднем громче тихих, дБ. */
  contrastDb: number;
  /** Сколько ударов оказались на своей стороне от середины между тихими и громкими. */
  correct: number;
  total: number;
}

/**
 * Контраст громкости. Сравниваются удары только по одному и тому же полю: разные поля
 * звучат в микрофоне с разной громкостью, и сравнивать их между собой нечестно.
 */
export function dynamicsReport(hits: readonly DynamicsHit[]): DynamicsReport | null {
  const byTongue = new Map<string, DynamicsHit[]>();
  for (const h of hits) {
    if (!Number.isFinite(h.levelDb)) continue;
    const list = byTongue.get(h.tongue) ?? [];
    list.push(h);
    byTongue.set(h.tongue, list);
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  let contrastSum = 0;
  let tongues = 0;
  let correct = 0;
  let total = 0;
  for (const list of byTongue.values()) {
    const loud = list.filter((h) => h.dyn === 'loud').map((h) => h.levelDb);
    const soft = list.filter((h) => h.dyn === 'soft').map((h) => h.levelDb);
    if (loud.length === 0 || soft.length === 0) continue;
    const loudMean = mean(loud);
    const softMean = mean(soft);
    const middle = (loudMean + softMean) / 2;
    contrastSum += loudMean - softMean;
    tongues++;
    total += list.length;
    // Если тихие вышли громче громких, середина ничего не значит: все удары мимо.
    if (loudMean > softMean) {
      correct += loud.filter((x) => x > middle).length + soft.filter((x) => x < middle).length;
    }
  }
  if (tongues === 0) return null;
  return { contrastDb: contrastSum / tongues, correct, total };
}
