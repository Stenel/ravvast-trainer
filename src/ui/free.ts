import { MUTED_RATIO, clarityPercent } from '../core/quality';
import { type AppCtx, type Screen, h, levelMeter, noteOf, playTap, topBar } from './dom';
import { createInstrument } from './instrument';

export function freeScreen(ctx: AppCtx): Screen {
  const inst = createInstrument(ctx.scale, (id) => {
    playTap(ctx, id);
    inst.flash(id, 'hit');
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
    for (const id of ev.tongues) inst.flash(id, 'good');
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
    ctx.mic.enabled ? h('div', { class: 'row center' }, recordBtn) : '',
  );
  return {
    el,
    destroy() {
      unsubscribe();
      meter.destroy();
      inst.destroy();
    },
  };
}
