import type { Browser, RequestHandlers, View } from '../types.js';
import type { ChainedHandler } from './types.js';

/** Key of the method a browser attaches an extension host with (not public API). */
export const ATTACH = Symbol('browser-lite.attachExtensions');

/** What a running browser offers its extension host. */
export interface ExtensionBrowser {
  readonly browser: Browser;
  /** Open views right now. */
  views(): Iterable<View>;
  /** Replaces the page content of all extensions (engine bl_set_user_content). */
  setContent(json: string): void;
  /** A message to the scripts of an extension in a view (engine bl_extension_message). */
  postMessage(view: View, extension: string, json: string): void;
}

/** A message of an extension's script (engine event `extension-message`). */
export interface ScriptMessage {
  extension: string;
  url: string;
  /** JSON text. */
  message: string;
}

/** The side of an extension host its browser calls while attached. */
export interface ExtensionLink {
  /** Handlers of the extensions for a request, in chain order. */
  handlers<K extends keyof RequestHandlers>(type: K): readonly ChainedHandler<K>[];
  /** A view opened (by the integrator or the pages). */
  viewAdded(view: View): void;
  /** Resolves the answer of the extension; rejects to reject in the page. */
  message(message: ScriptMessage, view: View): Promise<unknown>;
  /** The browser ends (destroyed or crashed). */
  detach(): void;
}

/** Implemented by the host of `createExtensionHost`. */
export interface AttachableHost {
  [ATTACH](browser: ExtensionBrowser): ExtensionLink;
}

/** The internal side of an extension host passed in the options; null when it is none. */
export function attachableHost(value: unknown): AttachableHost | null {
  return typeof (value as Partial<AttachableHost> | null)?.[ATTACH] === 'function'
    ? (value as AttachableHost)
    : null;
}
