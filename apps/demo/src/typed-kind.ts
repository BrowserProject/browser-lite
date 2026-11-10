import { typedAddress } from '@browser-lite/core';
import { TOP_LEVEL_DOMAINS } from './tlds.js';

/**
 * What text typed into the address bar without a scheme is: `address` opens on Enter, `maybe`
 * searches on Enter and offers the address after the search (node.js, intranet/wiki), `search` is
 * only a search (weather, 3.14, an invalid address).
 */
export type TypedKind = 'address' | 'maybe' | 'search';

// [user@]host[:port][/path][?query][#ref]
const PARTS =
  /^(?:([^\s/?#@]+)@)?(\[[0-9a-f:.]+\]|[^\s/?#@:[\]]+)(?::(\d+))?(\/[^\s?#]*)?(\?[^\s#]*)?(#\S*)?$/i;

/**
 * The kind of text typed without a scheme, like Chrome's omnibox (`AutocompleteInput::Parse`):
 * an address with localhost, an IP address, a port, a path that ends in a slash or two parts
 * after the host (path, query, fragment, user), else one whose host ends in a top level domain of
 * the root zone (`example.com`). Other hosts with a dot or with a part after them may be
 * intranet names and are offered; a word alone, a mail address (`me@example.com`) and a number
 * (`3.14`) are searches.
 */
export function typedKind(text: string): TypedKind {
  const value = text.trim();
  const parts = PARTS.exec(value);
  const url = parts ? typedAddress(value) : '';
  if (!parts || !url) return 'search';
  const [, user, host = '', port, path = '', query, ref] = parts;
  const { hostname } = new URL(url);
  if (
    port ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.startsWith('[') ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    path.endsWith('/') ||
    [user, path, query, ref].filter(Boolean).length > 1
  )
    return 'address';
  // A mail address, or a number like 3.14 that the URL parser makes an IPv4 address (3.0.0.14)
  if (user || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return 'search';
  if (hasKnownTld(hostname)) return 'address';
  return hostname.includes('.') || path || query || ref ? 'maybe' : 'search';
}

/**
 * True when hostname (as the URL parser gives it, lower case, internationalized labels as xn--)
 * ends in a top level domain of the root zone after at least one more label: `example.com`, not
 * `node.js` or `com`.
 */
export function hasKnownTld(hostname: string): boolean {
  const labels = hostname.replace(/\.$/, '').split('.');
  return labels.length > 1 && TOP_LEVEL_DOMAINS.has(labels.at(-1) ?? '');
}
