import { describe, expect, it } from 'vitest';
import { MUTED_RATIO, clarityPercent, summarizeQuality } from '../src/core/quality';

describe('clarityPercent', () => {
  it('переводит сходство с эталоном в проценты 0–100', () => {
    expect(clarityPercent(1)).toBe(100);
    expect(clarityPercent(0.97)).toBe(100);
    expect(clarityPercent(0.55)).toBe(0);
    expect(clarityPercent(0.2)).toBe(0);
    expect(clarityPercent(0.76)).toBe(50);
  });
});

describe('summarizeQuality', () => {
  it('пустой набор даёт null-показатели', () => {
    expect(summarizeQuality([])).toEqual({
      hits: 0,
      clarity: null,
      evennessDb: null,
      muted: 0,
      meanOffsetMs: null,
    });
  });

  it('считает среднюю чистоту, разброс громкости, заглушённые и среднее отклонение', () => {
    const s = summarizeQuality([
      { clarity: 0.97, levelDb: -20, offsetMs: 30, sustain: 0.5 },
      { clarity: 0.76, levelDb: -24, offsetMs: 50, sustain: MUTED_RATIO - 0.05 },
      { clarity: 0.76, levelDb: -22, offsetMs: 40, sustain: null },
    ]);
    expect(s.hits).toBe(3);
    expect(s.clarity).toBe(67);
    expect(s.evennessDb).toBeCloseTo(1.63, 1);
    expect(s.muted).toBe(1);
    expect(s.meanOffsetMs).toBe(40);
  });

  it('один удар: разброс громкости не определён', () => {
    const s = summarizeQuality([{ clarity: 0.9, levelDb: -20 }]);
    expect(s.evennessDb).toBeNull();
    expect(s.meanOffsetMs).toBeNull();
  });
});
