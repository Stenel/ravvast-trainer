import { parseCompositionJson } from '../core/composition';
import { DIFFICULTIES, type Difficulty } from '../core/judge';
import { type Progress, bestAccuracy, loadProgress, starsFor } from '../core/progress';
import type { Composition } from '../core/types';
import { loadBuiltin, loadImported, removeImported, saveImported } from '../data';
import { type AppCtx, type Screen, h } from './dom';
import { canInstall, onInstallChange, promptInstall } from './install';

const DIFFICULTY_KEY = 'ravvast-trainer:difficulty';
const MAX_FILE_BYTES = 1_000_000;
const LEVELS = { 1: 'Просто', 2: 'Средне', 3: 'Сложно' } as const;

const EXAMPLE = `{
  "title": "Моя мелодия",
  "scale": "SCALE_ID",
  "bpm": 90,
  "notes": [
    { "tongue": "0", "beat": 0, "duration": 1 },
    { "tongue": "4", "beat": 1, "duration": 1 }
  ]
}`;

function readDifficulty(ctx: AppCtx): Difficulty {
  const v = ctx.store.getItem(DIFFICULTY_KEY);
  return v === 'easy' || v === 'hard' ? v : 'normal';
}

export function homeScreen(ctx: AppCtx): Screen {
  let difficulty = readDifficulty(ctx);
  const list = h('div', { class: 'list' });
  const levelRow = h('div', {
    class: 'segmented four',
    role: 'group',
    'aria-label': 'Уровень композиций',
  });
  let levelFilter: 0 | 1 | 2 | 3 = 0;
  const message = h('div', { class: 'message', role: 'alert' });
  const diffRow = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Сложность' });

  function showMessage(lines: string[], kind: 'error' | 'ok'): void {
    message.className = `message ${kind}`;
    message.replaceChildren(...lines.map((l) => h('div', {}, l)));
  }

  const inputBox = h('div', { class: 'input-box' });

  const MIC_STATUS: Record<string, string> = {
    off: 'Микрофон включится на экране игры, разучивания или калибровки.',
    starting: 'Включаю микрофон…',
    on: 'Микрофон слушает инструмент.',
    denied: 'Нет доступа к микрофону. Разрешите его для этого сайта в настройках браузера.',
    unsupported: 'Этот браузер не поддерживает запись звука.',
    insecure: 'Микрофон доступен только по HTTPS или на localhost.',
    error: 'Не удалось запустить микрофон. Проверьте, что он подключён и не занят.',
  };
  const CALIBRATION: Record<string, string> = {
    ok: 'Калибровка выполнена.',
    partial: 'Откалиброваны не все поля — остальные распознаются приблизительно.',
    stale: 'Калибровка снята на другом устройстве звука — повторите её.',
    none: 'Калибровка не выполнена: распознавание приблизительное.',
  };

  let alive = true;
  let accessOk = false;

  /**
   * Запрашивает доступ к микрофону (браузер покажет вопрос) и сразу отпускает его:
   * на главном экране слушать незачем, микрофон включится на экране игры.
   */
  function checkAccess(): void {
    void ctx.mic.start().then((ok) => {
      accessOk = ok;
      if (alive && ok) ctx.mic.stop();
    });
  }

  function renderInput(): void {
    const mic = ctx.mic;
    const seg = (label: string, on: boolean, click: () => void) =>
      h(
        'button',
        { type: 'button', class: on ? 'seg active' : 'seg', 'aria-pressed': String(on), onclick: click },
        label,
      );
    const children: (Node | string)[] = [
      h(
        'div',
        { class: 'segmented two', role: 'group', 'aria-label': 'Способ ввода' },
        seg('Экран', !mic.enabled, () => {
          mic.setEnabled(false);
          renderInput();
        }),
        seg('Микрофон', mic.enabled, () => {
          mic.setEnabled(true);
          renderInput();
          checkAccess();
        }),
      ),
    ];
    if (mic.enabled) {
      const latency = h('input', {
        type: 'number',
        min: -400,
        max: 400,
        step: 5,
        value: mic.latencyMs,
        inputmode: 'numeric',
        'aria-label': 'Задержка микрофона, мс',
        onchange: () => {
          mic.setLatency(Number(latency.value));
          latency.value = String(mic.latencyMs);
        },
      });
      const sens = h(
        'select',
        {
          'aria-label': 'Чувствительность',
          onchange: () => mic.setSensitivity(sens.value as 'low' | 'normal' | 'high'),
        },
        h('option', { value: 'low' }, 'низкая'),
        h('option', { value: 'normal' }, 'средняя'),
        h('option', { value: 'high' }, 'высокая'),
      );
      sens.value = mic.sensitivity;
      children.push(
        h(
          'p',
          { class: accessOk && mic.status === 'off' ? 'meta ok-text' : 'meta' },
          accessOk && mic.status === 'off'
            ? 'Доступ к микрофону есть. Он включится на экране игры, разучивания или калибровки.'
            : MIC_STATUS[mic.status],
        ),
        h('p', { class: 'meta' }, CALIBRATION[mic.calibration]),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: ctx.calibrate }, 'Калибровка'),
          h('button', { class: 'btn', type: 'button', onclick: checkAccess }, 'Проверить доступ'),
        ),
        h('label', { class: 'control' }, 'Задержка микрофона, мс', latency),
        h('label', { class: 'control' }, 'Чувствительность', sens),
        h(
          'p',
          { class: 'meta' },
          'Положите устройство рядом с инструментом. В наушниках с микрофоном и по Bluetooth задержка больше.',
        ),
      );
    }
    inputBox.replaceChildren(...children);
  }
  const unsubStatus = ctx.mic.onStatus(renderInput);

  const installBox = h('div', {});
  function renderInstall(): void {
    installBox.replaceChildren(
      ...(canInstall()
        ? [
            h(
              'button',
              { class: 'btn wide-btn', type: 'button', onclick: () => void promptInstall() },
              'Установить как приложение',
            ),
          ]
        : []),
    );
  }
  const unsubInstall = onInstallChange(renderInstall);

  function renderDifficulty(): void {
    diffRow.replaceChildren(
      ...(Object.keys(DIFFICULTIES) as Difficulty[]).map((d) =>
        h(
          'button',
          {
            type: 'button',
            class: d === difficulty ? 'seg active' : 'seg',
            'aria-pressed': String(d === difficulty),
            onclick: () => {
              difficulty = d;
              ctx.store.setItem(DIFFICULTY_KEY, d);
              renderDifficulty();
              renderList();
            },
          },
          DIFFICULTIES[d].label,
        ),
      ),
    );
  }

  function card(comp: Composition, imported: boolean, progress: Progress): HTMLElement {
    const best = progress.best[comp.id]?.[difficulty];
    const completed = progress.completed.includes(comp.id);
    const stars = starsFor(bestAccuracy(progress, comp.id));
    return h(
      'article',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h3', {}, comp.title),
        stars > 0
          ? h(
              'span',
              { class: 'badge stars', 'aria-label': `Звёзд: ${stars} из 3` },
              '★'.repeat(stars) + '☆'.repeat(3 - stars),
            )
          : completed
            ? h('span', { class: 'badge ok' }, '✓ Пройдено')
            : '',
      ),
      h(
        'p',
        { class: 'meta' },
        [
          comp.level ? `${LEVELS[comp.level]}` : '',
          `${comp.bpm} уд/мин`,
          `нот: ${comp.notes.length}`,
          imported ? 'своя' : '',
        ]
          .filter(Boolean)
          .join(' · '),
      ),
      h(
        'p',
        { class: 'meta' },
        best
          ? `Лучший счёт (${DIFFICULTIES[difficulty].label.toLowerCase()}): ${best.score} · точность ${Math.round(best.accuracy * 100)}%`
          : 'Ещё не сыграно на этой сложности',
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          { class: 'btn primary', type: 'button', onclick: () => ctx.play(comp, difficulty) },
          'Играть',
        ),
        h('button', { class: 'btn', type: 'button', onclick: () => ctx.practice(comp) }, 'Учить'),
        imported
          ? h(
              'button',
              {
                class: 'btn ghost',
                type: 'button',
                'aria-label': `Удалить «${comp.title}»`,
                onclick: () => {
                  if (!window.confirm(`Удалить композицию «${comp.title}»?`)) return;
                  removeImported(ctx.store, comp.id);
                  renderList();
                },
              },
              'Удалить',
            )
          : '',
      ),
    );
  }

  function renderList(): void {
    const builtin = loadBuiltin(ctx.scale);
    const imported = loadImported(ctx.store, ctx.scale);
    const progress = loadProgress(ctx.store);
    const fits = (c: Composition) => levelFilter === 0 || c.level === levelFilter;
    const cards = [
      ...builtin.filter(fits).map((c) => card(c, false, progress)),
      // Свои композиции уровня не имеют — показываем их при любом фильтре.
      ...imported.map((c) => card(c, true, progress)),
    ];
    list.replaceChildren(
      ...(cards.length ? cards : [h('p', { class: 'meta' }, 'Нет композиций этого уровня.')]),
    );
    levelRow.replaceChildren(
      ...([0, 1, 2, 3] as const).map((lv) =>
        h(
          'button',
          {
            type: 'button',
            class: lv === levelFilter ? 'seg active' : 'seg',
            'aria-pressed': String(lv === levelFilter),
            onclick: () => {
              levelFilter = lv;
              renderList();
            },
          },
          lv === 0 ? 'Все' : LEVELS[lv],
        ),
      ),
    );
  }

  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
    onchange: async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) {
        showMessage(['Файл слишком большой (больше 1 МБ).'], 'error');
        return;
      }
      let text: string;
      try {
        text = await file.text();
      } catch {
        showMessage(['Не удалось прочитать файл.'], 'error');
        return;
      }
      const r = parseCompositionJson(text, ctx.scale);
      if (!r.ok) {
        showMessage(['Не удалось импортировать:', ...r.errors], 'error');
        return;
      }
      const builtinIds = new Set(loadBuiltin(ctx.scale).map((c) => c.id));
      const comp = builtinIds.has(r.value.id)
        ? { ...r.value, id: `custom:${r.value.id}` }
        : r.value;
      if (!saveImported(ctx.store, comp)) {
        showMessage(
          ['Не удалось сохранить композицию: хранилище браузера недоступно или заполнено.'],
          'error',
        );
        return;
      }
      showMessage([`Композиция «${comp.title}» добавлена.`], 'ok');
      renderList();
    },
  });

  const el = h(
    'div',
    { class: 'screen home' },
    h(
      'header',
      { class: 'hero' },
      h('h1', {}, 'RAV Vast — тренажёр'),
      h('p', { class: 'meta' }, `Строй: ${ctx.scale.name}`),
    ),
    h(
      'button',
      { class: 'btn wide-btn', type: 'button', onclick: ctx.free },
      'Свободная игра и проверка распознавания',
    ),
    installBox,
    h('h2', {}, 'Чем играть'),
    inputBox,
    h('h2', {}, 'Сложность игры'),
    diffRow,
    h('h2', {}, 'Композиции'),
    levelRow,
    list,
    h(
      'button',
      { class: 'btn wide-btn', type: 'button', onclick: () => fileInput.click() },
      'Импортировать свой JSON',
    ),
    fileInput,
    message,
    h(
      'details',
      { class: 'format' },
      h('summary', {}, 'Формат файла композиции'),
      h(
        'p',
        { class: 'meta' },
        'tongue — номер поля (0 — центр), beat — начало в долях, duration — длительность в долях. Ноты с одинаковым beat звучат вместе.',
      ),
      h('pre', {}, EXAMPLE.replace('SCALE_ID', ctx.scale.id)),
    ),
  );

  renderInput();
  renderInstall();
  renderDifficulty();
  renderList();

  return {
    el,
    destroy() {
      alive = false;
      unsubStatus();
      unsubInstall();
    },
  };
}
