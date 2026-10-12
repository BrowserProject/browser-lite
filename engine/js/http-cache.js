// HTTP-Cache der Engine (engine/src/HttpCache.cpp), Teil im Haupt-Thread.
//
// Die Eintraege liegen in der Cache API des Host-Browsers (auf der Platte,
// wird nur bei Bedarf gelesen). Die Liste der URLs halten wir im Speicher,
// so kostet eine Anfrage, die nicht im Cache ist, keinen Plattenzugriff.
var blHttpCache = {
  name: 'bl-http-v1',
  limit: 400 * 1024 * 1024,
  ready: null,
  cache: null,
  urls: null,
  stores: 0,

  open: function () {
    if (blHttpCache.ready)
      return blHttpCache.ready;
    if (typeof caches === 'undefined' || Module['blHttpCacheDisabled'])
      return blHttpCache.ready = Promise.resolve(null);
    blHttpCache.ready = caches.open(blHttpCache.name).then(function (cache) {
      return cache.keys().then(function (keys) {
        blHttpCache.cache = cache;
        blHttpCache.urls = new Set(keys.map(function (request) { return request.url; }));
        return cache;
      });
    }).catch(function () { return null; });
    return blHttpCache.ready;
  },

  lookup: function (id, url) {
    blHttpCache.open().then(function (cache) {
      if (!cache || !blHttpCache.urls.has(url))
        return blHttpCache.reply(id, 0, '', null);
      return cache.match(url, { ignoreVary: true }).then(function (response) {
        if (!response) {
          blHttpCache.urls.delete(url);
          return blHttpCache.reply(id, 0, '', null);
        }
        return response.arrayBuffer().then(function (buffer) {
          var headers = '';
          response.headers.forEach(function (value, name) { headers += name + ': ' + value + '\n'; });
          blHttpCache.reply(id, response.status, headers, new Uint8Array(buffer));
        });
      });
    }).catch(function () { blHttpCache.reply(id, 0, '', null); });
  },

  reply: function (id, status, headers, body) {
    var headerBytes = new TextEncoder().encode(headers);
    var headerPointer = Module['_malloc'](headerBytes.length + 1);
    HEAPU8.set(headerBytes, headerPointer);
    HEAPU8[headerPointer + headerBytes.length] = 0;
    var bodyPointer = 0;
    var bodyLength = body ? body.length : 0;
    if (bodyLength) {
      bodyPointer = Module['_malloc'](bodyLength);
      HEAPU8.set(body, bodyPointer);
    }
    Module['_bl_http_cache_result'](id, status, headerPointer, headerBytes.length, bodyPointer, bodyLength);
  },

  store: function (url, status, headerText, body) {
    blHttpCache.open().then(function (cache) {
      if (!cache)
        return;
      var headers = new Headers();
      headerText.split('\n').forEach(function (line) {
        var colon = line.indexOf(':');
        if (colon > 0)
          headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      });
      return cache.put(url, new Response(body, { status: status, headers: headers })).then(function () {
        blHttpCache.urls.add(url);
        if (++blHttpCache.stores % 50 === 0)
          blHttpCache.trim();
      });
    }).catch(function () { });
  },

  // Zu gross: die aeltesten Eintraege loeschen (Reihenfolge der Cache API =
  // Reihenfolge des Speicherns)
  trim: function () {
    if (!navigator.storage || !navigator.storage.estimate)
      return;
    navigator.storage.estimate().then(function (estimate) {
      if (estimate.usage < blHttpCache.limit)
        return;
      var cache = blHttpCache.cache;
      return cache.keys().then(function (keys) {
        var victims = keys.slice(0, Math.max(1, Math.floor(keys.length / 5)));
        return Promise.all(victims.map(function (request) {
          blHttpCache.urls.delete(request.url);
          return cache.delete(request);
        }));
      });
    }).catch(function () { });
  },
};
Module['blClearHttpCache'] = function () {
  blHttpCache.ready = null;
  return typeof caches === 'undefined' ? Promise.resolve() : caches.delete(blHttpCache.name);
};
