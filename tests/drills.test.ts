import { describe, expect, it } from 'vitest';
import { parseComposition } from '../src/core/composition';
import { focusDrill, generateDrills } from '../src/core/drills';
import { parseScale } from '../src/core/scale';
import type { Composition, Scale } from '../src/core/types';
import pygmy from '../scales/e-low-pygmy.json';

const parsed = parseScale(pygmy);
if (!parsed.ok) throw new Error('scale');
const scale: Scale = parsed.value;
const byId = new Map(scale.tongues.map((t) => [t.id, t]));

const small: Scale = {
  id: 'small',
  name: 'Малый',
  tongues: [
    { id: 'c', note: 'E2', freq: 82.4, center: true, angle: 0 },
    { id: 'a', note: 'A2', freq: 110, center: false, angle: 0 },
    { id: 'b', note: 'C3', freq: 130.8, center: false, angle: 90 },
    { id: 'd', note: 'E3', freq: 164.8, center: false, angle: 180 },
    { id: 'e', note: 'G3', freq: 196, center: false, angle: 270 },
  ],
};

/** Общие проверки: любая сгенерированная композиция должна им удовлетворять. */
function checkCommon(comp: Composition, sc: Scale) {
  const r = parseComposition(comp, sc);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  expect(comp.scale).toBe(sc.id);
  expect(comp.title.length).toBeGreaterThan(0);
  expect(comp.bpm).toBeGreaterThanOrEqual(60);
  expect(comp.bpm).toBeLessThanOrEqual(90);
  expect(comp.notes.length).toBeGreaterThanOrEqual(16);
  expect(comp.notes.length).toBeLessThanOrEqual(48);

  const beats = comp.notes.map((n) => n.beat);
  expect(new Set(beats).size).toBe(beats.length);
  expect([...beats].sort((a, b) => a - b)).toEqual(beats);

  const last = new Map<string, number>();
  for (const n of comp.notes) {
    const prev = last.get(n.tongue);
    if (prev !== undefined) expect(n.beat - prev).toBeGreaterThanOrEqual(2);
    last.set(n.tongue, n.beat);
  }

  const centre = sc.tongues.find((t) => t.center)!;
  const b3 = sc.tongues.find((t) => t.note === 'B3');
  if (b3) {
    for (const x of comp.notes) {
      for (const y of comp.notes) {
        if (x.tongue === centre.id && y.tongue === b3.id) {
          expect(Math.abs(x.beat - y.beat)).toBeGreaterThanOrEqual(2);
        }
      }
    }
  }
}

const angDist = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

describe('generateDrills на реальном строе', () => {
  const drills = generateDrills(scale);
  const find = (slug: string) => {
    const d = drills.find((x) => x.id === `drill:${slug}`);
    if (!d) throw new Error(slug);
    return d;
  };

  it('даёт не меньше пяти упражнений с уникальными id и русскими названиями', () => {
    expect(drills.length).toBeGreaterThanOrEqual(5);
    const ids = drills.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of drills) {
      expect(d.id.startsWith('drill:')).toBe(true);
      expect(d.title).toMatch(/[А-Яа-яЁё]/);
      expect([1, 2, 3]).toContain(d.level);
    }
  });

  it('каждое упражнение проходит все музыкальные ограничения', () => {
    for (const d of drills) checkCommon(d, scale);
  });

  it('детерминировано: два вызова дают равные результаты', () => {
    expect(generateDrills(scale)).toEqual(generateDrills(scale));
  });

  it('гамма: по высоте вверх, затем вниз, все поля задействованы', () => {
    const d = find('scale');
    const freqs = d.notes.map((n) => byId.get(n.tongue)!.freq);
    const top = freqs.indexOf(Math.max(...freqs));
    for (let i = 1; i <= top; i++) expect(freqs[i]).toBeGreaterThan(freqs[i - 1]);
    for (let i = top + 1; i < freqs.length; i++) expect(freqs[i]).toBeLessThan(freqs[i - 1]);
    expect(top).toBeGreaterThan(0);
    expect(top).toBeLessThan(freqs.length - 1);
    expect(new Set(d.notes.map((n) => n.tongue)).size).toBe(scale.tongues.length);
  });

  it('круг: сначала по часовой стрелке, затем против', () => {
    const d = find('ring');
    const angles = d.notes.map((n) => byId.get(n.tongue)!.angle);
    expect(d.notes.every((n) => !byId.get(n.tongue)!.center)).toBe(true);
    for (let i = 1; i < 8; i++) expect((angles[i] - angles[i - 1] + 360) % 360).toBe(45);
    for (let i = 9; i < 16; i++) expect((angles[i - 1] - angles[i] + 360) % 360).toBe(45);
  });

  it('руки: левая и правая половины круга чередуются', () => {
    const d = find('hands');
    const left = (id: string) => byId.get(id)!.angle >= 180;
    d.notes.forEach((n, i) => expect(left(n.tongue)).toBe(i % 2 === 0));
    expect(d.notes.some((n) => !byId.get(n.tongue)!.center)).toBe(true);
  });

  it('прыжки: пары нот лежат на противоположных сторонах круга', () => {
    const d = find('jumps');
    for (let i = 0; i + 1 < d.notes.length; i += 2) {
      const a = byId.get(d.notes[i].tongue)!;
      const b = byId.get(d.notes[i + 1].tongue)!;
      expect(angDist(a.angle, b.angle)).toBeGreaterThanOrEqual(135);
    }
  });

  it('пульс: центр каждые 4 доли, между ним поля круга', () => {
    const d = find('pulse');
    const centre = scale.tongues.find((t) => t.center)!;
    const last = d.notes[d.notes.length - 1].beat;
    for (let b = 0; b <= last; b += 4) {
      expect(d.notes.find((n) => n.beat === b)?.tongue).toBe(centre.id);
    }
    for (const n of d.notes) {
      if (n.tongue === centre.id) expect(n.beat % 4).toBe(0);
      else expect(n.beat % 4).not.toBe(0);
    }
    expect(d.notes.filter((n) => n.tongue !== centre.id).length).toBeGreaterThan(8);
  });

  it('восьмые: длительность 0.5, шаблон из трёх полей', () => {
    const d = find('eighths');
    expect(d.notes.every((n) => n.duration === 0.5)).toBe(true);
    expect(d.notes.some((n) => n.beat % 1 === 0.5)).toBe(true);
    expect(new Set(d.notes.slice(0, 6).map((n) => n.tongue)).size).toBe(3);
  });
});

describe('focusDrill', () => {
  const inputs: string[][] = [['1'], ['2', '5'], ['0', '7'], ['1', '3', '5', '7'], ['0', '4', '7', '8']];

  for (const ids of inputs) {
    it(`слабые поля ${ids.join(',')}: ограничения и повторы`, () => {
      const d = focusDrill(scale, ids)!;
      expect(d).not.toBeNull();
      expect(d.id).toBe('drill:focus');
      expect(d.title).toBe('Слабые поля');
      expect([1, 2, 3]).toContain(d.level);
      checkCommon(d, scale);
      for (const id of ids) {
        expect(d.notes.filter((n) => n.tongue === id).length).toBeGreaterThanOrEqual(4);
      }
      expect(focusDrill(scale, ids)).toEqual(d);
    });
  }

  it('чередует слабые поля с другими', () => {
    const d = focusDrill(scale, ['3'])!;
    expect(new Set(d.notes.map((n) => n.tongue)).size).toBeGreaterThan(1);
  });

  it('игнорирует неизвестные id и повторы, берёт не больше четырёх', () => {
    const d = focusDrill(scale, ['zzz', '2', '2', '4'])!;
    expect(d.notes.filter((n) => n.tongue === '2').length).toBeGreaterThanOrEqual(4);
    expect(d.notes.filter((n) => n.tongue === '4').length).toBeGreaterThanOrEqual(4);
    const many = focusDrill(scale, ['1', '2', '3', '4', '5', '6'])!;
    checkCommon(many, scale);
    expect(many.notes.filter((n) => n.tongue === '5').length).toBeLessThan(
      many.notes.filter((n) => n.tongue === '1').length,
    );
  });

  it('возвращает null без допустимых id', () => {
    expect(focusDrill(scale, [])).toBeNull();
    expect(focusDrill(scale, ['x', 'y'])).toBeNull();
  });
});

describe('малый синтетический строй', () => {
  it('центр и четыре поля круга: все упражнения корректны', () => {
    const drills = generateDrills(small);
    expect(drills.length).toBeGreaterThanOrEqual(5);
    expect(new Set(drills.map((d) => d.id)).size).toBe(drills.length);
    for (const d of drills) checkCommon(d, small);
    checkCommon(focusDrill(small, ['a', 'd'])!, small);
    checkCommon(focusDrill(small, ['c'])!, small);
    expect(generateDrills(small)).toEqual(drills);
  });
});
