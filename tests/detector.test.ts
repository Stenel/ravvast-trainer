import { describe, expect, it } from 'vitest';
import {
  type DetectorEvent,
  HitDetector,
  averageTemplates,
  cosine,
  defaultTemplates,
} from '../src/core/detector';
import { parseScale } from '../src/core/scale';
import { renderTone } from '../src/core/tone';
import pygmy from '../scales/e-low-pygmy.json';

const ps = parseScale(pygmy);
if (!ps.ok) throw new Error('scale');
const tongues = ps.value.tongues;
const freqOf = (id: string) => tongues.find((t) => t.id === id)!.freq;

interface Strike {
  id?: string;
  freq?: number;
  t: number;
  amp?: number;
  decayScale?: number;
}

function mix(sr: number, dur: number, strikes: Strike[], noise = 0.0005, detune = 1): Float32Array {
  const out = new Float32Array(Math.round(dur * sr));
  for (const s of strikes) {
    const start = Math.round(s.t * sr);
    const f = (s.freq ?? freqOf(s.id!)) * detune;
    const spectrum = s.id ? tongues.find((t) => t.id === s.id)?.partials : undefined;
    const tone = renderTone(f, out.length - start, sr, s.amp ?? 0.5, s.decayScale ?? 1, spectrum);
    for (let i = 0; i < tone.length; i++) out[start + i] += tone[i];
  }
  let seed = 12345;
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    out[i] += (seed / 2 ** 32 - 0.5) * 2 * noise;
  }
  return out;
}

function run(det: HitDetector, samples: Float32Array, chunk = 512): DetectorEvent[] {
  const events: DetectorEvent[] = [];
  for (let i = 0; i < samples.length; i += chunk) {
    events.push(...det.push(samples.subarray(i, Math.min(samples.length, i + chunk))));
  }
  return events;
}

const hitsOf = (events: DetectorEvent[]) =>
  events.filter((e): e is Extract<DetectorEvent, { type: 'hit' }> => e.type === 'hit');
const known = (events: DetectorEvent[]) => hitsOf(events).filter((h) => h.tongues.length > 0);

function detector(sr: number, templates = defaultTemplates(tongues, sr)): HitDetector {
  return new HitDetector({ sampleRate: sr, templates });
}

describe('шаблоны', () => {
  it('шаблоны разных полей различимы', () => {
    const t = defaultTemplates(tongues, 48000);
    const ids = Object.keys(t);
    expect(ids).toHaveLength(9);
    for (const a of ids) {
      for (const b of ids) {
        if (a < b) expect(cosine(t[a], t[b])).toBeLessThan(0.9);
      }
    }
  });
});

describe.each([44100, 48000])('HitDetector при %i Гц', (sr) => {
  it('тишина и слабый шум не дают событий', () => {
    expect(run(detector(sr), mix(sr, 1.5, [], 0.002))).toEqual([]);
  });

  it.each(tongues.map((t) => t.id))('узнаёт одиночный удар по полю %s и его время', (id) => {
    const hits = known(run(detector(sr), mix(sr, 0.9, [{ id, t: 0.2 }])));
    expect(hits.map((h) => h.tongues)).toEqual([[id]]);
    expect(Math.abs(hits[0].frame / sr - 0.2)).toBeLessThan(0.02);
    expect(hits[0].clarity).toBeGreaterThan(0.8);
  });

  it('узнаёт последовательность нот, звучащих внахлёст', () => {
    const order = ['0', '4', '5', '6', '1', '3', '8', '7', '2'];
    const strikes = order.map((id, i) => ({ id, t: 0.2 + i * 0.35 }));
    const hits = known(run(detector(sr), mix(sr, 0.2 + order.length * 0.35 + 0.5, strikes)));
    expect(hits.map((h) => h.tongues.join('+'))).toEqual(order);
    hits.forEach((h, i) => expect(Math.abs(h.frame / sr - strikes[i].t)).toBeLessThan(0.025));
  });

  it('нестационарный шум (шорохи, всплески) не даёт ложных полей', () => {
    const n = Math.round(4 * sr);
    const noisy = new Float32Array(n);
    let seed = 777;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const t = i / sr;
      // фон + всплески втрое громче каждые 0,37 с + редкие щелчки
      const burst = t % 0.37 < 0.05 ? 3 : 1;
      const click = i % Math.round(0.9 * sr) < 40 ? 0.02 : 0;
      noisy[i] = (seed / 2 ** 32 - 0.5) * 2 * 0.003 * burst + click;
    }
    expect(known(run(detector(sr), noisy))).toEqual([]);
  });

  it('после шумного фона по-прежнему слышит обычный удар', () => {
    const samples = mix(sr, 3.2, [{ id: '6', t: 2.5, amp: 0.2 }], 0.004);
    expect(known(run(detector(sr), samples)).map((h) => h.tongues)).toEqual([['6']]);
  });

  it('слышит очень тихий удар (обертоны низкого поля в микрофоне телефона)', () => {
    const hits = known(run(detector(sr), mix(sr, 0.9, [{ id: '0', t: 0.2, amp: 0.006 }], 0.0002)));
    expect(hits.map((h) => h.tongues)).toEqual([['0']]);
  });

  it('плотная игра при очень долгом сустейне (ноты звучат ~10 с)', () => {
    // Быстрых повторов одного поля здесь нет: в тесте звуки просто складываются и могут
    // взаимно гаситься, чего у настоящего язычка при повторном ударе не происходит.
    const order = ['0', '4', '7', '6', '8', '5', '1', '3', '2', '6', '4', '7', '5'];
    const strikes = order.map((id, i) => ({ id, t: 0.2 + i * 0.4, decayScale: 3 }));
    const events = run(detector(sr), mix(sr, 0.2 + order.length * 0.4 + 0.5, strikes));
    expect(known(events).map((h) => h.tongues.join('+'))).toEqual(order);
  });

  it('сообщает новизну и ближайшие поля', () => {
    const [hit] = known(run(detector(sr), mix(sr, 0.9, [{ id: '6', t: 0.2 }])));
    expect(hit.novelty).toBeGreaterThan(0.9);
    expect(hit.scores[0].id).toBe('6');
    expect(hit.scores).toHaveLength(3);
  });

  it('повторный удар по тому же полю засчитывается отдельно', () => {
    const hits = known(
      run(
        detector(sr),
        mix(sr, 1.4, [
          { id: '5', t: 0.2 },
          { id: '5', t: 0.65 },
        ]),
      ),
    );
    expect(hits.map((h) => h.tongues[0])).toEqual(['5', '5']);
  });

  it('тихая нота после громкой не теряется', () => {
    const hits = known(
      run(
        detector(sr),
        mix(sr, 1.5, [
          { id: '5', t: 0.2, amp: 0.8 },
          { id: '7', t: 0.75, amp: 0.3 },
        ]),
      ),
    );
    expect(hits.map((h) => h.tongues[0])).toEqual(['5', '7']);
  });

  it('аккорд даёт один удар, в котором узнано хотя бы одно из полей', () => {
    const hits = known(
      run(
        detector(sr),
        mix(sr, 0.9, [
          { id: '1', t: 0.2 },
          { id: '5', t: 0.2 },
        ]),
      ),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].tongues.some((id) => id === '1' || id === '5')).toBe(true);
  });

  it('аккорд с октавой (E2+E3) слышен как нижнее поле: обертон E2 совпадает с E3', () => {
    const hits = known(
      run(
        detector(sr),
        mix(sr, 0.9, [
          { id: '0', t: 0.2 },
          { id: '4', t: 0.2 },
        ]),
      ),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].tongues).toContain('0');
  });

  it('посторонний звук не принимается за поле', () => {
    const events = run(
      detector(sr),
      mix(sr, 0.9, [
        { freq: 1010, t: 0.2 },
        { freq: 1370, t: 0.2 },
      ]),
    );
    expect(known(events)).toEqual([]);
  });

  it('сообщает сустейн: обычный удар звучит, заглушённый — нет', () => {
    const sustain = (decayScale: number) => {
      const events = run(detector(sr), mix(sr, 1.0, [{ id: '4', t: 0.2, decayScale }]));
      const s = events.find((e) => e.type === 'sustain');
      return s && s.type === 'sustain' ? s.ratio : null;
    };
    expect(sustain(1)).toBeGreaterThan(0.3);
    expect(sustain(0.03)).toBeLessThan(0.2);
  });

  it('после калибровки узнаёт инструмент с другим строем настройки (432 Гц)', () => {
    const detune = 432 / 440;
    const collected: Record<string, Float64Array[]> = {};
    for (const t of tongues) {
      const strikes = [0.2, 0.9, 1.6].map((time) => ({ id: t.id, t: time }));
      const hits = hitsOf(run(detector(sr), mix(sr, 2.3, strikes, 0.0005, detune)));
      expect(hits).toHaveLength(3);
      collected[t.id] = hits.map((h) => h.feature);
    }
    const templates = Object.fromEntries(
      Object.entries(collected).map(([id, f]) => [id, averageTemplates(f)]),
    );
    const order = ['2', '1', '0', '3', '7', '8', '4', '6', '5'];
    const strikes = order.map((id, i) => ({ id, t: 0.2 + i * 0.4 }));
    const hits = known(
      run(detector(sr, templates), mix(sr, 0.2 + order.length * 0.4 + 0.5, strikes, 0.0005, detune)),
    );
    expect(hits.map((h) => h.tongues.join('+'))).toEqual(order);
  });
});
