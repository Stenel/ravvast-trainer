import { toTimedNotes } from '../core/composition';
import { DIFFICULTIES, type Difficulty, GameSession, multiplier } from '../core/judge';
import { PASS_ACCURACY, recordGame } from '../core/progress';
import type { Composition } from '../core/types';
import { type HitQuality, summarizeQuality } from '../core/quality';
import { type AppCtx, type Screen, h, noteOf, playTap, topBar } from './dom';
import { createInstrument } from './instrument';

const NS = 'http://www.w3.org/2000/svg';
const LEAD_IN = 1.2;
const RING_SPREAD = 1.3;
/** Удар с микрофона приходит с опозданием на время анализа, поэтому промах объявляем позже. */
const MIC_GRACE = 0.35;
const LATENCY_HINT_MS = 15;
/** Ноты ближе этого (в секундах) считаются одним аккордом. */
const CHORD_SPREAD = 0.03;

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

  // Ноты по порядку, аккорд — одна группа. По ним видно, что бить сейчас и что потом.
  const groups: number[][] = [];
  notes.forEach((n, i) => {
    const last = groups[groups.length - 1];
    if (last && Math.abs(n.time - notes[last[0]].time) < CHORD_SPREAD) last.push(i);
    else groups.push([i]);
  });
  let groupAt = 0;
  let cueKey = '';
  let strikeKey = '';
  const queueEl = h('div', { class: 'queue', 'aria-hidden': 'true' });

  /** Подсвечивает ближайшую несыгранную ноту и следующую за ней. Возвращает индексы ближайших. */
  function updateCue(): readonly number[] {
    while (
      groupAt < groups.length &&
      groups[groupAt].every((i) => session.state(i) !== 'pending')
    ) {
      groupAt++;
    }
    const current = (groups[groupAt] ?? []).filter((i) => session.state(i) === 'pending');
    const key = `${groupAt}:${current.join(',')}`;
    if (key !== cueKey) {
      cueKey = key;
      const targets = current.map((i) => notes[i].tongue);
      inst.setTargets(targets);
      inst.setNext(
        (groups[groupAt + 1] ?? []).map((i) => notes[i].tongue).filter((t) => !targets.includes(t)),
      );
      queueEl.replaceChildren(
        ...groups.slice(groupAt, groupAt + 5).map((g, k) =>
          h(
            'span',
            { class: k === 0 ? 'queue-item now' : 'queue-item' },
            g.map((i) => noteOf(ctx.scale, notes[i].tongue)).join('+'),
          ),
        ),
      );
    }
    return current;
  }

  const quality: (HitQuality & { id: number })[] = [];

  const unsubscribeMic = ctx.mic.subscribe((ev) => {
    if (ev.type === 'sustain') {
      for (const q of quality) if (q.id === ev.id) q.sustain = ev.ratio;
      return;
    }
    if (done || pausedAt !== null || ev.tongues.length === 0) return;
    const t = (ev.timeMs - startAt) / 1000;
    let counted = false;
    // Аккорд — это один удар, и микрофон надёжно различает в нём только одно поле
    // (обертоны нижнего поля совпадают с верхними). Поэтому, если услышано любое поле
    // ожидаемого аккорда, засчитываем аккорд целиком.
    const heard = [...ev.tongues];
    for (const id of ev.tongues) {
      const i = notes.findIndex(
        (n, k) =>
          n.tongue === id && session.state(k) === 'pending' && Math.abs(n.time - t) <= cfg.good,
      );
      if (i < 0) continue;
      notes.forEach((n, k) => {
        if (
          session.state(k) === 'pending' &&
          Math.abs(n.time - notes[i].time) < CHORD_SPREAD &&
          !heard.includes(n.tongue)
        ) {
          heard.push(n.tongue);
        }
      });
    }
    for (const id of heard) {
      const r = session.hit(id, t);
      if (r.grade === 'stray') {
        inst.flash(id, 'wrong');
        showJudge('Мимо', 'miss');
      } else {
        inst.flash(id, r.grade);
        removeRing(r.index);
        showJudge(r.grade === 'perfect' ? 'Идеально!' : 'Хорошо', r.grade);
        // Аккорд — один удар: качество учитываем один раз.
        if (counted) continue;
        counted = true;
        quality.push({
          id: ev.id,
          clarity: ev.clarity,
          levelDb: ev.levelDb,
          offsetMs: r.offset * 1000,
        });
      }
    }
    renderHud();
    checkFinished();
  });

  const inst = createInstrument(ctx.scale, (id) => {
    playTap(ctx, id);
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

  const beatSec = 60 / comp.bpm;
  let countShown = 0;

  function frame(): void {
    const t = now();

    // Обратный отсчёт по долям перед началом и пульс на каждую долю во время игры.
    if (t < 0) {
      const left = Math.ceil(-t / beatSec);
      if (left !== countShown) {
        countShown = left;
        window.clearTimeout(judgeTimer);
        judgeEl.className = 'judge count';
        judgeEl.textContent = left <= 4 ? String(left) : 'Приготовьтесь…';
      }
    } else if (countShown !== 0) {
      countShown = 0;
      if (judgeEl.classList.contains('count')) {
        judgeEl.className = 'judge';
        judgeEl.textContent = '';
      }
    }
    const phase = (((t / beatSec) % 1) + 1) % 1;
    inst.el.style.setProperty('--pulse', ((1 - phase) ** 3).toFixed(2));
    const missed = session.update(ctx.mic.active ? t - MIC_GRACE : t);
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
    const current = updateCue();
    // «Бей сейчас»: кольцо сошлось с краем поля — поле загорается целиком.
    const strike = current.filter((i) => notes[i].time - t <= cfg.perfect);
    const strikeNow = strike.map((i) => notes[i].tongue).join(',');
    if (strikeNow !== strikeKey) {
      strikeKey = strikeNow;
      inst.setStrike(strike.map((i) => notes[i].tongue));
    }
    for (const [i, ring] of rings) {
      const p = inst.pos(notes[i].tongue);
      const k = Math.max(0, (notes[i].time - t) / cfg.approach);
      const isNow = current.includes(i);
      ring.classList.toggle('now', isNow);
      ring.classList.toggle('strike', strike.includes(i));
      ring.setAttribute('r', (p.r * (1 + RING_SPREAD * k)).toFixed(1));
      // Кольца более поздних нот приглушены, чтобы не спорить с ближайшей.
      ring.style.opacity = ((1 - 0.75 * k) * (isNow ? 1 : 0.4)).toFixed(2);
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
      const resume = () => {
        if (done || document.hidden || pausedAt === null) return;
        startAt += performance.now() - pausedAt;
        pausedAt = null;
        raf = requestAnimationFrame(frame);
      };
      // После долгого фона микрофон выключается сам и включается не мгновенно: ждём его,
      // иначе первые ноты после возврата ушли бы в пропуски.
      if (ctx.mic.enabled && ctx.mic.status !== 'on') void ctx.mic.start().then(resume, resume);
      else resume();
    }
  }
  document.addEventListener('visibilitychange', onVisibility);

  const overlayHost = h('div', {});

  function showResults(isRecord: boolean): void {
    const pct = Math.round(session.accuracy * 100);
    const passed = session.accuracy >= PASS_ACCURACY;
    const row = (label: string, value: string) =>
      h('div', { class: 'result-row' }, h('span', {}, label), h('strong', {}, value));
    const q = summarizeQuality(quality);
    const qualityRows: (Node | string)[] = [];
    if (q.hits > 0) {
      qualityRows.push(h('h3', { class: 'sub' }, 'Качество звука (по микрофону)'));
      if (q.clarity !== null) qualityRows.push(row('Чистота тона', `${q.clarity}%`));
      if (q.evennessDb !== null) {
        qualityRows.push(row('Разброс громкости', `±${q.evennessDb.toFixed(1)} дБ`));
      }
      qualityRows.push(row('Заглушённых ударов', String(q.muted)));
      const off = q.meanOffsetMs;
      if (off !== null) {
        qualityRows.push(
          row('В среднем', off === 0 ? 'точно' : `на ${Math.abs(off)} мс ${off > 0 ? 'позже' : 'раньше'}`),
        );
        if (Math.abs(off) >= LATENCY_HINT_MS) {
          const btn = h(
            'button',
            {
              class: 'btn wide-btn',
              type: 'button',
              onclick: () => {
                ctx.mic.setLatency(ctx.mic.latencyMs + off);
                btn.disabled = true;
                btn.textContent = `Задержка микрофона: ${ctx.mic.latencyMs} мс`;
              },
            },
            'Учесть это как задержку микрофона',
          );
          qualityRows.push(btn);
        }
      }
    }
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
          ...qualityRows,
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
    queueEl,
    h('div', { class: 'stage' }, inst.el as unknown as Node),
    h(
      'p',
      { class: 'hint' },
      ctx.mic.enabled
        ? 'Ударяйте по полю, когда белое кольцо сойдётся с краем и поле загорится жёлтым. Микрофон слушает.'
        : 'Касайтесь поля, когда белое кольцо сойдётся с краем и поле загорится жёлтым.',
    ),
    overlayHost,
  );

  inst.el.classList.add('pulsing');
  raf = requestAnimationFrame(frame);

  return {
    el,
    destroy() {
      done = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(finishTimer);
      window.clearTimeout(judgeTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribeMic();
      inst.destroy();
    },
  };
}
