import type { PermissionStore } from './types.js';

type Decision = 'grant' | 'deny';

/** Default PermissionStore: decisions live as long as the page. */
export class MemoryPermissionStore implements PermissionStore {
  private readonly decisions = new Map<string, [string, string, Decision]>();

  get(origin: string, kind: string): Decision | undefined {
    return this.decisions.get(`${kind} ${origin}`)?.[2];
  }

  set(origin: string, kind: string, value: Decision): void {
    this.decisions.set(`${kind} ${origin}`, [origin, kind, value]);
  }

  *entries(): Iterable<[origin: string, kind: string, value: Decision]> {
    yield* this.decisions.values();
  }
}
