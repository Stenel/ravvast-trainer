import type { Difficulty } from './judge';
import { isRecord } from './scale';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BestResult {
  score: number;
  accuracy: number;
}

export interface Progress {
  best: Record<string, Partial<Record<Difficulty, BestResult>>>;
  completed: string[];
}

export const PROGRESS_KEY = 'ravvast-trainer:progress:v1';
/** Доля попаданий, с которой игра засчитывает композицию пройденной. */
export const PASS_ACCURACY = 0.7;

const DIFFS: Difficulty[] = ['easy', 'normal', 'hard'];

export function loadProgress(store: KeyValueStore): Progress {
  // best без прототипа: id композиции приходит из импортированного файла и может быть "__proto__".
  const progress: Progress = { best: Object.create(null), completed: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(store.getItem(PROGRESS_KEY) ?? 'null');
  } catch {
    return progress;
  }
  if (!isRecord(raw)) return progress;

  if (isRecord(raw.best)) {
    for (const [id, entry] of Object.entries(raw.best)) {
      if (!isRecord(entry)) continue;
      const clean: Partial<Record<Difficulty, BestResult>> = {};
      for (const d of DIFFS) {
        const r = entry[d];
        if (
          Object.hasOwn(entry, d) &&
          isRecord(r) &&
          typeof r.score === 'number' &&
          typeof r.accuracy === 'number'
        ) {
          clean[d] = { score: r.score, accuracy: Math.min(1, Math.max(0, r.accuracy)) };
        }
      }
      progress.best[id] = clean;
    }
  }
  if (Array.isArray(raw.completed)) {
    progress.completed = raw.completed.filter((x): x is string => typeof x === 'string');
  }
  return progress;
}

function save(store: KeyValueStore, progress: Progress): void {
  try {
    store.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Хранилище недоступно или переполнено: прогресс живёт до конца сессии.
  }
}

export function recordGame(
  store: KeyValueStore,
  compositionId: string,
  difficulty: Difficulty,
  score: number,
  accuracy: number,
): { progress: Progress; isRecord: boolean } {
  const progress = loadProgress(store);
  const entry = (progress.best[compositionId] ??= {});
  const prev = entry[difficulty];
  const isNewRecord = !prev || score > prev.score;
  if (isNewRecord) entry[difficulty] = { score, accuracy };
  if (accuracy >= PASS_ACCURACY && !progress.completed.includes(compositionId)) {
    progress.completed.push(compositionId);
  }
  save(store, progress);
  return { progress, isRecord: isNewRecord };
}

export function markCompleted(store: KeyValueStore, compositionId: string): Progress {
  const progress = loadProgress(store);
  if (!progress.completed.includes(compositionId)) {
    progress.completed.push(compositionId);
    save(store, progress);
  }
  return progress;
}
