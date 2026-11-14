import { BANDS, type DetectorEvent, HitDetector, defaultTemplates } from '../core/detector';
import type { KeyValueStore } from '../core/progress';
import { isRecord } from '../core/scale';
import type { Scale } from '../core/types';

// Worklet лежит в public/ и отдаётся отдельным файлом: так он загружается во всех браузерах.
const workletUrl = `${import.meta.env.BASE_URL}capture-worklet.js`;

export type MicStatus = 'off' | 'starting' | 'on' | 'denied' | 'unsupported' | 'insecure' | 'error';
export type Sensitivity = 'low' | 'normal' | 'high';

export type MicEvent =
  | {
      type: 'hit';
      id: number;
      /** Момент удара на шкале performance.now(), уже с поправкой на задержку микрофона. */
      timeMs: number;
      tongues: string[];
      clarity: number;
      levelDb: number;
      feature: Float64Array;
      novelty: number;
      scores: { id: string; similarity: number }[];
    }
  | { type: 'sustain'; id: number; ratio: number };

const SETTINGS_KEY = 'ravvast-trainer:mic:v1';
const RATIO: Record<Sensitivity, number> = { low: 2.2, normal: 1.7, high: 1.35 };
/** Во сколько раз (по мощности) удар должен быть громче фона. */
const NOISE_FACTOR: Record<Sensitivity, number> = { low: 20, normal: 8, high: 4 };

/** Моно WAV, 16 бит. */
export function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const view = new DataView(new ArrayBuffer(44 + length * 2));
  const text = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, Math.round(s * 32767), true);
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}
export const MAX_LATENCY_MS = 400;
/** Через сколько времени в фоне микрофон отключается. */
const HIDDEN_STOP_MS = 30_000;

/** Микрофон: захват звука, распознавание ударов, настройки и калибровка. */
export class MicInput {
  status: MicStatus = 'off';
  enabled = false;
  latencyMs = 40;
  sensitivity: Sensitivity = 'normal';
  /** Текущий уровень входного сигнала, дБ относительно максимума (−120 — тишина). */
  levelDb = -120;

  get sampleRate(): number | null {
    return this.ctx?.sampleRate ?? null;
  }

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private detector: HitDetector | null = null;
  private frameOffset: number | null = null;
  private starting: Promise<boolean> | null = null;
  private gen = 0;
  private hiddenTimer = 0;
  private autoStopped = false;
  private recording: {
    chunks: Float32Array[];
    left: number;
    done: (b: Blob) => void;
    fail: (e: Error) => void;
  } | null = null;
  private readonly listeners = new Set<(ev: MicEvent) => void>();
  private readonly statusListeners = new Set<() => void>();

  constructor(
    private readonly store: KeyValueStore,
    private readonly scale: Scale,
  ) {
    try {
      const raw: unknown = JSON.parse(store.getItem(SETTINGS_KEY) ?? 'null');
      if (isRecord(raw)) {
        this.enabled = raw.enabled === true;
        if (typeof raw.latencyMs === 'number') this.latencyMs = this.clampLatency(raw.latencyMs);
        if (raw.sensitivity === 'low' || raw.sensitivity === 'high') this.sensitivity = raw.sensitivity;
      }
    } catch {
      // настройки по умолчанию
    }
    document.addEventListener('visibilitychange', () => {
      // Приватность: если приложение долго в фоне, микрофон отключается сам и
      // включается снова при возвращении.
      window.clearTimeout(this.hiddenTimer);
      if (document.hidden) {
        if (this.status === 'on' || this.status === 'starting') {
          this.hiddenTimer = window.setTimeout(() => {
            this.autoStopped = true;
            this.stop();
          }, HIDDEN_STOP_MS);
        }
        return;
      }
      if (this.autoStopped) {
        this.autoStopped = false;
        if (this.enabled) void this.start();
        return;
      }
      // На iOS после звонка или сворачивания состояние бывает 'interrupted', а не 'suspended'.
      const state: string | undefined = this.ctx?.state;
      if (!document.hidden && state && state !== 'running' && state !== 'closed') {
        void this.ctx?.resume().catch(() => undefined);
      }
    });
  }

  private clampLatency(ms: number): number {
    return Math.round(Math.min(MAX_LATENCY_MS, Math.max(-MAX_LATENCY_MS, Number(ms) || 0)));
  }

  private get calibrationKey(): string {
    // v2: изменился способ построения «отпечатка», старые калибровки несовместимы.
    return `ravvast-trainer:calibration:${this.scale.id}:v2`;
  }

  private saveSettings(): void {
    this.store.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        enabled: this.enabled,
        latencyMs: this.latencyMs,
        sensitivity: this.sensitivity,
      }),
    );
  }

  private setStatus(status: MicStatus): void {
    this.status = status;
    for (const fn of this.statusListeners) fn();
  }

  /** Микрофон включён в настройках и реально слушает. */
  get active(): boolean {
    return this.enabled && this.status === 'on';
  }

  subscribe(fn: (ev: MicEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: () => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.saveSettings();
    if (!enabled) this.stop();
  }

  setLatency(ms: number): void {
    this.latencyMs = this.clampLatency(ms);
    this.saveSettings();
  }

  setSensitivity(s: Sensitivity): void {
    this.sensitivity = s;
    this.saveSettings();
    this.rebuildDetector();
  }

  /** Сохранённая калибровка: шаблоны по всем полям строя или null. */
  private loadCalibration(): {
    sampleRate: number;
    templates: Record<string, number[]>;
    calibrated: string[];
  } | null {
    try {
      const raw: unknown = JSON.parse(this.store.getItem(this.calibrationKey) ?? 'null');
      if (!isRecord(raw) || typeof raw.sampleRate !== 'number' || !isRecord(raw.templates)) {
        return null;
      }
      const templates: Record<string, number[]> = Object.create(null);
      for (const t of this.scale.tongues) {
        const v = raw.templates[t.id];
        if (
          !Array.isArray(v) ||
          v.length !== BANDS ||
          !v.every((x) => typeof x === 'number' && Number.isFinite(x))
        ) {
          return null;
        }
        // Сравнение идёт скалярным произведением, поэтому шаблон обязан быть единичной длины.
        const norm = Math.hypot(...(v as number[]));
        if (norm < 0.5 || norm > 1.5) return null;
        templates[t.id] = (v as number[]).map((x) => x / norm);
      }
      const known = new Set(this.scale.tongues.map((t) => t.id));
      // В старом формате списка не было: тогда калибровались все поля сразу.
      const calibrated = Array.isArray(raw.calibrated)
        ? raw.calibrated.filter((x): x is string => typeof x === 'string' && known.has(x))
        : [...known];
      return { sampleRate: raw.sampleRate, templates, calibrated: [...new Set(calibrated)] };
    } catch {
      return null;
    }
  }

  /**
   * 'ok' — откалиброваны все поля; 'partial' — часть; 'none' — ни одного;
   * 'stale' — калибровка снята на другой частоте дискретизации и не применяется.
   */
  get calibration(): 'ok' | 'partial' | 'stale' | 'none' {
    const c = this.loadCalibration();
    if (!c || c.calibrated.length === 0) return 'none';
    if (this.ctx && c.sampleRate !== this.ctx.sampleRate) return 'stale';
    return c.calibrated.length >= this.scale.tongues.length ? 'ok' : 'partial';
  }

  /** Поля, для которых есть действующая калибровка. */
  calibratedIds(): string[] {
    const c = this.loadCalibration();
    if (!c || (this.ctx && c.sampleRate !== this.ctx.sampleRate)) return [];
    return c.calibrated;
  }

  /** Сохраняет шаблон одного поля; остальные поля остаются как были. Нужен запущенный микрофон. */
  saveTongueCalibration(id: string, template: ArrayLike<number>): boolean {
    if (!this.ctx) return false;
    const sr = this.ctx.sampleRate;
    const prev = this.loadCalibration();
    const keep = prev && prev.sampleRate === sr ? prev : null;
    const fallback = defaultTemplates(this.scale.tongues, sr);
    const round = (v: ArrayLike<number>) => Array.from(v, (x) => Math.round(x * 1e4) / 1e4);
    const templates: Record<string, number[]> = {};
    for (const t of this.scale.tongues) {
      templates[t.id] = round(
        t.id === id ? template : (keep?.templates[t.id] ?? fallback[t.id]),
      );
    }
    const calibrated = [...new Set([...(keep?.calibrated ?? []), id])];
    const json = JSON.stringify({ sampleRate: sr, templates, calibrated });
    this.store.setItem(this.calibrationKey, json);
    this.rebuildDetector();
    return this.store.getItem(this.calibrationKey) === json;
  }

  clearCalibration(): void {
    this.store.setItem(this.calibrationKey, 'null');
    this.rebuildDetector();
  }

  private rebuildDetector(): void {
    if (!this.ctx) return;
    const sr = this.ctx.sampleRate;
    const c = this.loadCalibration();
    this.detector = new HitDetector({
      sampleRate: sr,
      templates: c && c.sampleRate === sr ? c.templates : defaultTemplates(this.scale.tongues, sr),
      ratio: RATIO[this.sensitivity],
      noiseFactor: NOISE_FACTOR[this.sensitivity],
    });
    this.frameOffset = null;
  }

  private frameToMs(frame: number): number {
    const ctx = this.ctx!;
    const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
    const base =
      ts && ts.performanceTime && ts.contextTime
        ? ts.performanceTime - ts.contextTime * 1000
        : performance.now() - ctx.currentTime * 1000;
    return base + (frame / ctx.sampleRate) * 1000 - this.latencyMs;
  }

  private onSamples(samples: Float32Array, frame: number): void {
    if (!this.detector || !this.enabled) return;
    if (this.recording) {
      this.recording.chunks.push(samples.slice());
      this.recording.left -= samples.length;
      if (this.recording.left <= 0) {
        const { chunks, done } = this.recording;
        this.recording = null;
        done(encodeWav(chunks, this.ctx!.sampleRate));
      }
    }
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    this.levelDb = 10 * Math.log10(sum / Math.max(1, samples.length) + 1e-12);
    this.frameOffset ??= frame;
    const offset = this.frameOffset;
    let events: DetectorEvent[];
    try {
      events = this.detector.push(samples);
    } catch (err) {
      console.error('Ошибка распознавания', err);
      return;
    }
    for (const ev of events) {
      const out: MicEvent =
        ev.type === 'hit'
          ? {
              type: 'hit',
              id: ev.id,
              timeMs: this.frameToMs(ev.frame + offset),
              tongues: ev.tongues,
              clarity: ev.clarity,
              levelDb: ev.levelDb,
              feature: ev.feature,
              novelty: ev.novelty,
              scores: ev.scores,
            }
          : ev;
      for (const fn of [...this.listeners]) {
        try {
          fn(out);
        } catch (err) {
          console.error('Ошибка обработчика микрофона', err);
        }
      }
    }
  }

  /** Записывает сырой звук с микрофона и возвращает WAV-файл (для диагностики распознавания). */
  record(seconds: number): Promise<Blob> {
    if (!this.ctx || this.status !== 'on') return Promise.reject(new Error('Микрофон не включён'));
    if (this.recording) return Promise.reject(new Error('Запись уже идёт'));
    return new Promise((done, fail) => {
      this.recording = {
        chunks: [],
        left: Math.round(seconds * this.ctx!.sampleRate),
        done,
        fail,
      };
    });
  }

  /** Запрашивает доступ и начинает слушать. Вызывать из обработчика нажатия. */
  start(): Promise<boolean> {
    if (this.status === 'on') return Promise.resolve(true);
    if (!this.starting) {
      const attempt: Promise<boolean> = this.doStart().finally(() => {
        if (this.starting === attempt) this.starting = null;
      });
      this.starting = attempt;
    }
    return this.starting;
  }

  private async doStart(): Promise<boolean> {
    if (!window.isSecureContext) {
      this.setStatus('insecure');
      return false;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
      this.setStatus('unsupported');
      return false;
    }
    this.setStatus('starting');
    // Если за время ожидания микрофон выключили (stop), этот запуск устарел.
    const gen = ++this.gen;
    let stream: MediaStream;
    try {
      // Обработка голоса (шумоподавление, эхоподавление, АРУ) искажает звук инструмента.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      if (gen === this.gen) {
        this.setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'error');
      }
      return false;
    }
    const abandon = (ctx?: AudioContext) => {
      stream.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => undefined);
      return false;
    };
    if (gen !== this.gen || !this.enabled) return abandon();
    let ctx: AudioContext | undefined;
    try {
      ctx = new AudioContext({ latencyHint: 'interactive' });
      await ctx.audioWorklet.addModule(workletUrl);
      if (gen !== this.gen || !this.enabled) return abandon(ctx);
      this.stream = stream;
      this.ctx = ctx;
      for (const track of stream.getTracks()) {
        track.onended = () => {
          if (gen !== this.gen) return;
          this.stop();
          this.setStatus('error');
        };
      }
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, 'capture', { numberOfOutputs: 1 });
      node.port.onmessage = (e: MessageEvent<{ samples: Float32Array; frame: number }>) => {
        if (gen === this.gen) this.onSamples(e.data.samples, e.data.frame);
      };
      // Узел должен быть подключён к выходу, чтобы обрабатываться; громкость нулевая.
      const silent = ctx.createGain();
      silent.gain.value = 0;
      source.connect(node).connect(silent).connect(ctx.destination);
      this.rebuildDetector();
      if (ctx.state === 'suspended') await ctx.resume();
      if (gen !== this.gen) return false;
      this.setStatus('on');
      return true;
    } catch (err) {
      console.error('Не удалось запустить микрофон', err);
      if (gen !== this.gen) return abandon(ctx);
      abandon(ctx);
      this.stop();
      this.setStatus('error');
      return false;
    }
  }

  stop(): void {
    this.gen++;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.detector = null;
    this.frameOffset = null;
    // Незавершённая запись не должна «висеть»: сообщаем ожидающему об остановке.
    this.recording?.fail(new Error('Микрофон остановлен'));
    this.recording = null;
    // Старый запуск устарел (gen изменился): новый start() должен начать заново, а не
    // получить его результат.
    this.starting = null;
    if (this.status !== 'off') this.setStatus('off');
  }
}
