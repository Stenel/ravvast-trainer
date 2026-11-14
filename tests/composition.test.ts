import { describe, expect, it } from 'vitest';
import { parseComposition, parseCompositionJson, toTimedNotes } from '../src/core/composition';
import { parseScale } from '../src/core/scale';
import pygmy from '../scales/e-low-pygmy.json';
import { testScale } from './fixtures';

const scale = testScale();

const valid = {
  id: 'demo',
  title: 'Демо',
  scale: 'test-scale',
  bpm: 120,
  notes: [
    { tongue: '1', beat: 1, duration: 1 },
    { tongue: '0', beat: 0, duration: 0.5 },
    { tongue: '2', beat: 2, duration: 2, note: 'B2' },
  ],
};

describe('parseComposition', () => {
  it('разбирает корректную композицию и сортирует ноты по времени', () => {
    const r = parseComposition(valid, scale);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.title).toBe('Демо');
    expect(r.value.bpm).toBe(120);
    expect(r.value.notes.map((n) => n.tongue)).toEqual(['0', '1', '2']);
  });

  it('принимает числовой номер поля', () => {
    const r = parseComposition({ ...valid, notes: [{ tongue: 1, beat: 0, duration: 1 }] }, scale);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.notes[0].tongue).toBe('1');
  });

  it('подставляет id из названия, если он не задан', () => {
    const { id: _id, ...noId } = valid;
    const r = parseComposition(noId, scale);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe('custom:Демо');
  });

  it('отклоняет неизвестное поле с указанием номера ноты', () => {
    const r = parseComposition({ ...valid, notes: [{ tongue: '9', beat: 0, duration: 1 }] }, scale);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('Нота 1');
  });

  it('отклоняет чужой строй', () => {
    const r = parseComposition({ ...valid, scale: 'd-kurd' }, scale);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(' ')).toContain('d-kurd');
  });

  it('отклоняет неверные темп, длительность и время', () => {
    expect(parseComposition({ ...valid, bpm: 0 }, scale).ok).toBe(false);
    expect(parseComposition({ ...valid, bpm: '120' }, scale).ok).toBe(false);
    expect(
      parseComposition({ ...valid, notes: [{ tongue: '1', beat: 0, duration: 0 }] }, scale).ok,
    ).toBe(false);
    expect(
      parseComposition({ ...valid, notes: [{ tongue: '1', beat: -1, duration: 1 }] }, scale).ok,
    ).toBe(false);
    expect(
      parseComposition({ ...valid, notes: [{ tongue: '1', beat: NaN, duration: 1 }] }, scale).ok,
    ).toBe(false);
  });

  it('отклоняет слишком большие время и длительность', () => {
    expect(
      parseComposition({ ...valid, notes: [{ tongue: '1', beat: 1e7, duration: 1 }] }, scale).ok,
    ).toBe(false);
    expect(
      parseComposition({ ...valid, notes: [{ tongue: '1', beat: 0, duration: 1e7 }] }, scale).ok,
    ).toBe(false);
  });

  it('принимает необязательный уровень 1–3 и отклоняет другие значения', () => {
    const ok = parseComposition({ ...valid, level: 2 }, scale);
    expect(ok.ok && ok.value.level).toBe(2);
    const none = parseComposition(valid, scale);
    expect(none.ok && none.value.level).toBeUndefined();
    expect(parseComposition({ ...valid, level: 5 }, scale).ok).toBe(false);
    expect(parseComposition({ ...valid, level: '1' }, scale).ok).toBe(false);
  });

  it('отклоняет несовпадение ноты и поля', () => {
    const r = parseComposition(
      { ...valid, notes: [{ tongue: '1', beat: 0, duration: 1, note: 'B2' }] },
      scale,
    );
    expect(r.ok).toBe(false);
  });

  it('отклоняет пустой список нот, пустое название и не-объект', () => {
    expect(parseComposition({ ...valid, notes: [] }, scale).ok).toBe(false);
    expect(parseComposition({ ...valid, title: '  ' }, scale).ok).toBe(false);
    expect(parseComposition([], scale).ok).toBe(false);
    expect(parseComposition(null, scale).ok).toBe(false);
  });

  it('собирает несколько ошибок сразу', () => {
    const r = parseComposition({ ...valid, bpm: -5, title: '' }, scale);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('parseCompositionJson', () => {
  it('разбирает текст JSON', () => {
    expect(parseCompositionJson(JSON.stringify(valid), scale).ok).toBe(true);
  });

  it('сообщает о битом JSON', () => {
    const r = parseCompositionJson('{ not json', scale);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toContain('JSON');
  });
});

describe('toTimedNotes', () => {
  it('переводит доли в секунды с учётом темпа', () => {
    const r = parseComposition(valid, scale);
    if (!r.ok) throw new Error('fixture');
    const notes = toTimedNotes(r.value);
    expect(notes.map((n) => n.time)).toEqual([0, 0.5, 1]);
    expect(notes[2].duration).toBe(1);
    const slow = toTimedNotes(r.value, 0.5);
    expect(slow.map((n) => n.time)).toEqual([0, 1, 2]);
  });
});

describe('поставляемые примеры', () => {
  const files = import.meta.glob('../compositions/*.json', { eager: true, import: 'default' });
  const ps = parseScale(pygmy);
  if (!ps.ok) throw new Error('scale');

  it('в комплекте восемнадцать композиций', () => {
    expect(Object.keys(files)).toHaveLength(18);
  });

  for (const [path, raw] of Object.entries(files)) {
    it(`${path} проходит проверку`, () => {
      const r = parseComposition(raw, ps.value);
      expect(r.ok ? [] : r.errors).toEqual([]);
    });
  }
});
