import { isRecord } from './scale';

export type SessionKind = 'game' | 'fragment' | 'drill';

export interface SessionEntry {
  /** Локальная дата, 'YYYY-MM-DD'. */
  day: string;
  compId: string;
  kind: SessionKind;
  /** Доля попаданий, 0..1. */
  accuracy: number;
  /** Нот в заходе. */
  notes: number;
  /** Длительность захода в секундах. */
  seconds: number;
  /** id языка -> сколько нот сыграно верно. */
  hits: Record<string, number>;
  /** id языка -> сколько нот пропущено. */
  misses: Record<string, number>;
}

export const HISTORY_CAP = 500;

const KINDS: readonly string[] = ['game', 'fragment', 'drill'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** Локальная дата в виде 'YYYY-MM-DD'. */
export function dayKey(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Карта id -> число без прототипа: id приходит из хранилища и может быть "__proto__". */
function cleanCounts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  if (!isRecord(raw)) return out;
  for (const [id, n] of Object.entries(raw)) {
    if (isCount(n)) out[id] = n;
  }
  return out;
}

function parseEntry(raw: unknown): SessionEntry | null {
  if (!isRecord(raw)) return null;
  const { day, compId, kind, accuracy, notes, seconds } = raw;
  if (typeof day !== 'string' || !DAY_RE.test(day)) return null;
  if (typeof compId !== 'string') return null;
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return null;
  if (typeof accuracy !== 'number' || !Number.isFinite(accuracy)) return null;
  if (!isCount(notes) || !isCount(seconds)) return null;
  return {
    day,
    compId,
    kind: kind as SessionKind,
    accuracy: Math.min(1, Math.max(0, accuracy)),
    notes,
    seconds,
    hits: cleanCounts(raw.hits),
    misses: cleanCounts(raw.misses),
  };
}

/** Последние n элементов; n <= 0 даёт пустой массив (slice(-0) вернул бы всё). */
function newest<T>(items: readonly T[], n: number): T[] {
  return n > 0 ? items.slice(-n) : [];
}

/** Разбор недоверенного JSON: битые записи отбрасываются, остаются самые новые HISTORY_CAP. */
export function parseHistory(raw: unknown): SessionEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionEntry[] = [];
  for (const item of raw) {
    const e = parseEntry(item);
    if (e) out.push(e);
  }
  return newest(out, HISTORY_CAP);
}

export function addSession(
  history: readonly SessionEntry[],
  entry: SessionEntry,
  cap: number = HISTORY_CAP,
): SessionEntry[] {
  return newest([...history, entry], cap);
}

/** Предыдущий день для 'YYYY-MM-DD'. Арифметика целиком в UTC, часовой пояс не участвует. */
function prevDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - 1));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1, 2)}-${pad(t.getUTCDate(), 2)}`;
}

/** Сколько дней подряд были занятия; серия, закончившаяся вчера, ещё считается. */
export function streak(history: readonly SessionEntry[], today: string): number {
  const days = new Set(history.map((e) => e.day));
  let cur = today;
  if (!days.has(cur)) cur = prevDay(cur);
  let count = 0;
  while (days.has(cur)) {
    count++;
    cur = prevDay(cur);
  }
  return count;
}

export function secondsOn(history: readonly SessionEntry[], day: string): number {
  let sum = 0;
  for (const e of history) if (e.day === day) sum += e.seconds;
  return sum;
}

export interface TongueStat {
  tongue: string;
  hits: number;
  misses: number;
  missRate: number;
}

/** Статистика по языкам за последние lastSessions записей, самые проблемные первыми. */
export function tongueStats(
  history: readonly SessionEntry[],
  lastSessions = 30,
  minAttempts = 5,
): TongueStat[] {
  const acc: Record<string, { hits: number; misses: number }> = Object.create(null);
  const bump = (id: string, key: 'hits' | 'misses', n: number) => {
    const s = (acc[id] ??= { hits: 0, misses: 0 });
    s[key] += n;
  };
  for (const e of newest(history, lastSessions)) {
    for (const [id, n] of Object.entries(e.hits)) bump(id, 'hits', n);
    for (const [id, n] of Object.entries(e.misses)) bump(id, 'misses', n);
  }
  const out: TongueStat[] = [];
  for (const [tongue, s] of Object.entries(acc)) {
    const total = s.hits + s.misses;
    if (total === 0 || total < minAttempts) continue;
    out.push({ tongue, hits: s.hits, misses: s.misses, missRate: s.misses / total });
  }
  out.sort((a, b) => b.missRate - a.missRate || (a.tongue < b.tongue ? -1 : a.tongue > b.tongue ? 1 : 0));
  return out;
}

/** Точность игр (kind 'game'), от старых к новым, последние `last`. */
export function accuracyTrend(
  history: readonly SessionEntry[],
  compId?: string,
  last = 10,
): number[] {
  const acc = history
    .filter((e) => e.kind === 'game' && (compId === undefined || e.compId === compId))
    .map((e) => e.accuracy);
  return newest(acc, last);
}
