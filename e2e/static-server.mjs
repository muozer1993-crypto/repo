/**
 * Minimal static file server for the exported web build.
 * Expo's static export writes real .html files, so anything without an
 * extension is served as "<path>.html" and unknown paths fall back to
 * index.html (the router resolves them client side).
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

export function startStaticServer(root, port = 0) {
  const base = resolve(root);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index';

    const candidates = [
      join(base, normalize(pathname)),
      join(base, `${normalize(pathname)}.html`),
      join(base, normalize(pathname), 'index.html'),
      join(base, 'index.html'),
    ];

    for (const candidate of candidates) {
      if (!candidate.startsWith(base)) continue;
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      res.writeHead(200, {
        'Content-Type': MIME[extname(candidate)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      createReadStream(candidate).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  return new Promise((resolveServer) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolveServer({
        url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.argv[2] ?? '.';
  const port = Number(process.argv[3] ?? 4200);
  const { url } = await startStaticServer(root, port);
  console.log(`static server on ${url} serving ${resolve(root)}`);
}
