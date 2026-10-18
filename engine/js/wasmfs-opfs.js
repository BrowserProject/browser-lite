// Replaces parts of the WasmFS OPFS backend at link time (--js-library,
// src/lib/libwasmfs_opfs.js of Emscripten).
addToLibrary({
  // /data is the namespace directory <OPFS root>/<BL_STORAGE_NAMESPACE>, not
  // the root itself. This runs on the OPFS worker of WasmFS, which does not see
  // the host's Module fields, so the name comes from the engine configuration.
  _wasmfs_opfs_init_root_directory__deps: ['$wasmfsOPFSDirectoryHandles', '$wasmfsOPFSProxyFinish', '$UTF8ToString', 'bl__storage_namespace'],
  // With pthreads the OPFS calls are proxied to their worker and never suspend
  _wasmfs_opfs_init_root_directory__async: false,
  _wasmfs_opfs_init_root_directory: async (ctx) => {
    // allocated.length starts at 1, 0 is a reserved handle
    if (wasmfsOPFSDirectoryHandles.allocated.length == 1) {
      /** @suppress {checkTypes} */
      var top = await navigator.storage.getDirectory();
      var root = await top.getDirectoryHandle(UTF8ToString(_bl__storage_namespace()), { create: true });
      wasmfsOPFSDirectoryHandles.allocated.push(root);
    }
    wasmfsOPFSProxyFinish(ctx);
  },

  // "No space" in the host's OPFS arrives as ENOSPC instead of EIO or EBADF.
  // The pages then get QuotaExceededError (engine/src/FileSystemStorageWasm.cpp).
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
    // Chromium returns an error of an in-memory OPFS (incognito, little free
    // RAM) as a count: base::File::Error unsigned, -8 is FILE_ERROR_NO_SPACE
    if (written > len)
      return (written | 0) == -8 ? -{{{ cDefs.ENOSPC }}} : -{{{ cDefs.EIO }}};
    return written;
  },
});
