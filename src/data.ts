import { parseComposition } from './core/composition';
import { type SessionEntry, addSession, parseHistory } from './core/history';
import type { KeyValueStore } from './core/progress';
import { isRecord, parseScale } from './core/scale';
import type { Composition, Scale } from './core/types';

const scaleFiles = import.meta.glob('../scales/*.json', { eager: true, import: 'default' });
const compositionFiles = import.meta.glob('../compositions/*.json', {
  eager: true,
  import: 'default',
});

const IMPORTED_KEY = 'ravvast-trainer:imported:v1';
const MAX_STORED_CHARS = 2_000_000;
export const MAX_IMPORTED = 100;

/** localStorage, который не бросает исключений (приватный режим, переполнение). */
export const safeStore: KeyValueStore = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // игнорируем: данные останутся только в памяти текущей сессии
    }
  },
};

export function loadScales(): Scale[] {
  return Object.entries(scaleFiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, raw]) => {
      const r = parseScale(raw);
      if (!r.ok) throw new Error(`Ошибка в ${path}: ${r.errors.join(' ')}`);
      return r.value;
    });
}

export function loadBuiltin(scale: Scale): Composition[] {
  const out: Composition[] = [];
  for (const [path, raw] of Object.entries(compositionFiles).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const r = parseComposition(raw, scale);
    if (r.ok) out.push(r.value);
    else if ((raw as { scale?: unknown })?.scale === scale.id) {
      console.error(`Ошибка в ${path}:`, r.errors);
    }
  }
  return out;
}

function readImportedRaw(store: KeyValueStore): unknown[] {
  try {
    const text = store.getItem(IMPORTED_KEY) ?? '[]';
    // Хранилище общее для всего адреса сайта: не разбираем подозрительно большие данные.
    if (text.length > MAX_STORED_CHARS) return [];
    const raw: unknown = JSON.parse(text);
    return Array.isArray(raw) ? raw.slice(0, MAX_IMPORTED) : [];
  } catch {
    return [];
  }
}

export function loadImported(store: KeyValueStore, scale: Scale): Composition[] {
  const out: Composition[] = [];
  for (const raw of readImportedRaw(store)) {
    const r = parseComposition(raw, scale);
    if (r.ok) out.push(r.value);
  }
  return out;
}

/** Возвращает false, если сохранить не удалось (хранилище недоступно, переполнено или достигнут лимит). */
export function saveImported(store: KeyValueStore, comp: Composition): boolean {
  const rest = readImportedRaw(store).filter((c) => (c as { id?: unknown })?.id !== comp.id);
  if (rest.length >= MAX_IMPORTED) return false;
  const json = JSON.stringify([...rest, comp]);
  store.setItem(IMPORTED_KEY, json);
  return store.getItem(IMPORTED_KEY) === json;
}

/**
 * Свободный идентификатор для новой своей композиции: если такой уже занят, добавляет
 * номер. Иначе две записи с одинаковым названием затёрли бы друг друга.
 */
export function freeImportedId(store: KeyValueStore, id: string): string {
  const taken = new Set(readImportedRaw(store).map((c) => (c as { id?: unknown })?.id));
  if (!taken.has(id)) return id;
  for (let n = 2; ; n++) {
    const candidate = `${id} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

const HISTORY_KEY = 'ravvast-trainer:history:v1';

/** Журнал занятий: по нему считаются серия дней, время и слабые поля. */
export function loadHistory(store: KeyValueStore): SessionEntry[] {
  try {
    return parseHistory(JSON.parse(store.getItem(HISTORY_KEY) ?? '[]'));
  } catch {
    return [];
  }
}

export function appendHistory(store: KeyValueStore, entry: SessionEntry): void {
  try {
    store.setItem(HISTORY_KEY, JSON.stringify(addSession(loadHistory(store), entry)));
  } catch {
    // Хранилище недоступно или переполнено: занятие просто не попадёт в журнал.
  }
}

const STORAGE_PREFIX = 'ravvast-trainer:';
const MAX_BACKUP_CHARS = 4_000_000;

/** Все данные приложения (прогресс, журнал, свои композиции, калибровка, настройки) одной строкой. */
export function exportBackup(): string {
  const data: Record<string, string> = {};
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      const value = window.localStorage.getItem(key);
      if (value !== null) data[key] = value;
    }
  } catch {
    // хранилище недоступно — копия будет пустой
  }
  return JSON.stringify({ app: 'ravvast-trainer', version: 1, data });
}

/** Разбирает резервную копию. Возвращает пары ключ-значение или null, если файл не подходит. */
export function parseBackup(text: string): [string, string][] | null {
  if (text.length > MAX_BACKUP_CHARS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || raw.app !== 'ravvast-trainer' || !isRecord(raw.data)) return null;
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(raw.data)) {
    // Чужие ключи не трогаем: хранилище общее для всего адреса сайта.
    if (key.startsWith(STORAGE_PREFIX) && typeof value === 'string') pairs.push([key, value]);
  }
  return pairs.length ? pairs : null;
}

/** Записывает резервную копию поверх текущих данных. Возвращает число записей или null. */
export function importBackup(store: KeyValueStore, text: string): number | null {
  const pairs = parseBackup(text);
  if (!pairs) return null;
  try {
    for (const [key, value] of pairs) store.setItem(key, value);
  } catch {
    return null;
  }
  return pairs.length;
}

export function removeImported(store: KeyValueStore, id: string): void {
  const rest = readImportedRaw(store).filter((c) => (c as { id?: unknown })?.id !== id);
  store.setItem(IMPORTED_KEY, JSON.stringify(rest));
}
