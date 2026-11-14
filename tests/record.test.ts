import { describe, expect, it } from 'vitest';
import { parseComposition } from '../src/core/composition';
import { RECORD_BPM, hitsToComposition } from '../src/core/record';
import { testScale } from './fixtures';

describe('hitsToComposition', () => {
  it('без ударов композиции нет', () => {
    expect(hitsToComposition([], 'x', 's')).toBeNull();
  });

  it('переводит время в доли по сетке и считает длительности до следующей ноты', () => {
    // при 120 уд/мин доля = 500 мс
    const c = hitsToComposition(
      [
        { tongue: '1', timeMs: 1000 },
        { tongue: '2', timeMs: 1510 },
        { tongue: '0', timeMs: 2240 },
        { tongue: '1', timeMs: 9000 },
      ],
      '  Проба  ',
      'test-scale',
    );
    expect(c).not.toBeNull();
    expect(c!.title).toBe('Проба');
    expect(c!.id).toBe('custom:Проба');
    expect(c!.bpm).toBe(RECORD_BPM);
    expect(c!.notes).toEqual([
      { tongue: '1', beat: 0, duration: 1 },
      { tongue: '2', beat: 1, duration: 1.5 },
      { tongue: '0', beat: 2.5, duration: 4 },
      { tongue: '1', beat: 16, duration: 2 },
    ]);
  });

  it('одновременные удары становятся аккордом, дубли убираются', () => {
    const c = hitsToComposition(
      [
        { tongue: '2', timeMs: 20 },
        { tongue: '1', timeMs: 0 },
        { tongue: '1', timeMs: 30 },
        { tongue: '0', timeMs: 500 },
      ],
      '',
      'test-scale',
    );
    expect(c!.title).toBe('Моя запись');
    expect(c!.notes).toEqual([
      { tongue: '1', beat: 0, duration: 1 },
      { tongue: '2', beat: 0, duration: 1 },
      { tongue: '0', beat: 1, duration: 2 },
    ]);
  });

  it('результат проходит проверку формата композиций', () => {
    const c = hitsToComposition(
      [
        { tongue: '0', timeMs: 0 },
        { tongue: '2', timeMs: 730 },
      ],
      'Запись',
      'test-scale',
    );
    const r = parseComposition(c, testScale());
    expect(r.ok ? [] : r.errors).toEqual([]);
  });
});
