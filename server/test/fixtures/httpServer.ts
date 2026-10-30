// Test-only local HTTP server used to exercise the real fetch code paths (never imported by production code).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export class FixtureServer {
  private server: Server;
  routes = new Map<string, Handler>();
  hits = new Map<string, number>();
  requests: { path: string; headers: IncomingMessage['headers'] }[] = [];
  base = '';

  constructor() {
    this.server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]!;
      this.hits.set(path, (this.hits.get(path) ?? 0) + 1);
      this.requests.push({ path, headers: req.headers });
      const h = this.routes.get(path);
      if (h) return h(req, res);
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  url(path: string): string {
    return `${this.base}${path}`;
  }

  hit(path: string): number {
    return this.hits.get(path) ?? 0;
  }

  robots(text: string): void {
    this.routes.set('/robots.txt', (_q, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end(text));
  }

  html(path: string, body: () => string, headers: Record<string, string> = {}): void {
    this.routes.set(path, (_q, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }).end(body()));
  }
}

export function page(title: string, main: string): string {
  return `<!doctype html><html><head><title>${title}</title><style>.x{color:red}</style>
<script>window.tracking = 'ignore me';</script></head>
<body><nav>Home | Plans | Login</nav><main><h1>${title}</h1>${main}</main></body></html>`;
}
