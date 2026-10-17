// Das Browser-Profil auf dem Server (relay/profile.mjs): Cookies, localStorage und kleine
// IndexedDBs der Seiten, dazu Einstellungen, Lesezeichen und Berechtigungen der Oberflaeche.
// So bleibt man auf Websites angemeldet, auch auf einem anderen Geraet. Verlauf und Sitzung
// bleiben auf dem Geraet (library.js).
//
// openProfile legt das Profil vor dem Start der Engine ins OPFS, das /data der Engine ist.
// Danach schreibt nur noch die Engine dorthin, syncProfile liest die Dateien und laedt
// Geaendertes hoch. Eine Datenbank des Profils ist cookies.db, eine .localstorage-Datei oder
// der Ordner einer IndexedDB. Ausser cookies.db kommt sie nur bis DB_LIMIT ins Profil,
// groessere bleiben als Cache auf diesem Geraet.

import { reloadUI, storage, tokenKey } from './util.js';

export const DEFAULT_DB_LIMIT = 256; // KB
const PREFS_KEY = 'bl-profile-prefs';
// Was hochgeladen ist: { id, session, files: { pfad: [size, lastModified] }, prefs: [name] }
// (prefs: noch nicht auf dem Server). Bleibt ueber einen Neustart, damit der naechste Start
// nachholt, was nicht mehr hochging.
const SYNC_KEY = 'bl-profile-sync';
// OPFS beim naechsten Start leeren (resetProfile)
const CLEAR_KEY = 'bl-clear-data';
// Datei im OPFS mit der id des Profils, das darin liegt
const MARKER = 'profile-id';
const VISIBLE_INTERVAL = 2000;
const HIDDEN_INTERVAL = 30000;
const AFTER_HIDE = 2500;
// open: bis der Kopf der Antwort da ist, dann fuer alle Dateien
const OPEN_TIMEOUT = 10000;
const DOWNLOAD_TIMEOUT = 120000;

// off: kein Profil (zweiter Tab der Oberflaeche, vor dem Start), local: Server nicht
// erreichbar, connected, taken / reset: ein anderes Geraet hat uebernommen bzw. zurueckgesetzt
const STATE_TEXT = {
  off: 'Kein Profil in diesem Tab: browser-lite ist schon in einem anderen Tab offen',
  local: 'Profil-Server nicht erreichbar, Änderungen bleiben auf diesem Gerät',
  connected: 'Mit dem Profil-Server verbunden',
  taken: 'Das Profil wurde auf einem anderen Gerät geöffnet, hier wird nichts mehr gespeichert',
  reset: 'Das Profil wurde auf einem anderen Gerät zurückgesetzt',
};
let state = 'off';
let problem = '';
let record = { files: {} };
let prefsCache = readJSON(PREFS_KEY) || {};
// Namen der prefs, die noch nicht auf dem Server sind
let unsentPrefs = new Set();
let prefsQueue = Promise.resolve();
let syncing = null;
let syncTimer = 0;
// Fehlt eine Datei, kann die Engine sie gerade ersetzen: erst beim zweiten Mal loeschen
let missing = new Set();
// Vom Server abgelehnt (Pfad, zu gross, Profil voll), bis sich die Datei aendert
const rejected = new Map();

function readJSON(key) {
  try {
    return JSON.parse(storage(key) || 'null');
  } catch {
    return null;
  }
}

const saveRecord = () => storage(SYNC_KEY, JSON.stringify({ ...record, prefs: [...unsentPrefs] }));
const dbLimit = () => (prefsCache.settings?.dbLimit || DEFAULT_DB_LIMIT) * 1024;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Die Engine ersetzt Dateien per rename: dabei kann Lesen kurz scheitern
const transient = (error) => error?.name === 'NotFoundError' || error?.name === 'NotReadableError';

// ------------------------------------------------------------ Server

// Browser und System des Host, damit man sieht, wo das Profil offen ist
function hostDevice() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const system = /CrOS/.test(ua) ? 'ChromeOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'unbekannt';
  return browser + ' auf ' + system;
}

// json: Body als JSON (sonst rohe Bytes)
function request(path, { method = 'GET', body, json, timeout = 60000, signal = AbortSignal.timeout(timeout) } = {}) {
  const headers = {};
  if (json !== undefined) {
    body = JSON.stringify(json);
    headers['Content-Type'] = 'application/json';
  }
  const token = storage(tokenKey(location.host));
  if (token)
    headers.Authorization = 'Bearer ' + token;
  if (record.session)
    headers['X-Profile-Session'] = record.session;
  return fetch('/profile/' + path, { method, body, headers, cache: 'no-store', signal });
}

// Schreibende Anfrage. 409: ein anderes Geraet hat uebernommen (error.reason)
async function write(path, method, { body, json, timeout } = {}) {
  const response = await request(path, { method, body, json, timeout });
  if (response.status === 409) {
    const reason = (await response.json().catch(() => null))?.reason === 'reset' ? 'reset' : 'taken';
    throw Object.assign(new Error(STATE_TEXT[reason]), { reason });
  }
  if (!response.ok)
    throw Object.assign(new Error('Profil-Server: HTTP ' + response.status), { status: response.status });
}

const filePath = (path) => 'files/' + path.split('/').map(encodeURIComponent).join('/');

function concat(chunks) {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

// POST /profile/open: u32 LE Laenge des Kopfes, Kopf (JSON), alle Dateien hintereinander.
// Die neue Session gilt auf dem Server, sobald er antwortet: onHead(head), bevor die
// Dateien da sind.
async function fetchProfile(onHead) {
  const controller = new AbortController();
  const abortAfter = (ms) => setTimeout(() => controller.abort(new DOMException('Profil-Server antwortet nicht', 'TimeoutError')), ms);
  let timer = abortAfter(OPEN_TIMEOUT);
  try {
    const response = await request('open', { method: 'POST', json: { device: hostDevice() }, signal: controller.signal });
    if (!response.ok)
      throw new Error('Profil-Server: HTTP ' + response.status);
    clearTimeout(timer);
    timer = abortAfter(DOWNLOAD_TIMEOUT);
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    let head = null;
    for (let chunk; !(chunk = await reader.read()).done;) {
      chunks.push(chunk.value);
      received += chunk.value.length;
      if (!head && received >= 4) {
        const start = concat(chunks);
        const headEnd = 4 + new DataView(start.buffer).getUint32(0, true);
        if (received >= headEnd) {
          head = JSON.parse(new TextDecoder().decode(start.subarray(4, headEnd)));
          onHead(head);
        }
      }
    }
    if (!head)
      throw new Error('Profil unvollständig');
    const bytes = concat(chunks);
    let offset = 4 + new DataView(bytes.buffer).getUint32(0, true);
    const files = head.files.map(({ path, size }) => {
      offset += size;
      return { path, data: bytes.subarray(offset - size, offset) };
    });
    if (offset !== bytes.length)
      throw new Error('Profil unvollständig');
    return { head, files };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------ OPFS

const isMissing = (error) => error?.name === 'NotFoundError' || error?.name === 'TypeMismatchError';

// Ordner unter parent, null wenn es ihn nicht gibt
async function folder(parent, names, create = false) {
  let dir = parent;
  try {
    for (const name of names)
      dir = await dir.getDirectoryHandle(name, { create });
    return dir;
  } catch (error) {
    if (isMissing(error))
      return null;
    throw error;
  }
}

// Eintraege eines Ordners, leer wenn es ihn nicht (mehr) gibt: indexedDB.deleteDatabase kann
// einen Ordner waehrend des Lesens loeschen
async function children(dir) {
  const all = [];
  try {
    for await (const handle of dir?.values() ?? [])
      all.push(handle);
  } catch (error) {
    if (!isMissing(error))
      throw error;
  }
  return all;
}

async function writeFile(top, path, data) {
  const parts = path.split('/');
  const dir = await folder(top, parts.slice(0, -1), true);
  const writable = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await writable.write(data);
  await writable.close();
}

async function removePath(top, path) {
  const parts = path.split('/');
  await (await folder(top, parts.slice(0, -1)))?.removeEntry(parts.at(-1), { recursive: true }).catch((error) => {
    if (!isMissing(error))
      throw error;
  });
}

async function clearOPFS(top) {
  for await (const name of top.keys())
    await top.removeEntry(name, { recursive: true }).catch((error) => console.warn('OPFS:', name, error));
}

async function readMarker(top) {
  try {
    return await (await (await top.getFileHandle(MARKER)).getFile()).text();
  } catch {
    return null;
  }
}

async function folderSize(dir) {
  let size = 0;
  for (const handle of await children(dir)) {
    if (handle.kind === 'directory')
      size += await folderSize(handle);
    else
      size += (await handle.getFile().catch(() => null))?.size || 0;
  }
  return size;
}

// ------------------------------------------------------------ Datenbanken im OPFS

// Datenbank einer Datei: cookies.db, die .localstorage-Datei oder der Ordner der IndexedDB
const unitOf = (path) => (path.startsWith('indexeddb/') ? path.slice(0, path.lastIndexOf('/')) : path);
// Namen, die der Server annimmt (relay/profile.mjs), ohne Reste kaputter Datenbanken
const validName = (name) => name !== '' && !name.startsWith('.') && !name.includes('\\') && !name.endsWith('-corrupted')
  && new TextEncoder().encode(name).length <= 255;

// Datei mit Groesse und Zeit, null waehrend die Engine sie gerade ersetzt
async function readEntry(handle, path) {
  try {
    const file = await handle.getFile();
    return { path, handle, size: file.size, modified: file.lastModified };
  } catch (error) {
    if (transient(error))
      return null;
    throw error;
  }
}

function fileUnit(key, entry, limit) {
  return { key, files: entry ? [entry] : [], size: entry?.size || 0, unstable: !entry, big: key !== 'cookies.db' && entry?.size > limit };
}

// Ordner einer IndexedDB: erst IndexedDB.sqlite3, ueber der Grenze nicht weiter lesen. null
// fuer einen leeren Ordner (geloeschte Datenbank)
async function databaseUnit(key, dir, limit) {
  const unit = { key, files: [], size: 0, unstable: false, big: false };
  const add = (entry) => {
    if (!entry) {
      unit.unstable = true;
      return false;
    }
    unit.files.push(entry);
    unit.size += entry.size;
    unit.big = unit.size > limit;
    return !unit.big;
  };
  const main = await dir.getFileHandle('IndexedDB.sqlite3').catch(() => null);
  if (!main)
    return (await children(dir)).some((handle) => handle.kind === 'file') ? { ...unit, unstable: true } : null;
  if (!add(await readEntry(main, key + '/IndexedDB.sqlite3')))
    return unit;
  for (const handle of await children(dir)) {
    const { name } = handle;
    if (handle.kind === 'file' && name !== 'IndexedDB.sqlite3' && validName(name) && !add(await readEntry(handle, key + '/' + name)))
      break;
  }
  return unit;
}

// Ordner der IndexedDBs: indexeddb/v1/<oben>/<name> bzw. fuer Frames <oben>/<frame>/<name>.
// Ein Ordner mit Dateien ohne IndexedDB.sqlite3 wird gerade ersetzt.
async function* databaseFolders(top) {
  for (const originDir of await children(await folder(top, ['indexeddb', 'v1']))) {
    if (originDir.kind !== 'directory' || !validName(originDir.name))
      continue;
    for (const dir of await children(originDir)) {
      if (dir.kind !== 'directory' || !validName(dir.name))
        continue;
      const key = `indexeddb/v1/${originDir.name}/${dir.name}`;
      if (await dir.getFileHandle('IndexedDB.sqlite3').then(() => true, () => false)) {
        yield [key, dir];
        continue;
      }
      const inner = (await children(dir)).filter((handle) => handle.kind === 'directory' && validName(handle.name));
      if (!inner.length)
        yield [key, dir];
      for (const handle of inner)
        yield [key + '/' + handle.name, handle];
    }
  }
}

// Alle Datenbanken des Profils im OPFS, big ueber limit (nicht ganz gelesen), unstable
// waehrend die Engine eine Datei ersetzt
async function scan(top, limit) {
  const units = [];
  const cookies = await top.getFileHandle('cookies.db').catch(() => null);
  if (cookies)
    units.push(fileUnit('cookies.db', await readEntry(cookies, 'cookies.db'), limit));
  for (const handle of await children(await folder(top, ['localstorage']))) {
    const path = 'localstorage/' + handle.name;
    if (handle.kind === 'file' && handle.name.endsWith('.localstorage') && validName(handle.name))
      units.push(fileUnit(path, await readEntry(handle, path), limit));
  }
  for await (const [key, dir] of databaseFolders(top))
    units.push(await databaseUnit(key, dir, limit));
  return units.filter(Boolean);
}

// ------------------------------------------------------------ Start

// Beim Start, bevor die Engine laeuft (app.js mountStorage, mit der Sperre bl-data). Holt
// nach, was beim letzten Mal nicht mehr hochging, solange dieses Geraet das Profil noch hat,
// und legt dann das Profil des Servers ins OPFS. Gibt einen Hinweis fuer den Tab zurueck,
// '' wenn alles gut ging.
export async function openProfile() {
  const top = await navigator.storage.getDirectory();
  if (storage(CLEAR_KEY)) {
    await clearOPFS(top);
    storage(CLEAR_KEY, null);
  }
  record = { files: {}, ...readJSON(SYNC_KEY) };
  unsentPrefs = new Set(record.prefs);
  delete record.prefs;
  try {
    let catchUp = { taken: false, pending: new Set() };
    if (record.session && record.id === await readMarker(top))
      catchUp = await syncProfile(true);
    // Ein anderes Geraet hat inzwischen uebernommen: dann gilt der Server
    if (catchUp.taken)
      unsentPrefs.clear();
    const opened = await fetchProfile((head) => {
      record = { id: head.id, session: head.session, files: head.id === record.id ? record.files : {} };
      saveRecord();
    });
    await seed(top, opened, catchUp.pending);
  } catch (error) {
    console.warn('Profil:', error);
    state = 'local';
    return STATE_TEXT.local;
  }
  state = 'connected';
  flushPrefs();
  scheduleSync(VISIBLE_INTERVAL);
  return '';
}

// Das Profil des Servers ins OPFS. Ein anderes Profil (neues Geraet, zurueckgesetzt): erst
// alles leeren. Sonst gilt der Server, ausser fuer pending (Datenbanken, die beim Nachholen
// nicht hochgingen, bleiben wie sie sind). Eine Datenbank, die im Profil war und die er nicht
// mehr hat, wurde anderswo geloescht. Datenbanken, die nie im Profil waren, bleiben.
async function seed(top, { head, files }, pending) {
  const local = prefsCache;
  prefsCache = { ...head.prefs };
  for (const name of unsentPrefs)
    prefsCache[name] = local[name] ?? null;
  storage(PREFS_KEY, JSON.stringify(prefsCache));
  if (await readMarker(top) !== head.id) {
    await clearOPFS(top);
    pending = new Set();
  } else {
    const remote = new Set(files.map((file) => unitOf(file.path)));
    const known = new Set(Object.keys(record.files).map(unitOf));
    for (const unit of await scan(top, dbLimit())) {
      if (!pending.has(unit.key) && (remote.has(unit.key) || known.has(unit.key)))
        await removePath(top, unit.key);
    }
  }
  // Baut WebKit beim Start aus den .localstorage-Dateien neu auf
  await removePath(top, 'localstorage/LegacyStorageTracker.db');
  // pending behalten ihren alten Stand, der Abgleich laedt sie dann hoch
  const stamps = Object.fromEntries(Object.entries(record.files).filter(([path]) => pending.has(unitOf(path))));
  for (const file of files) {
    if (pending.has(unitOf(file.path)))
      continue;
    await writeFile(top, file.path, file.data);
    const parts = file.path.split('/');
    const written = await (await (await folder(top, parts.slice(0, -1))).getFileHandle(parts.at(-1))).getFile();
    stamps[file.path] = [written.size, written.lastModified];
  }
  await writeFile(top, MARKER, head.id);
  record.files = stamps;
  saveRecord();
}

// ------------------------------------------------------------ Abgleich

function scheduleSync(ms) {
  clearTimeout(syncTimer);
  if (state !== 'connected')
    return;
  syncTimer = setTimeout(async () => {
    await syncProfile();
    scheduleSync(document.hidden ? HIDDEN_INTERVAL : VISIBLE_INTERVAL);
  }, ms);
}

// Beim Verstecken schreibt die Engine ihre Datenbanken (bl_storage_flush in app.js)
document.addEventListener('visibilitychange', () => scheduleSync(document.hidden ? AFTER_HIDE : VISIBLE_INTERVAL));

function stop(reason) {
  state = reason;
  clearTimeout(syncTimer);
  const notice = document.getElementById('profile-notice');
  notice.querySelector('span').textContent = STATE_TEXT[reason];
  notice.querySelector('button').onclick = () => reloadUI();
  notice.hidden = false;
}

// Laedt Geaendertes hoch und loescht auf dem Server, was lokal weg oder zu gross geworden ist.
// beforeStart (openProfile): die Engine laeuft noch nicht, nichts wird gerade ersetzt. Gibt
// dann { taken, pending } zurueck: taken bei 409 (ein anderes Geraet hat uebernommen),
// pending sind die Datenbanken, die nicht auf den Server kamen.
function syncProfile(beforeStart = false) {
  if (syncing || !record.session || (!beforeStart && state !== 'connected'))
    return syncing || Promise.resolve(null);
  syncing = runSync(beforeStart).finally(() => {
    syncing = null;
  });
  return syncing;
}

const changed = (file) => {
  const known = record.files[file.path];
  return !known || known[0] !== file.size || known[1] !== file.modified;
};

async function runSync(beforeStart) {
  const timeout = beforeStart ? 10000 : 60000;
  // Nach resetProfile nichts mehr schreiben
  const active = () => beforeStart || state === 'connected';
  let units = null;
  let taken = false;
  try {
    units = await scan(await navigator.storage.getDirectory(), dbLimit());
    const byKey = new Map(units.map((unit) => [unit.key, unit]));
    const present = new Set();
    for (const unit of units) {
      if (unit.unstable || unit.big)
        continue;
      for (const file of unit.files) {
        present.add(file.path);
        if (changed(file) && active())
          await upload(file, timeout);
      }
    }
    const stillMissing = new Set();
    for (const path of Object.keys(record.files)) {
      const unit = byKey.get(unitOf(path));
      if (present.has(path) || unit?.unstable || !active())
        continue;
      if (unit?.big || beforeStart || missing.has(path)) {
        // 400: kein Pfad des Profils, dann gibt es ihn auf dem Server auch nicht
        await write(filePath(path), 'DELETE', { timeout }).catch((error) => {
          if (error.status !== 400)
            throw error;
        });
        delete record.files[path];
      } else {
        stillMissing.add(path);
      }
    }
    missing = stillMissing;
    problem = rejected.size ? 'Nicht alles passt ins Profil (Grenze des Servers)' : '';
    if (unsentPrefs.size && !beforeStart)
      flushPrefs();
  } catch (error) {
    if (error.reason) {
      taken = true;
      if (!beforeStart)
        stop(error.reason);
    } else {
      problem = 'Verbindung zum Profil-Server unterbrochen, wird wiederholt';
      console.warn('Profil:', error);
    }
  } finally {
    saveRecord();
  }
  if (!beforeStart)
    return null;
  if (!units)
    throw new Error('Profil im OPFS nicht lesbar');
  return { taken, pending: taken ? new Set() : unsynced(units) };
}

// Datenbanken, deren Stand nicht auf dem Server ist: geaendert oder neu (auch abgelehnt),
// lokal geloescht oder zu gross geworden, solange der Server sie noch hat
function unsynced(units) {
  const pending = new Set();
  const present = new Set();
  for (const unit of units) {
    if (unit.big)
      continue;
    if (unit.unstable || unit.files.some(changed))
      pending.add(unit.key);
    for (const file of unit.files)
      present.add(file.path);
  }
  for (const path of Object.keys(record.files)) {
    if (!present.has(path))
      pending.add(unitOf(path));
  }
  return pending;
}

async function upload(file, timeout) {
  const stamp = file.size + ':' + file.modified;
  if (rejected.get(file.path) === stamp)
    return;
  rejected.delete(file.path);
  for (let attempt = 1; ; attempt++) {
    try {
      const snapshot = await file.handle.getFile();
      await write(filePath(file.path), 'PUT', { body: await snapshot.arrayBuffer(), timeout });
      record.files[file.path] = [snapshot.size, snapshot.lastModified];
      return;
    } catch (error) {
      if (transient(error)) {
        if (attempt === 3)
          return;
        await sleep(250);
        continue;
      }
      if (error.status === 400 || error.status === 413 || error.status === 507) {
        rejected.set(file.path, stamp);
        return;
      }
      throw error;
    }
  }
}

// ------------------------------------------------------------ prefs

// settings, bookmarks oder permissions (JSON der Oberflaeche), null wenn es nichts gibt
export function prefs(name) {
  return prefsCache[name] ?? null;
}

// Lokal sofort, zum Server, wenn er erreichbar ist. Sonst beim naechsten Start mit Server:
// dann gilt fuer diesen Namen der Wert von hier.
export function savePrefs(name, value) {
  prefsCache[name] = value;
  storage(PREFS_KEY, JSON.stringify(prefsCache));
  if (state === 'off')
    return;
  unsentPrefs.add(name);
  saveRecord();
  if (state === 'connected')
    flushPrefs();
}

function flushPrefs() {
  prefsQueue = prefsQueue.then(async () => {
    for (const name of [...unsentPrefs]) {
      if (state !== 'connected')
        return;
      const value = prefsCache[name] ?? null;
      const sent = JSON.stringify(value);
      try {
        await write('prefs/' + name, 'PUT', { json: value });
      } catch (error) {
        if (error.reason)
          stop(error.reason);
        return; // sonst beim naechsten Abgleich nochmals
      }
      // Waehrend der Anfrage wieder geaendert: nochmals
      if (JSON.stringify(prefsCache[name] ?? null) === sent) {
        unsentPrefs.delete(name);
        saveRecord();
      }
    }
  });
  return prefsQueue;
}

// Fertig, wenn die prefs auf dem Server sind (hoechstens ms), vor einem Neuladen
export function prefsSaved(ms = 5000) {
  return Promise.race([prefsQueue, sleep(ms)]);
}

// ------------------------------------------------------------ Einstellungsseite

// { state, text, problem }: text beschreibt den Zustand
export function profileStatus() {
  return { state, text: STATE_TEXT[state], problem };
}

// GET /profile/info, null ohne Server
export async function profileInfo() {
  if (state === 'off')
    return null;
  try {
    const response = await request('info', { timeout: 10000 });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

// Website einer Datei des Profils ("https://example.com"), aus dem Ordner bzw. Namen
// <protokoll>_<host>_<port> von WebKit (Port 0 = Standard)
export function siteOfPath(path) {
  const parts = path.split('/');
  const id = parts[0] === 'localstorage' ? parts[1].replace(/\.localstorage$/, '') : parts[2] || '';
  const match = /^([a-z][a-z0-9+.-]*)_(.+)_(\d+)$/.exec(id);
  return match ? `${match[1]}://${match[2]}${match[3] === '0' ? '' : ':' + match[3]}` : id;
}

// Was nur auf diesem Geraet liegt: Datenbanken ueber der Grenze, Cache, Service Worker und
// die Dateien der Seiten (OPFS), dazu der HTTP-Cache der Engine (Cache API des Host)
export async function localStats() {
  const top = await navigator.storage.getDirectory();
  const limit = dbLimit();
  const databases = (await scan(top, Infinity)).filter((unit) => unit.key !== 'cookies.db' && unit.size > limit)
    .map((unit) => ({ path: unit.key, site: siteOfPath(unit.key), size: unit.size, kind: unit.key.startsWith('indexeddb/') ? 'IndexedDB' : 'localStorage' }));
  const size = async (name) => folderSize(await folder(top, [name]));
  const estimate = await navigator.storage.estimate?.().catch(() => null);
  return {
    databases,
    cacheStorage: await size('cachestorage'),
    serviceWorkers: await size('serviceworkers'),
    pageFiles: await size('opfs'),
    httpCache: estimate?.usageDetails?.caches ?? null,
  };
}

// Websitedaten loeschen (all = false: Cookies, Speicher, Berechtigungen) bzw. das ganze Profil
// zuruecksetzen (auch Einstellungen und Lesezeichen). Auf dem Server und hier: das OPFS wird
// beim naechsten Start geleert, danach laedt die Oberflaeche neu (settings.js). Nur der Tab
// mit dem Profil darf das, ein zweiter Tab wuerde dem ersten das OPFS leeren.
export async function resetProfile(all) {
  if (state !== 'connected' && state !== 'local')
    throw new Error(STATE_TEXT[state]);
  const connected = state === 'connected';
  state = 'off';
  clearTimeout(syncTimer);
  // Ein laufender Abgleich darf nach dem Zuruecksetzen nichts mehr hochladen
  await syncing;
  await prefsQueue;
  if (connected) {
    try {
      await write('reset', 'POST', { json: { all }, timeout: 10000 });
    } catch (error) {
      if (error.reason)
        stop(error.reason);
      else
        state = 'connected';
      scheduleSync(VISIBLE_INTERVAL);
      throw error;
    }
  }
  for (const name of all ? ['settings', 'bookmarks', 'permissions'] : ['permissions']) {
    delete prefsCache[name];
    unsentPrefs.delete(name);
  }
  storage(PREFS_KEY, JSON.stringify(prefsCache));
  record = { files: {} };
  saveRecord();
  storage(CLEAR_KEY, '1');
}
