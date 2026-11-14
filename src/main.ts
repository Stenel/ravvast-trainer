import './styles.css';
import { MicInput } from './audio/mic';
import { Synth } from './audio/synth';
import { accuracyScreen } from './ui/accuracy';
import { calibrateScreen } from './ui/calibrate';
import { loadScales, safeStore } from './data';
import type { AppCtx, Screen } from './ui/dom';
import { freeScreen } from './ui/free';
import { gameScreen } from './ui/game';
import { homeScreen } from './ui/home';
import { practiceScreen } from './ui/practice';
import { keepScreenOn } from './ui/wakelock';

// Service worker даёт установку на домашний экран и работу без сети. Только в сборке:
// в режиме разработки он мешал бы обновлению модулей.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch((err) => console.warn('Service worker не зарегистрирован', err));
  });
}

const root = document.getElementById('app');
if (!root) throw new Error('Не найден контейнер #app');

let current: Screen | null = null;

function show(screen: Screen, awake = true): void {
  current?.destroy();
  current = screen;
  // На всех экранах, кроме списка композиций, руки заняты инструментом — экран не должен гаснуть.
  keepScreenOn(awake);
  root!.replaceChildren(screen.el);
  window.scrollTo(0, 0);
}

try {
  const scales = loadScales();
  if (scales.length === 0) throw new Error('В папке scales нет ни одного строя.');
  const mic = new MicInput(safeStore, scales[0]);
  // Экраны открываются по нажатию, поэтому здесь можно запросить микрофон.
  // Ждём готовности микрофона, чтобы отсчёт игры не шёл во время запроса доступа.
  let opening = false;
  const withMic = (open: () => void) => () => {
    if (!mic.enabled || mic.status === 'on') {
      open();
      return;
    }
    if (opening) return;
    opening = true;
    void mic.start().finally(() => {
      opening = false;
      open();
    });
  };
  const ctx: AppCtx = {
    scale: scales[0],
    synth: new Synth(),
    store: safeStore,
    mic,
    home: () => {
      // На главном экране микрофон не нужен — не слушаем без необходимости.
      if (mic.status === 'on' || mic.status === 'starting') mic.stop();
      show(homeScreen(ctx), false);
    },
    free: withMic(() => show(freeScreen(ctx))),
    calibrate: () => {
      mic.setEnabled(true);
      void mic.start();
      show(calibrateScreen(ctx));
    },
    accuracy: () => {
      mic.setEnabled(true);
      void mic.start();
      show(accuracyScreen(ctx));
    },
    play: (comp, difficulty) => withMic(() => show(gameScreen(ctx, comp, difficulty)))(),
    practice: (comp) => withMic(() => show(practiceScreen(ctx, comp)))(),
  };
  for (const type of ['pointerup', 'touchend', 'click', 'keydown']) {
    document.addEventListener(type, () => ctx.synth.unlock(), { passive: true });
  }
  ctx.home();
} catch (err) {
  const p = document.createElement('p');
  p.className = 'message error';
  p.textContent = `Не удалось запустить приложение: ${err instanceof Error ? err.message : String(err)}`;
  root.replaceChildren(p);
}
