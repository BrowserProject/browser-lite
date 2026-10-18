import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { type ResourcePolicy, securityHeaders } from './headers.js';

export { coiHeaders, type ResourcePolicy } from './headers.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Content type for a file name, `application/octet-stream` when unknown. */
export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Options of {@link serveStatic}. */
export interface ServeStaticOptions {
  /** Decoded URL path to serve instead of the path of `req.url` (for mounting a prefix). */
  urlPath?: string;
  /** `Cache-Control` value, or a function of the URL path. Default `'no-cache'`. */
  cacheControl?: string | ((urlPath: string) => string);
  /** `Cross-Origin-Resource-Policy`, default `'same-origin'`. */
  corp?: ResourcePolicy;
}

async function fileStat(file: string): Promise<Stats | null> {
  try {
    const stats = await stat(file);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

function matchesETag(header: string, etag: string): boolean {
  return header.split(',').some((tag) => {
    const trimmed = tag.trim();
    return trimmed === '*' || trimmed.replace(/^W\//, '') === etag;
  });
}

// Single range "bytes=a-b", "bytes=a-" or "bytes=-n"; null without a usable range, 'invalid' if
// it cannot be satisfied. Several ranges are answered with the whole file.
function parseRange(
  header: string,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

function decodedPath(req: IncomingMessage): string | null {
  try {
    return decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    return null;
  }
}

/**
 * Serves `<root>/<path>` for GET and HEAD with the cross-origin isolation headers, a precompressed
 * `.br`/`.gz` file next to it when the client accepts it, ETag/Last-Modified (304) and single
 * byte ranges (206, on the uncompressed file). Resolves false (nothing sent) when there is no
 * such file, the method is not GET/HEAD or the URL is invalid.
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  o: ServeStaticOptions = {},
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const urlPath = o.urlPath ?? decodedPath(req);
  if (urlPath === null || urlPath.includes('\0')) return false;
  const base = path.resolve(root);
  const file = path.join(
    base,
    path.normalize(urlPath.endsWith('/') ? `${urlPath}index.html` : urlPath),
  );
  if (!file.startsWith(base + path.sep)) return false;
  let stats = await fileStat(file);
  if (!stats) return false;

  const rangeHeader = req.headers.range;
  let send = file;
  let encoding: string | null = null;
  if (!rangeHeader) {
    const accepted = String(req.headers['accept-encoding'] ?? '');
    for (const [name, ext] of [
      ['br', '.br'],
      ['gzip', '.gz'],
    ] as const) {
      const compressed = accepted.includes(name) ? await fileStat(file + ext) : null;
      if (compressed) {
        send = file + ext;
        stats = compressed;
        encoding = name;
        break;
      }
    }
  }

  const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}${encoding ? `-${encoding}` : ''}"`;
  const cacheControl =
    typeof o.cacheControl === 'function' ? o.cacheControl(urlPath) : (o.cacheControl ?? 'no-cache');
  const headers: Record<string, string | number> = {
    ...securityHeaders({ corp: o.corp }),
    'Cache-Control': cacheControl,
    Vary: 'Accept-Encoding',
    ETag: etag,
    'Last-Modified': stats.mtime.toUTCString(),
  };
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && matchesETag(ifNoneMatch, etag)) {
    res.writeHead(304, headers).end();
    return true;
  }

  headers['Content-Type'] = contentType(file);
  if (encoding) headers['Content-Encoding'] = encoding;
  else headers['Accept-Ranges'] = 'bytes';
  const ifRange = req.headers['if-range'];
  const range =
    rangeHeader && (!ifRange || ifRange === etag) ? parseRange(rangeHeader, stats.size) : null;
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stats.size}` }).end();
    return true;
  }
  let status = 200;
  if (range) {
    status = 206;
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stats.size}`;
  }
  headers['Content-Length'] = range ? range.end - range.start + 1 : stats.size;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
  } else {
    // If the client aborts, pipeline also closes the file
    const stream = createReadStream(send, range ? { start: range.start, end: range.end } : {});
    pipeline(stream, res, () => {});
  }
  return true;
}
