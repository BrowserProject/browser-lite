// End-to-End Test fuer dauerhaften Speicher: Cookie, localStorage und
// IndexedDB muessen ein Neuladen der ganzen Oberflaeche ueberleben
// (/data in der Engine liegt im OPFS des Host-Browsers).
//
//   cd tests/e2e && node storage-test.mjs [engine-ordner]
import { TIMEOUT, check, collect, finish, launch, serve, startStack, timeLimit } from './harness.mjs';

timeLimit(3 * TIMEOUT + 120000);

// Erster Besuch speichert, zweiter Besuch (nach Neuladen) liest
const PAGE = `<!doctype html><title>Speicher-Test</title><script>
(async () => {
  const cookie = document.cookie.includes('bl_store=ja') ? 'ja' : 'nein';
  const local = localStorage.getItem('bl') || 'leer';
  const db = await new Promise((resolve) => {
    const open = indexedDB.open('bl-test', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('werte');
    open.onerror = () => resolve('fehler');
    open.onsuccess = () => {
      const get = open.result.transaction('werte').objectStore('werte').get('x');
      get.onsuccess = () => resolve(get.result || 'leer');
      get.onerror = () => resolve('fehler');
    };
  });
  console.log('RESULT read=' + [cookie, local, db].join(','));
  localStorage.setItem('bl', 'gespeichert');
  await new Promise((resolve) => {
    const open = indexedDB.open('bl-test', 1);
    open.onsuccess = () => {
      const tx = open.result.transaction('werte', 'readwrite');
      tx.objectStore('werte').put('idb-wert', 'x');
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    };
    open.onerror = resolve;
  });
  // Cache API (engine/src/CacheStorageWasm.cpp): bleibt nach Neuladen
  const cache = await caches.open('bl-cache');
  const cachedResponse = await cache.match('/gespeichert');
  console.log('RESULT cacheapi=' + (cachedResponse ? (await cachedResponse.text()) + ':' + cachedResponse.headers.get('X-Test') : 'leer'));
  await cache.put('/gespeichert', new Response('cache-wert', { headers: { 'X-Test': 'ja' } }));
  console.log('RESULT written=1');
  // Origin Private File System: Datei lesen, schreiben, Ordner, resolve()
  try {
    const root = await navigator.storage.getDirectory();
    let text = 'leer';
    try {
      text = await (await (await root.getFileHandle('notiz.txt')).getFile()).text();
    } catch (e) {}
    const folder = await root.getDirectoryHandle('ordner', { create: true });
    const inner = await folder.getFileHandle('notiz.txt', { create: true });
    const innerWriter = await inner.createWritable();
    await innerWriter.write('innen');
    await innerWriter.close();
    const top = await root.getFileHandle('notiz.txt', { create: true });
    const writer = await top.createWritable();
    await writer.write('gespeichert');
    await writer.close();
    const names = [];
    for await (const [name] of root.entries())
      names.push(name);
    console.log('RESULT opfs=' + [text, names.sort().join('+'), (await root.resolve(inner)).join('/'), await (await inner.getFile()).text()].join(','));
  } catch (e) {
    console.log('RESULT opfs=fehler:' + e.name);
  }
  // Synchroner Zugriff gibt es nur in Workern
  const workerSource = \`onmessage = async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle('sync.bin', { create: true });
      const handle = await file.createSyncAccessHandle();
      handle.truncate(0);
      handle.write(new TextEncoder().encode('sync-ok'));
      handle.flush();
      const bytes = new Uint8Array(handle.getSize());
      handle.read(bytes, { at: 0 });
      handle.close();
      postMessage(new TextDecoder().decode(bytes));
    } catch (e) {
      postMessage('fehler:' + e.name);
    }
  };\`;
  const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));
  worker.onmessage = (e) => console.log('RESULT opfsworker=' + e.data);
  worker.postMessage(1);
  // Zweiter Besuch: eine Datenbank anlegen und wieder loeschen (WebKit loescht
  // die Dateien dabei selber, die Engine darf sie nicht zurueckschreiben)
  const exists = async (name) => (await indexedDB.databases()).some((db) => db.name === name) ? 'da' : 'weg';
  if (local === 'gespeichert') {
    await new Promise((resolve) => {
      const open = indexedDB.open('bl-weg', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('w').put('x', 'y');
      open.onsuccess = () => { open.result.close(); resolve(); };
      open.onerror = resolve;
    });
    await new Promise((resolve) => {
      const del = indexedDB.deleteDatabase('bl-weg');
      del.onsuccess = del.onerror = resolve;
    });
    localStorage.setItem('bl', 'zwei');
    console.log('RESULT deleted=' + await exists('bl-weg'));
  }
  if (local === 'zwei')
    console.log('RESULT third=' + local + ',' + await exists('bl-weg'));
})();
</script>`;

// Das Cookie kommt nur beim ersten Besuch, danach muss es aus dem
// gespeicherten Cookie-Speicher der Engine kommen
let visits = 0;
const { url: siteURL } = await serve((req, res) => {
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };
  if (visits++ === 0)
    headers['Set-Cookie'] = 'bl_store=ja; Path=/; Max-Age=86400';
  res.writeHead(200, headers).end(PAGE);
});

const stack = await startStack({ token: 'store-token-0123456789abcdef' });
const browser = await launch();
const context = await browser.newContext();
const page = await context.newPage();
const results = collect(page);
const result = (key) => results.wait(key);

const appURL = stack.app({ url: siteURL });

await page.goto(appURL);
const first = await result('read');
check('Erster Besuch: nur das neue Cookie', first === 'ja,leer,leer', String(first));
check('Daten geschrieben', (await result('written')) === '1');
check('Cache API am Anfang leer', results.get('cacheapi') === 'leer', results.get('cacheapi'));
check('OPFS: Dateien, Ordner, resolve()', (await result('opfs')) === 'leer,notiz.txt+ordner,ordner/notiz.txt,innen', results.get('opfs'));
check('OPFS: synchroner Zugriff im Worker', (await result('opfsworker')) === 'sync-ok', results.get('opfsworker'));

// Warten bis /data gespeichert ist (alle 5 s), dann alles neu laden
await page.waitForTimeout(7000);
results.clear();
await page.reload();
const second = await result('read');
check('Nach Neuladen noch da (Cookie, localStorage, IndexedDB)', second === 'ja,gespeichert,idb-wert', String(second));
check('Cache API: nach Neuladen noch da (mit Headern)', (await result('cacheapi')) === 'cache-wert:ja', results.get('cacheapi'));
check('OPFS: nach Neuladen noch da', (await result('opfs')) === 'gespeichert,notiz.txt+ordner+sync.bin,ordner/notiz.txt,innen', results.get('opfs'));
check('IndexedDB-Datenbank geloescht', (await result('deleted')) === 'weg', String(results.get('deleted')));

// Nochmal neu laden: die geloeschte Datenbank darf nicht zurueckkommen
await page.waitForTimeout(7000);
results.clear();
await page.reload();
check('Nach zweitem Neuladen: neuer Wert da, geloeschte Datenbank weg', (await result('third')) === 'zwei,weg', String(results.get('third')));

// Daten aus dem IDBFS frueherer Versionen (IndexedDB "/data", ein Eintrag pro
// Datei) uebernimmt die Engine beim ersten Start mit WasmFS nach /data (OPFS)
// und loescht die alte Datenbank danach (web/app.js, engine/src/Storage.cpp)
const fresh = await (await browser.newContext()).newPage();
results.clear();
results.watch(fresh);
await fresh.goto(stack.uiURL + 'nicht-da');
const origin = encodeURIComponent(siteURL.slice(0, -1));
await fresh.evaluate((file) => new Promise((resolve, reject) => {
  const open = indexedDB.open('/data', 21);
  open.onupgradeneeded = () => open.result.createObjectStore('FILE_DATA').createIndex('timestamp', 'timestamp', { unique: false });
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const tx = open.result.transaction('FILE_DATA', 'readwrite');
    tx.objectStore('FILE_DATA').put({ timestamp: new Date(), mode: 16877 }, '/data/opfs');
    tx.objectStore('FILE_DATA').put({ timestamp: new Date(), mode: 33188, contents: new TextEncoder().encode('alt-daten') }, file);
    tx.oncomplete = () => { open.result.close(); resolve(); };
    tx.onerror = () => reject(tx.error);
  };
}), `/data/opfs/${origin}/${origin}/notiz.txt`);
await fresh.goto(appURL);
const migrated = await result('opfs');
check('Alte IDBFS-Daten uebernommen', migrated?.startsWith('alt-daten,'), String(migrated));
await fresh.waitForTimeout(1000);
const legacyGone = await fresh.evaluate(async () => !(await indexedDB.databases()).some((db) => db.name === '/data'));
check('Alte IDBFS-Datenbank geloescht', legacyGone);

// "Daten loeschen": die Oberflaeche laedt neu und leert /data vor dem Start
// der Engine, danach ist die Datei weg
await fresh.waitForTimeout(6000);
results.clear();
fresh.once('dialog', (dialog) => dialog.accept());
await fresh.evaluate(() => document.getElementById('clear-data').click());
const cleared = await result('opfs');
check('Daten loeschen leert /data', cleared?.startsWith('leer,'), String(cleared));

await browser.close();
finish();
