import type { Composition, CompositionNote, Scale, Tongue } from './types';

const MIN_NOTES = 16;
const MAX_NOTES = 48;
/** Минимум долей между повторным ударом по одному полю и между E2 и B3. */
const GAP = 2;

/** Раскладывает удары по долям, соблюдая паузу между повтором поля и парой центр/B3. */
class Builder {
  readonly notes: CompositionNote[] = [];
  private readonly last = new Map<string, number>();
  private readonly centreId: string | undefined;
  private readonly b3Id: string | undefined;

  constructor(scale: Scale) {
    this.centreId = scale.tongues.find((t) => t.center)?.id;
    this.b3Id = scale.tongues.find((t) => t.note === 'B3' && !t.center)?.id;
  }

  get size(): number {
    return this.notes.length;
  }

  get lastBeat(): number {
    return this.notes.length ? this.notes[this.notes.length - 1].beat : -Infinity;
  }

  fits(id: string, beat: number): boolean {
    if (beat <= this.lastBeat) return false;
    const own = this.last.get(id);
    if (own !== undefined && beat - own < GAP) return false;
    const other = id === this.centreId ? this.b3Id : id === this.b3Id ? this.centreId : undefined;
    const o = other === undefined ? undefined : this.last.get(other);
    return !(o !== undefined && beat - o < GAP);
  }

  /** Ставит удар не раньше minBeat и не раньше чем через step после предыдущего. */
  add(id: string, step = 1, duration = 1, minBeat = 0): number {
    let beat = Math.max(minBeat, this.notes.length ? this.lastBeat + step : 0);
    while (!this.fits(id, beat)) beat += step;
    this.notes.push({ tongue: id, beat, duration });
    this.last.set(id, beat);
    return beat;
  }
}

function ringOf(scale: Scale): Tongue[] {
  return scale.tongues.filter((t) => !t.center).sort((a, b) => a.angle - b.angle);
}

const byFreq = (scale: Scale): Tongue[] => [...scale.tongues].sort((a, b) => a.freq - b.freq);

const angDist = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

/** Повторяет последовательность до минимальной длины и обрезает до максимальной. */
function fit(seq: string[]): string[] {
  const out: string[] = [];
  while (out.length < MIN_NOTES && seq.length > 0) out.push(...seq);
  return out.slice(0, MAX_NOTES);
}

function sequential(
  scale: Scale,
  slug: string,
  title: string,
  level: 1 | 2 | 3,
  bpm: number,
  seq: string[],
): Composition {
  const b = new Builder(scale);
  for (const t of fit(seq)) b.add(t);
  return { id: `drill:${slug}`, title, scale: scale.id, bpm, level, notes: b.notes };
}

function scaleDrill(scale: Scale): Composition {
  const up = byFreq(scale).map((t) => t.id);
  const down = up.slice(0, -1).reverse();
  return sequential(scale, 'scale', 'Гамма вверх и вниз', 1, 60, [...up, ...down]);
}

function ringDrill(scale: Scale): Composition {
  const ring = ringOf(scale).map((t) => t.id);
  const ccw = [...ring].reverse();
  const seq = [...ring, ...ccw.slice(1), ccw[0]];
  return sequential(scale, 'ring', 'Круг по часовой и против', 1, 60, seq);
}

function handsDrill(scale: Scale): Composition {
  const ring = ringOf(scale);
  let left = ring.filter((t) => t.angle >= 180);
  let right = ring.filter((t) => t.angle < 180);
  if (!left.length || !right.length) {
    const half = Math.floor(ring.length / 2);
    right = ring.slice(0, half);
    left = ring.slice(half);
  }
  const seq: string[] = [];
  const pairs = 12;
  for (let i = 0; i < pairs; i++) seq.push(left[i % left.length].id, right[i % right.length].id);
  const b = new Builder(scale);
  for (const t of seq.slice(0, 24)) b.add(t);
  return {
    id: 'drill:hands',
    title: 'Чередование рук',
    scale: scale.id,
    bpm: 66,
    level: 2,
    notes: b.notes,
  };
}

function jumpsDrill(scale: Scale): Composition {
  const ring = ringOf(scale);
  const seq: string[] = [];
  for (const t of ring) {
    const target = (t.angle + 180) % 360;
    const opp = ring
      .filter((r) => r.id !== t.id)
      .reduce((best, r) => (angDist(r.angle, target) < angDist(best.angle, target) ? r : best));
    seq.push(t.id, opp.id);
  }
  return sequential(scale, 'jumps', 'Дальние прыжки', 2, 66, seq);
}

function pulseDrill(scale: Scale): Composition {
  const centre = scale.tongues.find((t) => t.center)!;
  const ring = byFreq({ ...scale, tongues: ringOf(scale) });
  const b = new Builder(scale);
  let ptr = 0;
  for (let bar = 0; bar < 6; bar++) {
    const base = bar * 4;
    b.add(centre.id, 1, 1, base);
    for (let slot = 1; slot <= 3; slot++) {
      const beat = base + slot;
      let pick = -1;
      for (let k = 0; k < ring.length && pick < 0; k++) {
        const i = (ptr + k) % ring.length;
        if (b.fits(ring[i].id, beat)) pick = i;
      }
      if (pick < 0) pick = ptr % ring.length;
      b.add(ring[pick].id, 1, 1, beat);
      ptr = pick + 1;
    }
  }
  return {
    id: 'drill:pulse',
    title: 'Пульс центра',
    scale: scale.id,
    bpm: 72,
    level: 2,
    notes: b.notes,
  };
}

function eighthsDrill(scale: Scale): Composition {
  const ring = ringOf(scale);
  const b = new Builder(scale);
  const n = ring.length;
  const perGroup = 2;
  let bar = 0;
  for (let g = 0; b.size < 24; g++) {
    for (let rep = 0; rep < perGroup && b.size < 24; rep++, bar++) {
      for (let k = 0; k < 3; k++) {
        b.add(ring[(g * 3 + k) % n].id, 0.5, 0.5, bar * 2 + k * 0.5);
      }
    }
  }
  return {
    id: 'drill:eighths',
    title: 'Ровные восьмые',
    scale: scale.id,
    bpm: 60,
    level: 3,
    notes: b.notes,
  };
}

export function generateDrills(scale: Scale): Composition[] {
  return [
    scaleDrill(scale),
    ringDrill(scale),
    handsDrill(scale),
    jumpsDrill(scale),
    pulseDrill(scale),
    eighthsDrill(scale),
  ];
}

/** Упражнение на выбранные поля: каждое из них чередуется с другими полями. */
export function focusDrill(scale: Scale, tongueIds: readonly string[]): Composition | null {
  const known = new Set(scale.tongues.map((t) => t.id));
  const focus: string[] = [];
  for (const id of tongueIds) {
    if (known.has(id) && !focus.includes(id)) focus.push(id);
    if (focus.length === 4) break;
  }
  if (!focus.length) return null;

  const fillers = byFreq(scale)
    .map((t) => t.id)
    .filter((id) => !focus.includes(id));
  const rounds = Math.max(4, Math.ceil(MIN_NOTES / (2 * focus.length)));
  const b = new Builder(scale);
  let ptr = 0;
  const addFiller = () => {
    if (!fillers.length) return;
    let pick = ptr % fillers.length;
    const beat = b.lastBeat + 1;
    for (let k = 0; k < fillers.length; k++) {
      const i = (ptr + k) % fillers.length;
      if (b.fits(fillers[i], beat)) {
        pick = i;
        break;
      }
    }
    b.add(fillers[pick]);
    ptr = pick + 1;
  };
  for (let r = 0; r < rounds && b.size < MAX_NOTES; r++) {
    for (const id of focus) {
      b.add(id);
      addFiller();
    }
  }
  return {
    id: 'drill:focus',
    title: 'Слабые поля',
    scale: scale.id,
    bpm: 60,
    level: 2,
    notes: b.notes.slice(0, MAX_NOTES),
  };
}
