// The full write of a database never stops the engine thread (engine/src/MemoryVFS.cpp). With a
// slow disk (every OPFS write takes 50 ms longer, BL_OPFS_WRITE_DELAY_MS) a page commits many
// small IndexedDB transactions while a timer on the engine thread records its longest gap. The
// write about a second after a change ran on the engine thread and wrote every committed WAL frame
// on its own, one OPFS write per frame: seconds without timers, input or paint (edition.cnn.com
// froze for 3 to 13 s writing a 24 KB cookie database). Afterwards a new engine reads every value
// back: commits made while a full write is under way reach the disk too.
//
//   node tests/core/storage-flush-test.mjs [engine-dir]
import {
  TIMEOUT,
  check,
  collect,
  finish,
  launchProfile,
  serve,
  startStack,
  timeLimit,
} from '../lib/index.mjs';

timeLimit(2 * TIMEOUT + 60000);

const COUNT = 150;
const DELAY_MS = 50;
// Longest timer gap allowed on a loaded machine; the write on the engine thread took 100 to 200
// writes of 50 ms here
const GAP_LIMIT_MS = 1500;

const PAGE = `<!doctype html><title>Flush</title><script>
const COUNT = ${COUNT};
const value = (i) => ('v' + i).padEnd(3000, '.');
const request = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
(async () => {
  const open = indexedDB.open('flush', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('v');
  const db = await request(open);
  if (location.search === '?read') {
    const values = await request(db.transaction('v').objectStore('v').getAll());
    console.log('RESULT read=' + values.length + ',' + values.filter((v, i) => v === value(i)).length);
    return;
  }
  let last = performance.now();
  let gap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
  }, 10);
  for (let i = 0; i < COUNT; i++) {
    const tx = db.transaction('v', 'readwrite');
    tx.objectStore('v').put(value(i), i);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
  }
  // The full write comes about a second after the last change
  await new Promise((resolve) => setTimeout(resolve, 3000));
  clearInterval(timer);
  console.log('RESULT fill=' + Math.round(gap));
})().catch((e) => console.log('RESULT fill=error:' + e.name));
</script>`;

const { url: siteURL } = await serve((req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE),
);
const stack = await startStack({ token: 'flush-token-0123456789abcdef' });
const context = await launchProfile();
const page = context.pages()[0] || (await context.newPage());
const results = collect(page);
const appURL = (query) =>
  stack.app({
    url: `${siteURL}${query}`,
    persistent: '1',
    env: `BL_OPFS_WRITE_DELAY_MS=${DELAY_MS}`,
  });

await page.goto(appURL(''));
const gap = await results.wait('fill');
check(
  `slow disk: the engine thread never waits for a full write (longest timer gap ${gap} ms)`,
  Number(gap) < GAP_LIMIT_MS,
  String(gap),
);

results.clear();
await page.goto(appURL('?read'));
check(
  'every commit is there after a restart',
  (await results.wait('read')) === `${COUNT},${COUNT}`,
  results.get('read'),
);

await context.close();
finish();
