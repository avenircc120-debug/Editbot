// Service worker minimal — requis par les navigateurs pour proposer
// l'installation de la page (Ajouter à l'écran d'accueil). Ne met rien
// en cache : chaque requête part directement au réseau, comme sans lui.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
