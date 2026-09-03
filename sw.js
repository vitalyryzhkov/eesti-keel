// Офлайн-кэш. Меняешь файлы — подними CACHE, иначе старая версия останется на телефоне.
const CACHE = 'eesti-a2-v17';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'data/words.json',
  'data/grammar.json',
  'data/exam.json',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' обязателен: иначе addAll берёт файлы из HTTP-кэша браузера
  // и в новый кэш попадает старая версия — подъём CACHE перестаёт работать
  const fresh = ASSETS.map((u) => new Request(u, { cache: 'reload' }));
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(fresh)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// network-first для данных (чтобы правки словаря доезжали), cache-first для остального
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const isData = e.request.url.includes('/data/');

  // читаем строго из своего кэша: caches.match перебирает все кэши по старшинству,
  // и недоудалённый старый кэш начал бы выигрывать у нового
  const fromCache = (req) => caches.open(CACHE).then((c) => c.match(req));

  if (isData) {
    // no-store обязателен: иначе «сначала сеть» упирается в HTTP-кэш браузера
    // и словарь на телефоне остаётся старым, хотя версию мы не меняли
    e.respondWith(
      fetch(e.request.url, { cache: 'no-store' })
        .then((r) => {
          // Cache.put кладёт ответ с любым статусом. Без этой проверки 404 при
          // кривом деплое или HTML-заглушка captive-портала в кафе перезапишут
          // рабочий словарь в офлайн-кэше — и приложение офлайн больше не встанет
          const type = r.headers.get('content-type') || '';
          // не JSON — значит это не наш словарь, а чужая страница: не кэшируем
          // и не отдаём приложению, пусть берёт рабочую копию из кэша
          if (!r.ok || !type.includes('json')) throw new Error('ответ не словарь');
          const copy = r.clone();
          e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)));
          return r;
        })
        .catch(() => fromCache(e.request))
    );
    return;
  }

  e.respondWith(fromCache(e.request).then((hit) => hit || fetch(e.request)));
});
