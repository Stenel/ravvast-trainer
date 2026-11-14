/**
 * Установка на домашний экран. Chrome сообщает событием beforeinstallprompt, что приложение
 * можно установить; сам диалог разрешено показать только по нажатию пользователя.
 */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let pending: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  pending = ev as InstallPromptEvent;
  notify();
});

window.addEventListener('appinstalled', () => {
  pending = null;
  notify();
});

export function canInstall(): boolean {
  return pending !== null;
}

export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function promptInstall(): Promise<void> {
  const ev = pending;
  if (!ev) return;
  pending = null;
  notify();
  try {
    await ev.prompt();
    await ev.userChoice;
  } catch {
    // диалог не показан — кнопка просто исчезнет до следующего предложения браузера
  }
}
