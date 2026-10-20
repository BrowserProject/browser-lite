// Caches of the engine in the Cache API of the host browser (http-cache.js,
// bytecode-cache.js), shared helpers.
//
// A family is a base name like "<namespace>-http" with every name
// "<base>-<suffix>" (format versions, build IDs). The namespace has no "-"
// (BL_STORAGE_NAMESPACE), so families of different namespaces never mix.
var blCacheStorage = {
  // Request URL of an entry, https://<host>/?<fields form encoded>: already in
  // the form cache.keys() gives back, so it can be compared with those
  entryURL: function (host, fields) {
    return 'https://' + host + '/?' + new URLSearchParams(fields);
  },

  inFamily: function (name, base) {
    return name === base || name.indexOf(base + '-') === 0;
  },

  // Deletes every cache of the family except keep (undefined: all of them)
  deleteFamily: function (base, keep) {
    if (typeof caches === 'undefined')
      return Promise.resolve();
    return caches.keys().then(function (names) {
      return Promise.all(names.filter(function (name) {
        return name !== keep && blCacheStorage.inFamily(name, base);
      }).map(function (name) { return caches.delete(name); }));
    });
  },
};
