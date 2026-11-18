import { type AppCtx, h, noteOf } from './dom';
import { debugEnabled } from './settings';

/** Дольше запись не идёт: пять минут звука — это уже около 30 МБ. */
export const DEBUG_CAPTURE_SECONDS = 300;

type Json = Record<string, unknown>;

interface SavedLog {
  name: string;
  report: Json;
  audio: Blob | null;
}

/** Отчёт последнего прохода: его можно сохранить и после выхода с экрана. */
let last: SavedLog | null = null;

export interface DebugLog {
  /** Отметка на шкале performance.now(): тик, касание, оценка удара. */
  mark(type: string, timeMs: number, data?: Json): void;
  /**
   * Останавливает запись и собирает отчёт. summary получает перевод времени performance.now()
   * в секунды от начала записи. Повторный вызов ничего не делает.
   */
  finish(summary?: (sec: (ms: number) => number) => Json): void;
}

const round = (x: number, k: number) => Math.round(x * k) / k;

/**
 * Начинает отладочную запись прохода: сырой звук с микрофона и всё, что услышал
 * распознаватель. Возвращает null, если отладка выключена.
 */
export function startDebugLog(ctx: AppCtx, mode: string, meta: Json): DebugLog | null {
  if (!debugEnabled(ctx)) return null;
  const startedMs = performance.now();
  const events: Json[] = [];
  const rawTimes: number[] = [];
  const marks: { type: string; timeMs: number; data: Json }[] = [];
  let finished = false;

  const begin = () => {
    if (!finished && ctx.mic.status === 'on') ctx.mic.beginCapture(DEBUG_CAPTURE_SECONDS);
  };
  // Не сразу: прежний экран при закрытии завершает свою запись, и задел бы нашу.
  const beginTimer = window.setTimeout(begin, 0);
  const offStatus = ctx.mic.onStatus(begin);
  const offMic = ctx.mic.subscribe((ev) => {
    if (ev.type === 'sustain') {
      const hit = events.find((e) => e.id === ev.id);
      if (hit) hit.sustain = round(ev.ratio, 100);
      return;
    }
    rawTimes.push(ev.timeMs);
    events.push({
      id: ev.id,
      heard: ev.tongues.map((id) => noteOf(ctx.scale, id)),
      levelDb: round(ev.levelDb, 10),
      novelty: round(ev.novelty, 100),
      clarity: round(ev.clarity, 1000),
      scores: ev.scores.map((s) => ({
        note: noteOf(ctx.scale, s.id),
        similarity: round(s.similarity, 1000),
      })),
    });
  });

  return {
    mark(type, timeMs, data = {}) {
      if (!finished) marks.push({ type, timeMs, data });
    },
    finish(summary) {
      if (finished) return;
      finished = true;
      window.clearTimeout(beginTimer);
      offStatus();
      offMic();
      const sampleRate = ctx.mic.sampleRate;
      const capture = ctx.mic.endCapture();
      const base = capture?.startMs ?? startedMs;
      const sec = (ms: number) => round((ms - base) / 1000, 1000);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      last = {
        name: `rav-${mode}-${stamp}`,
        audio: capture?.blob ?? null,
        report: {
          app: 'ravvast-trainer',
          mode,
          scale: ctx.scale.id,
          userAgent: navigator.userAgent,
          mic: {
            active: ctx.mic.active,
            sampleRate,
            sensitivity: ctx.mic.sensitivity,
            latencyMs: ctx.mic.latencyMs,
            calibration: ctx.mic.calibration,
            calibrated: ctx.mic.calibratedIds().map((id) => noteOf(ctx.scale, id)),
          },
          audio: capture ? 'есть' : 'нет',
          seconds: round((performance.now() - startedMs) / 1000, 10),
          meta,
          ...(summary ? summary(sec) : {}),
          events: events.map((e, i) => ({ timeSec: sec(rawTimes[i]), ...e })),
          marks: marks.map((m) => ({ timeSec: sec(m.timeMs), type: m.type, ...m.data })),
        },
      };
    },
  };
}

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function hasDebugLog(): boolean {
  return last !== null;
}

/** Скачивает отчёт последнего прохода (.json) и запись (.wav), если она есть. */
export function saveDebugLog(): boolean {
  const log = last;
  if (!log) return false;
  download(
    new Blob([JSON.stringify(log.report, null, 2)], { type: 'application/json' }),
    `${log.name}.json`,
  );
  // Второй файл — с небольшой задержкой: браузеры блокируют одновременные скачивания.
  const audio = log.audio;
  if (audio) window.setTimeout(() => download(audio, `${log.name}.wav`), 700);
  return true;
}

/** Кнопка сохранения отчёта последнего прохода; пусто, если сохранять нечего. */
export function debugSaveButton(before?: () => void): HTMLElement | '' {
  if (!last) return '';
  const withAudio = last.audio !== null;
  const btn = h(
    'button',
    {
      class: 'btn wide-btn',
      type: 'button',
      onclick: () => {
        before?.();
        if (saveDebugLog()) btn.textContent = 'Отчёт сохранён в загрузки';
      },
    },
    withAudio ? 'Сохранить отчёт и запись (отладка)' : 'Сохранить отчёт (отладка, без звука)',
  );
  return btn;
}
