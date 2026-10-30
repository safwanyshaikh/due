import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, request } from 'undici';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True for loopback, private, link-local, CGNAT, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return blocked.check(mapped[1]!, 'ipv4');
  const fam = isIP(ip);
  if (fam === 4) return blocked.check(ip, 'ipv4');
  if (fam === 6) return blocked.check(ip, 'ipv6');
  return true;
}

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly kind: 'timeout' | 'too_large' | 'network' | 'blocked_address' | 'bad_url' | 'redirect',
  ) {
    super(message);
  }
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  url: string;
  durationMs: number;
}

export interface HttpOptions {
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  allowPrivateHosts: boolean;
  headers?: Record<string, string>;
}

const agents = new Map<boolean, Agent>();

/** One shared agent per policy. The DNS hook rejects private targets after resolution (DNS-rebinding safe). */
function agentFor(allowPrivate: boolean): Agent {
  let a = agents.get(allowPrivate);
  if (!a) {
    a = new Agent({
      connect: {
        lookup: (hostname, options, callback) => {
          dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
            if (err) return callback(err, '', 4);
            const list = (addresses as LookupAddress[]).filter((x) => allowPrivate || !isPrivateAddress(x.address));
            if (list.length === 0) {
              return callback(new FetchError(`Refusing to fetch private address for ${hostname}`, 'blocked_address'), '', 4);
            }
            if ((options as { all?: boolean }).all) {
              (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
            } else {
              callback(null, list[0]!.address, list[0]!.family);
            }
          });
        },
      },
      keepAliveTimeout: 10_000,
    });
    agents.set(allowPrivate, a);
  }
  return a;
}

export function assertFetchableUrl(raw: string, allowPrivate: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new FetchError(`Invalid URL: ${raw}`, 'bad_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('Only http(s) URLs are fetched', 'bad_url');
  if (u.username || u.password) throw new FetchError('URLs with credentials are not fetched', 'bad_url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate && (host === 'localhost' || (isIP(host) && isPrivateAddress(host)))) {
    throw new FetchError(`Refusing to fetch private address ${host}`, 'blocked_address');
  }
  return u;
}

/** A single GET (no redirect following) with timeout and a hard response-size cap. */
export async function httpGet(rawUrl: string, opts: HttpOptions): Promise<HttpResponse> {
  const u = assertFetchableUrl(rawUrl, opts.allowPrivateHosts);
  const started = Date.now();
  const signal = AbortSignal.timeout(opts.timeoutMs);
  try {
    const res = await request(u, {
      method: 'GET',
      dispatcher: agentFor(opts.allowPrivateHosts),
      signal,
      headersTimeout: opts.timeoutMs,
      bodyTimeout: opts.timeoutMs,
      headers: {
        'user-agent': opts.userAgent,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml,application/json;q=0.8,*/*;q=0.5',
        'accept-language': 'en-IN,en;q=0.8',
        ...opts.headers,
      },
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    const declared = Number(headers['content-length'] ?? '0');
    if (declared > opts.maxBytes) {
      res.body.destroy();
      throw new FetchError(`Response too large (${declared} bytes)`, 'too_large');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      const b = chunk as Buffer;
      size += b.length;
      if (size > opts.maxBytes) {
        res.body.destroy();
        throw new FetchError(`Response exceeded ${opts.maxBytes} bytes`, 'too_large');
      }
      chunks.push(b);
    }
    return { status: res.statusCode, headers, body: Buffer.concat(chunks), url: u.toString(), durationMs: Date.now() - started };
  } catch (err) {
    if (err instanceof FetchError) throw err;
    const e = err as Error & { code?: string; cause?: unknown };
    if (e.cause instanceof FetchError) throw e.cause;
    if (signal.aborted || e.name === 'TimeoutError' || e.name === 'AbortError' || /Timeout/i.test(e.code ?? '')) {
      throw new FetchError(`Timed out after ${opts.timeoutMs} ms`, 'timeout');
    }
    throw new FetchError(`${e.code ? `${e.code}: ` : ''}${e.message}`, 'network');
  }
}

export function decodeBody(body: Buffer, contentType: string | undefined): string {
  const m = /charset=["']?([\w-]+)/i.exec(contentType ?? '');
  let label = m?.[1]?.toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    label = 'utf-8';
    return new TextDecoder(label).decode(body);
  }
}
