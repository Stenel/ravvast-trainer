import type { AppCtx } from './dom';

const TICK_KEY = 'ravvast-trainer:tick';
const DEBUG_KEY = 'ravvast-trainer:debug';

/** Тик метронома в упражнениях; по умолчанию включён. */
export function tickEnabled(ctx: AppCtx): boolean {
  return ctx.store.getItem(TICK_KEY) !== 'off';
}

export function setTickEnabled(ctx: AppCtx, on: boolean): void {
  ctx.store.setItem(TICK_KEY, on ? 'on' : 'off');
}

/** Отладка: в игре и разучивании пишется звук и отчёт о том, что услышано. */
export function debugEnabled(ctx: AppCtx): boolean {
  return ctx.store.getItem(DEBUG_KEY) === 'on';
}

export function setDebugEnabled(ctx: AppCtx, on: boolean): void {
  ctx.store.setItem(DEBUG_KEY, on ? 'on' : 'off');
}
