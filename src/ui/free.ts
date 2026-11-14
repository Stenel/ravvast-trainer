import { type AppCtx, type Screen, freqOf, h, topBar } from './dom';
import { createInstrument } from './instrument';

export function freeScreen(ctx: AppCtx): Screen {
  const inst = createInstrument(ctx.scale, (id) => {
    ctx.synth.play(freqOf(ctx.scale, id));
    inst.flash(id, 'hit');
  });
  const el = h(
    'div',
    { class: 'screen' },
    topBar('Свободная игра', ctx.home),
    h('div', { class: 'stage' }, inst.el as unknown as Node),
    h(
      'p',
      { class: 'hint' },
      'Касайтесь полей или нажимайте клавиши с их номерами — 0 это центр.',
    ),
  );
  return { el, destroy: () => inst.destroy() };
}
