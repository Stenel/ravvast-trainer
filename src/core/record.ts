import type { Composition, CompositionNote } from './types';

export interface RecordedHit {
  tongue: string;
  /** Момент удара в миллисекундах (любая общая шкала). */
  timeMs: number;
}

export const RECORD_BPM = 120;
/** Шаг сетки в долях: при 120 уд/мин это 1/16 ноты, 125 мс. */
export const RECORD_GRID = 0.25;
const MAX_DURATION = 4;

/**
 * Превращает записанную импровизацию в композицию: время ударов переводится в доли
 * и выравнивается по сетке, длительность ноты — до следующей ноты (не больше 4 долей).
 * Возвращает null, если ударов нет.
 */
export function hitsToComposition(
  hits: readonly RecordedHit[],
  title: string,
  scaleId: string,
): Composition | null {
  if (hits.length === 0) return null;
  const sorted = [...hits].sort((a, b) => a.timeMs - b.timeMs);
  const t0 = sorted[0].timeMs;
  const beatMs = 60000 / RECORD_BPM;
  const seen = new Set<string>();
  const notes: CompositionNote[] = [];
  for (const h of sorted) {
    const beat = Math.round((h.timeMs - t0) / beatMs / RECORD_GRID) * RECORD_GRID;
    const key = `${h.tongue}@${beat}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push({ tongue: h.tongue, beat, duration: MAX_DURATION });
  }
  const beats = [...new Set(notes.map((n) => n.beat))].sort((a, b) => a - b);
  for (const n of notes) {
    const next = beats[beats.indexOf(n.beat) + 1];
    n.duration = next === undefined ? 2 : Math.min(MAX_DURATION, next - n.beat);
  }
  const clean = title.trim().slice(0, 120) || 'Моя запись';
  return { id: `custom:${clean}`, title: clean, scale: scaleId, bpm: RECORD_BPM, notes };
}
