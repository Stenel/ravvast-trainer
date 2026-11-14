import { parseScale } from '../src/core/scale';
import type { Scale } from '../src/core/types';

export const rawScale = {
  id: 'test-scale',
  name: 'Test',
  tongues: [
    { id: '0', note: 'E2', position: 'center' },
    { id: '1', note: 'A2', angle: 200 },
    { id: '2', note: 'B2', angle: 160 },
  ],
};

export function testScale(): Scale {
  const r = parseScale(rawScale);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.value;
}
