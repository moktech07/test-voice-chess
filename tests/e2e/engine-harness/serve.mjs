/**
 * A tiny static file server used by tests/e2e/engine.browser.test.ts.
 *
 * It serves a directory under a SUBDIRECTORY path, exactly like a GitHub
 * Pages project site (`https://user.github.io/voice-chess/`). That is the
 * whole point: the engine's asset URLs have to be relative for this to
 * work.
 *
 * Usage: node serve.mjs <root-dir> <port> [mount-path] [request-log]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const root = path.resolve(process.argv[2] ?? path.join(here, 'dist'));
const port = Number(process.argv[3] ?? 4174);
const mount = (process.argv[4] ?? '/voice-chess/').replace(/\/*$/, '/');
const logFile = process.argv[5] ?? '';

/* Every request is appended to the log file so the test can assert on what
   the Web Worker actually fetched (Playwright's page-level request events do
   not include requests made from inside a dedicated worker). */
function logRequest(pathname) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${pathname}\n`);
  } catch {
    /* ignore */
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  logRequest(url.pathname);

  if (!url.pathname.startsWith(mount)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`Not found. The app is mounted at ${mount}\n`);
    return;
  }

  let rel = url.pathname.slice(mount.length);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';

  const filePath = path.join(root, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(root)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Forbidden\n');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`Not found: ${rel}\n`);
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
    });
    res.end(data);
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${root} at http://127.0.0.1:${port}${mount}`);
});
