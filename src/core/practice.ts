import type { Composition } from './types';

export interface Step {
  beat: number;
  /** Поля, которые нужно взять одновременно. */
  tongues: string[];
  /** Доли до следующего шага (для последнего — длительность самой длинной ноты). */
  duration: number;
}

const SAME_BEAT = 1e-6;

/** Группирует ноты композиции в шаги: одновременные ноты — один шаг. */
export function buildSteps(comp: Composition): Step[] {
  const steps: Step[] = [];
  let lastDuration = 0;
  for (const n of comp.notes) {
    const prev = steps[steps.length - 1];
    if (prev && Math.abs(prev.beat - n.beat) < SAME_BEAT) {
      if (!prev.tongues.includes(n.tongue)) prev.tongues.push(n.tongue);
      lastDuration = Math.max(lastDuration, n.duration);
    } else {
      if (prev) prev.duration = n.beat - prev.beat;
      steps.push({ beat: n.beat, tongues: [n.tongue], duration: n.duration });
      lastDuration = n.duration;
    }
  }
  if (steps.length) steps[steps.length - 1].duration = lastDuration;
  for (const s of steps) s.tongues.sort();
  return steps;
}

export function stepSeconds(step: Step, bpm: number, tempoFactor: number): number {
  return (step.duration * 60) / (bpm * tempoFactor);
}

export interface PressResult {
  correct: boolean;
  /** Все ноты шага взяты, произошёл переход. */
  stepDone: boolean;
  /** Переход вернул к началу (цикла или композиции). */
  wrapped: boolean;
  /** Композиция пройдена целиком (только без цикла). */
  completed: boolean;
}

export interface AdvanceResult {
  wrapped: boolean;
  completed: boolean;
}

/** Состояние режима разучивания: текущий шаг, цикл, ожидание нужных нот. */
export class PracticeSession {
  index = 0;
  loop: { from: number; to: number } | null = null;
  private pending: Set<string>;

  constructor(readonly steps: readonly Step[]) {
    this.pending = new Set(steps[0]?.tongues ?? []);
  }

  get remaining(): string[] {
    return [...this.pending].sort();
  }

  private get first(): number {
    return this.loop ? this.loop.from : 0;
  }

  private get last(): number {
    return this.loop ? this.loop.to : this.steps.length - 1;
  }

  private clamp(i: number): number {
    return Math.min(this.last, Math.max(this.first, Math.round(i)));
  }

  jump(index: number): void {
    this.index = this.clamp(index);
    this.pending = new Set(this.steps[this.index]?.tongues ?? []);
  }

  setLoop(from: number, to: number): void {
    const max = this.steps.length - 1;
    const c = (v: number) => Math.min(max, Math.max(0, Math.round(v)));
    const a = c(from);
    const b = c(to);
    this.loop = { from: Math.min(a, b), to: Math.max(a, b) };
    if (this.index < this.loop.from || this.index > this.loop.to) this.jump(this.loop.from);
  }

  clearLoop(): void {
    this.loop = null;
  }

  advance(): AdvanceResult {
    if (this.steps.length === 0) return { wrapped: false, completed: false };
    if (this.index >= this.last) {
      const completed = this.loop === null;
      this.jump(this.first);
      return { wrapped: true, completed };
    }
    this.jump(this.index + 1);
    return { wrapped: false, completed: false };
  }

  press(tongue: string): PressResult {
    if (!this.pending.has(tongue)) {
      return { correct: false, stepDone: false, wrapped: false, completed: false };
    }
    this.pending.delete(tongue);
    if (this.pending.size > 0) {
      return { correct: true, stepDone: false, wrapped: false, completed: false };
    }
    return { correct: true, stepDone: true, ...this.advance() };
  }
}
