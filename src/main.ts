import './styles.css';
import { Synth } from './audio/synth';
import { loadScales, safeStore } from './data';
import type { AppCtx, Screen } from './ui/dom';
import { freeScreen } from './ui/free';
import { gameScreen } from './ui/game';
import { homeScreen } from './ui/home';
import { practiceScreen } from './ui/practice';

const root = document.getElementById('app');
if (!root) throw new Error('Не найден контейнер #app');

let current: Screen | null = null;

function show(screen: Screen): void {
  current?.destroy();
  current = screen;
  root!.replaceChildren(screen.el);
  window.scrollTo(0, 0);
}

try {
  const scales = loadScales();
  if (scales.length === 0) throw new Error('В папке scales нет ни одного строя.');
  const ctx: AppCtx = {
    scale: scales[0],
    synth: new Synth(),
    store: safeStore,
    home: () => show(homeScreen(ctx)),
    free: () => show(freeScreen(ctx)),
    play: (comp, difficulty) => show(gameScreen(ctx, comp, difficulty)),
    practice: (comp) => show(practiceScreen(ctx, comp)),
  };
  ctx.home();
} catch (err) {
  const p = document.createElement('p');
  p.className = 'message error';
  p.textContent = `Не удалось запустить приложение: ${err instanceof Error ? err.message : String(err)}`;
  root.replaceChildren(p);
}
