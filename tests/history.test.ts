import { describe, expect, it } from 'vitest';
import {
  HISTORY_CAP,
  accuracyTrend,
  addSession,
  dayKey,
  parseHistory,
  secondsOn,
  streak,
  tongueStats,
  type SessionEntry,
} from '../src/core/history';

function entry(over: Partial<SessionEntry> = {}): SessionEntry {
  return {
    day: '2025-03-10',
    compId: 'c1',
    kind: 'game',
    accuracy: 0.8,
    notes: 10,
    seconds: 60,
    hits: {},
    misses: {},
    ...over,
  };
}

describe('dayKey', () => {
  it('дополняет месяц и день нулями', () => {
    expect(dayKey(new Date(2025, 0, 5))).toBe('2025-01-05');
    expect(dayKey(new Date(2025, 11, 31))).toBe('2025-12-31');
  });

  it('использует локальное время', () => {
    expect(dayKey(new Date(2024, 1, 29, 23, 59))).toBe('2024-02-29');
    expect(dayKey(new Date(2024, 2, 1, 0, 0))).toBe('2024-03-01');
  });
});

describe('parseHistory', () => {
  it('не массив даёт пустую историю', () => {
    for (const raw of [null, undefined, 5, 'x', {}, { length: 1 }]) {
      expect(parseHistory(raw)).toEqual([]);
    }
  });

  it('читает корректную запись', () => {
    const e = entry({ hits: { a: 3 }, misses: { b: 2 } });
    expect(parseHistory([e])).toEqual([e]);
  });

  it('отбрасывает битые записи', () => {
    const good = entry();
    const raw = [
      null,
      5,
      'x',
      [],
      { ...good, day: '2025-3-1' },
      { ...good, day: 20250310 },
      { ...good, compId: 7 },
      { ...good, kind: 'other' },
      { ...good, accuracy: 'high' },
      { ...good, accuracy: NaN },
      { ...good, notes: -1 },
      { ...good, seconds: Infinity },
      { ...good, notes: '10' },
      good,
    ];
    expect(parseHistory(raw)).toEqual([good]);
  });

  it('ограничивает точность диапазоном 0..1', () => {
    const out = parseHistory([entry({ accuracy: 1.7 }), entry({ accuracy: -0.3 })]);
    expect(out.map((e) => e.accuracy)).toEqual([1, 0]);
  });

  it('оставляет в hits и misses только неотрицательные конечные числа', () => {
    const raw = [
      {
        ...entry(),
        hits: { a: 2, b: -1, c: 'x', d: Infinity, e: NaN, f: 0 },
        misses: 'oops',
      },
    ];
    const [e] = parseHistory(raw);
    expect({ ...e.hits }).toEqual({ a: 2, f: 0 });
    expect({ ...e.misses }).toEqual({});
  });

  it('hits и misses без прототипа, "__proto__" не ломает разбор', () => {
    const raw = JSON.parse(
      '[{"day":"2025-03-10","compId":"c","kind":"drill","accuracy":1,"notes":1,"seconds":1,' +
        '"hits":{"__proto__":4},"misses":{"__proto__":1}}]',
    );
    const [e] = parseHistory(raw);
    expect(Object.getPrototypeOf(e.hits)).toBeNull();
    expect(Object.getPrototypeOf(e.misses)).toBeNull();
    expect(e.hits['__proto__']).toBe(4);
    expect(e.misses['__proto__']).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('оставляет не больше HISTORY_CAP самых новых записей', () => {
    const raw = Array.from({ length: HISTORY_CAP + 20 }, (_, i) => entry({ notes: i }));
    const out = parseHistory(raw);
    expect(out).toHaveLength(HISTORY_CAP);
    expect(out[0].notes).toBe(20);
    expect(out[out.length - 1].notes).toBe(HISTORY_CAP + 19);
  });
});

describe('addSession', () => {
  it('не меняет исходный массив', () => {
    const h = [entry({ notes: 1 })];
    const out = addSession(h, entry({ notes: 2 }));
    expect(h).toHaveLength(1);
    expect(out).toHaveLength(2);
    expect(out).not.toBe(h);
    expect(out[1].notes).toBe(2);
  });

  it('отбрасывает самые старые записи сверх лимита', () => {
    const h = [entry({ notes: 1 }), entry({ notes: 2 }), entry({ notes: 3 })];
    const out = addSession(h, entry({ notes: 4 }), 3);
    expect(out.map((e) => e.notes)).toEqual([2, 3, 4]);
  });

  it('по умолчанию лимит равен HISTORY_CAP', () => {
    let h: SessionEntry[] = [];
    for (let i = 0; i < HISTORY_CAP + 5; i++) h = addSession(h, entry({ notes: i }));
    expect(h).toHaveLength(HISTORY_CAP);
    expect(h[0].notes).toBe(5);
  });
});

describe('streak', () => {
  const on = (...days: string[]) => days.map((day) => entry({ day }));

  it('пустая история даёт 0', () => {
    expect(streak([], '2025-03-10')).toBe(0);
  });

  it('считает дни подряд до сегодня', () => {
    expect(streak(on('2025-03-08', '2025-03-09', '2025-03-10'), '2025-03-10')).toBe(3);
  });

  it('серия, закончившаяся вчера, ещё считается', () => {
    expect(streak(on('2025-03-08', '2025-03-09'), '2025-03-10')).toBe(2);
  });

  it('пропуск обрывает серию', () => {
    expect(streak(on('2025-03-05', '2025-03-06', '2025-03-08', '2025-03-10'), '2025-03-10')).toBe(1);
  });

  it('если не было ни сегодня, ни вчера, серия 0', () => {
    expect(streak(on('2025-03-07', '2025-03-08'), '2025-03-10')).toBe(0);
  });

  it('несколько записей за день считаются как один день', () => {
    expect(streak(on('2025-03-09', '2025-03-10', '2025-03-10', '2025-03-10'), '2025-03-10')).toBe(2);
  });

  it('работает через границу месяца', () => {
    expect(streak(on('2025-02-27', '2025-02-28', '2025-03-01'), '2025-03-01')).toBe(3);
  });

  it('учитывает високосный год', () => {
    expect(streak(on('2024-02-28', '2024-02-29', '2024-03-01'), '2024-03-01')).toBe(3);
  });

  it('работает через границу года', () => {
    expect(streak(on('2024-12-30', '2024-12-31', '2025-01-01'), '2025-01-01')).toBe(3);
  });

  it('записи не по порядку и из будущего не мешают', () => {
    expect(streak(on('2025-03-10', '2025-03-08', '2025-03-09', '2025-03-12'), '2025-03-10')).toBe(3);
  });
});

describe('secondsOn', () => {
  it('суммирует секунды за день', () => {
    const h = [
      entry({ day: '2025-03-10', seconds: 30 }),
      entry({ day: '2025-03-10', seconds: 45 }),
      entry({ day: '2025-03-09', seconds: 100 }),
    ];
    expect(secondsOn(h, '2025-03-10')).toBe(75);
  });

  it('без записей за день даёт 0', () => {
    expect(secondsOn([], '2025-03-10')).toBe(0);
    expect(secondsOn([entry({ day: '2025-03-09' })], '2025-03-10')).toBe(0);
  });
});

describe('tongueStats', () => {
  it('считает промахи и сортирует по доле промахов, затем по id', () => {
    const h = [
      entry({ hits: { a: 8, b: 5, c: 5, d: 0 }, misses: { a: 2, b: 5, c: 5, d: 10 } }),
    ];
    const stats = tongueStats(h);
    expect(stats.map((s) => s.tongue)).toEqual(['d', 'b', 'c', 'a']);
    expect(stats[0]).toEqual({ tongue: 'd', hits: 0, misses: 10, missRate: 1 });
    expect(stats[3].missRate).toBeCloseTo(0.2);
  });

  it('суммирует по нескольким записям', () => {
    const h = [entry({ hits: { a: 3 }, misses: { a: 1 } }), entry({ hits: { a: 2 }, misses: { a: 4 } })];
    expect(tongueStats(h)).toEqual([{ tongue: 'a', hits: 5, misses: 5, missRate: 0.5 }]);
  });

  it('minAttempts отсекает редкие языки', () => {
    const h = [entry({ hits: { a: 2, b: 10 }, misses: { a: 2 } })];
    expect(tongueStats(h).map((s) => s.tongue)).toEqual(['b']);
    expect(tongueStats(h, 30, 4).map((s) => s.tongue)).toEqual(['a', 'b']);
    expect(tongueStats(h, 30, 11)).toEqual([]);
  });

  it('смотрит только в последние lastSessions записей', () => {
    const h = [
      entry({ hits: { old: 0 }, misses: { old: 10 } }),
      entry({ hits: { a: 5 }, misses: {} }),
      entry({ hits: { b: 5 }, misses: {} }),
    ];
    expect(tongueStats(h, 2).map((s) => s.tongue)).toEqual(['a', 'b']);
    expect(tongueStats(h, 30).map((s) => s.tongue)).toEqual(['old', 'a', 'b']);
  });

  it('по умолчанию окно 30 записей', () => {
    const h = [
      entry({ hits: { old: 0 }, misses: { old: 10 } }),
      ...Array.from({ length: 30 }, () => entry()),
    ];
    expect(tongueStats(h)).toEqual([]);
  });

  it('пустая история и "__proto__" не ломают подсчёт', () => {
    expect(tongueStats([])).toEqual([]);
    const hits = Object.create(null) as Record<string, number>;
    hits['__proto__'] = 6;
    const out = tongueStats([entry({ hits })]);
    expect(out).toEqual([{ tongue: '__proto__', hits: 6, misses: 0, missRate: 0 }]);
  });
});

describe('accuracyTrend', () => {
  const h = [
    entry({ compId: 'a', accuracy: 0.1 }),
    entry({ compId: 'b', accuracy: 0.2 }),
    entry({ compId: 'a', kind: 'drill', accuracy: 0.9 }),
    entry({ compId: 'a', accuracy: 0.3 }),
    entry({ compId: 'a', kind: 'fragment', accuracy: 0.95 }),
    entry({ compId: 'b', accuracy: 0.4 }),
  ];

  it('берёт только игры, от старых к новым', () => {
    expect(accuracyTrend(h)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('фильтрует по композиции', () => {
    expect(accuracyTrend(h, 'a')).toEqual([0.1, 0.3]);
    expect(accuracyTrend(h, 'zzz')).toEqual([]);
  });

  it('оставляет последние last значений', () => {
    expect(accuracyTrend(h, undefined, 2)).toEqual([0.3, 0.4]);
  });

  it('по умолчанию last равен 10', () => {
    const many = Array.from({ length: 15 }, (_, i) => entry({ accuracy: i / 100 }));
    const out = accuracyTrend(many);
    expect(out).toHaveLength(10);
    expect(out[0]).toBeCloseTo(0.05);
  });

  it('пустая история даёт пустой массив', () => {
    expect(accuracyTrend([])).toEqual([]);
  });
});
