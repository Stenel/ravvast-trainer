import { toTimedNotes } from '../core/composition';
import { DIFFICULTIES, type Difficulty, GameSession, multiplier } from '../core/judge';
import { PASS_ACCURACY, recordGame } from '../core/progress';
import { type DynamicsHit, dynamicsReport, timingSpread } from '../core/rhythm';
import type { Composition, Dynamic } from '../core/types';
import { type HitQuality, summarizeQuality } from '../core/quality';
import { RAMP_START, nextTempo, sliceComposition, weakestWindow } from '../core/fragment';
import { dayKey } from '../core/history';
import { appendHistory } from '../data';
import { type AppCtx, type PlayOptions, type Screen, h, noteOf, playTap, topBar } from './dom';
import { debugSaveButton, startDebugLog } from './debuglog';
import { createInstrument } from './instrument';
import { tickEnabled } from './settings';

const NS = 'http://www.w3.org/2000/svg';
const LEAD_IN = 1.2;
const RING_SPREAD = 1.3;
/** Удар с микрофона приходит с опозданием на время анализа, поэтому промах объявляем позже. */
const MIC_GRACE = 0.35;
const LATENCY_HINT_MS = 15;
/** Ноты ближе этого (в секундах) считаются одним аккордом. */
const CHORD_SPREAD = 0.03;

const DYN_WORD: Record<Dynamic, string> = { loud: 'ГРОМКО', soft: 'тихо' };
/** С какой разницы между громкими и тихими ударами контраст считается хорошим, дБ. */
const GOOD_CONTRAST_DB = 6;

/** Длина «трудного места», которое предлагается отработать после игры, в долях. */
const WEAK_SPAN_BEATS = 8;
/** Точность прохода, с которой цикл прибавляет темп. */
const RAMP_PASS = 0.9;
const LOOP_PAUSE_MS = 3500;
/** За сколько секунд до доли тик ставится в очередь звука. */
const TICK_AHEAD = 0.3;
/** Размер такта для тика: первая доля звучит выше. */
const TICK_BAR = 4;

export function gameScreen(
  ctx: AppCtx,
  comp: Composition,
  difficulty: Difficulty,
  opts: PlayOptions = {},
): Screen {
  const cfg = DIFFICULTIES[difficulty];
  const tempo = opts.tempo ?? 1;
  const kind = opts.kind ?? 'game';
  const parent = opts.parent ?? comp;
  const notes = toTimedNotes(comp, tempo);
  let loopTimer = 0;
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

  // В упражнениях доли отбивает тик метронома. Он лежит выше слышимого распознавателем
  // диапазона, поэтому с микрофоном ударом не считается.
  const ticking = kind === 'drill' && tickEnabled(ctx);
  let nextTick = -TICK_BAR;

  const log = startDebugLog(ctx, 'game', {
    composition: comp.id,
    title: comp.title,
    parent: parent.id,
    bpm: comp.bpm,
    tempo,
    kind,
    loop: opts.loop === true,
    difficulty,
    perfectMs: Math.round(cfg.perfect * 1000),
    goodMs: Math.round(cfg.good * 1000),
    tick: ticking,
  });

  /** Завершает отладочную запись: что ожидалось и как сыграна каждая нота. */
  function finishLog(): void {
    log?.finish((sec) => ({
      score: session.score,
      accuracy: Math.round(session.accuracy * 1000) / 1000,
      notes: notes.map((n, i) => {
        const off = session.offset(i);
        return {
          note: noteOf(ctx.scale, n.tongue),
          expectedSec: sec(startAt + n.time * 1000),
          ...(n.dyn ? { dyn: n.dyn } : {}),
          state: session.state(i),
          offsetMs: off === null ? null : Math.round(off * 1000),
        };
      }),
    }));
  }

  type HitResult = ReturnType<GameSession['hit']>;
  function logJudge(source: string, timeMs: number, id: string, r: HitResult): void {
    log?.mark('judge', timeMs, {
      source,
      note: noteOf(ctx.scale, id),
      grade: r.grade,
      ...(r.grade === 'stray' ? {} : { index: r.index, offsetMs: Math.round(r.offset * 1000) }),
    });
  }

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
            g.map((i) => noteOf(ctx.scale, notes[i].tongue)).join('+') +
              // Громкость: у ближайшей ноты словом, у следующих — значком.
              (notes[g[0]].dyn
                ? k === 0
                  ? ` — ${DYN_WORD[notes[g[0]].dyn as Dynamic]}`
                  : notes[g[0]].dyn === 'loud'
                    ? ' ●'
                    : ' ○'
                : ''),
          ),
        ),
      );
    }
    return current;
  }

  const quality: (HitQuality & { id: number })[] = [];
  /** Громкость ударов по нотам с заданной динамикой — только с микрофона. */
  const dynHits: DynamicsHit[] = [];
  const hasDynamics = notes.some((n) => n.dyn);

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
      logJudge(ev.tongues.includes(id) ? 'mic' : 'chord', ev.timeMs, id, r);
      if (r.grade === 'stray') {
        inst.flash(id, 'wrong');
        showJudge('Мимо', 'miss');
      } else {
        inst.flash(id, r.grade);
        removeRing(r.index);
        showJudge(r.grade === 'perfect' ? 'Идеально!' : 'Хорошо', r.grade);
        const dyn = notes[r.index].dyn;
        // Громкость берём только у реально услышанного поля, не у достроенных нот аккорда.
        if (dyn && ev.tongues.includes(id)) dynHits.push({ tongue: id, dyn, levelDb: ev.levelDb });
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
    logJudge('tap', performance.now(), id, r);
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
    finishLog();
    // Результат сохраняем сразу, чтобы он не пропал при быстром выходе с экрана.
    // Рекорды — только за целую композицию: проход фрагмента или упражнения не должен
    // помечать её пройденной.
    const isRecord =
      kind === 'game'
        ? recordGame(ctx.store, comp.id, difficulty, session.score, session.accuracy).isRecord
        : false;
    const hits: Record<string, number> = Object.create(null);
    const misses: Record<string, number> = Object.create(null);
    notes.forEach((n, i) => {
      const bucket = session.state(i) === 'miss' ? misses : hits;
      bucket[n.tongue] = (bucket[n.tongue] ?? 0) + 1;
    });
    appendHistory(ctx.store, {
      day: dayKey(new Date()),
      compId: parent.id,
      kind,
      accuracy: session.accuracy,
      notes: notes.length,
      seconds: Math.max(0, Math.round(now())),
      hits,
      misses,
    });
    finishTimer = window.setTimeout(
      () => (opts.loop ? showLoopResult() : showResults(isRecord)),
      700,
    );
  }

  const beatSec = 60 / (comp.bpm * tempo);
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
    if (ticking) {
      const end = notes[notes.length - 1].time + 1e-6;
      while (nextTick * beatSec - t < TICK_AHEAD && nextTick * beatSec <= end) {
        const at = nextTick * beatSec;
        // Доли, которые уже прошли (пауза, короткий отсчёт), не догоняем.
        if (at - t > -0.02) {
          const accent = ((nextTick % TICK_BAR) + TICK_BAR) % TICK_BAR === 0;
          ctx.synth.tick(Math.max(0, at - t), accent);
          log?.mark('tick', startAt + at * 1000, { accent });
        }
        nextTick++;
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
        ring.setAttribute('class', notes[spawn].dyn ? `ring ${notes[spawn].dyn}` : 'ring');
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

  /** Ноты, сыгранные не идеально: пропуск или удар за пределами окна «Идеально». */
  const isBad = (i: number) =>
    session.state(i) === 'miss' || Math.abs(session.offset(i) ?? 0) > cfg.perfect;

  /** Самый трудный отрезок композиции — если ошибок там хотя бы две. */
  function weakSpot(): { fromBeat: number; toBeat: number; bad: number } | null {
    const beats = comp.notes.map((n) => n.beat);
    const length = (beats[beats.length - 1] ?? 0) - (beats[0] ?? 0);
    if (length <= WEAK_SPAN_BEATS) return null;
    const w = weakestWindow(
      beats,
      notes.map((_, i) => isBad(i)),
      WEAK_SPAN_BEATS,
    );
    return w && w.bad >= 2 ? w : null;
  }

  /** Лента прохода: каждая нота — точка; выше линии — раньше срока, ниже — позже. */
  function timeline(weak: { fromBeat: number; toBeat: number } | null): HTMLElement {
    const total = notes[notes.length - 1]?.time || 1;
    const pct = (x: number) => `${(Math.min(1, Math.max(0, x)) * 94 + 3).toFixed(1)}%`;
    const box = h('div', {
      class: 'timeline',
      role: 'img',
      'aria-label': 'Ноты по времени: выше линии — раньше срока, ниже — позже, красные — пропуски',
    });
    if (weak) {
      const band = h('div', { class: 'tl-weak' });
      const from = (weak.fromBeat * beatSec) / total;
      const to = (weak.toBeat * beatSec) / total;
      band.style.left = pct(from);
      band.style.right = `${(100 - parseFloat(pct(to))).toFixed(1)}%`;
      box.append(band);
    }
    notes.forEach((n, i) => {
      const state = session.state(i);
      const off = session.offset(i);
      const y = state === 'miss' || off === null ? 0 : Math.max(-1, Math.min(1, off / cfg.good));
      const dot = h('span', { class: `tl-dot ${state}` });
      dot.style.left = pct(n.time / total);
      dot.style.top = `${(50 + y * 40).toFixed(1)}%`;
      box.append(dot);
    });
    return h(
      'div',
      {},
      box,
      h('p', { class: 'meta tl-legend' }, 'Выше линии — рано, ниже — поздно, красные — пропуски.'),
    );
  }

  const resultRow = (label: string, value: string) =>
    h('div', { class: 'result-row' }, h('span', {}, label), h('strong', {}, value));

  /** Ровность ритма и, в упражнениях на динамику, контраст громкости. В счёт не входят. */
  function skillRows(): (Node | string)[] {
    const rows: (Node | string)[] = [];
    const spread = timingSpread(notes.map((_, i) => session.offset(i)));
    if (spread) {
      rows.push(resultRow('Ровность ритма', `±${spread.spreadMs} мс`));
      // С микрофоном среднее смещение уже показано в блоке качества звука.
      if (spread.meanMs !== 0 && quality.length === 0) {
        rows.push(
          resultRow(
            'В среднем',
            `на ${Math.abs(spread.meanMs)} мс ${spread.meanMs > 0 ? 'позже' : 'раньше'}`,
          ),
        );
      }
    }
    if (hasDynamics) {
      const d = dynamicsReport(dynHits);
      if (d) {
        const contrast = Math.round(d.contrastDb);
        rows.push(
          resultRow('Громкие громче тихих', `на ${contrast} дБ`),
          resultRow('Удары нужной громкости', `${d.correct} из ${d.total}`),
          h(
            'p',
            { class: 'hint' },
            contrast >= GOOD_CONTRAST_DB
              ? 'Контраст хороший: тихие и громкие удары различаются отчётливо.'
              : contrast > 0
                ? `Контраст слабый: попробуйте бить тихие ещё мягче. Хорошо — от ${GOOD_CONTRAST_DB} дБ.`
                : 'Тихие удары вышли не тише громких.',
          ),
        );
      } else {
        rows.push(
          h(
            'p',
            { class: 'hint' },
            'Громкость оценивается только с микрофоном, на настоящем инструменте.',
          ),
        );
      }
    }
    return rows;
  }

  /** Итог прохода в цикле: темп растёт после чистой игры, цикл идёт сам. */
  function showLoopResult(): void {
    const acc = session.accuracy;
    const next = nextTempo(tempo, acc, { pass: RAMP_PASS });
    const mastered = tempo >= 1 && acc >= RAMP_PASS;
    const pc = (x: number) => `${Math.round(x * 100)}%`;
    const again = (t: number) => ctx.play(comp, difficulty, { ...opts, tempo: t });
    const go = () => again(next);
    if (!mastered) loopTimer = window.setTimeout(go, LOOP_PAUSE_MS);
    overlayHost.replaceChildren(
      h(
        'div',
        { class: 'modal', role: 'dialog', 'aria-label': 'Итог прохода' },
        h(
          'div',
          { class: 'modal-card' },
          h('h2', {}, mastered ? 'Освоено на полном темпе!' : `Темп ${pc(tempo)}: точность ${pc(acc)}`),
          timeline(null),
          ...skillRows(),
          h(
            'p',
            { class: 'hint' },
            mastered
              ? `Точность ${pc(acc)}. Можно играть композицию целиком.`
              : next > tempo
                ? `Чисто — ускоряемся до ${pc(next)}.`
                : `Для следующего темпа нужно ${pc(RAMP_PASS)} — повторяем на ${pc(tempo)}.`,
          ),
          h(
            'div',
            { class: 'row' },
            mastered
              ? h(
                  'button',
                  {
                    class: 'btn primary',
                    type: 'button',
                    onclick: () => (parent === comp ? again(1) : ctx.play(parent, difficulty)),
                  },
                  parent === comp ? 'Ещё раз' : 'Сыграть целиком',
                )
              : h('button', { class: 'btn primary', type: 'button', onclick: go }, 'Дальше'),
            h('button', { class: 'btn', type: 'button', onclick: ctx.home }, 'Стоп'),
          ),
          // Сохранение останавливает автопродолжение: иначе запись ушла бы со следующим проходом.
          debugSaveButton(() => window.clearTimeout(loopTimer)),
        ),
      ),
    );
  }

  function showResults(isRecord: boolean): void {
    const weak = kind === 'game' ? weakSpot() : null;
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
          timeline(weak),
          ...skillRows(),
          weak
            ? h(
                'button',
                {
                  class: 'btn wide-btn',
                  type: 'button',
                  onclick: () =>
                    ctx.play(sliceComposition(comp, weak.fromBeat, weak.toBeat), difficulty, {
                      tempo: RAMP_START,
                      loop: true,
                      kind: 'fragment',
                      parent: comp,
                    }),
                },
                `Отработать трудное место (неточных нот: ${weak.bad})`,
              )
            : '',
          ...qualityRows,
          debugSaveButton(),
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
              {
                class: 'btn primary',
                type: 'button',
                onclick: () => ctx.play(comp, difficulty, opts),
              },
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
    topBar(
      comp.title,
      ctx.home,
      h(
        'span',
        { class: 'badge' },
        opts.loop || tempo !== 1 ? `темп ${Math.round(tempo * 100)}%` : cfg.label,
      ),
    ),
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
      ticking ? ' Доли отбивает тик.' : '',
      log ? (ctx.mic.enabled ? ' Отладка: идёт запись.' : ' Отладка: пишется отчёт без звука.') : '',
    ),
    overlayHost,
  );

  inst.el.classList.add('pulsing');
  raf = requestAnimationFrame(frame);

  return {
    el,
    destroy() {
      done = true;
      finishLog();
      cancelAnimationFrame(raf);
      window.clearTimeout(finishTimer);
      window.clearTimeout(judgeTimer);
      window.clearTimeout(loopTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribeMic();
      inst.destroy();
    },
  };
}
