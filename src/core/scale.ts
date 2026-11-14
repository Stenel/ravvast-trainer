import type { Result, Scale, Tongue } from './types';

const SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Частота ноты в равномерной темперации (A4 = 440 Гц) или null, если название не разобрано. */
export function noteToFreq(note: string): number | null {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(note);
  if (!m) return null;
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const midi = (Number(m[3]) + 1) * 12 + SEMITONES[m[1]] + accidental;
  return 440 * 2 ** ((midi - 69) / 12);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseScale(raw: unknown): Result<Scale> {
  if (!isRecord(raw)) return { ok: false, errors: ['Строй должен быть объектом JSON.'] };
  const errors: string[] = [];
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!id) errors.push('У строя нет поля "id".');
  if (!name) errors.push('У строя нет поля "name".');

  const tongues: Tongue[] = [];
  if (!Array.isArray(raw.tongues) || raw.tongues.length === 0) {
    errors.push('Список "tongues" должен быть непустым массивом.');
  } else {
    const seen = new Set<string>();
    raw.tongues.forEach((t: unknown, i: number) => {
      const where = `Поле ${i + 1}`;
      if (!isRecord(t)) {
        errors.push(`${where}: ожидался объект.`);
        return;
      }
      const tid = typeof t.id === 'string' || typeof t.id === 'number' ? String(t.id) : '';
      if (!tid) errors.push(`${where}: нет "id".`);
      else if (seen.has(tid)) errors.push(`${where}: id "${tid}" повторяется.`);
      seen.add(tid);

      const note = typeof t.note === 'string' ? t.note : '';
      const freq = noteToFreq(note);
      if (freq === null) errors.push(`${where}: не удалось разобрать ноту "${note}".`);

      const center = t.position === 'center';
      const angle = typeof t.angle === 'number' && Number.isFinite(t.angle) ? t.angle : null;
      if (!center && angle === null) {
        errors.push(`${where}: укажите "angle" в градусах или "position": "center".`);
      }
      let partials: [number, number][] | undefined;
      if (t.partials !== undefined) {
        const ok =
          Array.isArray(t.partials) &&
          t.partials.length > 0 &&
          t.partials.length <= 16 &&
          t.partials.every(
            (p: unknown) =>
              Array.isArray(p) &&
              p.length === 2 &&
              p.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0) &&
              p[0] <= 32 &&
              p[1] <= 4,
          );
        if (ok) partials = (t.partials as [number, number][]).map(([r, g]) => [r, g]);
        else errors.push(`${where}: "partials" должен быть списком пар [гармоника, амплитуда].`);
      }
      tongues.push({
        id: tid,
        note,
        freq: freq ?? 0,
        center,
        angle: angle ?? 0,
        ...(partials ? { partials } : {}),
      });
    });
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { id, name, tongues } };
}
