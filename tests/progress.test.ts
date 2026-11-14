import { describe, expect, it } from 'vitest';
import { PASS_ACCURACY, loadProgress, markCompleted, recordGame } from '../src/core/progress';

function memoryStore(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe('progress', () => {
  it('пустое хранилище даёт пустой прогресс', () => {
    expect(loadProgress(memoryStore())).toEqual({ best: {}, completed: [] });
  });

  it('битые данные не ломают загрузку', () => {
    const key = 'ravvast-trainer:progress:v1';
    expect(loadProgress(memoryStore({ [key]: '{oops' }))).toEqual({ best: {}, completed: [] });
    expect(loadProgress(memoryStore({ [key]: '"str"' }))).toEqual({ best: {}, completed: [] });
    expect(loadProgress(memoryStore({ [key]: '{"best":5,"completed":"x"}' }))).toEqual({
      best: {},
      completed: [],
    });
  });

  it('сохраняет лучший счёт по композиции и сложности', () => {
    const st = memoryStore();
    expect(recordGame(st, 'a', 'normal', 500, 0.5).isRecord).toBe(true);
    expect(recordGame(st, 'a', 'normal', 300, 0.9).isRecord).toBe(false);
    expect(recordGame(st, 'a', 'hard', 100, 0.2).isRecord).toBe(true);
    const p = loadProgress(st);
    expect(p.best.a.normal).toEqual({ score: 500, accuracy: 0.5 });
    expect(p.best.a.hard).toEqual({ score: 100, accuracy: 0.2 });
  });

  it('игра с достаточной точностью отмечает композицию пройденной', () => {
    const st = memoryStore();
    recordGame(st, 'a', 'easy', 10, PASS_ACCURACY - 0.01);
    expect(loadProgress(st).completed).toEqual([]);
    recordGame(st, 'a', 'easy', 5, PASS_ACCURACY);
    expect(loadProgress(st).completed).toEqual(['a']);
  });

  it('id вроде "__proto__" не портит прототип и чужие результаты', () => {
    const st = memoryStore();
    recordGame(st, '__proto__', 'normal', 900, 1);
    recordGame(st, 'constructor', 'easy', 5, 1);
    expect(({} as Record<string, unknown>).normal).toBeUndefined();
    const p = loadProgress(st);
    expect(p.best['__proto__'].normal).toEqual({ score: 900, accuracy: 1 });
    expect(p.best['constructor']?.easy).toEqual({ score: 5, accuracy: 1 });
    expect(p.best.other).toBeUndefined();
    expect(recordGame(st, 'other', 'normal', 1, 0).isRecord).toBe(true);
  });

  it('markCompleted не дублирует записи', () => {
    const st = memoryStore();
    markCompleted(st, 'a');
    markCompleted(st, 'a');
    markCompleted(st, 'b');
    expect(loadProgress(st).completed).toEqual(['a', 'b']);
  });

  it('ошибка записи в хранилище не роняет приложение', () => {
    const st = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => recordGame(st, 'a', 'easy', 1, 1)).not.toThrow();
  });
});
