import { MUTED_RATIO, clarityPercent } from '../core/quality';
import { type RecordedHit, hitsToComposition } from '../core/record';
import { freeImportedId, saveImported } from '../data';
import { type AppCtx, type Screen, h, levelMeter, noteOf, playTap, topBar } from './dom';
import { createInstrument } from './instrument';

export function freeScreen(ctx: AppCtx): Screen {
  // Запись импровизации: удары (с экрана или с микрофона) превращаются в композицию.
  const MAX_TAKE_NOTES = 2000;
  let take: RecordedHit[] | null = null;
  let alive = true;
  const takeBtn = h('button', { class: 'btn', type: 'button', onclick: toggleTake });
  const takeMsg = h('p', { class: 'hint', role: 'status' });

  function capture(tongue: string, timeMs: number): void {
    if (!take) return;
    if (take.length >= MAX_TAKE_NOTES) {
      takeMsg.textContent = `Достигнут предел в ${MAX_TAKE_NOTES} нот — остановите запись.`;
      return;
    }
    take.push({ tongue, timeMs });
    renderTake();
  }

  function renderTake(): void {
    takeBtn.textContent = take
      ? `Остановить и сохранить (нот: ${take.length})`
      : 'Записать свою композицию';
    takeBtn.classList.toggle('primary', take !== null);
  }

  function toggleTake(): void {
    if (!take) {
      take = [];
      takeMsg.textContent = 'Играйте — каждая нота записывается.';
      renderTake();
      return;
    }
    const hits = take;
    take = null;
    renderTake();
    if (hits.length < 2) {
      takeMsg.textContent = 'Слишком мало нот — запись не сохранена.';
      return;
    }
    const stamp = new Date().toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const title = window.prompt('Название композиции', `Моя запись ${stamp}`);
    if (title === null) {
      takeMsg.textContent = 'Запись отменена.';
      return;
    }
    const made = hitsToComposition(hits, title, ctx.scale.id);
    const comp = made && { ...made, id: freeImportedId(ctx.store, made.id) };
    takeMsg.textContent =
      comp && saveImported(ctx.store, comp)
        ? `Сохранено: «${comp.title}». Она появилась в списке композиций.`
        : 'Не удалось сохранить запись.';
  }

  const inst = createInstrument(ctx.scale, (id) => {
    playTap(ctx, id);
    inst.flash(id, 'hit');
    capture(id, performance.now());
  });
  const heard = h('p', { class: 'heard', role: 'status' });
  const debug = h('p', { class: 'hint debug' });
  const meter = levelMeter(ctx);
  let lastId = -1;

  const unsubscribe = ctx.mic.subscribe((ev) => {
    if (ev.type === 'sustain') {
      if (ev.id === lastId && ev.ratio < MUTED_RATIO) heard.textContent += ' · заглушено';
      return;
    }
    lastId = ev.id;
    // Диагностика: на какие поля похож звук и сколько в нём «нового».
    debug.textContent =
      ev.scores
        .map((s) => `${noteOf(ctx.scale, s.id)} ${Math.round(Math.max(0, s.similarity) * 100)}%`)
        .join(' · ') + ` · новизна ${Math.round(ev.novelty * 100)}%`;
    if (ev.tongues.length === 0) {
      heard.textContent = 'Звук не распознан';
      return;
    }
    for (const id of ev.tongues) {
      inst.flash(id, 'good');
      capture(id, ev.timeMs);
    }
    const notes = ev.tongues.map((id) => noteOf(ctx.scale, id)).join(' + ');
    heard.textContent = `${notes} · чистота ${clarityPercent(ev.clarity)}% · ${Math.round(ev.levelDb)} дБ`;
  });

  const RECORD_SECONDS = 15;
  const recordBtn = h(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: () => {
        recordBtn.disabled = true;
        recordBtn.textContent = `Идёт запись ${RECORD_SECONDS} с — играйте…`;
        ctx.mic
          .record(RECORD_SECONDS)
          .then((blob) => {
            // Пользователь уже ушёл с экрана — не подсовываем скачивание на другом экране.
            if (!alive) return;
            const url = URL.createObjectURL(blob);
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            const link = h('a', { href: url, download: `rav-${stamp}.wav` });
            document.body.append(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
            recordBtn.textContent = 'Файл сохранён. Записать ещё';
          })
          .catch(() => {
            recordBtn.textContent = 'Запись не удалась — включите микрофон';
          })
          .finally(() => {
            recordBtn.disabled = false;
          });
      },
    },
    `Записать ${RECORD_SECONDS} с для диагностики`,
  );

  const el = h(
    'div',
    { class: 'screen' },
    topBar('Свободная игра', ctx.home),
    heard,
    debug,
    meter.el,
    h('div', { class: 'stage' }, inst.el as unknown as Node),
    h(
      'p',
      { class: 'hint' },
      ctx.mic.enabled
        ? 'Играйте на инструменте — распознанные поля подсвечиваются.'
        : 'Касайтесь полей или нажимайте клавиши с их номерами — 0 это центр.',
    ),
    h('div', { class: 'row center' }, takeBtn, ctx.mic.enabled ? recordBtn : ''),
    takeMsg,
  );
  renderTake();
  return {
    el,
    destroy() {
      alive = false;
      // Диагностическая запись не должна идти дальше на других экранах.
      ctx.mic.endCapture();
      unsubscribe();
      meter.destroy();
      inst.destroy();
    },
  };
}
