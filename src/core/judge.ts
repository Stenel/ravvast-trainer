import type { TimedNote } from './types';

export type Difficulty = 'easy' | 'normal' | 'hard';
export type Grade = 'perfect' | 'good' | 'miss';
export type NoteState = 'pending' | Grade;

export interface DifficultyConfig {
  label: string;
  /** Окно «Идеально», ± секунды. */
  perfect: number;
  /** Окно «Хорошо», ± секунды. */
  good: number;
  /** За сколько секунд до удара нота появляется на экране. */
  approach: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyConfig> = {
  easy: { label: 'Легко', perfect: 0.12, good: 0.25, approach: 2.6 },
  normal: { label: 'Нормально', perfect: 0.08, good: 0.16, approach: 2.0 },
  hard: { label: 'Сложно', perfect: 0.05, good: 0.11, approach: 1.5 },
};

export const POINTS: Record<Grade, number> = { perfect: 100, good: 50, miss: 0 };
const EPS = 1e-9;

export function gradeOffset(offsetSec: number, difficulty: Difficulty): Grade {
  const d = DIFFICULTIES[difficulty];
  const abs = Math.abs(offsetSec);
  if (abs <= d.perfect + EPS) return 'perfect';
  if (abs <= d.good + EPS) return 'good';
  return 'miss';
}

/** Множитель очков: +1 за каждые 10 попаданий подряд, максимум x4. */
export function multiplier(combo: number): number {
  return Math.min(4, 1 + Math.floor(combo / 10));
}

export type HitResult =
  | { grade: 'perfect' | 'good'; index: number; offset: number; points: number }
  | { grade: 'stray' };

/** Чистая логика одной игры: принимает удары и время, считает счёт и комбо. */
export class GameSession {
  score = 0;
  combo = 0;
  maxCombo = 0;
  readonly counts: Record<Grade, number> = { perfect: 0, good: 0, miss: 0 };
  private readonly states: NoteState[];
  private firstPending = 0;

  constructor(
    readonly notes: readonly TimedNote[],
    readonly difficulty: Difficulty,
  ) {
    this.states = notes.map(() => 'pending');
  }

  state(index: number): NoteState {
    return this.states[index];
  }

  get finished(): boolean {
    return this.counts.perfect + this.counts.good + this.counts.miss === this.notes.length;
  }

  get accuracy(): number {
    if (this.notes.length === 0) return 0;
    return (this.counts.perfect + this.counts.good) / this.notes.length;
  }

  /** Есть ли ещё не сыгранная нота этого поля, в окно которой попадает момент time. */
  hasPending(tongue: string, time: number): boolean {
    const window = DIFFICULTIES[this.difficulty].good;
    for (let i = this.firstPending; i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.time - time > window + EPS) break;
      if (
        this.states[i] === 'pending' &&
        note.tongue === tongue &&
        Math.abs(time - note.time) <= window + EPS
      ) {
        return true;
      }
    }
    return false;
  }

  /** Удар по полю в момент time (секунды от начала композиции). */
  hit(tongue: string, time: number): HitResult {
    const window = DIFFICULTIES[this.difficulty].good;
    for (let i = this.firstPending; i < this.notes.length; i++) {
      const note = this.notes[i];
      if (note.time - time > window + EPS) break;
      if (this.states[i] !== 'pending' || note.tongue !== tongue) continue;
      const offset = time - note.time;
      const grade = gradeOffset(offset, this.difficulty);
      if (grade === 'miss') continue;
      const points = POINTS[grade] * multiplier(this.combo);
      this.states[i] = grade;
      this.counts[grade]++;
      this.score += points;
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      return { grade, index: i, offset, points };
    }
    this.combo = 0;
    return { grade: 'stray' };
  }

  /** Помечает ноты, окно которых истекло к моменту time. Возвращает их индексы. */
  update(time: number): number[] {
    const window = DIFFICULTIES[this.difficulty].good;
    const missed: number[] = [];
    for (let i = this.firstPending; i < this.notes.length; i++) {
      if (this.notes[i].time + window >= time) break;
      if (this.states[i] === 'pending') {
        this.states[i] = 'miss';
        this.counts.miss++;
        missed.push(i);
      }
    }
    while (this.firstPending < this.notes.length && this.states[this.firstPending] !== 'pending') {
      this.firstPending++;
    }
    if (missed.length) this.combo = 0;
    return missed;
  }
}
