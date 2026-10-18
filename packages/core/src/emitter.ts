import type { Unsubscribe } from './types.js';

type Listener<T> = (event: T) => void;

/** Small typed event emitter; a throwing listener does not stop the others. */
export class Emitter<Events> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(type: K, listener: Listener<Events[K]>): Unsubscribe {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as Listener<never>);
    return () => {
      set.delete(listener as Listener<never>);
    };
  }

  has(type: keyof Events): boolean {
    return (this.listeners.get(type)?.size ?? 0) > 0;
  }

  emit<K extends keyof Events>(type: K, event: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(event);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
