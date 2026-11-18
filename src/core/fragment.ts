import type { Composition } from './types';

/** Стартовый темп при постепенном разгоне (доля от нормального). */
export const RAMP_START = 0.6;

/** Вырезает фрагмент [fromBeat, toBeat) и сдвигает его к нулю. Исходник не меняется. */
export function sliceComposition(comp: Composition, fromBeat: number, toBeat: number): Composition {
  const kept = comp.notes.filter((n) => n.beat >= fromBeat && n.beat < toBeat);
  const shift = kept.length ? Math.min(...kept.map((n) => n.beat)) : 0;
  return {
    id: `${comp.id}#${fromBeat}-${toBeat}`,
    title: comp.title,
    scale: comp.scale,
    bpm: comp.bpm,
    notes: kept.map((n) => ({ ...n, beat: n.beat - shift })),
  };
}

/** Следующий темп разгона: растёт на шаг, если точность не ниже порога. */
export function nextTempo(
  tempo: number,
  accuracy: number,
  opts: { step?: number; pass?: number; max?: number } = {},
): number {
  const { step = 0.05, pass = 0.9, max = 1 } = opts;
  if (accuracy < pass) return tempo;
  return Math.round(Math.min(tempo + step, max) * 100) / 100;
}

/** Окно длиной spanBeats с наибольшим числом плохих нот; при ничьей — самое раннее. */
export function weakestWindow(
  beats: readonly number[],
  bad: readonly boolean[],
  spanBeats: number,
): { fromBeat: number; toBeat: number; bad: number } | null {
  let best: { fromBeat: number; toBeat: number; bad: number } | null = null;
  for (let i = 0; i < beats.length; i++) {
    const from = beats[i];
    const to = from + spanBeats;
    let count = 0;
    for (let j = 0; j < beats.length; j++) {
      if (bad[j] && beats[j] >= from && beats[j] < to) count++;
    }
    if (count > 0 && (!best || count > best.bad)) best = { fromBeat: from, toBeat: to, bad: count };
  }
  return best;
}
