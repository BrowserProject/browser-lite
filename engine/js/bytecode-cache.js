// Bytecode cache of the engine (engine/src/BytecodeCache.cpp), the part on the main thread.
//
// One cache per engine build ("<namespace>-bytecode-<build id>"), caches of
// old builds of the same namespace are deleted when opening. The key of the
// engine is "<partition> <url>" (engine/src/BytecodeCache.cpp), the request URL
// of an entry https://bytecode.invalid/?k=<key> (form encoded). The list of keys
// is kept in memory, so a script without an entry costs no disk access.
//
// Entry: header of 24 bytes (magic "BLBC", format version, length of the
// bytecode, checksum of the engine; little endian, 32 and 64 bit) and the
// bytecode. The format lives here, the engine checks length and checksum.
var blBytecodeCache = {
  maxEntries: 400,
  magic: 0x43424c42,
  version: 1,
  headerSize: 24,
  ready: null,
  cache: null,
  urls: null,
  stores: 0,

  open: function (buildID) {
    if (blBytecodeCache.ready || typeof caches === 'undefined')
      return;
    var base = blBytecodeCache.base();
    var name = base + '-' + buildID;
    blBytecodeCache.ready = blCacheStorage.deleteFamily(base, name).then(function () {
      return caches.open(name);
    }).then(function (cache) {
      return cache.keys().then(function (keys) {
        blBytecodeCache.cache = cache;
        blBytecodeCache.urls = new Set(keys.map(function (request) { return request.url; }));
        return cache;
      });
    }).catch(function () { return null; });
  },

  // Family of the cache names of this namespace (cache-storage.js)
  base: function () {
    return blStorageNamespace() + '-bytecode';
  },

  // Request URL of the entry for a key of the engine
  url: function (key) {
    return blCacheStorage.entryURL('bytecode.invalid', { k: key });
  },

  // A new entry (not in shared memory, the bytecode may be a view on it): one copy
  entry: function (bytecode, checksum) {
    var size = blBytecodeCache.headerSize;
    var entry = new Uint8Array(size + bytecode.length);
    var view = new DataView(entry.buffer);
    view.setUint32(0, blBytecodeCache.magic, true);
    view.setUint32(4, blBytecodeCache.version, true);
    view.setBigUint64(8, BigInt(bytecode.length), true);
    view.setBigUint64(16, checksum, true);
    entry.set(bytecode, size);
    return entry;
  },

  // Header fields and bytecode of a stored entry, null if it is none of this format
  parse: function (buffer) {
    var size = blBytecodeCache.headerSize;
    if (buffer.byteLength < size)
      return null;
    var view = new DataView(buffer);
    if (view.getUint32(0, true) !== blBytecodeCache.magic || view.getUint32(4, true) !== blBytecodeCache.version)
      return null;
    return {
      length: view.getBigUint64(8, true),
      checksum: view.getBigUint64(16, true),
      bytecode: new Uint8Array(buffer, size),
    };
  },

  lookup: function (key) {
    var ready = blBytecodeCache.ready || Promise.resolve(null);
    ready.then(function (cache) {
      var url = blBytecodeCache.url(key);
      if (!cache || !blBytecodeCache.urls.has(url))
        return blBytecodeCache.reply(key, null);
      return cache.match(url).then(function (response) {
        if (!response) {
          blBytecodeCache.urls.delete(url);
          return blBytecodeCache.reply(key, null);
        }
        return response.arrayBuffer().then(function (buffer) {
          blBytecodeCache.reply(key, blBytecodeCache.parse(buffer));
        });
      });
    }).catch(function () { blBytecodeCache.reply(key, null); });
  },

  // Only the bytecode goes into engine memory (malloc, the engine takes it over)
  reply: function (key, entry) {
    var keyPointer = stringToNewUTF8(key);
    var pointer = 0;
    var size = entry ? entry.bytecode.length : 0;
    if (size) {
      pointer = Module['_malloc'](size);
      if (pointer)
        HEAPU8.set(entry.bytecode, pointer);
    }
    if (pointer)
      Module['_bl__bytecode_cache_result'](keyPointer, pointer, size, entry.length, entry.checksum);
    else
      Module['_bl__bytecode_cache_result'](keyPointer, 0, 0, BigInt(0), BigInt(0));
    Module['_free'](keyPointer);
  },

  // bytecode: view on the engine memory, valid only during this call
  store: function (key, bytecode, checksum) {
    var entry = blBytecodeCache.entry(bytecode, checksum);
    var ready = blBytecodeCache.ready || Promise.resolve(null);
    ready.then(function (cache) {
      if (!cache)
        return;
      var url = blBytecodeCache.url(key);
      return cache.put(url, new Response(entry)).then(function () {
        blBytecodeCache.urls.add(url);
        if (blBytecodeCache.urls.size > blBytecodeCache.maxEntries)
          blBytecodeCache.trim();
      });
    }).catch(function () { });
  },

  // Too many entries: delete the oldest (order of the Cache API = order of
  // storing, newly stored entries go to the end)
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
// Host: deletes the bytecode caches of this namespace (browser.storage.clearCaches)
Module['blClearBytecodeCache'] = function () {
  blBytecodeCache.ready = null;
  return blCacheStorage.deleteFamily(blBytecodeCache.base());
};
