import { describe, expect, it } from 'vitest';
import { voicePartials } from '../src/core/tone';

describe('voicePartials — составляющие звука для синтезатора', () => {
  it('поднимает основной тон, ослабленный микрофоном телефона', () => {
    const e2 = voicePartials(82.4, [
      [1, 0.06],
      [3, 1],
    ]);
    const fundamental = e2.find((p) => p.ratio === 1)!;
    const third = e2.find((p) => p.ratio === 3)!;
    expect(fundamental.gain / third.gain).toBeCloseTo(0.6, 5);
  });

  it('добавляет основной тон, если его нет в измеренном спектре', () => {
    const v = voicePartials(110, [[3, 1]]);
    expect(v.map((p) => p.ratio)).toEqual([1, 3]);
  });

  it('обертоны гаснут быстрее основного тона', () => {
    const v = voicePartials(164.8, [
      [1, 1],
      [2, 0.5],
      [5.76, 0.5],
    ]);
    expect(v[0].decay).toBeGreaterThan(v[1].decay);
    expect(v[1].decay).toBeGreaterThan(v[2].decay);
  });

  it('низкое поле звучит дольше высокого, и оба — несколько секунд', () => {
    const low = voicePartials(82.4, [[1, 1]])[0].decay;
    const high = voicePartials(293.7, [[1, 1]])[0].decay;
    expect(low).toBeGreaterThan(high);
    expect(high).toBeGreaterThanOrEqual(5);
    expect(low).toBeLessThanOrEqual(10);
  });

  it('суммарная громкость ограничена при любом числе составляющих', () => {
    const v = voicePartials(110, [
      [1, 1],
      [2, 1],
      [3, 1],
      [6, 1],
      [7.28, 1],
    ]);
    expect(v.reduce((s, p) => s + p.gain, 0)).toBeLessThanOrEqual(1 / 0.6 + 1e-9);
  });

  it('без измеренного спектра использует модель по умолчанию', () => {
    expect(voicePartials(220).map((p) => p.ratio)).toEqual([1, 2, 3]);
  });
});
