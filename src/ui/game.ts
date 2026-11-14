import { toTimedNotes } from '../core/composition';
import { DIFFICULTIES, type Difficulty, GameSession, multiplier } from '../core/judge';
import { PASS_ACCURACY, recordGame } from '../core/progress';
import type { Composition } from '../core/types';
import { type AppCtx, type Screen, freqOf, h, topBar } from './dom';
import { createInstrument } from './instrument';

const NS = 'http://www.w3.org/2000/svg';
const LEAD_IN = 1.2;
const RING_SPREAD = 1.3;

export function gameScreen(ctx: AppCtx, comp: Composition, difficulty: Difficulty): Screen {
  const cfg = DIFFICULTIES[difficulty];
  const notes = toTimedNotes(comp);
  const session = new GameSession(notes, difficulty);

  let startAt = performance.now() + (cfg.approach + LEAD_IN) * 1000;
  let pausedAt: number | null = null;
  let raf = 0;
  let done = false;
  let finishTimer = 0;
  let judgeTimer = 0;
  let spawn = 0;
  const rings = new Map<number, SVGCircleElement>();
  const now = () => (performance.now() - startAt) / 1000;

  const scoreEl = h('strong', {}, '0');
  const comboEl = h('strong', {}, '0');
  const multEl = h('span', { class: 'mult' }, 'x1');
  const judgeEl = h('div', { class: 'judge' }, 'Приготовьтесь…');
  const progressEl = h('div', { class: 'progress-fill' });

  function renderHud(): void {
    scoreEl.textContent = String(session.score);
    comboEl.textContent = String(session.combo);
    multEl.textContent = `x${multiplier(session.combo)}`;
  }

  function showJudge(text: string, kind: string): void {
    window.clearTimeout(judgeTimer);
    judgeEl.textContent = text;
    judgeEl.className = `judge show ${kind}`;
    judgeTimer = window.setTimeout(() => judgeEl.classList.remove('show'), 600);
  }

  function removeRing(index: number): void {
    rings.get(index)?.remove();
    rings.delete(index);
  }

  const inst = createInstrument(ctx.scale, (id) => {
    ctx.synth.play(freqOf(ctx.scale, id));
    if (done || pausedAt !== null) {
      inst.flash(id, 'hit');
      return;
    }
    const r = session.hit(id, now());
    if (r.grade === 'stray') {
      inst.flash(id, 'wrong');
      showJudge('Мимо', 'miss');
    } else {
      inst.flash(id, r.grade);
      removeRing(r.index);
      showJudge(r.grade === 'perfect' ? 'Идеально!' : 'Хорошо', r.grade);
    }
    renderHud();
    checkFinished();
  });

  function checkFinished(): void {
    if (done || !session.finished) return;
    done = true;
    cancelAnimationFrame(raf);
    // Результат сохраняем сразу, чтобы он не пропал при быстром выходе с экрана.
    const { isRecord } = recordGame(ctx.store, comp.id, difficulty, session.score, session.accuracy);
    finishTimer = window.setTimeout(() => showResults(isRecord), 700);
  }

  function frame(): void {
    const t = now();
    const missed = session.update(t);
    for (const i of missed) {
      removeRing(i);
      inst.flash(notes[i].tongue, 'miss');
    }
    if (missed.length) {
      showJudge('Пропуск', 'miss');
      renderHud();
    }

    while (spawn < notes.length && notes[spawn].time - t <= cfg.approach) {
      if (session.state(spawn) === 'pending') {
        const p = inst.pos(notes[spawn].tongue);
        const ring = document.createElementNS(NS, 'circle');
        ring.setAttribute('cx', String(p.x));
        ring.setAttribute('cy', String(p.y));
        ring.setAttribute('class', 'ring');
        inst.overlay.append(ring);
        rings.set(spawn, ring);
      }
      spawn++;
    }
    for (const [i, ring] of rings) {
      const p = inst.pos(notes[i].tongue);
      const k = Math.max(0, (notes[i].time - t) / cfg.approach);
      ring.setAttribute('r', (p.r * (1 + RING_SPREAD * k)).toFixed(1));
      ring.style.opacity = (1 - 0.75 * k).toFixed(2);
    }

    const total = notes[notes.length - 1].time || 1;
    progressEl.style.width = `${Math.min(100, Math.max(0, (t / total) * 100)).toFixed(1)}%`;

    checkFinished();
    if (!done) raf = requestAnimationFrame(frame);
  }

  function onVisibility(): void {
    if (done) return;
    if (document.hidden) {
      pausedAt = performance.now();
      cancelAnimationFrame(raf);
    } else if (pausedAt !== null) {
      startAt += performance.now() - pausedAt;
      pausedAt = null;
      raf = requestAnimationFrame(frame);
    }
  }
  document.addEventListener('visibilitychange', onVisibility);

  const overlayHost = h('div', {});

  function showResults(isRecord: boolean): void {
    const pct = Math.round(session.accuracy * 100);
    const passed = session.accuracy >= PASS_ACCURACY;
    const row = (label: string, value: string) =>
      h('div', { class: 'result-row' }, h('span', {}, label), h('strong', {}, value));
    overlayHost.replaceChildren(
      h(
        'div',
        { class: 'modal', role: 'dialog', 'aria-label': 'Результат' },
        h(
          'div',
          { class: 'modal-card' },
          h('h2', {}, passed ? 'Композиция пройдена!' : 'Попробуйте ещё раз'),
          isRecord && session.score > 0 ? h('p', { class: 'record' }, 'Новый рекорд!') : '',
          row('Счёт', String(session.score)),
          row('Точность', `${pct}%`),
          row('Лучшее комбо', String(session.maxCombo)),
          row('Идеально', String(session.counts.perfect)),
          row('Хорошо', String(session.counts.good)),
          row('Пропущено', String(session.counts.miss)),
          passed
            ? ''
            : h(
                'p',
                { class: 'hint' },
                `Чтобы пройти, нужно попасть хотя бы в ${Math.round(PASS_ACCURACY * 100)}% нот.`,
              ),
          h(
            'div',
            { class: 'row' },
            h(
              'button',
              { class: 'btn primary', type: 'button', onclick: () => ctx.play(comp, difficulty) },
              'Ещё раз',
            ),
            h('button', { class: 'btn', type: 'button', onclick: ctx.home }, 'К списку'),
          ),
        ),
      ),
    );
  }

  const el = h(
    'div',
    { class: 'screen' },
    topBar(comp.title, ctx.home, h('span', { class: 'badge' }, cfg.label)),
    h('div', { class: 'progress' }, progressEl),
    h(
      'div',
      { class: 'hud' },
      h('div', {}, 'Счёт ', scoreEl),
      judgeEl,
      h('div', {}, 'Комбо ', comboEl, ' ', multEl),
    ),
    h('div', { class: 'stage' }, inst.el as unknown as Node),
    h('p', { class: 'hint' }, 'Касайтесь поля, когда кольцо сожмётся до его края.'),
    overlayHost,
  );

  raf = requestAnimationFrame(frame);

  return {
    el,
    destroy() {
      done = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(finishTimer);
      window.clearTimeout(judgeTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      inst.destroy();
    },
  };
}
