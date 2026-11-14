import { PracticeSession, buildSteps, stepSeconds } from '../core/practice';
import { markCompleted } from '../core/progress';
import type { Composition } from '../core/types';
import { MUTED_RATIO, clarityPercent } from '../core/quality';
import { type AppCtx, type Screen, freqOf, h, noteOf, playTap, topBar } from './dom';
import { createInstrument } from './instrument';

export function practiceScreen(ctx: AppCtx, comp: Composition): Screen {
  const steps = buildSteps(comp);
  const session = new PracticeSession(steps);
  let wait = true;
  let tempo = 1;
  let running = false;
  let timer = 0;
  let toastTimer = 0;
  let justCompleted = false;

  /** Нажатие поля (с экрана или с микрофона) в режиме ожидания. Возвращает, верная ли нота. */
  function press(id: string): boolean {
    const r = session.press(id);
    inst.flash(id, r.correct ? 'good' : 'wrong');
    if (r.completed) {
      justCompleted = true;
      markCompleted(ctx.store, comp.id);
      toast('Композиция пройдена! Начинаем сначала.');
    }
    render();
    return r.correct;
  }

  const inst = createInstrument(ctx.scale, (id) => {
    playTap(ctx, id);
    if (wait) press(id);
    else inst.flash(id, 'hit');
  });

  let lastMicHit = -1;
  const unsubscribeMic = ctx.mic.subscribe((ev) => {
    // Без ожидания композицию играет синтезатор — его звук не должен засчитываться.
    if (!wait) return;
    if (ev.type === 'sustain') {
      if (ev.id === lastMicHit && ev.ratio < MUTED_RATIO) {
        toast('Удар заглушён — дайте полю прозвучать.');
      }
      return;
    }
    justCompleted = false;
    let correct = false;
    for (const id of ev.tongues) correct = press(id) || correct;
    if (correct) {
      lastMicHit = ev.id;
      if (!justCompleted) toast(`Чистота тона: ${clarityPercent(ev.clarity)}%`);
    }
  });

  // --- элементы управления ---
  const strip = h('div', { class: 'strip' });
  const chips = steps.map((s, i) =>
    h(
      'button',
      {
        class: 'chip',
        type: 'button',
        'aria-label': `Шаг ${i + 1}`,
        onclick: () => {
          session.jump(i);
          if (running) scheduleStep();
          render();
        },
      },
      s.tongues.map((t) => noteOf(ctx.scale, t)).join('+'),
    ),
  );
  strip.append(...chips);

  const stepLabel = h('span', { class: 'step-label' });
  const toastEl = h('div', { class: 'toast', role: 'status' });
  const tempoLabel = h('span', {});
  const tempoInput = h('input', {
    type: 'range',
    min: 50,
    max: 150,
    step: 5,
    value: 100,
    'aria-label': 'Темп',
    oninput: () => {
      tempo = Number(tempoInput.value) / 100;
      if (running) armTimer();
      render();
    },
  });

  const waitInput = h('input', {
    type: 'checkbox',
    checked: true,
    onchange: () => {
      wait = waitInput.checked;
      if (wait) stop();
      session.jump(session.index);
      render();
    },
  });

  const loopInput = h('input', { type: 'checkbox', onchange: applyLoop });
  const numAttrs = { type: 'number', min: 1, max: steps.length, inputmode: 'numeric' };
  const fromInput = h('input', { ...numAttrs, value: 1, 'aria-label': 'Цикл с шага' });
  const toInput = h('input', {
    ...numAttrs,
    value: Math.min(steps.length, 4),
    'aria-label': 'Цикл по шаг',
  });
  fromInput.addEventListener('change', applyLoop);
  toInput.addEventListener('change', applyLoop);

  const playBtn = h('button', { class: 'btn primary', type: 'button', onclick: toggleRun });
  const restartBtn = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: () => {
        session.jump(0);
        if (running) scheduleStep();
        render();
      },
    },
    'В начало',
  );

  function applyLoop(): void {
    const before = session.index;
    if (loopInput.checked) {
      session.setLoop((Number(fromInput.value) || 1) - 1, (Number(toInput.value) || 1) - 1);
      const loop = session.loop;
      if (loop) {
        fromInput.value = String(loop.from + 1);
        toInput.value = String(loop.to + 1);
      }
    } else {
      session.clearLoop();
    }
    if (running && session.index !== before) scheduleStep();
    render();
  }

  function toast(text: string): void {
    window.clearTimeout(toastTimer);
    toastEl.textContent = text;
    toastEl.classList.add('show');
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2500);
  }

  // --- режим без ожидания: композиция идёт сама в выбранном темпе ---
  /** Перезапускает ожидание текущего шага, не проигрывая его заново. */
  function armTimer(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(
      () => {
        const r = session.advance();
        if (r.completed) {
          stop();
          render();
          return;
        }
        scheduleStep();
      },
      stepSeconds(steps[session.index], comp.bpm, tempo) * 1000,
    );
  }

  function scheduleStep(): void {
    for (const t of steps[session.index].tongues) {
      // Демонстрация: звучит всегда, микрофон в этом режиме не учитывается.
      ctx.synth.play(freqOf(ctx.scale, t), 0.8);
      inst.flash(t, 'good');
    }
    render();
    armTimer();
  }

  function stop(): void {
    running = false;
    window.clearTimeout(timer);
  }

  function toggleRun(): void {
    if (running) stop();
    else {
      running = true;
      scheduleStep();
    }
    render();
  }

  function render(): void {
    const loop = session.loop;
    chips.forEach((chip, i) => {
      chip.classList.toggle('current', i === session.index);
      chip.classList.toggle('in-loop', loop !== null && i >= loop.from && i <= loop.to);
    });
    chips[session.index]?.scrollIntoView({ block: 'nearest', inline: 'center' });
    inst.setTargets(wait ? session.remaining : (steps[session.index]?.tongues ?? []));
    stepLabel.textContent = `Шаг ${session.index + 1} из ${steps.length}`;
    tempoLabel.textContent = `Темп: ${Math.round(tempo * 100)}% (${Math.round(comp.bpm * tempo)} уд/мин)`;
    playBtn.textContent = running ? '⏸ Пауза' : '▶ Пуск';
    playBtn.disabled = wait;
    fromInput.disabled = toInput.disabled = !loopInput.checked;
  }

  const el = h(
    'div',
    { class: 'screen' },
    topBar(comp.title, ctx.home, stepLabel),
    h('div', { class: 'stage' }, inst.el as unknown as Node),
    toastEl,
    strip,
    h(
      'div',
      { class: 'controls' },
      h('label', { class: 'control wide' }, tempoLabel, tempoInput),
      h('label', { class: 'control check' }, waitInput, 'Ждать правильную ноту'),
      h(
        'div',
        { class: 'control check' },
        h('label', { class: 'check' }, loopInput, 'Цикл: шаги с'),
        fromInput,
        'по',
        toInput,
      ),
      h('div', { class: 'row' }, playBtn, restartBtn),
    ),
  );

  render();

  return {
    el,
    destroy() {
      stop();
      unsubscribeMic();
      window.clearTimeout(toastTimer);
      inst.destroy();
    },
  };
}
