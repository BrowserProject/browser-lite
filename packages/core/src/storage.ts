import { checkNamespace } from './config.js';
import { BrowserLiteError } from './errors.js';

const LOCK_TIMEOUT = 3000;

const lockName = (namespace: string) => `${namespace}-data`;

/**
 * Holds the Web Lock of a namespace: only one browser per namespace may write its OPFS
 * directory (all tabs of the origin). Resolves with a release function, or null when another
 * tab holds it (after a page reload the old page releases it only shortly after).
 */
export function holdStorageLock(namespace: string): Promise<(() => void) | null> {
  if (!navigator.locks) return Promise.resolve(() => {});
  return new Promise((resolve) => {
    let release: () => void = () => {};
    const held = new Promise<void>((done) => {
      release = done;
    });
    navigator.locks
      .request(lockName(namespace), { signal: AbortSignal.timeout(LOCK_TIMEOUT) }, () => {
        resolve(release);
        return held;
      })
      .catch(() => resolve(null));
  });
}

/** OPFS directory of the namespace, null without OPFS. */
export async function namespaceDirectory(
  namespace: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    return root ? await root.getDirectoryHandle(namespace, { create: true }) : null;
  } catch {
    return null;
  }
}

/**
 * Deletes everything a browser stored under the namespace: its OPFS directory and its caches.
 * Throws BrowserLiteError('storage-locked') while a browser of this origin uses it.
 */
export async function clearStorage(namespace?: string): Promise<void> {
  const name = checkNamespace(namespace);
  const clear = async () => {
    const root = await navigator.storage?.getDirectory?.().catch(() => null);
    await root?.removeEntry(name, { recursive: true }).catch((error: DOMException) => {
      if (error?.name !== 'NotFoundError') throw error;
    });
    if (typeof caches !== 'undefined')
      for (const key of await caches.keys())
        if (key.startsWith(`${name}-`)) await caches.delete(key);
  };
  if (!navigator.locks) return clear();
  await navigator.locks.request(lockName(name), { ifAvailable: true }, async (lock) => {
    if (!lock) throw new BrowserLiteError('storage-locked', `Storage ${name} is in use`);
    await clear();
  });
}
