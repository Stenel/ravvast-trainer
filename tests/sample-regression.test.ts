// Контроль на реальной записи с телефона. Файл лежит в samples/ (в репозиторий не входит),
// поэтому без него тест пропускается.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HitDetector, defaultTemplates } from '../src/core/detector';
import { parseScale } from '../src/core/scale';
import pygmy from '../scales/e-low-pygmy.json';
import { readWav } from './wav';

const SAMPLE = 'samples/phone-play-01.wav';

describe.skipIf(!existsSync(SAMPLE))('реальная запись phone-play-01', () => {
  const ps = parseScale(pygmy);
  if (!ps.ok) throw new Error('scale');
  const tongues = ps.value.tongues;
  const noteOf = (id: string) => tongues.find((t) => t.id === id)?.note ?? id;

  function detect() {
    const { sr, samples } = readWav(SAMPLE);
    const det = new HitDetector({ sampleRate: sr, templates: defaultTemplates(tongues, sr) });
    const hits = [];
    for (let i = 0; i < samples.length; i += 512) {
      for (const e of det.push(samples.subarray(i, i + 512))) if (e.type === 'hit') hits.push(e);
    }
    return { hits, sr };
  }

  it('почти все удары узнаются, без ложных аккордов', () => {
    const { hits } = detect();
    const known = hits.filter((h) => h.tongues.length > 0);
    // Что именно сыграно, достоверно неизвестно; фиксируем то, что слышно в спектре.
    expect(known.length).toBeGreaterThanOrEqual(19);
    expect(hits.length - known.length).toBeLessThanOrEqual(1);
    expect(known.every((h) => h.tongues.length === 1)).toBe(true);
  });

  it('низкие поля E2 и B2 узнаются по обертонам', () => {
    const { hits } = detect();
    const notes = hits.flatMap((h) => h.tongues.map(noteOf));
    expect(notes).toContain('E2');
    expect(notes.filter((n) => n === 'B2').length).toBeGreaterThanOrEqual(3);
  });

  it('в тишине перед игрой (первая секунда) срабатываний нет', () => {
    const { hits, sr } = detect();
    expect(hits.filter((h) => h.frame / sr < 1)).toEqual([]);
  });
});
