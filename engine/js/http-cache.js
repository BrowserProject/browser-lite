// HTTP cache of the engine (engine/src/HttpCache.cpp), the part on the main thread.
//
// The entries live in the Cache API of the host browser (on disk, only read
// when needed), in the cache "<namespace>-http-v<format>"; caches of other
// formats are deleted when opening (no migration). The namespace has no "-"
// (BL_STORAGE_NAMESPACE), so caches of different namespaces never mix. The
// request URL of an entry is https://http.invalid/?p=<partition>&u=<url> (form
// encoded; partition: top site, frame site, subframe document;
// HttpCache::partition). The list of keys is kept in memory, so a request that
// is not in the cache costs no disk access.
//
// A range of a resource (206) has the key of the resource plus
// &r=<first>-<last>/<total>&v=<version> (version: validator and Vary values,
// HttpCache.cpp). A range request is answered when the ranges of the newest
// version cover the whole resource; the answer is a 206 with the requested bytes
// and the headers of the newest range. Storing a range deletes the ranges of
// other versions and those inside it, storing a whole response all ranges of
// the resource. After a 304 only the headers change (update).
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
    blHttpCache.ready = blHttpCache.deleteCaches(blHttpCache.name).then(function () {
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

  // Every HTTP cache of this namespace is "<base>" or "<base>-<format>"
  base: function () {
    return blStorageNamespace() + '-http';
  },

  // Deletes every HTTP cache of this namespace except keep (undefined: all of them)
  deleteCaches: function (keep) {
    if (typeof caches === 'undefined')
      return Promise.resolve();
    var base = blHttpCache.base();
    return caches.keys().then(function (names) {
      return Promise.all(names.filter(function (name) {
        return name !== keep && (name === base || name.indexOf(base + '-') === 0);
      }).map(function (name) { return caches.delete(name); }));
    });
  },

  // Request URL of the entry of url in partition (with range: of that range of
  // the resource, {first, last, total, version}): already in the form
  // cache.keys() gives back, so it can be compared with those
  key: function (partition, url, range) {
    var fields = { p: partition, u: url };
    if (range) {
      fields.r = range.first + '-' + range.last + '/' + range.total;
      fields.v = range.version;
    }
    return 'https://http.invalid/?' + new URLSearchParams(fields);
  },

  // Stored ranges of the resource with this key, in the order of storing
  ranges: function (key) {
    var prefix = key + '&';
    var ranges = [];
    blHttpCache.urls.forEach(function (url) {
      if (url.indexOf(prefix) !== 0)
        return;
      var fields = new URL(url).searchParams;
      var match = /^(\d+)-(\d+)\/(\d+)$/.exec(fields.get('r') || '');
      if (match)
        ranges.push({ key: url, first: Number(match[1]), last: Number(match[2]), total: Number(match[3]), version: fields.get('v') });
    });
    return ranges;
  },

  // Ranges that together hold first to last, null if a byte is missing. Of the
  // ranges that start at the next missing byte or before it, the one reaching
  // furthest
  cover: function (ranges, first, last) {
    var sorted = ranges.slice().sort(function (a, b) { return a.first - b.first; });
    var chosen = [];
    var position = first;
    var i = 0;
    while (position <= last) {
      var best = null;
      for (; i < sorted.length && sorted[i].first <= position; i++) {
        if (!best || sorted[i].last > best.last)
          best = sorted[i];
      }
      if (!best || best.last < position)
        return null;
      chosen.push(best);
      position = best.last + 1;
    }
    return chosen;
  },

  headerText: function (response, skip) {
    var headers = '';
    response.headers.forEach(function (value, name) {
      if (name !== blHttpCache.sizeHeader && name !== skip)
        headers += name + ': ' + value + '\n';
    });
    return headers;
  },

  // start < 0: the whole resource, end < 0: up to its end
  lookup: function (id, partition, url, start, end) {
    var key = blHttpCache.key(partition, url);
    var miss = function () { blHttpCache.reply(id, 0, '', null); };
    blHttpCache.open().then(function (cache) {
      if (!cache)
        return miss();
      if (start >= 0)
        return blHttpCache.lookupRange(cache, id, key, start, end);
      if (!blHttpCache.urls.has(key))
        return miss();
      return cache.match(key, { ignoreVary: true }).then(function (response) {
        if (!response) {
          blHttpCache.urls.delete(key);
          return miss();
        }
        return response.arrayBuffer().then(function (buffer) {
          blHttpCache.reply(id, response.status, blHttpCache.headerText(response), new Uint8Array(buffer));
        });
      });
    }).catch(miss);
  },

  lookupRange: function (cache, id, key, start, end) {
    var miss = function () { blHttpCache.reply(id, 0, '', null); };
    var ranges = blHttpCache.ranges(key);
    if (!ranges.length)
      return miss();
    var newest = ranges[ranges.length - 1];
    ranges = ranges.filter(function (range) {
      return range.version === newest.version && range.total === newest.total;
    });
    var last = end < 0 ? newest.total - 1 : Math.min(end, newest.total - 1);
    if (start > last || !blHttpCache.cover(ranges, 0, newest.total - 1))
      return miss();
    var parts = blHttpCache.cover(ranges, start, last);
    return Promise.all([newest].concat(parts).map(function (range) {
      return cache.match(range.key, { ignoreVary: true });
    })).then(function (responses) {
      var gone = false;
      responses.forEach(function (response, i) {
        if (!response) {
          blHttpCache.urls.delete((i ? parts[i - 1] : newest).key);
          gone = true;
        }
      });
      if (gone)
        return miss();
      return Promise.all(responses.slice(1).map(function (response) { return response.arrayBuffer(); })).then(function (buffers) {
        var body = new Uint8Array(last - start + 1);
        for (var i = 0; i < parts.length; i++) {
          var bytes = new Uint8Array(buffers[i]);
          if (bytes.length !== parts[i].last - parts[i].first + 1)
            return miss();
          var from = Math.max(start, parts[i].first);
          var to = Math.min(last, parts[i].last);
          body.set(bytes.subarray(from - parts[i].first, to - parts[i].first + 1), from - start);
        }
        var headers = blHttpCache.headerText(responses[0], 'content-range') +
          'content-range: bytes ' + start + '-' + last + '/' + newest.total + '\n';
        blHttpCache.reply(id, 206, headers, body);
      });
    });
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

  // start < 0: a whole response, else a range of a resource of total bytes and this version
  // Headers of an entry from "name: value" lines and its size
  headers: function (headerText, size) {
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
    headers.set(blHttpCache.sizeHeader, String(size));
    return headers;
  },

  store: function (partition, url, status, headerText, body, start, total, version) {
    var range = start >= 0 ? { first: start, last: start + body.length - 1, total: total, version: version } : null;
    var key = blHttpCache.key(partition, url, range);
    blHttpCache.open().then(function (cache) {
      if (!cache)
        return;
      var headers = blHttpCache.headers(headerText, body.length);
      // The Cache API refuses 206: a range is stored as 200, its key says what it is
      var put = function () {
        return cache.put(key, new Response(body, { status: range ? 200 : status, headers: headers }));
      };
      var stored = function () {
        blHttpCache.urls.add(key);
        if (blHttpCache.total !== null)
          blHttpCache.total += body.length;
        blHttpCache.dropRanges(cache, partition, url, range);
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

  // After a 304: the entry (version: the newest range of that version) gets the
  // new headers, the body stays in the Cache API
  update: function (partition, url, headerText, version) {
    var key = blHttpCache.key(partition, url);
    blHttpCache.open().then(function (cache) {
      if (!cache)
        return;
      if (version) {
        var ranges = blHttpCache.ranges(key).filter(function (range) { return range.version === version; });
        if (!ranges.length)
          return;
        key = ranges[ranges.length - 1].key;
      }
      if (!blHttpCache.urls.has(key))
        return;
      return cache.match(key, { ignoreVary: true }).then(function (response) {
        if (!response)
          return;
        return response.blob().then(function (body) {
          return cache.put(key, new Response(body, { status: response.status, headers: blHttpCache.headers(headerText, body.size) }));
        });
      });
    }).catch(function () { });
  },

  // After storing range (null: the whole response) of a resource: deletes the
  // ranges it replaces (all for a whole response; other versions and those
  // inside it for a range)
  dropRanges: function (cache, partition, url, range) {
    var keep = blHttpCache.key(partition, url, range);
    blHttpCache.ranges(blHttpCache.key(partition, url)).forEach(function (old) {
      if (old.key === keep)
        return;
      if (range && old.version === range.version && (old.first < range.first || old.last > range.last))
        return;
      blHttpCache.urls.delete(old.key);
      if (blHttpCache.total !== null)
        blHttpCache.total -= old.last - old.first + 1;
      cache.delete(old.key).catch(function () { });
    });
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
  return blHttpCache.deleteCaches();
};
