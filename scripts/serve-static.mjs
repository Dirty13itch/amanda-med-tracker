import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

function respond(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

export async function startStaticServer({ root, port = 4173 } = {}) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/__health') {
        respond(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }

      const requestedPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      const targetPath = path.resolve(resolvedRoot, '.' + requestedPath);
      if (!targetPath.startsWith(resolvedRoot)) {
        respond(res, 403, 'Forbidden', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }

      const body = await readFile(targetPath);
      const ext = path.extname(targetPath).toLowerCase();
      respond(res, 200, body, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        respond(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }
      respond(res, 500, String(error), { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close() {
      return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
      });
    }
  };
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryUrl) {
  const port = Number(process.argv[2] || 4173);
  const root = process.cwd();
  const { baseUrl } = await startStaticServer({ root, port });
  console.log(`Serving ${root} at ${baseUrl}`);
}
