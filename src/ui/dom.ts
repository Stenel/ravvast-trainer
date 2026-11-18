import type { MicInput } from '../audio/mic';
import type { Synth } from '../audio/synth';
import type { SessionKind } from '../core/history';
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
  mic: MicInput;
  home(): void;
  calibrate(): void;
  accuracy(): void;
  free(): void;
  play(comp: Composition, difficulty: Difficulty, opts?: PlayOptions): void;
  practice(comp: Composition): void;
}

/** Как запустить игру: обычный проход, цикл по фрагменту с разгоном темпа или упражнение. */
export interface PlayOptions {
  /** Доля от темпа композиции, 1 — как записано. */
  tempo?: number;
  /** После прохода начинать заново, прибавляя темп за чистую игру. */
  loop?: boolean;
  /** Что это за проход — для истории; рекорды пишутся только для 'game'. */
  kind?: SessionKind;
  /** Композиция, из которой вырезан фрагмент. */
  parent?: Composition;
}

const DIFFICULTY_KEY = 'ravvast-trainer:difficulty';

export function storedDifficulty(ctx: AppCtx): Difficulty {
  const v = ctx.store.getItem(DIFFICULTY_KEY);
  return v === 'easy' || v === 'hard' ? v : 'normal';
}

export function storeDifficulty(ctx: AppCtx, d: Difficulty): void {
  ctx.store.setItem(DIFFICULTY_KEY, d);
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

/**
 * Звук при касании поля на экране. Когда слушает микрофон, синтезатор молчит,
 * иначе его звук из динамика был бы распознан как удар по инструменту.
 */
export function playTap(ctx: AppCtx, tongueId: string, velocity = 1): void {
  if (!ctx.mic.active) playTongue(ctx, tongueId, velocity);
}

/** Звук поля из синтезатора, без оглядки на микрофон (демонстрация композиции). */
export function playTongue(ctx: AppCtx, tongueId: string, velocity = 1): void {
  const tongue = ctx.scale.tongues.find((t) => t.id === tongueId);
  if (tongue) ctx.synth.play(tongue, velocity);
}

/** Индикатор уровня микрофона: показывает, что вообще слышит устройство. */
export function levelMeter(ctx: AppCtx): { el: HTMLElement; destroy(): void } {
  const fill = h('div', { class: 'meter-fill' });
  const label = h('span', { class: 'meter-label' });
  const el = h('div', { class: 'meter', 'aria-hidden': 'true' }, h('div', { class: 'meter-bar' }, fill), label);
  const timer = window.setInterval(() => {
    const on = ctx.mic.status === 'on';
    el.hidden = !on;
    if (!on) return;
    const db = ctx.mic.levelDb;
    // −80 дБ — пустая шкала, −10 дБ — полная.
    fill.style.width = `${Math.min(100, Math.max(0, ((db + 80) / 70) * 100)).toFixed(0)}%`;
    label.textContent = `${Math.round(db)} дБ`;
  }, 120);
  el.hidden = true;
  return { el, destroy: () => window.clearInterval(timer) };
}

export function noteOf(scale: Scale, tongueId: string): string {
  return scale.tongues.find((t) => t.id === tongueId)?.note ?? '?';
}
