import { describe, expect, it } from 'vitest';
import { PracticeSession, buildSteps, stepSeconds } from '../src/core/practice';
import type { Composition } from '../src/core/types';

const comp: Composition = {
  id: 'c',
  title: 'c',
  scale: 's',
  bpm: 60,
  notes: [
    { tongue: '0', beat: 0, duration: 1 },
    { tongue: '1', beat: 1, duration: 1 },
    { tongue: '2', beat: 1, duration: 2 },
    { tongue: '1', beat: 3, duration: 0.5 },
    { tongue: '0', beat: 3.5, duration: 2 },
  ],
};

describe('buildSteps', () => {
  it('объединяет одновременные ноты в один шаг', () => {
    const steps = buildSteps(comp);
    expect(steps.map((s) => s.tongues)).toEqual([['0'], ['1', '2'], ['1'], ['0']]);
  });

  it('длительность шага — до следующего шага, у последнего — длительность ноты', () => {
    const steps = buildSteps(comp);
    expect(steps.map((s) => s.duration)).toEqual([1, 2, 0.5, 2]);
  });
});

describe('stepSeconds', () => {
  it('учитывает темп композиции и множитель темпа', () => {
    const [first] = buildSteps(comp);
    expect(stepSeconds(first, 60, 1)).toBe(1);
    expect(stepSeconds(first, 120, 1)).toBe(0.5);
    expect(stepSeconds(first, 60, 0.5)).toBe(2);
  });
});

describe('PracticeSession', () => {
  const make = () => new PracticeSession(buildSteps(comp));

  it('переходит дальше только после правильной ноты', () => {
    const s = make();
    expect(s.press('1')).toMatchObject({ correct: false, stepDone: false });
    expect(s.index).toBe(0);
    expect(s.press('0')).toMatchObject({ correct: true, stepDone: true, completed: false });
    expect(s.index).toBe(1);
  });

  it('аккорд требует все ноты шага', () => {
    const s = make();
    s.press('0');
    expect(s.press('2')).toMatchObject({ correct: true, stepDone: false });
    expect(s.remaining).toEqual(['1']);
    expect(s.press('2')).toMatchObject({ correct: false });
    expect(s.press('1')).toMatchObject({ correct: true, stepDone: true });
    expect(s.index).toBe(2);
  });

  it('после последнего шага композиция пройдена и начинается сначала', () => {
    const s = make();
    s.press('0');
    s.press('1');
    s.press('2');
    s.press('1');
    expect(s.press('0')).toMatchObject({ correct: true, completed: true, wrapped: true });
    expect(s.index).toBe(0);
    expect(s.remaining).toEqual(['0']);
  });

  it('цикл возвращает к началу фрагмента и не засчитывает прохождение', () => {
    const s = make();
    s.setLoop(1, 2);
    expect(s.index).toBe(1);
    s.press('1');
    s.press('2');
    expect(s.press('1')).toMatchObject({ stepDone: true, wrapped: true, completed: false });
    expect(s.index).toBe(1);
  });

  it('границы цикла нормализуются и ограничиваются', () => {
    const s = make();
    s.setLoop(9, -3);
    expect(s.loop).toEqual({ from: 0, to: 3 });
    s.setLoop(3, 2);
    expect(s.loop).toEqual({ from: 2, to: 3 });
    expect(s.index).toBe(2);
    s.clearLoop();
    expect(s.loop).toBeNull();
  });

  it('advance двигает шаг без нажатий (режим без ожидания)', () => {
    const s = make();
    expect(s.advance()).toEqual({ wrapped: false, completed: false });
    expect(s.index).toBe(1);
    s.advance();
    s.advance();
    expect(s.advance()).toEqual({ wrapped: true, completed: true });
    expect(s.index).toBe(0);
  });

  it('jump переходит к шагу в допустимых пределах', () => {
    const s = make();
    s.jump(2);
    expect(s.index).toBe(2);
    s.jump(99);
    expect(s.index).toBe(3);
    s.setLoop(1, 2);
    s.jump(0);
    expect(s.index).toBe(1);
  });
});
