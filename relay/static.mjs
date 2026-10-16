// Statische Dateien mit den Headern, die die Engine braucht (SharedArrayBuffer).
// Genutzt vom Server im Container (relay/server.mjs) und vom Entwicklungs-Server (web/serve.mjs).
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';

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

function fileSize(file) {
  try {
    const stat = statSync(file);
    return stat.isFile() ? stat.size : -1;
  } catch {
    return -1;
  }
}

// Liefert <root>/<urlPath> aus, mit .br/.gz daneben (tools/optimize-site.mjs) wenn der
// Browser das kann. Gibt false zurueck, wenn es die Datei nicht gibt.
export function serveStatic(req, res, root, urlPath, cacheControl) {
  let rel = urlPath;
  if (rel.endsWith('/'))
    rel += 'index.html';
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root + path.sep))
    return false;
  let size = fileSize(file);
  if (size < 0)
    return false;

  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': cacheControl,
    'Vary': 'Accept-Encoding',
  };
  let send = file;
  const accepted = String(req.headers['accept-encoding'] || '');
  for (const [encoding, ext] of [['br', '.br'], ['gzip', '.gz']]) {
    const compressedSize = accepted.includes(encoding) ? fileSize(file + ext) : -1;
    if (compressedSize >= 0) {
      send = file + ext;
      size = compressedSize;
      headers['Content-Encoding'] = encoding;
      break;
    }
  }
  headers['Content-Length'] = size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD')
    res.end();
  else
    createReadStream(send).pipe(res);
  return true;
}
