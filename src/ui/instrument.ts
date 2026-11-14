import type { Scale } from '../core/types';

const NS = 'http://www.w3.org/2000/svg';
const SIDE_RADIUS = 128;
const CENTER_R = 50;
const FLASH_MS = 260;

export type FlashKind = 'hit' | 'perfect' | 'good' | 'miss' | 'wrong';

export interface Instrument {
  el: SVGSVGElement;
  /** Слой поверх полей для подлетающих нот (не перехватывает касания). */
  overlay: SVGGElement;
  flash(id: string, kind: FlashKind): void;
  setTargets(ids: readonly string[]): void;
  pos(id: string): { x: number; y: number; r: number };
  destroy(): void;
}

function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** SVG-схема инструмента. onHit вызывается при касании поля, клике или нажатии клавиши с его номером. */
export function createInstrument(scale: Scale, onHit: (id: string) => void): Instrument {
  const root = svg('svg', {
    viewBox: '-200 -200 400 400',
    class: 'instrument',
    role: 'group',
    'aria-label': `Инструмент, строй ${scale.name}`,
  });

  const defs = svg('defs', {});
  const grad = svg('radialGradient', { id: 'body-grad', cx: '40%', cy: '35%', r: '75%' });
  grad.append(
    svg('stop', { offset: '0%', 'stop-color': '#3b4a8c' }),
    svg('stop', { offset: '100%', 'stop-color': '#171c3a' }),
  );
  defs.append(grad);
  root.append(defs, svg('circle', { cx: 0, cy: 0, r: 196, class: 'body' }));

  const sideCount = scale.tongues.filter((t) => !t.center).length;
  const sideR = Math.min(46, SIDE_RADIUS * Math.sin(Math.PI / Math.max(sideCount, 3)) * 0.86);

  const positions = new Map<string, { x: number; y: number; r: number }>();
  const groups = new Map<string, SVGGElement>();
  const timers = new Map<string, number>();

  for (const t of scale.tongues) {
    const rad = (t.angle * Math.PI) / 180;
    const p = t.center
      ? { x: 0, y: 0, r: CENTER_R }
      : { x: SIDE_RADIUS * Math.sin(rad), y: -SIDE_RADIUS * Math.cos(rad), r: sideR };
    positions.set(t.id, p);

    const g = svg('g', {
      class: 'tongue',
      role: 'button',
      'aria-label': `Поле ${t.id}, нота ${t.note}`,
    });
    const note = svg('text', { x: p.x, y: p.y + 3, class: 'tongue-note' });
    note.textContent = t.note;
    const num = svg('text', { x: p.x, y: p.y + 21, class: 'tongue-num' });
    num.textContent = t.id;
    g.append(svg('circle', { cx: p.x, cy: p.y, r: p.r }), note, num);
    g.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      onHit(t.id);
    });
    groups.set(t.id, g);
    root.append(g);
  }

  const overlay = svg('g', { class: 'overlay' });
  root.append(overlay);

  const onKey = (ev: KeyboardEvent) => {
    if (ev.repeat || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const target = ev.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (groups.has(ev.key)) onHit(ev.key);
  };
  window.addEventListener('keydown', onKey);

  return {
    el: root,
    overlay,
    pos: (id) => positions.get(id) ?? { x: 0, y: 0, r: sideR },
    flash(id, kind) {
      const g = groups.get(id);
      if (!g) return;
      window.clearTimeout(timers.get(id));
      g.classList.remove('flash-hit', 'flash-perfect', 'flash-good', 'flash-miss', 'flash-wrong');
      // Принудительный reflow, чтобы повторная вспышка перезапускала анимацию.
      void g.getBoundingClientRect();
      g.classList.add(`flash-${kind}`);
      timers.set(
        id,
        window.setTimeout(() => g.classList.remove(`flash-${kind}`), FLASH_MS),
      );
    },
    setTargets(ids) {
      for (const [id, g] of groups) g.classList.toggle('target', ids.includes(id));
    },
    destroy() {
      window.removeEventListener('keydown', onKey);
      for (const t of timers.values()) window.clearTimeout(t);
    },
  };
}
