import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from '../src/core/progress';
import { appendHistory, freeImportedId, importBackup, loadHistory, parseBackup } from '../src/data';

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe('резервная копия', () => {
  const backup = (data: unknown) => JSON.stringify({ app: 'ravvast-trainer', version: 1, data });

  it('берёт только свои ключи со строковыми значениями', () => {
    const pairs = parseBackup(
      backup({ 'ravvast-trainer:progress:v1': '{}', 'other-site:token': 'x', 'ravvast-trainer:n': 5 }),
    );
    expect(pairs).toEqual([['ravvast-trainer:progress:v1', '{}']]);
  });

  it('отвергает чужие и испорченные файлы', () => {
    expect(parseBackup('не json')).toBeNull();
    expect(parseBackup('[]')).toBeNull();
    expect(parseBackup(JSON.stringify({ app: 'другое', data: {} }))).toBeNull();
    expect(parseBackup(backup({}))).toBeNull();
    expect(parseBackup(backup({ 'other:key': 'x' }))).toBeNull();
    expect(parseBackup('x'.repeat(4_000_001))).toBeNull();
  });

  it('записывает данные в хранилище и сообщает число записей', () => {
    const store = memoryStore({ 'ravvast-trainer:a': 'старое' });
    expect(importBackup(store, backup({ 'ravvast-trainer:a': '1', 'ravvast-trainer:b': '2' }))).toBe(2);
    expect(store.data.get('ravvast-trainer:a')).toBe('1');
    expect(store.data.get('ravvast-trainer:b')).toBe('2');
    expect(importBackup(store, 'мусор')).toBeNull();
  });
});

describe('свои композиции', () => {
  it('занятому идентификатору добавляется номер', () => {
    const store = memoryStore({
      'ravvast-trainer:imported:v1': JSON.stringify([{ id: 'custom:Запись' }, { id: 'custom:Запись (2)' }]),
    });
    expect(freeImportedId(store, 'custom:Новая')).toBe('custom:Новая');
    expect(freeImportedId(store, 'custom:Запись')).toBe('custom:Запись (3)');
  });
});

describe('журнал занятий', () => {
  it('записи накапливаются и переживают чтение', () => {
    const store = memoryStore();
    const entry = {
      day: '2026-11-18',
      compId: 'a',
      kind: 'game' as const,
      accuracy: 0.8,
      notes: 10,
      seconds: 30,
      hits: { '1': 8 },
      misses: { '2': 2 },
    };
    appendHistory(store, entry);
    appendHistory(store, { ...entry, compId: 'b' });
    expect(loadHistory(store).map((e) => e.compId)).toEqual(['a', 'b']);
  });

  it('испорченный журнал читается как пустой', () => {
    expect(loadHistory(memoryStore({ 'ravvast-trainer:history:v1': '{{{' }))).toEqual([]);
  });
});
