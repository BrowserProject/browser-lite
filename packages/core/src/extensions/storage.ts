import type { ExtensionStorage, ExtensionStore } from './types.js';

/** The default {@link ExtensionStore}: data in memory for the life of the page. */
export class MemoryExtensionStore implements ExtensionStore {
  private readonly data = new Map<string, Record<string, unknown>>();

  load(id: string): Record<string, unknown> | null {
    return this.data.get(id) ?? null;
  }

  save(id: string, data: Record<string, unknown>): void {
    this.data.set(id, data);
  }
}

/** Storage of one extension: its own record of the store, values copied as JSON. */
export class ScopedStorage implements ExtensionStorage {
  constructor(
    private readonly id: string,
    private readonly store: ExtensionStore,
    private data: Record<string, unknown>,
  ) {}

  get<T = unknown>(key: string): T | undefined {
    const value = this.data[key];
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as T);
  }

  set(key: string, value: unknown): void {
    // A copy as JSON: later changes of the caller's object do not reach the store
    const json = value === undefined ? undefined : JSON.stringify(value);
    const next = { ...this.data };
    if (json === undefined) delete next[key];
    else next[key] = JSON.parse(json);
    this.data = next;
    this.save();
  }

  delete(key: string): void {
    this.set(key, undefined);
  }

  keys(): string[] {
    return Object.keys(this.data);
  }

  private save(): void {
    try {
      Promise.resolve(this.store.save(this.id, this.data)).catch((error: unknown) =>
        console.warn(`[browser-lite] extension ${this.id}: saving its data failed:`, error),
      );
    } catch (error) {
      console.warn(`[browser-lite] extension ${this.id}: saving its data failed:`, error);
    }
  }
}
