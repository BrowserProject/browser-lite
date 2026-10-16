// Statische Dateien mit den Headern, die die Engine braucht (SharedArrayBuffer).
// Genutzt vom Server im Container (relay/server.mjs) und vom Entwicklungs-Server (web/serve.mjs).
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export const SECURITY_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

// URL und dekodierter Pfad einer Anfrage, null bei kaputter URL
export function parseRequest(req) {
  try {
    const url = new URL(req.url, 'http://localhost');
    return { url, path: decodeURIComponent(url.pathname) };
  } catch {
    return null;
  }
}

function fileStat(file) {
  try {
    const stat = statSync(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function matchesETag(header, etag) {
  return header.split(',').some((tag) => {
    tag = tag.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  });
}

// Liefert <root>/<urlPath> aus, mit .br/.gz daneben (tools/optimize-site.mjs) wenn der
// Browser das kann, und mit ETag fuer 304. Gibt false zurueck, wenn es die Datei nicht gibt.
export function serveStatic(req, res, root, urlPath, cacheControl) {
  let rel = urlPath;
  if (rel.endsWith('/'))
    rel += 'index.html';
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root + path.sep))
    return false;
  let stat = fileStat(file);
  if (!stat)
    return false;

  let send = file;
  let encoding = null;
  const accepted = String(req.headers['accept-encoding'] || '');
  for (const [name, ext] of [['br', '.br'], ['gzip', '.gz']]) {
    const compressed = accepted.includes(name) ? fileStat(file + ext) : null;
    if (compressed) {
      send = file + ext;
      stat = compressed;
      encoding = name;
      break;
    }
  }

  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${encoding ? '-' + encoding : ''}"`;
  const headers = {
    ...SECURITY_HEADERS,
    'Cache-Control': cacheControl,
    'Vary': 'Accept-Encoding',
    'ETag': etag,
    'Last-Modified': stat.mtime.toUTCString(),
  };
  const ifNoneMatch = req.headers['if-none-match'];
  if (ifNoneMatch && matchesETag(ifNoneMatch, etag)) {
    res.writeHead(304, headers).end();
    return true;
  }

  headers['Content-Type'] = TYPES[path.extname(file)] || 'application/octet-stream';
  if (encoding)
    headers['Content-Encoding'] = encoding;
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD')
    res.end();
  else
    // Bricht der Client ab, schliesst pipeline auch die Datei
    pipeline(createReadStream(send), res, () => {});
  return true;
}
