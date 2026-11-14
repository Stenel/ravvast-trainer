// Офлайн-разбор диагностической записи. Запуск (PowerShell):
//   $env:WAV='путь\к\файлу.wav'; $env:OUT='отчёт.txt'; npx vitest run tests/analyze-wav.test.ts
// Без переменной WAV тест пропускается.
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { HitDetector, defaultTemplates, fft } from '../src/core/detector';
import { parseScale } from '../src/core/scale';
import pygmy from '../scales/e-low-pygmy.json';

function readWav(path: string): { sr: number; samples: Float32Array } {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 12;
  let sr = 48000;
  let channels = 1;
  let bits = 16;
  while (pos + 8 <= view.byteLength) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = view.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      channels = view.getUint16(pos + 10, true);
      sr = view.getUint32(pos + 12, true);
      bits = view.getUint16(pos + 22, true);
    } else if (id === 'data') {
      const step = (bits / 8) * channels;
      const n = Math.floor(Math.min(size, view.byteLength - pos - 8) / step);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = view.getInt16(pos + 8 + i * step, true) / 32768;
      return { sr, samples };
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error('В файле нет блока data');
}

function peaks(samples: Float32Array, start: number, sr: number, count = 6): string {
  const N = 16384;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const len = 8192;
  for (let i = 0; i < len; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1));
    re[i] = (samples[start + i] ?? 0) * w;
  }
  fft(re, im);
  const df = sr / N;
  const mag: number[] = [];
  for (let k = 0; k < N / 2; k++) mag.push(Math.hypot(re[k], im[k]));
  const found: { f: number; m: number }[] = [];
  for (let k = Math.ceil(50 / df); k < Math.floor(2500 / df); k++) {
    if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) found.push({ f: k * df, m: mag[k] });
  }
  found.sort((a, b) => b.m - a.m);
  const top = found.slice(0, count);
  const ref = top[0]?.m || 1;
  return top
    .sort((a, b) => a.f - b.f)
    .map((p) => `${p.f.toFixed(0)}Гц(${(20 * Math.log10(p.m / ref)).toFixed(0)})`)
    .join(' ');
}

it.skipIf(!process.env.WAV)('разбор записи', () => {
  const { sr, samples } = readWav(process.env.WAV as string);
  const ps = parseScale(pygmy);
  if (!ps.ok) throw new Error('scale');
  const tongues = ps.value.tongues;
  const noteOf = (id: string) => tongues.find((t) => t.id === id)?.note ?? id;
  const out: string[] = [];
  out.push(`Частота ${sr} Гц, длительность ${(samples.length / sr).toFixed(2)} с`);

  const db = (x: number) => (10 * Math.log10(x + 1e-12)).toFixed(0);
  const perHalf: string[] = [];
  const step = Math.round(sr / 2);
  for (let s = 0; s + step <= samples.length; s += step) {
    let e = 0;
    for (let i = s; i < s + step; i++) e += samples[i] * samples[i];
    perHalf.push(db(e / step));
  }
  out.push(`Уровень по 0,5 с, дБ: ${perHalf.join(' ')}`);

  const det = new HitDetector({ sampleRate: sr, templates: defaultTemplates(tongues, sr) });
  out.push(`--- события (шаблоны по умолчанию, чувствительность средняя) ---`);
  for (let i = 0; i < samples.length; i += 512) {
    for (const e of det.push(samples.subarray(i, i + 512))) {
      if (e.type === 'hit') {
        out.push(
          `${(e.frame / sr).toFixed(2)}с ${e.tongues.map(noteOf).join('+') || '—'} ур=${e.levelDb.toFixed(0)}дБ нов=${e.novelty.toFixed(2)} | ${e.scores.map((s) => `${noteOf(s.id)}:${s.similarity.toFixed(2)}`).join(' ')} | пики: ${peaks(samples, e.frame, sr)}`,
        );
      } else {
        out.push(`      сустейн ${e.ratio.toFixed(2)}`);
      }
    }
  }
  out.push(`Фон по оценке распознавателя: ${db(det.noiseEnergy)} дБ`);
  writeFileSync(process.env.OUT as string, out.join('\n') + '\n');
});
