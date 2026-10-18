import type { PermissionDecision, PermissionKind, PermissionStore } from './types.js';

/** Default PermissionStore: decisions live as long as the page. */
export class MemoryPermissionStore implements PermissionStore {
  private readonly decisions = new Map<string, [string, PermissionKind, PermissionDecision]>();

  set(origin: string, kind: PermissionKind, value: PermissionDecision | null): void {
    const key = `${kind} ${origin}`;
    if (value === null) this.decisions.delete(key);
    else this.decisions.set(key, [origin, kind, value]);
  }

  *entries(): Iterable<[origin: string, kind: PermissionKind, value: PermissionDecision]> {
    yield* this.decisions.values();
  }
}

/**
 * Writes a decision to a store; camera and microphone together are kept per kind, like the
 * engine does. A failing store only warns.
 */
export function storePermission(
  store: PermissionStore,
  origin: string,
  kind: PermissionKind,
  decision: PermissionDecision | null,
): void {
  const kinds: PermissionKind[] = kind === 'camera-microphone' ? ['camera', 'microphone'] : [kind];
  try {
    for (const each of kinds) store.set(origin, each, decision);
  } catch (error) {
    console.warn('[browser-lite] permission store failed:', error);
  }
}
