import { averageTemplates, cosine } from '../core/detector';
import { type AppCtx, type Screen, h, levelMeter, topBar } from './dom';
import { createInstrument } from './instrument';

const HITS_PER_TONGUE = 3;
const MIN_GAP_MS = 700;
/** Если шаблоны двух полей похожи сильнее — микрофон их плохо различает. */
const CONFUSABLE = 0.92;
/**
 * Для эталона нужен чистый удар. У инструмента долгий сустейн: удар по ещё громко
 * звучащему полю даёт искажённый «отпечаток», поэтому такие удары не принимаем.
 */
const MIN_CLEAN_NOVELTY = 0.85;
/**
 * Ниже этого сходства со встроенным шаблоном выбранного поля удар в эталон не берём:
 * это другое поле, призвук от приглушения или посторонний звук. Именно такие звуки
 * раньше попадали в калибровку и портили её.
 */
const MIN_OWN_SIMILARITY = 0.5;

export function calibrateScreen(ctx: AppCtx): Screen {
  const tongues = ctx.scale.tongues;
  const noteOfId = (id: string) => tongues.find((t) => t.id === id)?.note ?? id;
  const firstTodo = () => {
    const done = ctx.mic.calibratedIds();
    return tongues.find((t) => !done.includes(t.id))?.id ?? tongues[0].id;
  };

  let selected = firstTodo();
  let collected: Float64Array[] = [];
  const templates = new Map<string, Float64Array>();
  let lastHit = 0;
  let note = '';

  const inst = createInstrument(ctx.scale, (id) => {
    selected = id;
    collected = [];
    note = '';
    render();
  });
  const meter = levelMeter(ctx);
  const status = h('p', { class: 'calib-status' });
  const detail = h('p', { class: 'hint' });
  const result = h('div', { class: 'message' });
  const actions = h('div', { class: 'row center' });

  function say(lines: string[], kind: 'ok' | 'error' | ''): void {
    result.className = `message ${kind}`;
    result.replaceChildren(...lines.map((l) => h('div', {}, l)));
  }

  function saveSelected(): void {
    // Встроенный шаблон участвует в среднем как ещё один удар: уточнение под микрофон
    // не может увести эталон далеко от измеренного спектра поля.
    const builtin = ctx.mic.builtinTemplates()?.[selected];
    const template = averageTemplates(builtin ? [...collected, builtin] : collected);
    const saved = ctx.mic.saveTongueCalibration(selected, template);
    templates.set(selected, template);
    const confusable = [...templates]
      .filter(([id, t]) => id !== selected && cosine(template, t) > CONFUSABLE)
      .map(([id]) => noteOfId(id));
    const lines = [
      saved ? `Поле ${noteOfId(selected)} откалибровано.` : 'Не удалось сохранить калибровку.',
    ];
    if (confusable.length) {
      lines.push(
        `Микрофон плохо отличает его от: ${confusable.join(', ')}. Попробуйте поднести телефон ближе и повторить.`,
      );
    }
    say(lines, saved ? 'ok' : 'error');
    collected = [];
    note = '';
    const done = ctx.mic.calibratedIds();
    const next = tongues.find((t) => !done.includes(t.id));
    if (next) selected = next.id;
  }

  const unsubscribe = ctx.mic.subscribe((ev) => {
    if (ev.type !== 'hit') return;
    if (ev.timeMs - lastHit < MIN_GAP_MS) return;
    lastHit = ev.timeMs;
    const builtin = ctx.mic.builtinTemplates()?.[selected];
    if (builtin && cosine(ev.feature, builtin) < MIN_OWN_SIMILARITY) {
      note = `Это не похоже на удар по полю ${noteOfId(selected)} — ударьте по подсвеченному полю ещё раз.`;
      inst.flash(selected, 'wrong');
      render();
      return;
    }
    if (ev.novelty < MIN_CLEAN_NOVELTY) {
      note = 'Поле ещё звучит — приглушите его ладонью и ударьте снова.';
      inst.flash(selected, 'wrong');
      render();
      return;
    }
    note = '';
    collected.push(ev.feature);
    inst.flash(selected, 'good');
    if (collected.length >= HITS_PER_TONGUE) saveSelected();
    render();
  });
  const unsubStatus = ctx.mic.onStatus(render);

  function render(): void {
    if (ctx.mic.status !== 'on') {
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
    const done = ctx.mic.calibratedIds();
    inst.setMarked(done);
    inst.setTargets([selected]);
    const t = tongues.find((x) => x.id === selected);
    const all = done.length >= tongues.length;
    status.textContent = `${t?.note ?? ''}${t?.center ? ' (центр)' : ''}: удар ${collected.length + 1} из ${HITS_PER_TONGUE} · готово полей: ${done.length} из ${tongues.length}`;
    detail.textContent =
      note ||
      (all
        ? 'Все поля откалиброваны. Чтобы переснять поле, коснитесь его на схеме.'
        : 'Ударьте по подсвеченному полю, затем приглушите его ладонью — и так три раза. Другое поле можно выбрать касанием на схеме.');
    actions.replaceChildren(
      h('button', { class: 'btn primary', type: 'button', onclick: ctx.free }, 'Проверить'),
      h(
        'button',
        {
          class: 'btn ghost',
          type: 'button',
          onclick: () => {
            if (!window.confirm('Сбросить калибровку всех полей?')) return;
            ctx.mic.clearCalibration();
            templates.clear();
            collected = [];
            selected = tongues[0].id;
            say(['Калибровка сброшена.'], 'ok');
            render();
          },
        },
        'Сбросить всё',
      ),
    );
  }

  const el = h(
    'div',
    { class: 'screen' },
    topBar('Калибровка', ctx.home),
    status,
    meter.el,
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
      meter.destroy();
      inst.destroy();
    },
  };
}
