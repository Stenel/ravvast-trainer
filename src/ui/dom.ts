import type { Synth } from '../audio/synth';
import type { Difficulty } from '../core/judge';
import type { KeyValueStore } from '../core/progress';
import type { Composition, Scale } from '../core/types';

export interface Screen {
  el: HTMLElement;
  destroy(): void;
}

export interface AppCtx {
  scale: Scale;
  synth: Synth;
  store: KeyValueStore;
  home(): void;
  free(): void;
  play(comp: Composition, difficulty: Difficulty): void;
  practice(comp: Composition): void;
}

type Attr = string | number | boolean | ((ev: Event) => void);

/** Создаёт элемент. Текст всегда вставляется как текст, не как HTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, Attr> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') el.addEventListener(key.replace(/^on/, ''), value);
    else if (typeof value === 'boolean') el.toggleAttribute(key, value);
    else if (key === 'class') el.className = String(value);
    else el.setAttribute(key, String(value));
  }
  el.append(...children);
  return el;
}

export function topBar(title: string, onBack: () => void, extra?: Node): HTMLElement {
  return h(
    'header',
    { class: 'topbar' },
    h('button', { class: 'btn ghost', type: 'button', onclick: onBack }, '← Назад'),
    h('h1', {}, title),
    extra ?? h('span', {}),
  );
}

export function freqOf(scale: Scale, tongueId: string): number {
  return scale.tongues.find((t) => t.id === tongueId)?.freq ?? 0;
}

export function noteOf(scale: Scale, tongueId: string): string {
  return scale.tongues.find((t) => t.id === tongueId)?.note ?? '?';
}
