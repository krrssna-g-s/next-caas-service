/**
 * Test-only stand-in for the Next.js server.
 *
 * It maps URLs onto the real files under app/ (same [param] and [...catchAll]
 * rules) and calls the real route handlers and instrumentation.ts, so the
 * tests can start several "pods" as plain Node processes without a Next build.
 * Production runs `next start` / the standalone server, never this file.
 */
import { createServer } from 'node:http';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

type Handler = (req: Request, ctx: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;
interface Route {
  regex: RegExp;
  names: Array<{ name: string; catchAll: boolean }>;
  file: string;
  rank: number;
}

const appDir = join(process.cwd(), 'app');

function findRoutes(dir: string, out: Route[] = []): Route[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) findRoutes(full, out);
    else if (name === 'route.ts') {
      const segments = relative(appDir, dir).split(sep).filter(Boolean);
      const names: Route['names'] = [];
      let rank = 0;
      const pattern = segments
        .map((seg) => {
          const catchAll = /^\[\.\.\.(.+)\]$/.exec(seg);
          if (catchAll) {
            names.push({ name: catchAll[1], catchAll: true });
            rank += 100;
            return '(.+)';
          }
          const param = /^\[(.+)\]$/.exec(seg);
          if (param) {
            names.push({ name: param[1], catchAll: false });
            rank += 1;
            return '([^/]+)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/');
      out.push({ regex: new RegExp(`^/${pattern}/?$`), names, file: full, rank });
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

async function main(): Promise<void> {
  process.env.NEXT_RUNTIME = 'nodejs';
  const routes = findRoutes(appDir);
  const { register } = await import('../instrumentation');
  await register();

  const port = Number(process.env.PORT ?? 3000);
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const route = routes.find((r) => r.regex.test(url.pathname));
      const match = route?.regex.exec(url.pathname);
      if (!route || !match) {
        res.writeHead(404).end('not found');
        return;
      }
      const mod = (await import(pathToFileURL(route.file).href)) as Record<string, Handler | undefined>;
      const method = req.method ?? 'GET';
      const handler = mod[method] ?? (method === 'HEAD' ? mod.GET : undefined);
      if (!handler) {
        res.writeHead(405).end();
        return;
      }
      const params: Record<string, string | string[]> = {};
      route.names.forEach((n, i) => {
        const raw = match[i + 1];
        params[n.name] = n.catchAll ? raw.split('/').map(decodeURIComponent) : decodeURIComponent(raw);
      });

      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const request = new Request(url, {
        method,
        headers: req.headers as Record<string, string>,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      });
      const response = await handler(request, { params: Promise.resolve(params) });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error(err);
      res.writeHead(500).end('internal error');
    }
  }).listen(port, '127.0.0.1');
}

void main();
