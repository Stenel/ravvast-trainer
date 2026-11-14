import { describe, expect, it } from 'vitest';
import { noteToFreq, parseScale } from '../src/core/scale';
import pygmy from '../scales/e-low-pygmy.json';
import { rawScale } from './fixtures';

describe('noteToFreq', () => {
  it('считает частоту по названию ноты', () => {
    expect(noteToFreq('A4')).toBeCloseTo(440, 5);
    expect(noteToFreq('A2')).toBeCloseTo(110, 5);
    expect(noteToFreq('E2')).toBeCloseTo(82.407, 2);
    expect(noteToFreq('C4')).toBeCloseTo(261.626, 2);
  });

  it('понимает диезы и бемоли', () => {
    expect(noteToFreq('C#3')).toBeCloseTo(noteToFreq('Db3')!, 8);
    expect(noteToFreq('Bb2')).toBeCloseTo(116.541, 2);
  });

  it('возвращает null для мусора', () => {
    expect(noteToFreq('H2')).toBeNull();
    expect(noteToFreq('E')).toBeNull();
    expect(noteToFreq('')).toBeNull();
  });
});

describe('parseScale', () => {
  it('разбирает корректный строй', () => {
    const r = parseScale(rawScale);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tongues).toHaveLength(3);
    expect(r.value.tongues[0]).toMatchObject({ id: '0', note: 'E2', center: true });
    expect(r.value.tongues[1].freq).toBeCloseTo(110, 5);
    expect(r.value.tongues[1].angle).toBe(200);
  });

  it('разбирает поставляемый строй E Low Pygmy', () => {
    const r = parseScale(pygmy);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tongues.map((t) => t.note)).toEqual([
      'E2', 'A2', 'B2', 'C3', 'E3', 'G3', 'A3', 'B3', 'D4',
    ]);
    expect(r.value.tongues.filter((t) => t.center)).toHaveLength(1);
  });

  it('отклоняет неизвестную ноту', () => {
    const r = parseScale({ ...rawScale, tongues: [{ id: '0', note: 'X9', position: 'center' }] });
    expect(r.ok).toBe(false);
  });

  it('отклоняет повторяющиеся id', () => {
    const r = parseScale({
      ...rawScale,
      tongues: [
        { id: '1', note: 'E2', angle: 0 },
        { id: '1', note: 'A2', angle: 90 },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it('отклоняет боковое поле без угла и не-объект', () => {
    expect(parseScale({ ...rawScale, tongues: [{ id: '1', note: 'E2' }] }).ok).toBe(false);
    expect(parseScale(null).ok).toBe(false);
    expect(parseScale({ id: 'x', name: 'x', tongues: [] }).ok).toBe(false);
  });
});
