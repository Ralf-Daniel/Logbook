const CACHE_NAME = 'logbook-v47';
// Список файлов, которые телефон должен намертво сохранить в свой кэш:
const ASSETS = [
  'index.html',
  'styles.css',
  'db.js',
  'markdown-it.min.js',
  'manifest.json'
];

// 1. Событие установки: скачиваем все файлы в кэш устройства
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[PWA Service Worker] Кэшируем ресурсы приложения');
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// 2. Событие активации: удаляем старые версии кэша, если они были
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (key !== CACHE_NAME) {
            console.log('[PWA Service Worker] Удаляем старый кэш:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 3. Стратегия «Сначала Кэш, затем Сеть»: приложение работает мгновенно без интернета
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) {
        return cachedResponse; // Если файл есть в кэше — отдаем его моментально
      }
      return fetch(event.request); // Если файла нет (например, внешняя интернет-ссылка) — идем в сеть
    })
  );
});
