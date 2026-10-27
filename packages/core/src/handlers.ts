import { writeHostClipboard } from './clipboard.js';
import type { ChainedHandler } from './extensions/types.js';
import { nativeFileChooser } from './requests.js';
import type { RequestHandlers } from './types.js';

type Handler = (request: unknown) => unknown;

/** What a request gets when no handler answers it (also the end of an extension chain). */
const DEFAULTS: RequestHandlers = {
  dialog: () => undefined,
  permission: async () => 'dismiss',
  authenticate: async () => null,
  fileChooser: nativeFileChooser,
  selectPopup: async () => -1,
  colorPicker: async () => null,
  dateTimePicker: async () => null,
  clipboardWrite: writeHostClipboard,
};

/** True for the name of a request type (a key of RequestHandlers). */
export function isRequestType(type: unknown): type is keyof RequestHandlers {
  return typeof type === 'string' && Object.hasOwn(DEFAULTS, type);
}

/**
 * The handler of a request: the chain of the extensions (in their order, each may call `next`),
 * ending in the handler of the options or the default. Without extension handlers just the
 * handler of the options, undefined when there is none.
 */
export function requestHandler<K extends keyof RequestHandlers>(
  type: K,
  own: RequestHandlers[K] | undefined,
  chain: readonly ChainedHandler<K>[],
): RequestHandlers[K] | undefined {
  if (!chain.length) return own;
  const last = (own ?? DEFAULTS[type]) as Handler;
  const links = chain as unknown as readonly ((request: unknown, next: () => unknown) => unknown)[];
  const run = (index: number, request: unknown): unknown => {
    const link = links[index];
    return link ? link(request, () => run(index + 1, request)) : last(request);
  };
  return ((request: unknown) => run(0, request)) as unknown as RequestHandlers[K];
}
