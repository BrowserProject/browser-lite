/**
 * Module worker that writes files of the origin private file system with a synchronous access
 * handle, for browsers without `createWritable` on the main thread (Safari 18). Message:
 * `{ id, path, data }` with `path` relative to the OPFS root; answer `{ id, error? }`.
 */

/** A write request of {@link writeFile} (opfs.ts). */
export interface WriteRequest {
  id: number;
  path: string[];
  data: ArrayBuffer | string;
}

interface SyncAccessHandle {
  truncate(size: number): void;
  write(data: ArrayBufferView | ArrayBuffer, options?: { at: number }): number;
  flush(): void;
  close(): void;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WriteRequest>) => void) | null;
  postMessage(message: { id: number; error?: string }): void;
};

async function write({ path, data }: WriteRequest): Promise<void> {
  let dir = await navigator.storage.getDirectory();
  for (const name of path.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create: true });
  const handle = (await dir.getFileHandle(path.at(-1) ?? '', { create: true })) as unknown as {
    createSyncAccessHandle(): Promise<SyncAccessHandle>;
  };
  const access = await handle.createSyncAccessHandle();
  try {
    access.truncate(0);
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    let at = 0;
    while (at < bytes.length) {
      const written = access.write(bytes.subarray(at), { at });
      if (!written) throw new Error('Disk full');
      at += written;
    }
    access.flush();
  } finally {
    access.close();
  }
}

scope.onmessage = (event) => {
  const { id } = event.data;
  write(event.data).then(
    () => scope.postMessage({ id }),
    (error: unknown) => scope.postMessage({ id, error: `${(error as Error)?.message ?? error}` }),
  );
};
