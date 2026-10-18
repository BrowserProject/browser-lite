/** Value of `Cross-Origin-Resource-Policy`. */
export type ResourcePolicy = 'same-origin' | 'same-site' | 'cross-origin';

/**
 * Headers that make a page cross-origin isolated (SharedArrayBuffer, needed by the engine):
 * COOP `same-origin`, COEP `require-corp` and CORP (default `same-origin`).
 */
export function coiHeaders(o: { corp?: ResourcePolicy } = {}): Record<string, string> {
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': o.corp ?? 'same-origin',
  };
}

/** {@link coiHeaders} plus `nosniff` and `no-referrer`, sent with every response of this package. */
export function securityHeaders(o: { corp?: ResourcePolicy } = {}): Record<string, string> {
  return {
    ...coiHeaders(o),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}
