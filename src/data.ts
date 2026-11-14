import { parseComposition } from './core/composition';
import type { KeyValueStore } from './core/progress';
import { parseScale } from './core/scale';
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

export function removeImported(store: KeyValueStore, id: string): void {
  const rest = readImportedRaw(store).filter((c) => (c as { id?: unknown })?.id !== id);
  store.setItem(IMPORTED_KEY, JSON.stringify(rest));
}
