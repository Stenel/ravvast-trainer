import { parseCompositionJson } from '../core/composition';
import { RAMP_START } from '../core/fragment';
import { DIFFICULTIES, type Difficulty } from '../core/judge';
import { dynamicsDrills, rhythmDrills } from '../core/rhythm';
import { type Progress, bestAccuracy, loadProgress, starsFor } from '../core/progress';
import type { Composition } from '../core/types';
import { focusDrill, generateDrills } from '../core/drills';
import { dayKey, secondsOn, streak, tongueStats } from '../core/history';
import {
  exportBackup,
  importBackup,
  loadBuiltin,
  loadHistory,
  loadImported,
  removeImported,
  saveImported,
} from '../data';
import { type AppCtx, type Screen, h, noteOf, storeDifficulty, storedDifficulty } from './dom';
import { DEBUG_CAPTURE_SECONDS, debugSaveButton } from './debuglog';
import { canInstall, onInstallChange, promptInstall } from './install';
import { debugEnabled, setDebugEnabled, setTickEnabled, tickEnabled } from './settings';

const MAX_FILE_BYTES = 1_000_000;
const MAX_BACKUP_BYTES = 4_000_000;
/** Дневная цель занятий, минут. */
const GOAL_MINUTES = 10;
/** С какой доли пропусков поле считается слабым. */
const WEAK_MISS_RATE = 0.2;
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

export function homeScreen(ctx: AppCtx): Screen {
  let difficulty = storedDifficulty(ctx);
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
    none: 'Калибровка не выполнена — она необязательна: встроенные шаблоны сняты с настоящего инструмента.',
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
          h(
            'button',
            { class: 'btn', type: 'button', onclick: ctx.accuracy },
            'Проверка точности',
          ),
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
              storeDifficulty(ctx, d);
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

  // --- статистика занятий: серия дней, цель на сегодня, слабые поля ---
  const statsBox = h('section', { class: 'stats', 'aria-label': 'Статистика занятий' });
  function renderStats(): void {
    const history = loadHistory(ctx.store);
    if (history.length === 0) {
      statsBox.replaceChildren(
        h('p', { class: 'meta' }, 'Сыграйте композицию — здесь появятся серия дней и слабые поля.'),
      );
      return;
    }
    const today = dayKey(new Date());
    const minutes = Math.round(secondsOn(history, today) / 60);
    const fill = h('div', { class: 'goal-fill' });
    fill.style.width = `${Math.min(100, (minutes / GOAL_MINUTES) * 100).toFixed(0)}%`;
    const known = tongueStats(history);
    const weak = known.filter((s) => s.missRate >= WEAK_MISS_RATE).slice(0, 3);
    const drill = weak.length
      ? focusDrill(
          ctx.scale,
          weak.map((s) => s.tongue),
        )
      : null;
    statsBox.replaceChildren(
      h(
        'div',
        { class: 'stats-row' },
        h('span', {}, 'Серия: ', h('strong', {}, `${streak(history, today)} дн.`)),
        h('span', {}, 'Сегодня: ', h('strong', {}, `${minutes} из ${GOAL_MINUTES} мин`)),
      ),
      h('div', { class: 'goal', role: 'presentation' }, fill),
      h(
        'p',
        { class: 'meta' },
        weak.length
          ? `Слабые поля: ${weak
              .map((s) => `${noteOf(ctx.scale, s.tongue)} (${Math.round(s.missRate * 100)}% пропусков)`)
              .join(', ')}`
          : known.length
            ? 'Слабых полей нет: все поля попадают уверенно.'
            : 'Пока мало ударов, чтобы назвать слабые поля.',
      ),
      drill
        ? h(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => ctx.play(drill, difficulty, { kind: 'drill' }),
            },
            'Упражнение на слабые поля',
          )
        : '',
    );
  }

  // --- упражнения на технику: генерируются под строй, в рекорды не идут ---
  const drillList = h('div', { class: 'list' });
  function renderDrills(): void {
    const group = (title: string, note: string, drills: Composition[]): (Node | string)[] => [
      h('h3', { class: 'sub' }, title),
      h('p', { class: 'meta' }, note),
      ...drills.map(drillCard),
    ];
    drillList.replaceChildren(
      ...group(
        'Ритм',
        'Только центральное поле: всё внимание на время. В итогах — ровность ритма в миллисекундах.',
        rhythmDrills(ctx.scale),
      ),
      ...group(
        'Громкость',
        'Тихие и громкие удары по одному полю. Оценивается только с микрофоном и в счёт не идёт.',
        dynamicsDrills(ctx.scale),
      ),
      ...group('Техника', 'Переходы между полями и работа двух рук.', generateDrills(ctx.scale)),
    );
  }

  function drillCard(d: Composition): HTMLElement {
    return h(
          'article',
          { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, d.title)),
          h(
            'p',
            { class: 'meta' },
            [d.level ? LEVELS[d.level] : '', `${d.bpm} уд/мин`, `нот: ${d.notes.length}`]
              .filter(Boolean)
              .join(' · '),
          ),
          h(
            'div',
            { class: 'row' },
            h(
              'button',
              {
                class: 'btn primary',
                type: 'button',
                onclick: () => ctx.play(d, difficulty, { kind: 'drill' }),
              },
              'Играть',
            ),
            h(
              'button',
              {
                class: 'btn',
                type: 'button',
                onclick: () =>
                  ctx.play(d, difficulty, { kind: 'drill', loop: true, tempo: RAMP_START }),
              },
              'С разгоном темпа',
            ),
          ),
        );
  }

  const tickInput = h('input', {
    type: 'checkbox',
    checked: tickEnabled(ctx),
    onchange: () => setTickEnabled(ctx, tickInput.checked),
  });
  const debugInput = h('input', {
    type: 'checkbox',
    checked: debugEnabled(ctx),
    onchange: () => setDebugEnabled(ctx, debugInput.checked),
  });

  // --- резервная копия: телефон может очистить данные сайта ---
  const backupMsg = h('p', { class: 'meta', role: 'status' });
  const backupInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    hidden: true,
    onchange: async () => {
      const file = backupInput.files?.[0];
      backupInput.value = '';
      if (!file) return;
      if (file.size > MAX_BACKUP_BYTES) {
        backupMsg.textContent = 'Файл слишком большой для резервной копии.';
        return;
      }
      let text: string;
      try {
        text = await file.text();
      } catch {
        backupMsg.textContent = 'Не удалось прочитать файл.';
        return;
      }
      if (
        !window.confirm(
          'Восстановить данные из файла? Текущий прогресс, свои композиции и калибровка будут заменены.',
        )
      ) {
        return;
      }
      const count = importBackup(ctx.store, text);
      if (count === null) {
        backupMsg.textContent = 'Это не резервная копия тренажёра.';
        return;
      }
      // Настройки микрофона и калибровка читаются при запуске — перезагружаем страницу.
      window.location.reload();
    },
  });
  function saveBackup(): void {
    const url = URL.createObjectURL(new Blob([exportBackup()], { type: 'application/json' }));
    const link = h('a', { href: url, download: `rav-backup-${dayKey(new Date())}.json` });
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    backupMsg.textContent = 'Копия сохранена в загрузки.';
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
    statsBox,
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
    h('h2', {}, 'Упражнения'),
    h('label', { class: 'control check' }, tickInput, 'Тик метронома в упражнениях'),
    drillList,
    h(
      'details',
      { class: 'format', open: debugEnabled(ctx) },
      h('summary', {}, 'Отладка'),
      h('label', { class: 'control check' }, debugInput, 'Записывать звук и отчёт в игре и разучивании'),
      h(
        'p',
        { class: 'meta' },
        `Пока галочка стоит, каждый проход пишется с микрофона (до ${DEBUG_CAPTURE_SECONDS / 60} минут) вместе с тем, что услышало распознавание. Кнопка сохранения появляется в итогах прохода, на экране разучивания и здесь. Запись хранится только до закрытия страницы и никуда не отправляется.`,
      ),
      debugSaveButton(),
    ),
    h(
      'details',
      { class: 'format' },
      h('summary', {}, 'Резервная копия'),
      h(
        'p',
        { class: 'meta' },
        'Прогресс, свои композиции и калибровка хранятся в браузере и могут пропасть при очистке данных. Сохраните копию в файл.',
      ),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: saveBackup }, 'Сохранить копию'),
        h(
          'button',
          { class: 'btn', type: 'button', onclick: () => backupInput.click() },
          'Восстановить из файла',
        ),
      ),
      backupInput,
      backupMsg,
    ),
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
  renderStats();
  renderDrills();

  return {
    el,
    destroy() {
      alive = false;
      unsubStatus();
      unsubInstall();
    },
  };
}
