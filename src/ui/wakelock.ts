/**
 * Не даёт экрану гаснуть, пока пользователь играет: руки заняты инструментом,
 * экран никто не трогает. Блокировка снимается браузером при сворачивании вкладки,
 * поэтому при возврате запрашиваем её снова.
 */
interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

let wanted = false;
let sentinel: WakeLockSentinelLike | null = null;
/** Идёт запрос блокировки: второй параллельный запрос оставил бы неснимаемую блокировку. */
let acquiring = false;

async function acquire(): Promise<void> {
  const api = (navigator as Navigator & {
    wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
  }).wakeLock;
  if (!api || sentinel || acquiring || !wanted || document.hidden) return;
  acquiring = true;
  try {
    const s = await api.request('screen');
    s.addEventListener('release', () => {
      if (sentinel === s) sentinel = null;
    });
    if (wanted) sentinel = s;
    else void s.release().catch(() => undefined);
  } catch {
    // Браузер отказал (режим экономии энергии и т. п.) — работаем без блокировки.
  } finally {
    acquiring = false;
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void acquire();
});

export function keepScreenOn(on: boolean): void {
  wanted = on;
  if (on) void acquire();
  else if (sentinel) {
    const s = sentinel;
    sentinel = null;
    void s.release().catch(() => undefined);
  }
}
