import { MUTED_RATIO, clarityPercent } from '../core/quality';
import { type AppCtx, type Screen, h, noteOf, playTap, topBar } from './dom';
import { createInstrument } from './instrument';

export function freeScreen(ctx: AppCtx): Screen {
  const inst = createInstrument(ctx.scale, (id) => {
    playTap(ctx, id);
    inst.flash(id, 'hit');
  });
  const heard = h('p', { class: 'heard', role: 'status' });
  let lastId = -1;

  const unsubscribe = ctx.mic.subscribe((ev) => {
    if (ev.type === 'sustain') {
      if (ev.id === lastId && ev.ratio < MUTED_RATIO) heard.textContent += ' · заглушено';
      return;
    }
    lastId = ev.id;
    if (ev.tongues.length === 0) {
      heard.textContent = 'Звук не распознан';
      return;
    }
    for (const id of ev.tongues) inst.flash(id, 'good');
    const notes = ev.tongues.map((id) => noteOf(ctx.scale, id)).join(' + ');
    heard.textContent = `${notes} · чистота ${clarityPercent(ev.clarity)}% · ${Math.round(ev.levelDb)} дБ`;
  });

  const el = h(
    'div',
    { class: 'screen' },
    topBar('Свободная игра', ctx.home),
    heard,
    h('div', { class: 'stage' }, inst.el as unknown as Node),
    h(
      'p',
      { class: 'hint' },
      ctx.mic.enabled
        ? 'Играйте на инструменте — распознанные поля подсвечиваются.'
        : 'Касайтесь полей или нажимайте клавиши с их номерами — 0 это центр.',
    ),
  );
  return {
    el,
    destroy() {
      unsubscribe();
      inst.destroy();
    },
  };
}
