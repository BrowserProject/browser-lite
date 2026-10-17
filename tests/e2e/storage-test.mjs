// End-to-End Test fuer dauerhaften Speicher: Cookie, localStorage und
// IndexedDB muessen ein Neuladen der ganzen Oberflaeche ueberleben
// (/data in der Engine liegt im OPFS des Host-Browsers), auch gleich nach dem
// Schreiben. Dazu die Grenze fuer IndexedDB, zu grosse Datenbanken und
// Uploads im OPFS statt im Speicher der Engine.
//
//   cd tests/e2e && node storage-test.mjs [engine-ordner]
import { TIMEOUT, canvasOrigin, check, collect, finish, launchProfile, serve, startStack, timeLimit } from './harness.mjs';

timeLimit(4 * TIMEOUT + 120000);

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
  // Grenze pro Ursprung (256 MB): zu gross wird abgelehnt, der Rest bleibt
  if (local === 'leer') {
    let quota;
    try {
      await cache.put('/gross', new Response(new Uint8Array(257 << 20)));
      quota = 'gespeichert';
    } catch (e) {
      quota = e.name;
    }
    console.log('RESULT cachequota=' + quota + ',' + (await (await cache.match('/gespeichert')).text()) + ',' + !!(await cache.match('/gross')));
  }
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
  // Namen im OPFS waehlt die Seite, auch einer wie eine Kopie der Engine bleibt
  try {
    const root = await navigator.storage.getDirectory();
    let kept = 'leer';
    try {
      kept = await (await (await root.getFileHandle('rest.bl-tmp')).getFile()).text();
    } catch (e) {}
    const writer = await (await root.getFileHandle('rest.bl-tmp', { create: true })).createWritable();
    await writer.write('seite');
    await writer.close();
    console.log('RESULT opfsname=' + kept);
  } catch (e) {
    console.log('RESULT opfsname=fehler:' + e.name);
  }
  // Sperren: verschieben geht nicht, solange ein Writable offen ist. Ein
  // Writable ersetzt die Datei erst bei close(), abort() laesst sie wie sie war
  try {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('sperre-a.txt', { create: true });
    const writer = await file.createWritable();
    await writer.write('neu');
    let moved = 'erlaubt';
    try {
      await file.move(root, 'sperre-b.txt');
    } catch (e) {
      moved = e.name;
    }
    await writer.close();
    await file.move(root, 'sperre-b.txt');
    const append = await file.createWritable({ keepExistingData: true });
    await append.write({ type: 'write', position: 3, data: '+mehr' });
    await append.close();
    const aborted = await file.createWritable();
    await aborted.write('weg');
    await aborted.abort();
    const text = await (await file.getFile()).text();
    await root.removeEntry('sperre-b.txt');
    console.log('RESULT opfslock=' + [moved, file.name, text].join(','));
  } catch (e) {
    console.log('RESULT opfslock=fehler:' + e.name);
  }
  // Eine gelesene Datei mit einem zweiten Handle bleibt verschiebbar: die
  // Engine haelt sie im OPFS des Host nicht zum Schreiben offen
  try {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('lesen.txt', { create: true });
    const writer = await file.createWritable();
    await writer.write('gelesen');
    await writer.close();
    const text = await (await file.getFile()).text();
    await root.getFileHandle('lesen.txt', { create: true });
    await file.move(root, 'verschoben.txt');
    const left = await root.getFileHandle('lesen.txt').then(() => 'da', (e) => e.name);
    await root.removeEntry('verschoben.txt');
    console.log('RESULT opfsread=' + [text, left].join(','));
  } catch (e) {
    console.log('RESULT opfsread=fehler:' + e.name);
  }
  // Ordner verschieben (im OPFS des Host als Kopie, siehe moveDirectory)
  try {
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle('umzug', { create: true });
    const writer = await (await folder.getFileHandle('kiste.txt', { create: true })).createWritable();
    await writer.write('inhalt');
    await writer.close();
    await folder.move(root, 'umgezogen');
    const moved = await root.getDirectoryHandle('umgezogen');
    const text = await (await (await moved.getFileHandle('kiste.txt')).getFile()).text();
    const left = await root.getDirectoryHandle('umzug').then(() => 'da', (e) => e.name);
    await root.removeEntry('umgezogen', { recursive: true });
    console.log('RESULT opfsdir=' + [folder.name, text, left].join(','));
  } catch (e) {
    console.log('RESULT opfsdir=fehler:' + e.name);
  }
  // Synchroner Zugriff gibt es nur in Workern
  const workerSource = \`onmessage = async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const again = await (await root.getFileHandle('sperre-a.txt', { create: true })).createSyncAccessHandle();
      again.close();
      await root.removeEntry('sperre-a.txt');
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

// Schreibt IndexedDB und ein Cookie, die Oberflaeche laedt gleich danach neu
const QUICK_PAGE = `<!doctype html><title>Schnell</title><script>
(async () => {
  const db = await new Promise((resolve) => {
    const open = indexedDB.open('schnell', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('w');
    open.onsuccess = () => resolve(open.result);
  });
  const value = await new Promise((resolve) => {
    const get = db.transaction('w').objectStore('w').get('x');
    get.onsuccess = () => resolve(get.result || 'leer');
    get.onerror = () => resolve('fehler');
  });
  console.log('RESULT quick=' + value + ',' + ((document.cookie.match(/bl_schnell=(\\w+)/) || [])[1] || 'leer'));
  if (value !== 'leer')
    return;
  document.cookie = 'bl_schnell=keks; Path=/; Max-Age=86400';
  await new Promise((resolve) => {
    const tx = db.transaction('w', 'readwrite');
    tx.objectStore('w').put('wert', 'x');
    tx.oncomplete = tx.onerror = resolve;
  });
  console.log('RESULT quickwritten=1');
})();
</script>`;

// Grenze fuer IndexedDB (hier mit BL_INDEXEDDB_QUOTA_MB klein): ?fuellen
// schreibt 1-MB-Eintraege bis QuotaExceededError, ?voll und ?ueber lesen,
// schreiben und loeschen an bzw. ueber der Grenze und schreiben danach noch
// einmal, sonst ist die Datenbank zu gross fuer den Speicher (BL_DATABASE_MAX_MB)
const QUOTA_PAGE = `<!doctype html><title>Grenze</title><script>
const request = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const openDB = () => new Promise((resolve, reject) => {
  const open = indexedDB.open('gross', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('b');
  open.onsuccess = () => resolve(open.result);
  open.onerror = () => reject(open.error);
});
const put = (db, key) => new Promise((resolve, reject) => {
  const tx = db.transaction('b', 'readwrite');
  tx.objectStore('b').put(new Uint8Array(1 << 20).fill(key + 1), key);
  tx.oncomplete = resolve;
  tx.onabort = () => reject(tx.error);
});
const names = async () => (await indexedDB.databases()).some((db) => db.name === 'gross') ? 'gross' : 'keine';
const outcome = (promise) => promise.then(() => 'ok', (e) => e.name);
(async () => {
  if (location.search === '?fuellen') {
    const db = await openDB();
    let stored = 0;
    let error = 'keiner';
    for (let i = 0; i < 12; i++) {
      try {
        await put(db, i);
        stored++;
      } catch (e) {
        error = e.name;
        break;
      }
    }
    const first = await request(db.transaction('b').objectStore('b').get(0));
    db.close();
    console.log('RESULT quotafill=' + error + ',' + stored + ',' + first.length + ':' + first[0]);
    return;
  }
  if (location.search === '?voll' || location.search === '?ueber') {
    const db = await openDB();
    const first = await request(db.transaction('b').objectStore('b').get(0));
    const written = await outcome(put(db, 20));
    const tx = db.transaction('b', 'readwrite');
    tx.objectStore('b').delete(1);
    const deleted = await outcome(new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    }));
    const again = await outcome(put(db, 21));
    db.close();
    console.log('RESULT quotaopen=' + [await names(), first.length, written, deleted, again].join(','));
    return;
  }
  const opened = await openDB().then((db) => { db.close(); return 'offen'; }, (e) => e.name);
  const deleted = await outcome(request(indexedDB.deleteDatabase('gross')));
  console.log('RESULT toobig=' + opened + ',' + deleted);
})();
</script>`;

// Datei-Upload: die Seite liest nur Groesse und Ende
const UPLOAD_PAGE = `<!doctype html><title>Upload</title>
<input type=file id=datei style="position:absolute;left:0;top:0;width:400px;height:200px">
<script>
document.getElementById('datei').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  console.log('RESULT upload=' + file.name + ':' + file.size + ':' + await file.slice(file.size - 4).text());
});
console.log('RESULT uploadready=1');
</script>`;

// Das Cookie kommt nur beim ersten Besuch, danach muss es aus dem
// gespeicherten Cookie-Speicher der Engine kommen
let visits = 0;
const { url: siteURL } = await serve((req, res) => {
  const extra = { '/schnell': QUICK_PAGE, '/quota': QUOTA_PAGE, '/upload': UPLOAD_PAGE }[req.url.split('?')[0]];
  if (extra)
    return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(extra);
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };
  if (visits++ === 0)
    headers['Set-Cookie'] = 'bl_store=ja; Path=/; Max-Age=86400';
  res.writeHead(200, headers).end(PAGE);
});

const stack = await startStack({ token: 'store-token-0123456789abcdef' });
// Profil auf der Platte, OPFS in Dateien (siehe launchProfile)
const context = await launchProfile();
const page = context.pages()[0] || await context.newPage();
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
check('OPFS: verschieben bei offenem Writable gesperrt, Writable ersetzt erst bei close()', (await result('opfslock')) === 'NoModificationAllowedError,sperre-b.txt,neu+mehr', results.get('opfslock'));
check('Cache API: ueber der Grenze abgelehnt, alter Inhalt bleibt', (await result('cachequota')) === 'QuotaExceededError,cache-wert,false', results.get('cachequota'));

check('OPFS: gelesene Datei mit zweitem Handle verschiebbar', (await result('opfsread')) === 'gelesen,NotFoundError', results.get('opfsread'));
check('OPFS: Ordner verschoben', (await result('opfsdir')) === 'umgezogen,inhalt,NotFoundError', results.get('opfsdir'));
check('OPFS: Datei mit eigenem Namen angelegt', (await result('opfsname')) === 'leer', results.get('opfsname'));

// Rest einer abgebrochenen Kopie (replaceWholeFile, /data/tmp im OPFS des Host)
const leftoverExists = () => page.evaluate(async () => {
  try {
    await (await (await navigator.storage.getDirectory()).getDirectoryHandle('tmp')).getFileHandle('rest');
    return 'da';
  } catch (e) {
    return e.name;
  }
});
await page.evaluate(async () => {
  const tmp = await (await navigator.storage.getDirectory()).getDirectoryHandle('tmp', { create: true });
  const writer = await (await tmp.getFileHandle('rest', { create: true })).createWritable();
  await writer.write('abgebrochen');
  await writer.close();
});
check('Rest in /data/tmp angelegt', (await leftoverExists()) === 'da');

// Warten bis /data gespeichert ist (alle 5 s), dann alles neu laden
await page.waitForTimeout(7000);
results.clear();
await page.reload();
const second = await result('read');
check('Nach Neuladen noch da (Cookie, localStorage, IndexedDB)', second === 'ja,gespeichert,idb-wert', String(second));
check('Cache API: nach Neuladen noch da (mit Headern)', (await result('cacheapi')) === 'cache-wert:ja', results.get('cacheapi'));
check('OPFS: nach Neuladen noch da', (await result('opfs')) === 'gespeichert,notiz.txt+ordner+rest.bl-tmp+sync.bin,ordner/notiz.txt,innen', results.get('opfs'));
check('OPFS: Datei mit eigenem Namen nach Neustart noch da', (await result('opfsname')) === 'seite', results.get('opfsname'));
check('Start leert /data/tmp', (await leftoverExists()) === 'NotFoundError');
check('IndexedDB-Datenbank geloescht', (await result('deleted')) === 'weg', String(results.get('deleted')));

// Nochmal neu laden: die geloeschte Datenbank darf nicht zurueckkommen
await page.waitForTimeout(7000);
results.clear();
await page.reload();
check('Nach zweitem Neuladen: neuer Wert da, geloeschte Datenbank weg', (await result('third')) === 'zwei,weg', String(results.get('third')));

// Zweiter Tab der Oberflaeche: /data gehoert dem ersten (navigator.locks), der
// zweite hat nur Speicher und darf die Daten des ersten nicht ueberschreiben
await page.waitForTimeout(7000);
const secondTab = await context.newPage();
const secondResults = collect(secondTab);
await secondTab.goto(appURL);
check('Zweiter Tab: eigener leerer Speicher', (await secondResults.wait('read')) === 'nein,leer,leer', String(secondResults.get('read')));
await secondResults.wait('written');
await secondTab.waitForTimeout(7000);
await secondTab.close();
results.clear();
await page.reload();
check('Erster Tab: Daten nicht ueberschrieben', (await result('read')) === 'ja,gespeichert,idb-wert', String(results.get('read')));
await result('deleted');
await result('opfsworker');

// Daten aus dem IDBFS frueherer Versionen (IndexedDB "/data", ein Eintrag pro
// Datei) uebernimmt die Engine beim ersten Start mit WasmFS nach /data (OPFS)
// und loescht die alte Datenbank danach (web/app.js, engine/src/Storage.cpp)
const freshContext = await launchProfile();
const fresh = freshContext.pages()[0] || await freshContext.newPage();
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

// Gleich nach dem Schreiben neu geladen: beim Schliessen (pagehide) wartet die
// Oberflaeche kurz, bis die Engine die Datenbanken geschrieben hat
results.clear();
await fresh.goto(stack.app({ url: siteURL + 'schnell' }));
check('Schnell: am Anfang leer', (await result('quick')) === 'leer,leer', results.get('quick'));
await result('quickwritten');
results.clear();
await fresh.reload();
check('Sofort nach dem Schreiben neu geladen: IndexedDB und Cookie da', (await result('quick')) === 'wert,keks', results.get('quick'));

// Grenze fuer IndexedDB pro Ursprung: QuotaExceededError, was vorher kam, bleibt
results.clear();
await fresh.goto(stack.app({ url: siteURL + 'quota?fuellen', env: 'BL_INDEXEDDB_QUOTA_MB=4' }));
const filled = (await result('quotafill'))?.split(',') || [];
check('IndexedDB: ueber der Grenze QuotaExceededError, der Rest bleibt', filled[0] === 'QuotaExceededError' && filled[1] >= 1 && filled[1] <= 4 && filled[2] === '1048576:1', results.get('quotafill'));
await fresh.waitForTimeout(2000);
// Beim naechsten Besuch an der Grenze bzw. darueber: oeffnen, lesen und
// loeschen gehen (wie Chrome), nur Schreiben nicht. Geloeschtes gibt Platz
// frei, auch wenn die Datei von SQLite nicht kleiner wird
for (const [search, quota, again] of [['voll', 4, 'ok'], ['ueber', 1, 'QuotaExceededError']]) {
  results.clear();
  await fresh.goto(stack.app({ url: siteURL + 'quota?' + search, env: 'BL_INDEXEDDB_QUOTA_MB=' + quota }));
  check(`IndexedDB ${search}: oeffnen, lesen, loeschen ja, schreiben nein, nach dem Loeschen ${again}`, (await result('quotaopen')) === 'gross,1048576,QuotaExceededError,ok,' + again, results.get('quotaopen'));
  await fresh.waitForTimeout(2000);
}
// Zu gross fuer den Speicher der Engine: nicht geladen, aber loeschbar, danach
// ist die Datei im OPFS weg
const databaseFiles = () => fresh.evaluate(async () => {
  const files = [];
  const walk = async (directory) => {
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === 'directory')
        await walk(handle);
      else if (name.endsWith('.sqlite3'))
        files.push((await handle.getFile()).size);
    }
  };
  await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('indexeddb'));
  return files;
});
const bigFiles = (files) => files.filter((size) => size > (1 << 20)).length;
const filesBefore = await databaseFiles();
results.clear();
await fresh.goto(stack.app({ url: siteURL + 'quota', env: 'BL_DATABASE_MAX_MB=1' }));
const tooBig = (await result('toobig'))?.split(',') || [];
const filesAfter = await databaseFiles();
check('Datenbank zu gross fuer den Speicher: nicht geladen, loeschbar, Datei weg', bigFiles(filesBefore) === 1 && tooBig[0] !== 'offen' && tooBig[1] === 'ok' && !bigFiles(filesAfter), `${results.get('toobig')} Dateien ${filesBefore} -> ${filesAfter}`);

// Uploads liegen im OPFS (/data/tmp/uploads), nicht im WASM-Speicher der Engine
const engineMallocMB = async () => {
  const line = fresh.waitForEvent('console', { predicate: (msg) => /malloc belegt \d+ MB/.test(msg.text()), timeout: 30000 });
  await fresh.evaluate(() => window.__blMemory(3));
  return Number(/malloc belegt (\d+) MB/.exec((await line).text())[1]);
};
results.clear();
await fresh.goto(stack.app({ url: siteURL + 'upload' }));
await result('uploadready');
await fresh.waitForTimeout(1000);
const mallocBefore = await engineMallocMB();
const size = 32 << 20;
const content = Buffer.alloc(size, 'a');
content.write('Ende', size - 4);
const chooserPromise = fresh.waitForEvent('filechooser', { timeout: 30000 }).catch(() => null);
const { x, y } = await canvasOrigin(fresh);
await fresh.mouse.click(x + 100, y + 50);
const chooser = await chooserPromise;
await chooser?.setFiles({ name: 'gross.bin', mimeType: 'application/octet-stream', buffer: content });
check('Upload: Datei in der Seite', (await result('upload')) === 'gross.bin:' + size + ':Ende', results.get('upload'));
const mallocAfter = await engineMallocMB();
check('Upload: nicht im WASM-Speicher', mallocAfter - mallocBefore < 12, `${mallocBefore} -> ${mallocAfter} MB`);
const uploaded = await fresh.evaluate(async () => {
  const sizes = [];
  const walk = async (directory) => {
    for await (const [, handle] of directory.entries()) {
      if (handle.kind === 'directory')
        await walk(handle);
      else
        sizes.push(handle.name + ':' + (await handle.getFile()).size);
    }
  };
  const tmp = await (await navigator.storage.getDirectory()).getDirectoryHandle('tmp');
  await walk(await tmp.getDirectoryHandle('uploads'));
  return sizes.join(',');
});
check('Upload: Datei im OPFS', uploaded === 'gross.bin:' + size, uploaded);

await freshContext.close();
await context.close();
finish();
