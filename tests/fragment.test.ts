import { describe, expect, it } from 'vitest';
import { RAMP_START, nextTempo, sliceComposition, weakestWindow } from '../src/core/fragment';
import type { Composition } from '../src/core/types';

const comp: Composition = {
  id: 'song',
  title: 'Песня',
  scale: 'amara',
  bpm: 90,
  level: 2,
  notes: [
    { tongue: 'a', beat: 0, duration: 1 },
    { tongue: 'b', beat: 2, duration: 1 },
    { tongue: 'c', beat: 4, duration: 1 },
    { tongue: 'd', beat: 4, duration: 1 },
    { tongue: 'e', beat: 6, duration: 2 },
  ],
};

describe('sliceComposition', () => {
  it('начало включительно, конец исключительно', () => {
    const r = sliceComposition(comp, 2, 6);
    expect(r.notes.map((x) => x.tongue)).toEqual(['b', 'c', 'd']);
  });

  it('сдвигает так, что первая нота начинается с 0', () => {
    const r = sliceComposition(comp, 2, 8);
    expect(r.notes.map((x) => x.beat)).toEqual([0, 2, 2, 4]);
    expect(r.notes[3].duration).toBe(2);
  });

  it('аккорды остаются вместе', () => {
    const r = sliceComposition(comp, 4, 5);
    expect(r.notes).toEqual([
      { tongue: 'c', beat: 0, duration: 1 },
      { tongue: 'd', beat: 0, duration: 1 },
    ]);
  });

  it('пустой диапазон даёт пустые ноты', () => {
    expect(sliceComposition(comp, 3, 4).notes).toEqual([]);
    expect(sliceComposition(comp, 5, 5).notes).toEqual([]);
    expect(sliceComposition(comp, 10, 2).notes).toEqual([]);
  });

  it('id, метаданные и отсутствие level', () => {
    const r = sliceComposition(comp, 2, 6);
    expect(r.id).toBe('song#2-6');
    expect(r.title).toBe('Песня');
    expect(r.scale).toBe('amara');
    expect(r.bpm).toBe(90);
    expect('level' in r).toBe(false);
  });

  it('не мутирует исходную композицию', () => {
    const copy = JSON.parse(JSON.stringify(comp));
    sliceComposition(comp, 2, 6);
    expect(comp).toEqual(copy);
  });
});

describe('nextTempo', () => {
  it('повышает темп на шаг при точности не ниже порога', () => {
    expect(nextTempo(0.6, 0.9)).toBe(0.65);
    expect(nextTempo(0.6, 1)).toBe(0.65);
  });

  it('не повышает при точности ниже порога', () => {
    expect(nextTempo(0.6, 0.89)).toBe(0.6);
  });

  it('ограничен максимумом', () => {
    expect(nextTempo(0.98, 1)).toBe(1);
    expect(nextTempo(1, 1)).toBe(1);
    expect(nextTempo(1, 1, { max: 1.2 })).toBe(1.05);
  });

  it('учитывает свои step и pass', () => {
    expect(nextTempo(0.5, 0.7, { step: 0.1, pass: 0.7 })).toBe(0.6);
    expect(nextTempo(0.5, 0.69, { step: 0.1, pass: 0.7 })).toBe(0.5);
  });

  it('нет накопления ошибки float после многих шагов', () => {
    let t = RAMP_START;
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      t = nextTempo(t, 1);
      seen.push(t);
    }
    expect(seen).toEqual([0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1]);
    expect(nextTempo(t, 1)).toBe(1);
  });

  it('RAMP_START равен 0.6', () => {
    expect(RAMP_START).toBe(0.6);
  });
});

describe('weakestWindow', () => {
  it('null, если всё хорошо или вход пуст', () => {
    expect(weakestWindow([0, 1, 2], [false, false, false], 4)).toBeNull();
    expect(weakestWindow([], [], 4)).toBeNull();
  });

  it('все плохие: окно с наибольшим числом, при равенстве — раннее', () => {
    const r = weakestWindow([0, 1, 2, 3], [true, true, true, true], 4);
    expect(r).toEqual({ fromBeat: 0, toBeat: 4, bad: 4 });
  });

  it('находит окно с наибольшим числом плохих', () => {
    const beats = [0, 1, 2, 8, 9, 10, 11];
    const bad = [true, false, false, true, true, true, false];
    expect(weakestWindow(beats, bad, 4)).toEqual({ fromBeat: 8, toBeat: 12, bad: 3 });
  });

  it('ничья уходит самому раннему окну', () => {
    const beats = [0, 1, 10, 11];
    const bad = [true, true, true, true];
    expect(weakestWindow(beats, bad, 2)).toEqual({ fromBeat: 0, toBeat: 2, bad: 2 });
  });

  it('конец окна исключительно', () => {
    const r = weakestWindow([0, 4], [true, true], 4);
    expect(r).toEqual({ fromBeat: 0, toBeat: 4, bad: 1 });
  });

  it('нот меньше окна', () => {
    expect(weakestWindow([0, 1], [false, true], 16)).toEqual({ fromBeat: 0, toBeat: 16, bad: 1 });
  });

  it('аккорды на одном ударе считаются вместе', () => {
    const r = weakestWindow([0, 0, 5], [true, true, true], 2);
    expect(r).toEqual({ fromBeat: 0, toBeat: 2, bad: 2 });
  });
});
