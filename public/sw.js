// Service worker: приложение открывается без сети после первого визита.
// Стратегия «сначала сеть»: онлайн всегда свежая версия, офлайн — последняя сохранённая.
const PREFIX = 'ravvast-trainer-';
const CACHE = `${PREFIX}v2`;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // Удаляем только свои старые кэши: на этом же адресе могут жить другие проекты.
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Удаляет из кэша файлы сборки, на которые новая страница уже не ссылается. */
async function pruneAssets(html) {
  const cache = await caches.open(CACHE);
  for (const key of await cache.keys()) {
    const path = new URL(key.url).pathname;
    const i = path.lastIndexOf('/assets/');
    if (i >= 0 && !html.includes(path.slice(i + 1))) await cache.delete(key);
  }
}

async function respond(event) {
  const request = event.request;
  const navigation = request.mode === 'navigate';
  try {
    // Страницу запрашиваем в обход HTTP-кэша: иначе после обновления сайта можно получить
    // старый index.html со ссылками на уже удалённые файлы сборки.
    const response = navigation
      ? await fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' })
      : await fetch(request);

    if (response.status >= 500) {
      const cached = await caches.match(request);
      if (cached) return cached;
    }
    if (response.status === 200 && !response.redirected && response.type === 'basic') {
      const copy = response.clone();
      const html = navigation ? response.clone().text() : null;
      event.waitUntil(
        caches
          .open(CACHE)
          .then((cache) => cache.put(request, copy))
          .then(() => (html ? html.then(pruneAssets) : undefined))
          .catch(() => undefined),
      );
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Запасной вариант — оболочка приложения, но только для перехода на страницу:
    // скриптам и данным HTML вместо ответа отдавать нельзя.
    if (navigation) {
      const shell = await caches.match('./');
      if (shell) return shell;
    }
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(respond(event));
});
