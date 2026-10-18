import { base64ToBytes, bytesToBase64, domError } from '../../util.js';
import type { ServiceContext } from '../service.js';

const MAX_FILE = 256 * 1024 * 1024;

interface FsPayload {
  id?: string;
  other?: string;
  name?: string;
  kind?: string;
  create?: boolean;
  recursive?: boolean;
  keepExistingData?: boolean;
  op?: string;
  data?: string;
  position?: number | null;
  size?: number;
  mode?: string;
  request?: boolean;
  [option: string]: unknown;
}

type Handle = FileSystemHandle & {
  queryPermission?: (descriptor: { mode: string }) => Promise<string>;
  requestPermission?: (descriptor: { mode: string }) => Promise<string>;
};

type Picker = (options: Record<string, unknown>) => Promise<Handle | Handle[]>;

/**
 * File System Access of the pages: the host handles stay here, the page only gets a random id
 * that is valid for the origin that got it. Freed when the view closes (navigation keeps them,
 * the document may live on in the back/forward cache).
 */
export function installFileSystemAccess(ctx: ServiceContext): void {
  const handles = new Map<string, { handle: Handle; origin: string; view: number }>();
  const writables = new Map<
    string,
    { writable: FileSystemWritableFileStream; origin: string; view: number }
  >();

  const info = (handle: Handle, origin: string, view: number) => {
    const id = crypto.randomUUID();
    handles.set(id, { handle, origin, view });
    return { id, name: handle.name, kind: handle.kind };
  };

  const handleOf = (id: string | undefined, origin: string, kind?: string) => {
    const entry = id ? handles.get(id) : undefined;
    if (!entry || entry.origin !== origin || (kind && entry.handle.kind !== kind))
      throw domError('NotFoundError', 'Handle not found');
    return entry.handle;
  };

  const pickerOptions = (payload: FsPayload | null) => {
    const options: Record<string, unknown> = {};
    for (const key of [
      'types',
      'excludeAcceptAllOption',
      'multiple',
      'suggestedName',
      'id',
      'startIn',
      'mode',
    ]) {
      const value = payload?.[key];
      if (value !== undefined && value !== null) options[key] = value;
    }
    return options;
  };

  const picker = (name: string): Picker => {
    const fn = (globalThis as unknown as Record<string, Picker | undefined>)[name];
    if (typeof fn !== 'function') throw domError('NotSupportedError', `${name} not supported`);
    return fn.bind(globalThis);
  };

  const viewId = (view: { id: number } | undefined) => view?.id ?? 0;

  ctx.hostCall<FsPayload | null>('fs-open', async (payload, origin, view) => {
    const list = (await picker('showOpenFilePicker')(pickerOptions(payload))) as Handle[];
    return list.map((handle) => info(handle, origin, viewId(view)));
  });
  ctx.hostCall<FsPayload | null>('fs-save', async (payload, origin, view) =>
    info(
      (await picker('showSaveFilePicker')(pickerOptions(payload))) as Handle,
      origin,
      viewId(view),
    ),
  );
  ctx.hostCall<FsPayload | null>('fs-directory', async (payload, origin, view) =>
    info(
      (await picker('showDirectoryPicker')(pickerOptions(payload))) as Handle,
      origin,
      viewId(view),
    ),
  );
  ctx.hostCall<FsPayload | null>('fs-file', async (payload, origin) => {
    const file = await (handleOf(payload?.id, origin, 'file') as FileSystemFileHandle).getFile();
    if (file.size > MAX_FILE) throw domError('NotReadableError', 'File too large');
    return {
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    };
  });
  ctx.hostCall<FsPayload | null>('fs-writable', async (payload, origin, view) => {
    const writable = await (
      handleOf(payload?.id, origin, 'file') as FileSystemFileHandle
    ).createWritable({
      keepExistingData: !!payload?.keepExistingData,
    });
    const id = crypto.randomUUID();
    writables.set(id, { writable, origin, view: viewId(view) });
    return { id };
  });
  ctx.hostCall<FsPayload | null>('fs-write', async (payload, origin) => {
    const entry = payload?.id ? writables.get(payload.id) : undefined;
    if (!entry || entry.origin !== origin || !payload?.id)
      throw domError('InvalidStateError', 'Stream is closed');
    const { writable } = entry;
    switch (payload.op) {
      case 'write': {
        const data = base64ToBytes(payload.data || '');
        await writable.write(
          payload.position == null ? data : { type: 'write', position: payload.position, data },
        );
        return null;
      }
      case 'seek':
        await writable.seek(payload.position ?? 0);
        return null;
      case 'truncate':
        await writable.truncate(payload.size ?? 0);
        return null;
      case 'close':
        writables.delete(payload.id);
        await writable.close();
        return null;
      default:
        writables.delete(payload.id);
        await writable.abort();
        return null;
    }
  });
  ctx.hostCall<FsPayload | null>('fs-child', async (payload, origin, view) => {
    const directory = handleOf(payload?.id, origin, 'directory') as FileSystemDirectoryHandle;
    const options = { create: !!payload?.create };
    const name = String(payload?.name);
    const handle =
      payload?.kind === 'directory'
        ? await directory.getDirectoryHandle(name, options)
        : await directory.getFileHandle(name, options);
    return info(handle, origin, viewId(view));
  });
  ctx.hostCall<FsPayload | null>('fs-list', async (payload, origin, view) => {
    const directory = handleOf(payload?.id, origin, 'directory') as FileSystemDirectoryHandle & {
      values(): AsyncIterable<Handle>;
    };
    const list = [];
    for await (const handle of directory.values()) list.push(info(handle, origin, viewId(view)));
    return list;
  });
  ctx.hostCall<FsPayload | null>('fs-remove', async (payload, origin) => {
    await (handleOf(payload?.id, origin, 'directory') as FileSystemDirectoryHandle).removeEntry(
      String(payload?.name),
      { recursive: !!payload?.recursive },
    );
    return null;
  });
  ctx.hostCall<FsPayload | null>('fs-resolve', async (payload, origin) => {
    const other = payload?.other ? handleOf(payload.other, origin) : null;
    return other
      ? (handleOf(payload?.id, origin, 'directory') as FileSystemDirectoryHandle).resolve(other)
      : null;
  });
  ctx.hostCall<FsPayload | null>('fs-same', async (payload, origin) => {
    const other = payload?.other ? handleOf(payload.other, origin) : null;
    return other ? handleOf(payload?.id, origin).isSameEntry(other) : false;
  });
  ctx.hostCall<FsPayload | null>('fs-permission', async (payload, origin) => {
    const handle = handleOf(payload?.id, origin);
    const descriptor = { mode: payload?.mode === 'readwrite' ? 'readwrite' : 'read' };
    const method = payload?.request ? handle.requestPermission : handle.queryPermission;
    return typeof method === 'function' ? method.call(handle, descriptor) : 'granted';
  });

  ctx.onView((view, signal) =>
    signal.addEventListener('abort', () => {
      for (const [id, entry] of writables) {
        if (entry.view === view.id) {
          writables.delete(id);
          entry.writable.abort().catch(() => {});
        }
      }
      for (const [id, entry] of handles) if (entry.view === view.id) handles.delete(id);
    }),
  );
  ctx.signal.addEventListener('abort', () => {
    for (const entry of writables.values()) entry.writable.abort().catch(() => {});
    writables.clear();
    handles.clear();
  });
}
