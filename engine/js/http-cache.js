// HTTP-Cache der Engine (engine/src/HttpCache.cpp), Teil im Haupt-Thread.
//
// Die Eintraege liegen in der Cache API des Host-Browsers (auf der Platte,
// wird nur bei Bedarf gelesen). Die Liste der URLs halten wir im Speicher,
// so kostet eine Anfrage, die nicht im Cache ist, keinen Plattenzugriff.
//
// Grenze: 400 MB, hoechstens ein Viertel der Quote des Host. Gezaehlt wird
// nur der eigene Inhalt (Header x-bl-size), nicht was sonst im OPFS oder in
// der Cache API des Host liegt. Darueber, oder wenn die Quote voll ist, fallen
// die aeltesten Eintraege weg, bis noch 80 % belegt sind.
var blHttpCache = {
  name: 'bl-http-v2',
  sizeHeader: 'x-bl-size',
  limit: 400 * 1024 * 1024,
  ready: null,
  cache: null,
  urls: null,
  // Belegte Bytes, null bis zum ersten Aufraeumen (dann einmal gezaehlt)
  total: null,
  trimming: null,

  open: function () {
    if (blHttpCache.ready)
      return blHttpCache.ready;
    if (typeof caches === 'undefined' || Module['blHttpCacheDisabled'])
      return blHttpCache.ready = Promise.resolve(null);
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (estimate) {
        if (estimate.quota)
          blHttpCache.limit = Math.min(blHttpCache.limit, estimate.quota / 4);
      }).catch(function () { });
    }
    blHttpCache.ready = caches.open(blHttpCache.name).then(function (cache) {
      return cache.keys().then(function (keys) {
        blHttpCache.cache = cache;
        blHttpCache.urls = new Set(keys.map(function (request) { return request.url; }));
        blHttpCache.total = null;
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
          response.headers.forEach(function (value, name) {
            if (name !== blHttpCache.sizeHeader)
              headers += name + ': ' + value + '\n';
          });
          blHttpCache.reply(id, response.status, headers, new Uint8Array(buffer));
        });
      });
    }).catch(function () { blHttpCache.reply(id, 0, '', null); });
  },

  // Ohne Speicher in der Engine wird es ein Fehlschlag (status 0)
  reply: function (id, status, headers, body) {
    var headerBytes = new TextEncoder().encode(headers);
    var bodyLength = body ? body.length : 0;
    var headerPointer = Module['_malloc'](headerBytes.length + 1);
    var bodyPointer = bodyLength ? Module['_malloc'](bodyLength) : 0;
    if (!headerPointer || (bodyLength && !bodyPointer)) {
      Module['_free'](headerPointer);
      Module['_free'](bodyPointer);
      Module['_bl_http_cache_result'](id, 0, 0, 0, 0, 0);
      return;
    }
    HEAPU8.set(headerBytes, headerPointer);
    HEAPU8[headerPointer + headerBytes.length] = 0;
    if (bodyLength)
      HEAPU8.set(body, bodyPointer);
    Module['_bl_http_cache_result'](id, status, headerPointer, headerBytes.length, bodyPointer, bodyLength);
  },

  store: function (url, status, headerText, body) {
    blHttpCache.open().then(function (cache) {
      if (!cache)
        return;
      var headers = new Headers();
      headerText.split('\n').forEach(function (line) {
        var colon = line.indexOf(':');
        if (colon <= 0)
          return;
        // Werte ausserhalb von Latin-1 kann Headers nicht, nur dieses Feld fehlt dann
        try {
          headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
        } catch (e) { }
      });
      headers.set(blHttpCache.sizeHeader, String(body.length));
      var put = function () {
        return cache.put(url, new Response(body, { status: status, headers: headers }));
      };
      var stored = function () {
        blHttpCache.urls.add(url);
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

  // Die aeltesten Eintraege loeschen (Reihenfolge der Cache API = Reihenfolge
  // des Speicherns). force: die Quote ist voll, auch unter der Grenze
  // aufraeumen. Die Groesse kommt je Schluessel, damit ein put dazwischen die
  // beiden Listen nicht gegeneinander verschiebt.
  trim: function (force) {
    if (blHttpCache.trimming)
      return blHttpCache.trimming;
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
      // Nicht bei jedem Speichern neu zaehlen; ist die Quote voll, raeumt
      // store trotzdem auf (force)
      if (blHttpCache.total === null)
        blHttpCache.total = 0;
    }).then(function () {
      blHttpCache.trimming = null;
    });
    return blHttpCache.trimming;
  },
};
Module['blClearHttpCache'] = function () {
  blHttpCache.ready = null;
  return typeof caches === 'undefined' ? Promise.resolve() : caches.delete(blHttpCache.name);
};
