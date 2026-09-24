/** Serves the built demo web app (apps/web/dist) next to the API. */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { Hono } from 'hono';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const API_PREFIXES = ['/v1/', '/olp/', '/registry/', '/.well-known/', '/health', '/openapi.json'];

export function serveWeb(app: Hono, distFolder: string): void {
  const root = resolve(distFolder);
  if (!existsSync(join(root, 'index.html'))) return;

  const file = (path: string) => {
    const full = resolve(root, `.${path}`);
    if (full !== root && !full.startsWith(root + sep)) return undefined;
    return existsSync(full) && statSync(full).isFile() ? full : undefined;
  };

  app.get('*', (c, next) => {
    const path = decodeURIComponent(c.req.path);
    if (API_PREFIXES.some((prefix) => path.startsWith(prefix))) return next();
    const found = path === '/' ? join(root, 'index.html') : file(path);
    if (found === undefined) return next();
    const immutable = path.startsWith('/assets/');
    return c.body(new Uint8Array(readFileSync(found)), 200, {
      'content-type': TYPES[extname(found)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
  });
}
