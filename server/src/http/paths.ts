import type { FastifyRequest } from 'fastify';

/**
 * The path every security hook matches on (M-A): the route the router actually matched
 * (`req.routeOptions.url`, e.g. `/api/admin/users/:id`), or, for unmatched requests, the percent-decoded path.
 * Matching on the raw URL let `/%61pi/admin/users` reach an admin route while skipping hooks that compared
 * the raw string. Decoding is applied the same way the router decodes, so the two can never disagree.
 */
export function requestPath(req: FastifyRequest): string {
  const routed = req.routeOptions?.url;
  if (typeof routed === 'string' && routed.startsWith('/')) return routed;
  return decodePath(req.url);
}

export function decodePath(url: string): string {
  const raw = url.split('?')[0]!.split('#')[0]!;
  let p = raw;
  // Decode until stable (at most 3 rounds), so double-encoded segments cannot hide a prefix either.
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(p);
    } catch {
      break;
    }
    if (next === p) break;
    p = next;
  }
  return p.replace(/\/{2,}/g, '/');
}
