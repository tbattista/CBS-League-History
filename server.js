import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static server for the league dashboard.
 *
 * Deliberately dependency-free: the site is a handful of static files plus one
 * JSON document, and every dependency here is something that can break a deploy
 * years from now for a site whose whole purpose is outliving the platform it
 * came from.
 *
 * It serves the committed dataset rather than scraping on request. CBS session
 * cookies expire within days; a dashboard that needed one would be broken far
 * more often than it worked.
 */

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = join(ROOT, 'data');
const PORT = Number(process.env.PORT) || 3000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

/**
 * Resolve a request path inside a directory, refusing anything that escapes it.
 * Normalizing first means "../" is resolved before the prefix check, so a
 * traversal cannot slip through as a literal path segment.
 */
function safeJoin(dir, requestPath) {
  const clean = normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, '');
  const target = resolve(join(dir, clean));
  return target.startsWith(dir) ? target : null;
}

async function serveFile(res, path, { cache = 'no-cache' } = {}) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return false;
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': cache,
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }

  // Railway and friends want a cheap liveness endpoint.
  if (pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }

  // The dataset is the one thing served from outside public/.
  if (pathname === '/league.json') {
    const path = join(DATA_DIR, 'league.json');
    if (await serveFile(res, path, { cache: 'public, max-age=300' })) return;
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'league.json not built. Run: npm run parse' }));
    return;
  }

  const requested = pathname === '/' ? '/index.html' : pathname;
  const path = safeJoin(PUBLIC_DIR, requested);
  if (path && (await serveFile(res, path))) return;

  // Unknown paths fall back to the app shell so client routing keeps working.
  if (await serveFile(res, join(PUBLIC_DIR, 'index.html'))) return;

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`League history dashboard on http://localhost:${PORT}`);
});
