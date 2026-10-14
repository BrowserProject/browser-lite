// Bytecode-Cache der Engine (engine/src/BytecodeCache.cpp), Teil im Haupt-Thread.
//
// Ein Cache pro Engine-Build (Name mit Build-ID), Caches alter Builds werden
// beim Oeffnen geloescht. Die Liste der URLs halten wir im Speicher, so kostet
// ein Skript ohne Eintrag keinen Plattenzugriff.
var blBytecodeCache = {
  prefix: 'bl-bytecode-',
  maxEntries: 400,
  ready: null,
  cache: null,
  urls: null,
  stores: 0,

  open: function (buildID) {
    if (blBytecodeCache.ready || typeof caches === 'undefined')
      return;
    var name = blBytecodeCache.prefix + buildID;
    blBytecodeCache.ready = caches.keys().then(function (names) {
      return Promise.all(names.filter(function (other) {
        return other.indexOf(blBytecodeCache.prefix) === 0 && other !== name;
      }).map(function (other) { return caches.delete(other); }));
    }).then(function () {
      return caches.open(name);
    }).then(function (cache) {
      return cache.keys().then(function (keys) {
        blBytecodeCache.cache = cache;
        blBytecodeCache.urls = new Set(keys.map(function (request) { return request.url; }));
        return cache;
      });
    }).catch(function () { return null; });
  },

  key: function (url) {
    return 'https://bytecode.invalid/?' + encodeURIComponent(url);
  },

  lookup: function (url) {
    var ready = blBytecodeCache.ready || Promise.resolve(null);
    ready.then(function (cache) {
      var key = blBytecodeCache.key(url);
      if (!cache || !blBytecodeCache.urls.has(key))
        return blBytecodeCache.reply(url, null);
      return cache.match(key).then(function (response) {
        if (!response) {
          blBytecodeCache.urls.delete(key);
          return blBytecodeCache.reply(url, null);
        }
        return response.arrayBuffer().then(function (buffer) {
          blBytecodeCache.reply(url, new Uint8Array(buffer));
        });
      });
    }).catch(function () { blBytecodeCache.reply(url, null); });
  },

  reply: function (url, data) {
    var urlPointer = stringToNewUTF8(url);
    var dataPointer = 0;
    var length = data ? data.length : 0;
    if (length) {
      dataPointer = Module['_malloc'](length);
      if (dataPointer)
        HEAPU8.set(data, dataPointer);
      else
        length = 0;
    }
    Module['_bl_bytecode_cache_result'](urlPointer, dataPointer, length);
    Module['_free'](urlPointer);
  },

  store: function (url, data) {
    var ready = blBytecodeCache.ready || Promise.resolve(null);
    ready.then(function (cache) {
      if (!cache)
        return;
      var key = blBytecodeCache.key(url);
      return cache.put(key, new Response(data)).then(function () {
        blBytecodeCache.urls.add(key);
        if (blBytecodeCache.urls.size > blBytecodeCache.maxEntries)
          blBytecodeCache.trim();
      });
    }).catch(function () { });
  },

  // Zu viele Eintraege: die aeltesten loeschen (Reihenfolge der Cache API =
  // Reihenfolge des Speicherns, neu gespeicherte Eintraege kommen ans Ende)
  trim: function () {
    var cache = blBytecodeCache.cache;
    cache.keys().then(function (keys) {
      var victims = keys.slice(0, Math.max(1, Math.floor(keys.length / 4)));
      return Promise.all(victims.map(function (request) {
        blBytecodeCache.urls.delete(request.url);
        return cache.delete(request);
      }));
    }).catch(function () { });
  },
};
Module['blClearBytecodeCache'] = function () {
  blBytecodeCache.ready = null;
  if (typeof caches === 'undefined')
    return Promise.resolve();
  return caches.keys().then(function (names) {
    return Promise.all(names.filter(function (name) {
      return name.indexOf(blBytecodeCache.prefix) === 0;
    }).map(function (name) { return caches.delete(name); }));
  });
};
