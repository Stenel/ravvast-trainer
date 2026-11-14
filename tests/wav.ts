import { readFileSync } from 'node:fs';

/** Читает моно/стерео WAV 16 бит; из стерео берётся первый канал. */
export function readWav(path: string): { sr: number; samples: Float32Array } {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 12;
  let sr = 48000;
  let channels = 1;
  let bits = 16;
  while (pos + 8 <= view.byteLength) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = view.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      channels = view.getUint16(pos + 10, true);
      sr = view.getUint32(pos + 12, true);
      bits = view.getUint16(pos + 22, true);
    } else if (id === 'data') {
      const step = (bits / 8) * channels;
      const n = Math.floor(Math.min(size, view.byteLength - pos - 8) / step);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = view.getInt16(pos + 8 + i * step, true) / 32768;
      return { sr, samples };
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error('В файле нет блока data');
}
