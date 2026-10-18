import type { SupportFeature, SupportReport } from './types.js';

/** Checks the host browser for everything the engine needs. */
export function checkSupport(): SupportReport {
  const scope = globalThis as Record<string, unknown>;
  const missing: SupportFeature[] = [];
  if (typeof document === 'undefined') missing.push('document');
  if (!scope.crossOriginIsolated) missing.push('crossOriginIsolated');
  if (typeof SharedArrayBuffer === 'undefined') missing.push('SharedArrayBuffer');
  if (typeof Atomics === 'undefined') missing.push('Atomics');
  if (typeof Worker === 'undefined') missing.push('Worker');
  if (typeof WebAssembly === 'undefined') missing.push('WebAssembly');
  else {
    try {
      new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    } catch {
      missing.push('WebAssembly threads');
    }
  }
  if (typeof ResizeObserver === 'undefined') missing.push('ResizeObserver');
  return { supported: !missing.length, missing };
}
