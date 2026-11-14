import { type AppCtx, type Screen, h, levelMeter, noteOf, topBar } from './dom';
import { createInstrument } from './instrument';

const ROUNDS = 3;
/** Пауза после удара перед следующим заданием: рука успевает приглушить поле. */
const NEXT_DELAY_MS = 1400;
const MAX_CAPTURE_SECONDS = 240;

interface Trial {
  expected: string;
  /** Что услышано (пусто — звук не узнан); null — задание пропущено. */
  heard: string[] | null;
  /** Момент удара на шкале событий микрофона, мс. */
  rawTimeMs: number | null;
  /** Секунды от начала сохранённой записи. */
  timeSec: number | null;
  clarity: number | null;
  novelty: number | null;
  levelDb: number | null;
  scores: { id: string; similarity: number }[];
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Проверка точности: приложение по очереди просит ударить по каждому полю и сравнивает
 * услышанное с ожидаемым. Итог — точность по полям и размеченная запись для настройки.
 */
export function accuracyScreen(ctx: AppCtx): Screen {
  const tongues = ctx.scale.tongues;
  // Порядок: несколько кругов по всем полям, внутри круга — вперемешку, без повторов подряд.
  const order: string[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const ids = tongues.map((t) => t.id);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    if (order.length && ids[0] === order[order.length - 1]) ids.push(ids.shift() as string);
    order.push(...ids);
  }

  const trials: Trial[] = [];
  let index = -1; // -1 — ещё не начато
  let waiting = false;
  let nextTimer = 0;
  let alive = true;
  let capture: { blob: Blob; startMs: number } | null = null;

  const inst = createInstrument(ctx.scale, () => undefined);
  const meter = levelMeter(ctx);
  const status = h('p', { class: 'calib-status' });
  const detail = h('p', { class: 'hint' });
  const actions = h('div', { class: 'row center' });
  const report = h('div', { class: 'report' });

  const isCorrect = (t: Trial) => t.heard !== null && t.heard.length === 1 && t.heard[0] === t.expected;
  const heardText = (t: Trial) =>
    t.heard === null
      ? 'пропуск'
      : t.heard.length === 0
        ? 'не узнано'
        : t.heard.map((id) => noteOf(ctx.scale, id)).join('+');

  function ask(): void {
    index++;
    if (index >= order.length) {
      finish();
      return;
    }
    waiting = true;
    render();
  }

  function answer(trial: Trial): void {
    trials.push(trial);
    waiting = false;
    inst.flash(trial.expected, isCorrect(trial) ? 'perfect' : 'miss');
    render();
    window.clearTimeout(nextTimer);
    nextTimer = window.setTimeout(ask, NEXT_DELAY_MS);
  }

  const unsubscribe = ctx.mic.subscribe((ev) => {
    if (ev.type !== 'hit' || !waiting) return;
    answer({
      expected: order[index],
      heard: ev.tongues,
      rawTimeMs: ev.timeMs,
      timeSec: null,
      clarity: ev.clarity,
      novelty: ev.novelty,
      levelDb: ev.levelDb,
      scores: ev.scores,
    });
  });
  const unsubStatus = ctx.mic.onStatus(render);

  function start(): void {
    window.clearTimeout(nextTimer);
    trials.length = 0;
    index = -1;
    capture = null;
    report.replaceChildren();
    ctx.mic.endCapture();
    ctx.mic.beginCapture(MAX_CAPTURE_SECONDS);
    ask();
  }

  function finish(): void {
    window.clearTimeout(nextTimer);
    waiting = false;
    index = order.length;
    capture = ctx.mic.endCapture();
    if (capture) {
      for (const t of trials) {
        t.timeSec = t.rawTimeMs === null ? null : Math.round(t.rawTimeMs - capture.startMs) / 1000;
      }
    }
    render();
  }

  function summaryRows(): (Node | string)[] {
    return tongues.map((t) => {
      const mine = trials.filter((x) => x.expected === t.id);
      const good = mine.filter(isCorrect).length;
      const wrong = mine.filter((x) => !isCorrect(x)).map(heardText);
      return h(
        'div',
        { class: 'result-row' },
        h('span', {}, `${t.note}${wrong.length ? ` → ${wrong.join(', ')}` : ''}`),
        h(
          'strong',
          { class: mine.length > 0 && good === mine.length ? 'ok-text' : '' },
          `${good} из ${mine.length}`,
        ),
      );
    });
  }

  function saveFiles(): void {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const labels = {
      scale: ctx.scale.id,
      sampleRate: ctx.mic.sampleRate,
      calibration: ctx.mic.calibration,
      sensitivity: ctx.mic.sensitivity,
      trials: trials.map((t) => ({
        expected: noteOf(ctx.scale, t.expected),
        expectedId: t.expected,
        heard: t.heard === null ? null : t.heard.map((id) => noteOf(ctx.scale, id)),
        timeSec: t.timeSec,
        clarity: t.clarity,
        novelty: t.novelty,
        levelDb: t.levelDb,
        scores: t.scores.map((s) => ({
          note: noteOf(ctx.scale, s.id),
          similarity: Math.round(s.similarity * 1000) / 1000,
        })),
      })),
    };
    download(
      new Blob([JSON.stringify(labels, null, 2)], { type: 'application/json' }),
      `rav-test-${stamp}.json`,
    );
    // Второй файл — с небольшой задержкой: браузеры блокируют одновременные скачивания.
    const audio = capture;
    if (audio) {
      window.setTimeout(() => {
        if (alive) download(audio.blob, `rav-test-${stamp}.wav`);
      }, 700);
    }
  }

  function render(): void {
    if (ctx.mic.status !== 'on') {
      inst.setTargets([]);
      status.textContent =
        ctx.mic.status === 'starting' ? 'Включаю микрофон…' : 'Микрофон не включён.';
      detail.textContent = 'Для проверки нужен доступ к микрофону.';
      actions.replaceChildren(
        h(
          'button',
          { class: 'btn primary', type: 'button', onclick: () => void ctx.mic.start() },
          'Включить микрофон',
        ),
      );
      return;
    }
    if (index < 0) {
      inst.setTargets([]);
      status.textContent = `Проверка точности: ${order.length} ударов`;
      detail.textContent =
        'Приложение по очереди подсветит каждое поле. Ударьте по нему один раз и приглушите ладонью. В конце покажу, какие поля узнаются уверенно, а какие путаются.';
      actions.replaceChildren(
        h('button', { class: 'btn primary', type: 'button', onclick: start }, 'Начать'),
      );
      return;
    }
    if (index >= order.length) {
      inst.setTargets([]);
      const correct = trials.filter(isCorrect).length;
      const pct = Math.round((correct / Math.max(1, trials.length)) * 100);
      status.textContent = `Узнано верно: ${correct} из ${trials.length} (${pct}%)`;
      detail.textContent =
        'Сохраните отчёт и запись — по ним распознавание можно настроить точнее. Сохранятся два файла: .json и .wav.';
      report.replaceChildren(...summaryRows());
      actions.replaceChildren(
        h(
          'button',
          { class: 'btn primary', type: 'button', onclick: saveFiles },
          'Сохранить отчёт и запись',
        ),
        h('button', { class: 'btn', type: 'button', onclick: start }, 'Заново'),
      );
      return;
    }
    const id = order[index];
    inst.setTargets(waiting ? [id] : []);
    status.textContent = `Удар ${index + 1} из ${order.length}: ${noteOf(ctx.scale, id)}`;
    const last = trials[trials.length - 1];
    detail.textContent =
      waiting || !last
        ? 'Ударьте по подсвеченному полю один раз.'
        : `Услышано: ${heardText(last)}. Приглушите поле.`;
    actions.replaceChildren(
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          disabled: !waiting,
          onclick: () =>
            answer({
              expected: id,
              heard: null,
              rawTimeMs: null,
              timeSec: null,
              clarity: null,
              novelty: null,
              levelDb: null,
              scores: [],
            }),
        },
        'Не услышал — пропустить',
      ),
      h('button', { class: 'btn ghost', type: 'button', onclick: finish }, 'Закончить'),
    );
  }

  const el = h(
    'div',
    { class: 'screen' },
    topBar('Проверка точности', ctx.home),
    status,
    meter.el,
    h('div', { class: 'stage' }, inst.el as unknown as Node),
    detail,
    actions,
    report,
  );
  render();

  return {
    el,
    destroy() {
      alive = false;
      window.clearTimeout(nextTimer);
      ctx.mic.endCapture();
      unsubscribe();
      unsubStatus();
      meter.destroy();
      inst.destroy();
    },
  };
}
