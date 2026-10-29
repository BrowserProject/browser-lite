// Persistent storage through @browser-lite/core: cookie, localStorage and IndexedDB must survive
// a reload of the whole host page (/data of the engine lives in the OPFS of the host browser),
// also right after writing. Also the Cache API, the OPFS of the pages, the limit for IndexedDB,
// databases too large for memory, a second tab (storage lock), clearStorage() and uploads in
// the OPFS instead of the engine memory.
//
//   node tests/core/storage-test.mjs [engine-dir]
import {
  TIMEOUT,
  canvasOrigin,
  check,
  collect,
  finish,
  launchProfile,
  serve,
  startStack,
  timeLimit,
  waitFor,
} from '../lib/index.mjs';

timeLimit(4 * TIMEOUT + 120000);

// The first visit stores, the second visit (after a reload) reads
const PAGE = `<!doctype html><title>Storage test</title><script>
(async () => {
  const cookie = document.cookie.includes('bl_store=yes') ? 'yes' : 'no';
  const local = localStorage.getItem('bl') || 'empty';
  const db = await new Promise((resolve) => {
    const open = indexedDB.open('bl-test', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('values');
    open.onerror = () => resolve('error');
    open.onsuccess = () => {
      const get = open.result.transaction('values').objectStore('values').get('x');
      get.onsuccess = () => resolve(get.result || 'empty');
      get.onerror = () => resolve('error');
    };
  });
  console.log('RESULT read=' + [cookie, local, db].join(','));
  localStorage.setItem('bl', 'stored');
  await new Promise((resolve) => {
    const open = indexedDB.open('bl-test', 1);
    open.onsuccess = () => {
      const tx = open.result.transaction('values', 'readwrite');
      tx.objectStore('values').put('idb-value', 'x');
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    };
    open.onerror = resolve;
  });
  // Cache API (engine/src/CacheStorageWasm.cpp): stays after a reload
  const cache = await caches.open('bl-cache');
  const cachedResponse = await cache.match('/stored');
  console.log('RESULT cacheapi=' + (cachedResponse ? (await cachedResponse.text()) + ':' + cachedResponse.headers.get('X-Test') : 'empty'));
  await cache.put('/stored', new Response('cache-value', { headers: { 'X-Test': 'yes' } }));
  console.log('RESULT written=1');
  // Limit per origin (256 MB): too large is refused, the rest stays
  if (local === 'empty') {
    let quota;
    try {
      await cache.put('/large', new Response(new Uint8Array(257 << 20)));
      quota = 'stored';
    } catch (e) {
      quota = e.name;
    }
    console.log('RESULT cachequota=' + quota + ',' + (await (await cache.match('/stored')).text()) + ',' + !!(await cache.match('/large')));
  }
  // Origin Private File System: read and write a file, folders, resolve()
  try {
    const root = await navigator.storage.getDirectory();
    let text = 'empty';
    try {
      text = await (await (await root.getFileHandle('note.txt')).getFile()).text();
    } catch (e) {}
    const folder = await root.getDirectoryHandle('folder', { create: true });
    const inner = await folder.getFileHandle('note.txt', { create: true });
    const innerWriter = await inner.createWritable();
    await innerWriter.write('inside');
    await innerWriter.close();
    const top = await root.getFileHandle('note.txt', { create: true });
    const writer = await top.createWritable();
    await writer.write('stored');
    await writer.close();
    const names = [];
    for await (const [name] of root.entries())
      names.push(name);
    console.log('RESULT opfs=' + [text, names.sort().join('+'), (await root.resolve(inner)).join('/'), await (await inner.getFile()).text()].join(','));
  } catch (e) {
    console.log('RESULT opfs=error:' + e.name);
  }
  // The page chooses names in the OPFS, even one that looks like a copy of the engine stays
  try {
    const root = await navigator.storage.getDirectory();
    let kept = 'empty';
    try {
      kept = await (await (await root.getFileHandle('rest.bl-tmp')).getFile()).text();
    } catch (e) {}
    const writer = await (await root.getFileHandle('rest.bl-tmp', { create: true })).createWritable();
    await writer.write('page');
    await writer.close();
    console.log('RESULT opfsname=' + kept);
  } catch (e) {
    console.log('RESULT opfsname=error:' + e.name);
  }
  // Locks: moving fails while a writable is open. A writable replaces the file only at close(),
  // abort() leaves it as it was
  try {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('lock-a.txt', { create: true });
    const writer = await file.createWritable();
    await writer.write('new');
    let moved = 'allowed';
    try {
      await file.move(root, 'lock-b.txt');
    } catch (e) {
      moved = e.name;
    }
    await writer.close();
    await file.move(root, 'lock-b.txt');
    const append = await file.createWritable({ keepExistingData: true });
    await append.write({ type: 'write', position: 3, data: '+more' });
    await append.close();
    const aborted = await file.createWritable();
    await aborted.write('gone');
    await aborted.abort();
    const text = await (await file.getFile()).text();
    await root.removeEntry('lock-b.txt');
    console.log('RESULT opfslock=' + [moved, file.name, text].join(','));
  } catch (e) {
    console.log('RESULT opfslock=error:' + e.name);
  }
  // A file that was read stays movable with a second handle: the engine does not keep it open
  // for writing in the OPFS of the host
  try {
    const root = await navigator.storage.getDirectory();
    const file = await root.getFileHandle('read.txt', { create: true });
    const writer = await file.createWritable();
    await writer.write('readable');
    await writer.close();
    const text = await (await file.getFile()).text();
    await root.getFileHandle('read.txt', { create: true });
    await file.move(root, 'moved.txt');
    const left = await root.getFileHandle('read.txt').then(() => 'there', (e) => e.name);
    await root.removeEntry('moved.txt');
    console.log('RESULT opfsread=' + [text, left].join(','));
  } catch (e) {
    console.log('RESULT opfsread=error:' + e.name);
  }
  // Move a folder (a copy in the OPFS of the host, see moveDirectory)
  try {
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle('moving', { create: true });
    const writer = await (await folder.getFileHandle('box.txt', { create: true })).createWritable();
    await writer.write('content');
    await writer.close();
    await folder.move(root, 'moved');
    const moved = await root.getDirectoryHandle('moved');
    const text = await (await (await moved.getFileHandle('box.txt')).getFile()).text();
    const left = await root.getDirectoryHandle('moving').then(() => 'there', (e) => e.name);
    await root.removeEntry('moved', { recursive: true });
    console.log('RESULT opfsdir=' + [folder.name, text, left].join(','));
  } catch (e) {
    console.log('RESULT opfsdir=error:' + e.name);
  }
  // Synchronous access only exists in workers
  const workerSource = \`onmessage = async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const again = await (await root.getFileHandle('lock-a.txt', { create: true })).createSyncAccessHandle();
      again.close();
      await root.removeEntry('lock-a.txt');
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
      postMessage('error:' + e.name);
    }
  };\`;
  const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));
  worker.onmessage = (e) => console.log('RESULT opfsworker=' + e.data);
  worker.postMessage(1);
  // Second visit: create a database and delete it again (WebKit deletes the files itself, the
  // engine must not write them back)
  const exists = async (name) => (await indexedDB.databases()).some((db) => db.name === name) ? 'there' : 'gone';
  if (local === 'stored') {
    await new Promise((resolve) => {
      const open = indexedDB.open('bl-gone', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('w').put('x', 'y');
      open.onsuccess = () => { open.result.close(); resolve(); };
      open.onerror = resolve;
    });
    await new Promise((resolve) => {
      const del = indexedDB.deleteDatabase('bl-gone');
      del.onsuccess = del.onerror = resolve;
    });
    localStorage.setItem('bl', 'two');
    console.log('RESULT deleted=' + await exists('bl-gone'));
  }
  if (local === 'two')
    console.log('RESULT third=' + local + ',' + await exists('bl-gone'));
})();
</script>`;

// Writes IndexedDB and a cookie, the host page reloads right after
const QUICK_PAGE = `<!doctype html><title>Quick</title><script>
(async () => {
  const db = await new Promise((resolve) => {
    const open = indexedDB.open('quick', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('w');
    open.onsuccess = () => resolve(open.result);
  });
  const value = await new Promise((resolve) => {
    const get = db.transaction('w').objectStore('w').get('x');
    get.onsuccess = () => resolve(get.result || 'empty');
    get.onerror = () => resolve('error');
  });
  console.log('RESULT quick=' + value + ',' + ((document.cookie.match(/bl_quick=(\\w+)/) || [])[1] || 'empty'));
  if (value !== 'empty')
    return;
  document.cookie = 'bl_quick=cookie; Path=/; Max-Age=86400';
  await new Promise((resolve) => {
    const tx = db.transaction('w', 'readwrite');
    tx.objectStore('w').put('value', 'x');
    tx.oncomplete = tx.onerror = resolve;
  });
  console.log('RESULT quickwritten=1');
})();
</script>`;

// Limit for IndexedDB (small here with BL_INDEXEDDB_QUOTA_MB): ?fill writes 1 MB entries until
// QuotaExceededError, ?full and ?over read, write and delete at or over the limit and write once
// more afterwards; without a query the database is too large for memory (BL_DATABASE_MAX_MB)
const QUOTA_PAGE = `<!doctype html><title>Limit</title><script>
const request = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const openDB = () => new Promise((resolve, reject) => {
  const open = indexedDB.open('large', 1);
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
const names = async () => (await indexedDB.databases()).some((db) => db.name === 'large') ? 'large' : 'none';
const outcome = (promise) => promise.then(() => 'ok', (e) => e.name);
(async () => {
  if (location.search === '?fill') {
    const db = await openDB();
    let stored = 0;
    let error = 'none';
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
  if (location.search === '?full' || location.search === '?over') {
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
  const opened = await openDB().then((db) => { db.close(); return 'open'; }, (e) => e.name);
  const deleted = await outcome(request(indexedDB.deleteDatabase('large')));
  console.log('RESULT toobig=' + opened + ',' + deleted);
})();
</script>`;

// File upload: the page only reads the size and the end
const UPLOAD_PAGE = `<!doctype html><title>Upload</title>
<input type=file id=file style="position:absolute;left:0;top:0;width:400px;height:200px">
<script>
document.getElementById('file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  console.log('RESULT upload=' + file.name + ':' + file.size + ':' + await file.slice(file.size - 4).text());
});
console.log('RESULT uploadready=1');
</script>`;

// The cookie only comes on the first visit, afterwards it must come from the stored cookie
// store of the engine
let visits = 0;
const { url: siteURL } = await serve((req, res) => {
  const extra = { '/quick': QUICK_PAGE, '/quota': QUOTA_PAGE, '/upload': UPLOAD_PAGE }[
    req.url.split('?')[0]
  ];
  if (extra) return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(extra);
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };
  if (visits++ === 0) headers['Set-Cookie'] = 'bl_store=yes; Path=/; Max-Age=86400';
  res.writeHead(200, headers).end(PAGE);
});

const stack = await startStack({ token: 'store-token-0123456789abcdef' });
// Chromium profile on disk, OPFS in files (see launchProfile)
const context = await launchProfile();
const page = context.pages()[0] || (await context.newPage());
const results = collect(page);
const result = (key) => results.wait(key);
// Persistent storage in the default namespace 'browserlite' (like the demo)
const appURL = (url, extra = {}) => stack.app({ url, persistent: '1', ...extra });

await page.goto(appURL(siteURL));
const first = await result('read');
check('first visit: only the new cookie', first === 'yes,empty,empty', String(first));
check('data written', (await result('written')) === '1');
check('Cache API empty at the start', results.get('cacheapi') === 'empty', results.get('cacheapi'));
check(
  'OPFS: files, folders, resolve()',
  (await result('opfs')) === 'empty,folder+note.txt,folder/note.txt,inside',
  results.get('opfs'),
);
check(
  'OPFS: synchronous access in a worker',
  (await result('opfsworker')) === 'sync-ok',
  results.get('opfsworker'),
);
check(
  'OPFS: moving blocked while a writable is open, a writable replaces only at close()',
  (await result('opfslock')) === 'NoModificationAllowedError,lock-b.txt,new+more',
  results.get('opfslock'),
);
check(
  'Cache API: refused over the limit, the old content stays',
  (await result('cachequota')) === 'QuotaExceededError,cache-value,false',
  results.get('cachequota'),
);
check(
  'OPFS: a read file is movable with a second handle',
  (await result('opfsread')) === 'readable,NotFoundError',
  results.get('opfsread'),
);
check(
  'OPFS: folder moved',
  (await result('opfsdir')) === 'moved,content,NotFoundError',
  results.get('opfsdir'),
);
check(
  'OPFS: file with an own name created',
  (await result('opfsname')) === 'empty',
  results.get('opfsname'),
);

// Rest of an aborted copy (replaceWholeFile, /data/tmp in the OPFS of the host)
const leftoverExists = () =>
  page.evaluate(async () => {
    try {
      await (
        await (
          await (await navigator.storage.getDirectory()).getDirectoryHandle('browserlite')
        ).getDirectoryHandle('tmp')
      ).getFileHandle('rest');
      return 'there';
    } catch (e) {
      return e.name;
    }
  });
await page.evaluate(async () => {
  const tmp = await (
    await (await navigator.storage.getDirectory()).getDirectoryHandle('browserlite')
  ).getDirectoryHandle('tmp', { create: true });
  const writer = await (await tmp.getFileHandle('rest', { create: true })).createWritable();
  await writer.write('aborted');
  await writer.close();
});
check('rest in /data/tmp created', (await leftoverExists()) === 'there');

// Wait until /data is stored, then reload everything
await page.waitForTimeout(7000);
results.clear();
await page.reload();
const second = await result('read');
check(
  'still there after a reload (cookie, localStorage, IndexedDB)',
  second === 'yes,stored,idb-value',
  String(second),
);
check(
  'Cache API: still there after a reload (with headers)',
  (await result('cacheapi')) === 'cache-value:yes',
  results.get('cacheapi'),
);
check(
  'OPFS: still there after a reload',
  (await result('opfs')) === 'stored,folder+note.txt+rest.bl-tmp+sync.bin,folder/note.txt,inside',
  results.get('opfs'),
);
check(
  'OPFS: file with an own name still there after a restart',
  (await result('opfsname')) === 'page',
  results.get('opfsname'),
);
check('the start empties /data/tmp', (await leftoverExists()) === 'NotFoundError');
check(
  'IndexedDB database deleted',
  (await result('deleted')) === 'gone',
  String(results.get('deleted')),
);

// Reload again: the deleted database must not come back
await page.waitForTimeout(7000);
results.clear();
await page.reload();
check(
  'after a second reload: new value there, deleted database gone',
  (await result('third')) === 'two,gone',
  String(results.get('third')),
);

// Second tab of the host page: /data belongs to the first (navigator.locks), the second only has
// memory and must not overwrite the data of the first
await page.waitForTimeout(7000);
const secondTab = await context.newPage();
const secondResults = collect(secondTab);
await secondTab.goto(appURL(siteURL));
check(
  'second tab: its own empty storage',
  (await secondResults.wait('read')) === 'no,empty,empty',
  String(secondResults.get('read')),
);
check(
  'second tab: warning storage-locked',
  await secondTab.evaluate(() => window.blHost.warnings.includes('storage-locked')),
);
await secondResults.wait('written');
await secondTab.waitForTimeout(7000);
await secondTab.close();
results.clear();
await page.reload();
check(
  'first tab: data not overwritten',
  (await result('read')) === 'yes,stored,idb-value',
  String(results.get('read')),
);
await result('deleted');
await result('opfsworker');

// clearStorage(): after destroy() the namespace (OPFS directory and caches) is emptied, the next
// start begins without the file. First create a file in the OPFS of the page in a new profile
const freshContext = await launchProfile();
// Without a fileChooser handler the core uses the native file dialog of the host page
await freshContext.addInitScript(() => {
  window.blTestOptions = { handlers: { fileChooser: undefined } };
});
let fresh = freshContext.pages()[0] || (await freshContext.newPage());
// Firefox keeps the engines of earlier documents of a tab (#291); after about 7 engine starts in
// one tab its content process crashed: a new tab before the quota and upload sections, once the old
// one let go of the storage lock
async function freshTab() {
  // The new tab first: closing the last page of a profile closes Firefox's window
  const old = fresh;
  fresh = await freshContext.newPage();
  results.watch(fresh);
  await old.goto('about:blank');
  await old.close();
  await fresh.goto(stack.app({ manual: '1' }));
  await waitFor(
    () => fresh.evaluate(async () => !(await navigator.locks.query()).held?.length),
    20000,
  );
}
results.clear();
results.watch(fresh);
await fresh.goto(appURL(siteURL));
await result('opfs');
await fresh.waitForTimeout(2000);
results.clear();
await fresh.reload();
const saved = await result('opfs');
check('new profile: file stored in the OPFS', saved?.startsWith('stored,'), String(saved));
await fresh.waitForTimeout(2000);
const clearResult = await fresh.evaluate(async () => {
  await window.blHost.stop();
  const { clearStorage } = await import('@browser-lite/core');
  return clearStorage().then(
    () => 'cleared',
    (error) => error.code,
  );
});
results.clear();
await fresh.reload();
const cleared = await result('opfs');
check(
  'clearStorage() empties /data',
  clearResult === 'cleared' && cleared?.startsWith('empty,'),
  `${clearResult} ${cleared}`,
);

// Reloaded right after writing: on close (pagehide) the core waits a moment until the engine
// wrote the databases
results.clear();
await fresh.goto(appURL(`${siteURL}quick`));
check('quick: empty at the start', (await result('quick')) === 'empty,empty', results.get('quick'));
await result('quickwritten');
results.clear();
await fresh.reload();
check(
  'reloaded right after writing: IndexedDB and cookie there',
  (await result('quick')) === 'value,cookie',
  results.get('quick'),
);

// Limit for IndexedDB per origin: QuotaExceededError, what came before stays
await freshTab();
results.clear();
await fresh.goto(appURL(`${siteURL}quota?fill`, { env: 'BL_INDEXEDDB_QUOTA_MB=4' }));
const filled = (await result('quotafill'))?.split(',') || [];
check(
  'IndexedDB: QuotaExceededError over the limit, the rest stays',
  filled[0] === 'QuotaExceededError' &&
    filled[1] >= 1 &&
    filled[1] <= 4 &&
    filled[2] === '1048576:1',
  results.get('quotafill'),
);
await fresh.waitForTimeout(2000);
// On the next visit at or over the limit: open, read and delete work (like Chrome), only writing
// does not. Deleted entries free space, even if SQLite does not shrink the file
for (const [search, quota, again] of [
  ['full', 4, 'ok'],
  ['over', 1, 'QuotaExceededError'],
]) {
  results.clear();
  await fresh.goto(appURL(`${siteURL}quota?${search}`, { env: `BL_INDEXEDDB_QUOTA_MB=${quota}` }));
  check(
    `IndexedDB ${search}: open, read, delete yes, write no, after deleting ${again}`,
    (await result('quotaopen')) === `large,1048576,QuotaExceededError,ok,${again}`,
    results.get('quotaopen'),
  );
  await fresh.waitForTimeout(2000);
}
// Too large for the engine memory: not loaded, but deletable, afterwards the file in the OPFS
// is gone
const databaseFiles = () =>
  fresh.evaluate(async () => {
    const files = [];
    const walk = async (directory) => {
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind === 'directory') await walk(handle);
        else if (name.endsWith('.sqlite3')) files.push((await handle.getFile()).size);
      }
    };
    await walk(
      await (
        await (await navigator.storage.getDirectory()).getDirectoryHandle('browserlite')
      ).getDirectoryHandle('indexeddb'),
    );
    return files;
  });
const bigFiles = (files) => files.filter((size) => size > 1 << 20).length;
const filesBefore = await databaseFiles();
results.clear();
await fresh.goto(appURL(`${siteURL}quota`, { env: 'BL_DATABASE_MAX_MB=1' }));
const tooBig = (await result('toobig'))?.split(',') || [];
const filesAfter = await databaseFiles();
check(
  'database too large for memory: not loaded, deletable, file gone',
  bigFiles(filesBefore) === 1 &&
    tooBig[0] !== 'open' &&
    tooBig[1] === 'ok' &&
    !bigFiles(filesAfter),
  `${results.get('toobig')} files ${filesBefore} -> ${filesAfter}`,
);

// Uploads live in the OPFS (/data/tmp/uploads), not in the WASM memory of the engine
const engineMallocMB = async () => {
  const line = fresh.waitForEvent('console', {
    predicate: (msg) => /malloc used \d+ MB/.test(msg.text()),
    timeout: 30000,
  });
  await fresh.evaluate(() => window.blTest.memory(0));
  return Number(/malloc used (\d+) MB/.exec((await line).text())[1]);
};
await freshTab();
results.clear();
await fresh.goto(appURL(`${siteURL}upload`));
await result('uploadready');
await fresh.waitForTimeout(1000);
const mallocBefore = await engineMallocMB();
const size = 32 << 20;
const content = Buffer.alloc(size, 'a');
content.write('End!', size - 4);
const chooserPromise = fresh.waitForEvent('filechooser', { timeout: 30000 }).catch(() => null);
const { x, y } = await canvasOrigin(fresh);
await fresh.mouse.click(x + 100, y + 50);
const chooser = await chooserPromise;
await chooser?.setFiles({
  name: 'large.bin',
  mimeType: 'application/octet-stream',
  buffer: content,
});
check(
  'upload: file in the page',
  (await result('upload')) === `large.bin:${size}:End!`,
  results.get('upload'),
);
const mallocAfter = await engineMallocMB();
check(
  'upload: not in the WASM memory',
  mallocAfter - mallocBefore < 12,
  `${mallocBefore} -> ${mallocAfter} MB`,
);
// The copy into the OPFS finishes asynchronously, the page may read the file before
const uploadedFiles = () =>
  fresh.evaluate(async () => {
    const sizes = [];
    const walk = async (directory) => {
      for await (const [, handle] of directory.entries()) {
        if (handle.kind === 'directory') await walk(handle);
        else sizes.push(`${handle.name}:${(await handle.getFile()).size}`);
      }
    };
    const tmp = await (
      await (await navigator.storage.getDirectory()).getDirectoryHandle('browserlite')
    ).getDirectoryHandle('tmp');
    await walk(await tmp.getDirectoryHandle('uploads'));
    return sizes.join(',');
  });
let uploaded = await uploadedFiles();
for (let i = 0; i < 50 && uploaded !== `large.bin:${size}`; i++) {
  await fresh.waitForTimeout(200);
  uploaded = await uploadedFiles();
}
check('upload: file in the OPFS', uploaded === `large.bin:${size}`, uploaded);

await freshContext.close();
await context.close();
finish();
