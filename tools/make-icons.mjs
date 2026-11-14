// Генерирует значки приложения (PNG) без внешних зависимостей: node tools/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const SS = 3; // сглаживание: 3x3 выборки на пиксель
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = row + 1 + x * 4;
      raw[o] = Math.round(r / (SS * SS));
      raw[o + 1] = Math.round(g / (SS * SS));
      raw[o + 2] = Math.round(b / (SS * SS));
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [18, 20, 31];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Рисунок: тёмный фон, диск инструмента, центр и восемь полей по кругу. scale < 1 — отступ для maskable. */
function draw(scale) {
  return (u, v) => {
    const x = (u - 0.5) / scale;
    const y = (v - 0.5) / scale;
    const d = Math.hypot(x, y);
    if (d > 0.46) return BG;
    let color = mix([59, 74, 140], [23, 28, 58], Math.min(1, Math.hypot(x + 0.1, y + 0.12) / 0.6));
    const tongue = (cx, cy, r) => {
      const t = Math.hypot(x - cx, y - cy);
      if (t < r) color = t > r - 0.012 ? [205, 212, 245] : mix(color, [124, 156, 255], 0.35);
    };
    tongue(0, 0, 0.12);
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      tongue(0.3 * Math.sin(a), -0.3 * Math.cos(a), 0.085);
    }
    return color;
  };
}

writeFileSync('public/icon-192.png', png(192, draw(1)));
writeFileSync('public/icon-512.png', png(512, draw(1)));
writeFileSync('public/icon-maskable-512.png', png(512, draw(0.72)));
console.log('icons written');
