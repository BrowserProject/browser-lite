// Ersetzt beim Linken (--js-library) das Schreiben des OPFS-Backends von
// WasmFS (src/lib/libwasmfs_opfs.js von Emscripten), damit "kein Platz" im
// OPFS des Host als ENOSPC ankommt statt als EIO oder EBADF. Die Seiten
// bekommen dann QuotaExceededError (engine/src/FileSystemStorageWasm.cpp).
addToLibrary({
  _wasmfs_opfs_write_access__i53abi: true,
  _wasmfs_opfs_write_access__deps: ['$wasmfsOPFSAccessHandles'],
  _wasmfs_opfs_write_access: (accessID, bufPtr, len, pos) => {
    var data = HEAPU8.subarray(bufPtr, bufPtr + len);
    var written;
    try {
      written = wasmfsOPFSAccessHandles.get(accessID).write(data, { at: pos });
    } catch (e) {
      if (e.name == 'QuotaExceededError')
        return -{{{ cDefs.ENOSPC }}};
      return e.name == 'TypeError' ? -{{{ cDefs.EINVAL }}} : -{{{ cDefs.EIO }}};
    }
    // Chromium gibt einen Fehler des OPFS im Speicher (inkognito, bei wenig
    // freiem RAM) als Anzahl zurueck: base::File::Error vorzeichenlos, -8 ist
    // FILE_ERROR_NO_SPACE
    if (written > len)
      return (written | 0) == -8 ? -{{{ cDefs.ENOSPC }}} : -{{{ cDefs.EIO }}};
    return written;
  },
});
