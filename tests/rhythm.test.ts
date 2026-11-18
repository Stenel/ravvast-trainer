import { describe, expect, it } from 'vitest';
import { parseComposition, toTimedNotes } from '../src/core/composition';
import { dynamicsDrills, dynamicsReport, rhythmDrills, timingSpread } from '../src/core/rhythm';
import { parseScale } from '../src/core/scale';
import pygmy from '../scales/e-low-pygmy.json';

const ps = parseScale(pygmy);
if (!ps.ok) throw new Error('scale');
const scale = ps.value;
const centre = scale.tongues.find((t) => t.center)!.id;

describe('упражнения на ритм', () => {
  const drills = rhythmDrills(scale);

  it('бьют только по центральному полю, по одной ноте за раз', () => {
    expect(drills.length).toBeGreaterThanOrEqual(4);
    for (const d of drills) {
      expect(d.notes.every((n) => n.tongue === centre)).toBe(true);
      const beats = d.notes.map((n) => n.beat);
      expect(new Set(beats).size).toBe(beats.length);
      expect(beats).toEqual([...beats].sort((a, b) => a - b));
    }
  });

  it('проходят проверку формата, идентификаторы уникальны, результат повторяем', () => {
    for (const d of drills) expect(parseComposition(d, scale).ok).toBe(true);
    expect(new Set(drills.map((d) => d.id)).size).toBe(drills.length);
    expect(drills.every((d) => d.id.startsWith('drill:'))).toBe(true);
    expect(rhythmDrills(scale)).toEqual(drills);
  });

  it('первое упражнение — ровный пульс: одинаковые промежутки', () => {
    const gaps = drills[0].notes.slice(1).map((n, i) => n.beat - drills[0].notes[i].beat);
    expect(new Set(gaps).size).toBe(1);
  });

  it('удары не чаще, чем раз в 0,4 секунды', () => {
    for (const d of drills) {
      const t = toTimedNotes(d);
      for (let i = 1; i < t.length; i++) expect(t[i].time - t[i - 1].time).toBeGreaterThanOrEqual(0.4);
    }
  });
});

describe('упражнения на динамику', () => {
  const drills = dynamicsDrills(scale);

  it('у каждой ноты указана громкость, тихих и громких хватает', () => {
    expect(drills.length).toBeGreaterThanOrEqual(2);
    for (const d of drills) {
      expect(d.notes.every((n) => n.dyn === 'soft' || n.dyn === 'loud')).toBe(true);
      expect(d.notes.filter((n) => n.dyn === 'soft').length).toBeGreaterThanOrEqual(4);
      expect(d.notes.filter((n) => n.dyn === 'loud').length).toBeGreaterThanOrEqual(4);
    }
  });

  it('на каждом поле есть и тихий, и громкий удар — иначе их не с чем сравнить', () => {
    for (const d of drills) {
      for (const id of new Set(d.notes.map((n) => n.tongue))) {
        const kinds = new Set(d.notes.filter((n) => n.tongue === id).map((n) => n.dyn));
        expect(kinds.size).toBe(2);
      }
    }
  });

  it('громкость переживает разбор формата и перевод в секунды', () => {
    for (const d of drills) {
      const r = parseComposition(d, scale);
      expect(r.ok && r.value.notes.map((n) => n.dyn)).toEqual(d.notes.map((n) => n.dyn));
      expect(toTimedNotes(d).map((n) => n.dyn)).toEqual(d.notes.map((n) => n.dyn));
    }
    expect(dynamicsDrills(scale)).toEqual(drills);
  });

  it('неизвестная громкость в файле отбрасывается, а не ломает импорт', () => {
    const r = parseComposition(
      { title: 'x', scale: scale.id, bpm: 60, notes: [{ tongue: centre, beat: 0, duration: 1, dyn: 'очень' }] },
      scale,
    );
    expect(r.ok && r.value.notes[0].dyn).toBeUndefined();
  });
});

describe('ровность ритма', () => {
  it('считает среднее смещение и разброс в миллисекундах', () => {
    const r = timingSpread([0.02, 0.04, null, 0.06]);
    expect(r?.meanMs).toBe(40);
    expect(r?.spreadMs).toBe(16);
    expect(r?.hits).toBe(3);
  });

  it('без хотя бы двух попаданий оценки нет', () => {
    expect(timingSpread([])).toBeNull();
    expect(timingSpread([null, 0.01])).toBeNull();
  });
});

describe('контраст громкости', () => {
  const hit = (tongue: string, dyn: 'soft' | 'loud', levelDb: number) => ({ tongue, dyn, levelDb });

  it('сравнивает тихие и громкие удары по одному и тому же полю', () => {
    const r = dynamicsReport([
      hit('0', 'loud', -12),
      hit('0', 'soft', -24),
      hit('0', 'loud', -14),
      hit('0', 'soft', -22),
      // Другое поле само по себе тише — на оценку это влиять не должно.
      hit('5', 'loud', -30),
      hit('5', 'soft', -40),
    ]);
    expect(r?.contrastDb).toBeCloseTo(10);
    expect(r?.total).toBe(6);
    expect(r?.correct).toBe(6);
  });

  it('удар не той громкости считается ошибкой', () => {
    const r = dynamicsReport([
      hit('0', 'loud', -12),
      hit('0', 'loud', -12),
      hit('0', 'soft', -24),
      hit('0', 'soft', -12),
    ]);
    expect(r?.total).toBe(4);
    expect(r?.correct).toBeLessThan(4);
  });

  it('если на поле нет ударов обеих громкостей, оценки нет', () => {
    expect(dynamicsReport([])).toBeNull();
    expect(dynamicsReport([hit('0', 'loud', -10), hit('1', 'soft', -30)])).toBeNull();
  });
});
