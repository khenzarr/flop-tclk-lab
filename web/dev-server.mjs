import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWeb } from './build.mjs';

const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const port = Number.parseInt(process.env.PORT ?? '4173', 10);
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.sha256', 'text/plain; charset=utf-8'],
]);

await buildWeb({ outDir: root });
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '/deal/phase3b-final') pathname = '/index.html';
    const target = normalize(join(root, pathname));
    if (!target.startsWith(root) || !(await stat(target)).isFile()) throw new Error('NOT_FOUND');
    const bytes = await readFile(target);
    response.writeHead(200, { 'Content-Type': contentTypes.get(extname(target)) ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    if (request.method === 'HEAD') response.end(); else response.end(bytes);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Not found');
  }
});
server.listen(port, '127.0.0.1', () => process.stdout.write(`Local: http://127.0.0.1:${port}/deal/phase3b-final\n`));
