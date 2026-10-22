const VERSION='naklona-v1';
const SHELL=['/','/manifest.webmanifest','/icon.svg','/icon-192.png','/icon-512.png','/cards/back.svg',...['C','D','H','S'].flatMap(s=>['7','8','9','10','J','Q','K','A'].map(r=>`/cards/${s}-${r}.svg`))];
self.addEventListener('install',event=>{event.waitUntil(caches.open(VERSION).then(cache=>cache.addAll(SHELL)));self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(event.request.mode==='navigate'){event.respondWith(fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();void caches.open(VERSION).then(cache=>cache.put('/',copy));}return response;}).catch(()=>caches.match('/')));return;}
  event.respondWith(caches.match(event.request).then(cached=>cached||fetch(event.request).then(response=>{if(response.ok){const copy=response.clone();void caches.open(VERSION).then(cache=>cache.put(event.request,copy));}return response;})));
});
