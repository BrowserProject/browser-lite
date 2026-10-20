// HTTP cache of the engine (engine/src/HttpCache.cpp), the part on the main thread.
//
// The entries live in the Cache API of the host browser (on disk, only read
// when needed), in the cache "<namespace>-http-v<format>"; caches of other
// formats are deleted when opening (no migration). The request URL of an entry
// is https://http.invalid/?p=<partition>&u=<url> (form encoded; partition: top
// site, frame site, subframe document; HttpCache::partition). The list of keys
// is kept in memory, so a request that is not in the cache costs no disk access.
//
// Limit: 400 MB, at most a quarter of the host's quota. Only the own content
// counts (header x-bl-size), not what else is in the OPFS or in the host's
// Cache API. Above it, or when the quota is full, the oldest entries go away
// until 80 % are used.
var blHttpCache = {
  // Version of the entry format, part of the cache name
  format: 2,
  name: null,
  sizeHeader: 'x-bl-size',
  limit: 400 * 1024 * 1024,
  ready: null,
  cache: null,
  urls: null,
  // Used bytes, null until the first cleanup (counted once then)
  total: null,
  trimming: null,
  // A cleanup asked for while one counts runs again right after it: stores in between are
  // not in its count ('force' or 'limit', false when none is pending)
  again: false,

  open: function () {
    if (blHttpCache.ready)
      return blHttpCache.ready;
    if (typeof caches === 'undefined')
      return blHttpCache.ready = Promise.resolve(null);
    var base = blHttpCache.base();
    blHttpCache.name = base + '-v' + blHttpCache.format;
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (estimate) {
        if (estimate.quota)
          blHttpCache.limit = Math.min(blHttpCache.limit, estimate.quota / 4);
      }).catch(function () { });
    }
    blHttpCache.ready = blCacheStorage.deleteFamily(base, blHttpCache.name).then(function () {
      return caches.open(blHttpCache.name);
    }).then(function (cache) {
      return cache.keys().then(function (keys) {
        blHttpCache.cache = cache;
        blHttpCache.urls = new Set(keys.map(function (request) { return request.url; }));
        blHttpCache.total = null;
        return cache;
      });
    }).catch(function () { return null; });
    return blHttpCache.ready;
  },

  // Family of the cache names of this namespace (cache-storage.js)
  base: function () {
    return blStorageNamespace() + '-http';
  },

  // Request URL of the entry of url in partition
  key: function (partition, url) {
    return blCacheStorage.entryURL('http.invalid', { p: partition, u: url });
  },

  lookup: function (id, partition, url) {
    var key = blHttpCache.key(partition, url);
    blHttpCache.open().then(function (cache) {
      if (!cache || !blHttpCache.urls.has(key))
        return blHttpCache.reply(id, 0, '', null);
      return cache.match(key, { ignoreVary: true }).then(function (response) {
        if (!response) {
          blHttpCache.urls.delete(key);
          return blHttpCache.reply(id, 0, '', null);
        }
        return response.arrayBuffer().then(function (buffer) {
          var headers = '';
          response.headers.forEach(function (value, name) {
            if (name !== blHttpCache.sizeHeader)
              headers += name + ': ' + value + '\n';
          });
          blHttpCache.reply(id, response.status, headers, new Uint8Array(buffer));
        });
      });
    }).catch(function () { blHttpCache.reply(id, 0, '', null); });
  },

  // Without memory in the engine it becomes a miss (status 0)
  reply: function (id, status, headers, body) {
    var headerBytes = new TextEncoder().encode(headers);
    var bodyLength = body ? body.length : 0;
    var headerPointer = Module['_malloc'](headerBytes.length + 1);
    var bodyPointer = bodyLength ? Module['_malloc'](bodyLength) : 0;
    if (!headerPointer || (bodyLength && !bodyPointer)) {
      Module['_free'](headerPointer);
      Module['_free'](bodyPointer);
      Module['_bl__http_cache_result'](id, 0, 0, 0, 0, 0);
      return;
    }
    HEAPU8.set(headerBytes, headerPointer);
    HEAPU8[headerPointer + headerBytes.length] = 0;
    if (bodyLength)
      HEAPU8.set(body, bodyPointer);
    Module['_bl__http_cache_result'](id, status, headerPointer, headerBytes.length, bodyPointer, bodyLength);
  },

  store: function (partition, url, status, headerText, body) {
    var key = blHttpCache.key(partition, url);
    blHttpCache.open().then(function (cache) {
      if (!cache)
        return;
      var headers = new Headers();
      headerText.split('\n').forEach(function (line) {
        var colon = line.indexOf(':');
        if (colon <= 0)
          return;
        // Headers cannot hold values outside of Latin-1, only this field is missing then
        try {
          headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
        } catch (e) { }
      });
      headers.set(blHttpCache.sizeHeader, String(body.length));
      var put = function () {
        return cache.put(key, new Response(body, { status: status, headers: headers }));
      };
      var stored = function () {
        blHttpCache.urls.add(key);
        if (blHttpCache.total !== null)
          blHttpCache.total += body.length;
        if (blHttpCache.total === null || blHttpCache.total > blHttpCache.limit)
          blHttpCache.trim(false);
      };
      return put().then(stored, function (error) {
        if (!error || error.name !== 'QuotaExceededError')
          return;
        return blHttpCache.trim(true).then(put).then(stored);
      });
    }).catch(function () { });
  },

  // Deletes the oldest entries (order of the Cache API = order of storing).
  // force: the quota is full, clean up even below the limit. The size is read
  // per key, so a put in between does not shift the two lists against each
  // other.
  trim: function (force) {
    if (blHttpCache.trimming) {
      if (force || !blHttpCache.again)
        blHttpCache.again = force ? 'force' : 'limit';
      return blHttpCache.trimming;
    }
    var cache = blHttpCache.cache;
    var sizeOf = function (request) {
      return cache.match(request, { ignoreVary: true }).then(function (response) {
        return response ? Number(response.headers.get(blHttpCache.sizeHeader)) || 0 : 0;
      });
    };
    blHttpCache.trimming = cache.keys().then(function (keys) {
      return Promise.all(keys.map(sizeOf)).then(function (sizes) {
        var total = sizes.reduce(function (sum, size) { return sum + size; }, 0);
        var target = force || total > blHttpCache.limit ? 0.8 * Math.min(total, blHttpCache.limit) : total;
        var victims = [];
        for (var i = 0; i < keys.length && total > target; i++) {
          total -= sizes[i];
          victims.push(keys[i]);
        }
        blHttpCache.total = total;
        return Promise.all(victims.map(function (request) {
          blHttpCache.urls.delete(request.url);
          return cache.delete(request);
        }));
      });
    }).catch(function () {
      // Do not count again on every store; if the quota is full, store cleans
      // up anyway (force)
      if (blHttpCache.total === null)
        blHttpCache.total = 0;
    }).then(function () {
      blHttpCache.trimming = null;
      var again = blHttpCache.again;
      blHttpCache.again = false;
      if (again)
        return blHttpCache.trim(again === 'force');
    });
    return blHttpCache.trimming;
  },
};
// Host: deletes the HTTP caches of this namespace, all formats (browser.storage.clearCaches)
Module['blClearHttpCache'] = function () {
  blHttpCache.ready = null;
  return blCacheStorage.deleteFamily(blHttpCache.base());
};
