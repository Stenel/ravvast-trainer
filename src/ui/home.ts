import { parseCompositionJson } from '../core/composition';
import { DIFFICULTIES, type Difficulty } from '../core/judge';
import { loadProgress } from '../core/progress';
import type { Composition } from '../core/types';
import { loadBuiltin, loadImported, removeImported, saveImported } from '../data';
import { type AppCtx, type Screen, h } from './dom';

const DIFFICULTY_KEY = 'ravvast-trainer:difficulty';
const MAX_FILE_BYTES = 1_000_000;

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
  const message = h('div', { class: 'message', role: 'alert' });
  const diffRow = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Сложность' });

  function showMessage(lines: string[], kind: 'error' | 'ok'): void {
    message.className = `message ${kind}`;
    message.replaceChildren(...lines.map((l) => h('div', {}, l)));
  }

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

  function card(comp: Composition, imported: boolean): HTMLElement {
    const progress = loadProgress(ctx.store);
    const best = progress.best[comp.id]?.[difficulty];
    const completed = progress.completed.includes(comp.id);
    return h(
      'article',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h3', {}, comp.title),
        completed ? h('span', { class: 'badge ok' }, '✓ Пройдено') : '',
      ),
      h(
        'p',
        { class: 'meta' },
        `${comp.bpm} уд/мин · нот: ${comp.notes.length}${imported ? ' · своя' : ''}`,
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
    list.replaceChildren(
      ...builtin.map((c) => card(c, false)),
      ...imported.map((c) => card(c, true)),
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
      saveImported(ctx.store, comp);
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
      'Свободная игра на инструменте',
    ),
    h('h2', {}, 'Сложность игры'),
    diffRow,
    h('h2', {}, 'Композиции'),
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

  renderDifficulty();
  renderList();

  return { el, destroy() {} };
}
