import { averageTemplates, cosine } from '../core/detector';
import { type AppCtx, type Screen, h, topBar } from './dom';
import { createInstrument } from './instrument';

const HITS_PER_TONGUE = 3;
const MIN_LEVEL_DB = -45;
const MIN_GAP_MS = 350;
/** Если шаблоны двух полей похожи сильнее — микрофон их плохо различает. */
const CONFUSABLE = 0.92;

export function calibrateScreen(ctx: AppCtx): Screen {
  const tongues = ctx.scale.tongues;
  let index = 0;
  let collected: Float64Array[][] = tongues.map(() => []);
  let lastHit = 0;
  let finished = false;

  const inst = createInstrument(ctx.scale, () => undefined);
  const status = h('p', { class: 'calib-status' });
  const detail = h('p', { class: 'hint' });
  const result = h('div', { class: 'message' });
  const actions = h('div', { class: 'row center' });

  function finish(): void {
    finished = true;
    const templates = Object.fromEntries(
      tongues.map((t, i) => [t.id, averageTemplates(collected[i])]),
    );
    const confusable: string[] = [];
    for (let a = 0; a < tongues.length; a++) {
      for (let b = a + 1; b < tongues.length; b++) {
        if (cosine(templates[tongues[a].id], templates[tongues[b].id]) > CONFUSABLE) {
          confusable.push(`${tongues[a].note} и ${tongues[b].note}`);
        }
      }
    }
    const saved = ctx.mic.saveCalibration(templates);
    result.className = `message ${saved ? 'ok' : 'error'}`;
    result.replaceChildren(
      h('div', {}, saved ? 'Калибровка сохранена.' : 'Не удалось сохранить калибровку.'),
      ...(confusable.length
        ? [
            h(
              'div',
              {},
              `Микрофон плохо различает поля: ${confusable.join('; ')}. Попробуйте поднести его ближе и повторить.`,
            ),
          ]
        : []),
    );
    render();
  }

  const unsubscribe = ctx.mic.subscribe((ev) => {
    if (finished || ev.type !== 'hit' || ev.levelDb < MIN_LEVEL_DB) return;
    if (ev.timeMs - lastHit < MIN_GAP_MS) return;
    lastHit = ev.timeMs;
    collected[index].push(ev.feature);
    inst.flash(tongues[index].id, 'good');
    if (collected[index].length >= HITS_PER_TONGUE) {
      index++;
      if (index >= tongues.length) {
        finish();
        return;
      }
    }
    render();
  });
  const unsubStatus = ctx.mic.onStatus(render);

  function restart(): void {
    index = 0;
    collected = tongues.map(() => []);
    finished = false;
    result.className = 'message';
    result.replaceChildren();
    render();
  }

  function render(): void {
    const on = ctx.mic.status === 'on';
    if (!on) {
      inst.setTargets([]);
      status.textContent =
        ctx.mic.status === 'starting' ? 'Включаю микрофон…' : 'Микрофон не включён.';
      detail.textContent = 'Для калибровки нужен доступ к микрофону.';
      actions.replaceChildren(
        h(
          'button',
          { class: 'btn primary', type: 'button', onclick: () => void ctx.mic.start() },
          'Включить микрофон',
        ),
      );
      return;
    }
    if (finished) {
      inst.setTargets([]);
      status.textContent = 'Готово';
      detail.textContent = 'Проверьте распознавание в свободной игре.';
      actions.replaceChildren(
        h('button', { class: 'btn primary', type: 'button', onclick: ctx.free }, 'Проверить'),
        h('button', { class: 'btn', type: 'button', onclick: restart }, 'Заново'),
      );
      return;
    }
    const t = tongues[index];
    inst.setTargets([t.id]);
    status.textContent = `Поле ${index + 1} из ${tongues.length}: ${t.note}${t.center ? ' (центр)' : ''}`;
    detail.textContent = `Ударьте по подсвеченному полю ${HITS_PER_TONGUE} раза с паузой, давая звуку затихнуть. Удар ${collected[index].length + 1} из ${HITS_PER_TONGUE}.`;
    actions.replaceChildren(
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => {
            collected[index] = [];
            render();
          },
        },
        'Повторить поле',
      ),
      h(
        'button',
        {
          class: 'btn ghost',
          type: 'button',
          onclick: () => {
            ctx.mic.saveCalibration(null);
            restart();
            result.className = 'message ok';
            result.replaceChildren(h('div', {}, 'Калибровка сброшена.'));
          },
        },
        'Сбросить калибровку',
      ),
    );
  }

  const el = h(
    'div',
    { class: 'screen' },
    topBar('Калибровка', ctx.home),
    status,
    h('div', { class: 'stage' }, inst.el as unknown as Node),
    detail,
    actions,
    result,
  );
  render();

  return {
    el,
    destroy() {
      unsubscribe();
      unsubStatus();
      inst.destroy();
    },
  };
}
