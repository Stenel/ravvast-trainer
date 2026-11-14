import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, GameSession, gradeOffset, multiplier } from '../src/core/judge';
import type { TimedNote } from '../src/core/types';

const n = (tongue: string, time: number): TimedNote => ({ tongue, time, duration: 0.5 });

describe('gradeOffset', () => {
  const d = DIFFICULTIES.normal;

  it('оценивает по абсолютному отклонению', () => {
    expect(gradeOffset(0, 'normal')).toBe('perfect');
    expect(gradeOffset(d.perfect, 'normal')).toBe('perfect');
    expect(gradeOffset(-d.perfect, 'normal')).toBe('perfect');
    expect(gradeOffset(d.perfect + 0.001, 'normal')).toBe('good');
    expect(gradeOffset(-d.good, 'normal')).toBe('good');
    expect(gradeOffset(d.good + 0.001, 'normal')).toBe('miss');
  });

  it('окна сужаются с ростом сложности', () => {
    expect(DIFFICULTIES.easy.perfect).toBeGreaterThan(DIFFICULTIES.normal.perfect);
    expect(DIFFICULTIES.normal.perfect).toBeGreaterThan(DIFFICULTIES.hard.perfect);
    expect(DIFFICULTIES.easy.good).toBeGreaterThan(DIFFICULTIES.hard.good);
    expect(gradeOffset(0.1, 'easy')).toBe('perfect');
    expect(gradeOffset(0.1, 'hard')).toBe('good');
  });
});

describe('multiplier', () => {
  it('растёт каждые 10 попаданий и ограничен x4', () => {
    expect(multiplier(0)).toBe(1);
    expect(multiplier(9)).toBe(1);
    expect(multiplier(10)).toBe(2);
    expect(multiplier(29)).toBe(3);
    expect(multiplier(30)).toBe(4);
    expect(multiplier(500)).toBe(4);
  });
});

describe('GameSession', () => {
  it('начисляет очки за точное и неточное попадание', () => {
    const s = new GameSession([n('1', 1), n('2', 2)], 'normal');
    expect(s.hit('1', 1.01)).toMatchObject({ grade: 'perfect', index: 0 });
    expect(s.score).toBe(100);
    expect(s.hit('2', 2.12)).toMatchObject({ grade: 'good', index: 1 });
    expect(s.score).toBe(150);
    expect(s.combo).toBe(2);
    expect(s.counts).toEqual({ perfect: 1, good: 1, miss: 0 });
    expect(s.finished).toBe(true);
    expect(s.accuracy).toBe(1);
  });

  it('удар по чужому полю или вне окна — промах мимо, комбо сбрасывается', () => {
    const s = new GameSession([n('1', 1), n('1', 2)], 'normal');
    s.hit('1', 1);
    expect(s.combo).toBe(1);
    expect(s.hit('2', 2)).toEqual({ grade: 'stray' });
    expect(s.combo).toBe(0);
    expect(s.hit('1', 1.5)).toEqual({ grade: 'stray' });
    expect(s.score).toBe(100);
    expect(s.state(1)).toBe('pending');
  });

  it('одну ноту нельзя засчитать дважды', () => {
    const s = new GameSession([n('1', 1)], 'normal');
    expect(s.hit('1', 1).grade).toBe('perfect');
    expect(s.hit('1', 1.02).grade).toBe('stray');
    expect(s.score).toBe(100);
  });

  it('из двух близких нот одного поля засчитывается более ранняя', () => {
    const s = new GameSession([n('1', 1), n('1', 1.1)], 'normal');
    expect(s.hit('1', 1.05)).toMatchObject({ index: 0 });
    expect(s.hit('1', 1.1)).toMatchObject({ index: 1 });
  });

  it('update помечает пропущенные ноты и сбрасывает комбо', () => {
    const s = new GameSession([n('1', 1), n('2', 2), n('1', 3)], 'normal');
    s.hit('1', 1);
    expect(s.update(2.1)).toEqual([]);
    expect(s.update(2 + DIFFICULTIES.normal.good + 0.01)).toEqual([1]);
    expect(s.combo).toBe(0);
    expect(s.state(1)).toBe('miss');
    expect(s.counts.miss).toBe(1);
    expect(s.finished).toBe(false);
    expect(s.update(10)).toEqual([2]);
    expect(s.finished).toBe(true);
    expect(s.accuracy).toBeCloseTo(1 / 3, 5);
  });

  it('пропущенную ноту уже нельзя взять', () => {
    const s = new GameSession([n('1', 1)], 'normal');
    s.update(5);
    expect(s.hit('1', 1).grade).toBe('stray');
  });

  it('множитель применяется к очкам, запоминается лучшее комбо', () => {
    const notes = Array.from({ length: 12 }, (_, i) => n('1', i + 1));
    const s = new GameSession(notes, 'normal');
    for (let i = 0; i < 12; i++) s.hit('1', i + 1);
    // 10 нот по 100, затем две по 200
    expect(s.score).toBe(10 * 100 + 2 * 200);
    expect(s.maxCombo).toBe(12);
    s.hit('2', 13);
    expect(s.combo).toBe(0);
    expect(s.maxCombo).toBe(12);
  });

  it('пустая сессия сразу завершена с нулевой точностью', () => {
    const s = new GameSession([], 'easy');
    expect(s.finished).toBe(true);
    expect(s.accuracy).toBe(0);
  });
});
