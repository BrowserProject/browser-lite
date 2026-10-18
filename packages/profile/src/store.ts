/** Small persistent key value store of the profile client (localStorage). */
export interface KeyValueStore {
  read(name: string): string | null;
  /** null removes the entry. */
  write(name: string, value: string | null): void;
  readJSON<T>(name: string): T | null;
  writeJSON(name: string, value: unknown): void;
}

/**
 * localStorage entries named `<prefix>:<name>`. When storage is blocked (private mode,
 * settings), nothing is remembered and reads return null.
 */
export function createStore(prefix: string): KeyValueStore {
  const area = (): Storage | null => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };
  const store: KeyValueStore = {
    read(name) {
      try {
        return area()?.getItem(`${prefix}:${name}`) ?? null;
      } catch {
        return null;
      }
    },
    write(name, value) {
      try {
        if (value === null) area()?.removeItem(`${prefix}:${name}`);
        else area()?.setItem(`${prefix}:${name}`, value);
      } catch {}
    },
    readJSON<T>(name: string): T | null {
      try {
        return JSON.parse(store.read(name) ?? 'null') as T | null;
      } catch {
        return null;
      }
    },
    writeJSON(name, value) {
      store.write(name, JSON.stringify(value));
    },
  };
  return store;
}
