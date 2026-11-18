import { isRecord } from './scale';
import type { Composition, CompositionNote, Result, Scale, TimedNote } from './types';

export const MIN_BPM = 20;
export const MAX_BPM = 300;
export const MAX_NOTES = 5000;
export const MAX_BEAT = 20000;
export const MAX_DURATION = 64;
const MAX_ERRORS = 10;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Проверяет и нормализует композицию относительно заданного строя. */
export function parseComposition(raw: unknown, scale: Scale): Result<Composition> {
  if (!isRecord(raw)) return { ok: false, errors: ['Композиция должна быть объектом JSON.'] };
  const errors: string[] = [];

  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 120) : '';
  if (!title) errors.push('Укажите название в поле "title".');

  if (raw.scale !== scale.id) {
    errors.push(`Композиция написана для строя "${String(raw.scale)}", а нужен "${scale.id}".`);
  }

  const bpm = raw.bpm;
  if (!isNum(bpm) || bpm < MIN_BPM || bpm > MAX_BPM) {
    errors.push(`Темп "bpm" должен быть числом от ${MIN_BPM} до ${MAX_BPM}.`);
  }

  const level = raw.level;
  if (level !== undefined && level !== 1 && level !== 2 && level !== 3) {
    errors.push('Уровень "level" должен быть 1, 2 или 3.');
  }

  const notes: CompositionNote[] = [];
  if (!Array.isArray(raw.notes) || raw.notes.length === 0) {
    errors.push('Список "notes" должен быть непустым массивом.');
  } else if (raw.notes.length > MAX_NOTES) {
    errors.push(`Слишком много нот: максимум ${MAX_NOTES}.`);
  } else {
    const byId = new Map(scale.tongues.map((t) => [t.id, t]));
    raw.notes.forEach((n: unknown, i: number) => {
      if (errors.length >= MAX_ERRORS) return;
      const where = `Нота ${i + 1}`;
      if (!isRecord(n)) {
        errors.push(`${where}: ожидался объект.`);
        return;
      }
      const tongueId =
        typeof n.tongue === 'string' || typeof n.tongue === 'number' ? String(n.tongue) : '';
      const tongue = byId.get(tongueId);
      if (!tongue) {
        errors.push(`${where}: поля "${tongueId}" нет в строе ${scale.name}.`);
        return;
      }
      if (n.note !== undefined && n.note !== tongue.note) {
        errors.push(
          `${where}: указана нота "${String(n.note)}", но поле ${tongue.id} звучит как ${tongue.note}.`,
        );
        return;
      }
      if (!isNum(n.beat) || n.beat < 0 || n.beat > MAX_BEAT) {
        errors.push(`${where}: "beat" должен быть числом от 0 до ${MAX_BEAT}.`);
        return;
      }
      if (!isNum(n.duration) || n.duration <= 0 || n.duration > MAX_DURATION) {
        errors.push(`${where}: "duration" должна быть числом больше 0 и не больше ${MAX_DURATION}.`);
        return;
      }
      notes.push({
        tongue: tongueId,
        beat: n.beat,
        duration: n.duration,
        ...(n.dyn === 'soft' || n.dyn === 'loud' ? { dyn: n.dyn } : {}),
      });
    });
  }

  if (errors.length) return { ok: false, errors };

  notes.sort((a, b) => a.beat - b.beat);
  const id =
    typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 140) : `custom:${title}`;
  return {
    ok: true,
    value: {
      id,
      title,
      scale: scale.id,
      bpm: bpm as number,
      ...(level ? { level: level as 1 | 2 | 3 } : {}),
      notes,
    },
  };
}

export function parseCompositionJson(text: string, scale: Scale): Result<Composition> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['Файл не является корректным JSON.'] };
  }
  return parseComposition(raw, scale);
}

/** Переводит доли в секунды. tempoFactor 0.5 — вдвое медленнее. */
export function toTimedNotes(comp: Composition, tempoFactor = 1): TimedNote[] {
  const beatSec = 60 / (comp.bpm * tempoFactor);
  return comp.notes.map((n) => ({
    tongue: n.tongue,
    time: n.beat * beatSec,
    duration: n.duration * beatSec,
    ...(n.dyn ? { dyn: n.dyn } : {}),
  }));
}
