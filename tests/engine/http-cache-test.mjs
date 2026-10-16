// Aufraeumen des HTTP-Cache (engine/js/http-cache.js) ohne Engine: in node
// geladen, die Cache API ist eine Attrappe mit derselben Reihenfolge wie im
// Browser (Speichern haengt hinten an, Ersetzen auch).
//   node tests/engine/http-cache-test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let failed = 0;
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`);
  if (!ok)
    failed++;
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeCache {
  constructor() {
    this.entries = new Map();
    this.onMatch = null;
    this.fail = false;
  }
  async keys() {
    if (this.fail)
      throw new Error('kaputt');
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async match(request) {
    const url = typeof request === 'string' ? request : request.url;
    if (this.onMatch)
      await this.onMatch(url);
    return this.entries.get(url);
  }
  async put(url, response) {
    this.entries.delete(url);
    this.entries.set(url, response);
  }
  async delete(request) {
    return this.entries.delete(request.url);
  }
}

function load() {
  const cache = new FakeCache();
  const context = {
    Module: {},
    caches: { open: async () => cache, delete: async () => true },
    navigator: {},
    Headers,
    Response,
    TextEncoder,
    Promise,
    Number,
    String,
    Set,
    Math,
  };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../../engine/js/http-cache.js', import.meta.url), 'utf8'), context);
  const http = vm.runInContext('blHttpCache', context);
  return { http, cache };
}

const entry = (size) => new Response(null, { headers: { 'x-bl-size': String(size) } });

async function fill(http, cache, count, size) {
  await http.open();
  for (let i = 0; i < count; i++)
    await cache.put(`https://example.test/${i}`, entry(size));
}

// Ueber der Grenze: die aeltesten fallen weg, bis 80 % belegt sind
{
  const { http, cache } = load();
  await fill(http, cache, 10, 100);
  http.limit = 900;
  await http.trim(false);
  const left = [...cache.entries.keys()].map((url) => url.split('/').pop());
  check('Aelteste Eintraege geloescht', left.join(',') === '3,4,5,6,7,8,9', left.join(','));
  check('Belegung danach gezaehlt', http.total === 700, String(http.total));
}

// Quote voll (force): auch unter der Grenze auf 80 % des Belegten
{
  const { http, cache } = load();
  await fill(http, cache, 10, 100);
  http.limit = 5000;
  await http.trim(true);
  check('Quote voll: auf 80 % geraeumt', cache.entries.size === 8 && http.total === 800, `${cache.entries.size} Eintraege, ${http.total}`);
  await http.trim(false);
  check('Unter der Grenze: nichts geloescht', cache.entries.size === 8, String(cache.entries.size));
}

// Ein put waehrend des Zaehlens ersetzt einen Eintrag (wandert ans Ende):
// die Groessen gehoeren trotzdem zu den richtigen Schluesseln
{
  const { http, cache } = load();
  await http.open();
  await cache.put('https://example.test/big', entry(1000));
  for (let i = 0; i < 4; i++)
    await cache.put(`https://example.test/${i}`, entry(10));
  http.limit = 900;
  let replaced = false;
  cache.onMatch = async () => {
    if (!replaced) {
      replaced = true;
      await cache.put('https://example.test/0', entry(10));
    }
    await tick();
  };
  await http.trim(false);
  const left = [...cache.entries.keys()].map((url) => url.split('/').pop());
  check('Grosser alter Eintrag geloescht, kleine bleiben', !left.includes('big') && left.length === 4, left.join(','));
}

// Zaehlen schlaegt fehl: nicht bei jedem Speichern wieder alles zaehlen
{
  const { http, cache } = load();
  await http.open();
  cache.fail = true;
  await http.trim(false);
  check('Nach Fehler bekannte Belegung', http.total === 0, String(http.total));
  check('Nach Fehler kein Aufraeumen mehr offen', http.trimming === null);
}

if (failed) {
  console.log(`${failed} Pruefungen fehlgeschlagen`);
  process.exit(1);
}
console.log('alle Pruefungen ok');
