import { MIN_SIMILARITY } from './detector';

/** Сходство с эталоном, которое считается идеально чистым ударом. */
const CLEAN_SIMILARITY = 0.97;
/** Если через 0,2–0,3 с звук слабее этой доли начального — удар заглушён. */
export const MUTED_RATIO = 0.2;

export interface HitQuality {
  /** Сходство с эталоном поля, 0..1. */
  clarity: number;
  levelDb: number;
  /** Отклонение от нужного момента, мс (плюс — позже). */
  offsetMs?: number;
  /** Отношение громкости через 0,2–0,3 с к начальной; null — не измерено. */
  sustain?: number | null;
}

export interface QualitySummary {
  hits: number;
  /** Средняя чистота, 0–100. */
  clarity: number | null;
  /** Разброс громкости между ударами, дБ (меньше — ровнее). */
  evennessDb: number | null;
  muted: number;
  meanOffsetMs: number | null;
}

export function clarityPercent(similarity: number): number {
  const k = (similarity - MIN_SIMILARITY) / (CLEAN_SIMILARITY - MIN_SIMILARITY);
  return Math.round(Math.min(1, Math.max(0, k)) * 100);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function summarizeQuality(hits: readonly HitQuality[]): QualitySummary {
  if (hits.length === 0) {
    return { hits: 0, clarity: null, evennessDb: null, muted: 0, meanOffsetMs: null };
  }
  const levels = hits.map((h) => h.levelDb);
  const avg = mean(levels);
  const offsets = hits.flatMap((h) => (typeof h.offsetMs === 'number' ? [h.offsetMs] : []));
  return {
    hits: hits.length,
    clarity: Math.round(mean(hits.map((h) => clarityPercent(h.clarity)))),
    evennessDb:
      hits.length < 2 ? null : Math.sqrt(mean(levels.map((l) => (l - avg) ** 2))),
    muted: hits.filter((h) => typeof h.sustain === 'number' && h.sustain < MUTED_RATIO).length,
    meanOffsetMs: offsets.length ? Math.round(mean(offsets)) : null,
  };
}
