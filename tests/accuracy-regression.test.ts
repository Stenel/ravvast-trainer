// Контроль на размеченной записи «Проверки точности» с телефона: 26 ударов, для каждого
// известно, по какому полю били. Запись лежит в samples/ (в репозиторий не входит),
// без неё тест пропускается.
import { existsSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HitDetector, defaultTemplates } from '../src/core/detector';
import { parseScale } from '../src/core/scale';
import pygmy from '../scales/e-low-pygmy.json';
import { readWav } from './wav';

const SAMPLE = 'samples/accuracy-01.wav';

/** Момент удара в записи (с) и поле. Сверено по спектру: два задания в отчёте были
 * засчитаны по звуку приглушения, настоящие удары шли позже. */
const STRIKES: [number, string][] = [
  [3.31, 'C3'],
  [5.95, 'E2'],
  [8.53, 'B3'],
  [10.97, 'D4'],
  [13.69, 'B2'],
  [16.44, 'E3'],
  [18.05, 'A2'],
  [20.5, 'G3'],
  [23.04, 'A3'],
  [25.48, 'A2'],
  [28.3, 'E3'],
  [30.83, 'B3'],
  [33.46, 'G3'],
  [35.97, 'B2'],
  [38.53, 'D4'],
  [41.08, 'E2'],
  [43.51, 'C3'],
  [45.36, 'B2'],
  [47.99, 'E3'],
  [50.42, 'G3'],
  [53.17, 'B3'],
  [55.7, 'E2'],
  [60.0, 'A2'],
  [64.6, 'D4'],
  [67.09, 'C3'],
  [69.58, 'A3'],
];

describe.skipIf(!existsSync(SAMPLE))('размеченная запись accuracy-01', () => {
  const ps = parseScale(pygmy);
  if (!ps.ok) throw new Error('scale');
  const tongues = ps.value.tongues;
  const noteOf = (id: string) => tongues.find((t) => t.id === id)?.note ?? id;

  function run() {
    const { sr, samples } = readWav(SAMPLE);
    const det = new HitDetector({ sampleRate: sr, templates: defaultTemplates(tongues, sr) });
    const hits = [];
    for (let i = 0; i < samples.length; i += 512) {
      for (const e of det.push(samples.subarray(i, i + 512))) if (e.type === 'hit') hits.push(e);
    }
    const near = (t: number) => STRIKES.find(([s]) => Math.abs(s - t) < 0.15);
    const rows = hits.map((h) => {
      const t = h.frame / sr;
      return {
        t,
        truth: near(t)?.[1] ?? null,
        heard: h.tongues.map(noteOf).join('+'),
        level: h.levelDb,
        novelty: h.novelty,
        scores: h.scores.map((s) => `${noteOf(s.id)} ${s.similarity.toFixed(2)}`).join(', '),
      };
    });
    if (process.env.OUT) {
      writeFileSync(
        process.env.OUT,
        rows
          .map(
            (r) =>
              `${r.t.toFixed(2)} ${r.truth ?? '--'} -> ${r.heard || '-'} ${r.truth && r.heard !== r.truth ? '!!' : !r.truth && r.heard ? 'XX' : ''} lvl ${r.level.toFixed(0)} nov ${r.novelty.toFixed(2)} | ${r.scores}`,
          )
          .join('\n'),
      );
    }
    return rows;
  }

  it('все 26 ударов узнаются верно', () => {
    const rows = run();
    const wrong = STRIKES.filter(
      ([s, note]) => !rows.some((r) => Math.abs(r.t - s) < 0.15 && r.heard === note),
    );
    expect(wrong).toEqual([]);
  });

  it('между ударами (приглушение ладонью, шум) поля не «слышатся»', () => {
    const extra = run().filter((r) => !r.truth && r.heard);
    expect(extra).toEqual([]);
  });
});
