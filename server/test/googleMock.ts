/**
 * Test-only stand-in for Google's OAuth and Gmail endpoints (node:http on 127.0.0.1).
 * Records every request so tests can assert Due only reads (GET list/get) and only POSTs token/revoke.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GmailEndpoints } from '../src/config.js';
import type { GmailMessage, GmailPart } from '../src/gmail/google.js';

export const CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const CLIENT_SECRET = 'test-client-secret';
export const FULL_SCOPE = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly';

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  form: Record<string, string>;
  auth: string | null;
}

interface IssuedCode {
  challenge: string;
  email: string;
  sub: string;
  scope: string;
  refresh: boolean;
}

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

export function idToken(claims: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.sig`;
}

export function message(
  id: string,
  opts: { from: string; subject: string; text?: string; html?: string; attachment?: { filename: string; mimeType: string; text: string }; messageId?: string; date?: Date },
): GmailMessage {
  const parts: GmailPart[] = [];
  if (opts.text !== undefined) parts.push({ partId: '0', mimeType: 'text/plain', body: { size: opts.text.length, data: b64url(opts.text) } });
  if (opts.html !== undefined) parts.push({ partId: '1', mimeType: 'text/html', body: { size: opts.html.length, data: b64url(opts.html) } });
  if (opts.attachment) {
    parts.push({
      partId: '2',
      mimeType: opts.attachment.mimeType,
      filename: opts.attachment.filename,
      headers: [{ name: 'Content-Disposition', value: `attachment; filename="${opts.attachment.filename}"` }],
      body: { size: opts.attachment.text.length, attachmentId: `att-${id}` },
    });
  }
  return {
    id,
    threadId: `t-${id}`,
    internalDate: String((opts.date ?? new Date('2026-10-20T08:00:00Z')).getTime()),
    payload: {
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: opts.from },
        { name: 'Subject', value: opts.subject },
        { name: 'Date', value: 'Tue, 20 Oct 2026 08:00:00 +0000' },
        { name: 'Message-ID', value: opts.messageId ?? `<${id}@mail.test>` },
      ],
      parts,
    },
  };
}

export class GoogleMock {
  server: Server | null = null;
  base = '';
  requests: Recorded[] = [];
  codes = new Map<string, IssuedCode>();
  /** Valid access tokens -> refresh token they came from. */
  access = new Map<string, string>();
  refreshTokens = new Map<string, { email: string; sub: string; scope: string }>();
  revoked: string[] = [];
  messages = new Map<string, GmailMessage>();
  attachments = new Map<string, string>();
  /** Scope string returned on refresh (null: omit, as Google sometimes does). */
  refreshScope: string | null = FULL_SCOPE;
  nowSec = () => Math.floor(Date.now() / 1000);
  private seq = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, body }) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        },
        () => {
          res.writeHead(500);
          res.end('{}');
        },
      );
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  endpoints(): GmailEndpoints {
    return {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: `${this.base}/token`,
      revokeUrl: `${this.base}/revoke`,
      gmailApiBase: `${this.base}/gmail/v1`,
    };
  }

  reset(): void {
    this.requests = [];
    this.codes.clear();
    this.access.clear();
    this.refreshTokens.clear();
    this.revoked = [];
    this.messages.clear();
    this.attachments.clear();
    this.refreshScope = FULL_SCOPE;
  }

  /** Simulates the user approving consent at Google: returns an authorization code bound to the PKCE challenge. */
  issueCode(challenge: string, o: { email: string; sub?: string; scope?: string; refresh?: boolean }): string {
    const code = `code-${++this.seq}`;
    this.codes.set(code, { challenge, email: o.email, sub: o.sub ?? `sub-${o.email}`, scope: o.scope ?? FULL_SCOPE, refresh: o.refresh ?? true });
    return code;
  }

  addMessage(m: GmailMessage, attachmentText?: string): void {
    this.messages.set(m.id, m);
    if (attachmentText !== undefined) this.attachments.set(`att-${m.id}`, attachmentText);
  }

  count(method: string, pathPrefix: string): number {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(pathPrefix)).length;
  }

  private async body(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const url = new URL(req.url ?? '/', this.base);
    const raw = req.method === 'POST' ? await this.body(req) : '';
    const form = Object.fromEntries(new URLSearchParams(raw));
    const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : null;
    this.requests.push({ method: req.method ?? '', path: url.pathname, query: Object.fromEntries(url.searchParams), form, auth });

    if (req.method === 'POST' && url.pathname === '/token') {
      if (form.client_id !== CLIENT_ID || form.client_secret !== CLIENT_SECRET) return { status: 401, body: { error: 'invalid_client' } };
      if (form.grant_type === 'authorization_code') {
        const c = this.codes.get(form.code ?? '');
        if (!c) return { status: 400, body: { error: 'invalid_grant' } };
        this.codes.delete(form.code!);
        const s256 = createHash('sha256').update(form.code_verifier ?? '').digest('base64url');
        if (s256 !== c.challenge) return { status: 400, body: { error: 'invalid_grant', error_description: 'code_verifier mismatch' } };
        const at = `at-${++this.seq}`;
        const rt = `rt-secret-${this.seq}`;
        this.access.set(at, rt);
        this.refreshTokens.set(rt, { email: c.email, sub: c.sub, scope: c.scope });
        return {
          status: 200,
          body: {
            access_token: at,
            ...(c.refresh ? { refresh_token: rt } : {}),
            expires_in: 3600,
            scope: c.scope,
            token_type: 'Bearer',
            id_token: c.scope.includes('openid')
              ? idToken({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: c.sub, email: c.email, email_verified: true, exp: this.nowSec() + 3600 })
              : undefined,
          },
        };
      }
      if (form.grant_type === 'refresh_token') {
        const r = this.refreshTokens.get(form.refresh_token ?? '');
        if (!r || this.revoked.includes(form.refresh_token!)) return { status: 400, body: { error: 'invalid_grant' } };
        const at = `at-${++this.seq}`;
        this.access.set(at, form.refresh_token!);
        return { status: 200, body: { access_token: at, expires_in: 3600, token_type: 'Bearer', ...(this.refreshScope ? { scope: this.refreshScope } : {}) } };
      }
      return { status: 400, body: { error: 'unsupported_grant_type' } };
    }
    if (req.method === 'POST' && url.pathname === '/revoke') {
      const t = form.token ?? '';
      this.revoked.push(t);
      const rt = this.access.get(t) ?? t;
      this.revoked.push(rt);
      for (const [a, r] of this.access) if (r === rt) this.access.delete(a);
      return { status: 200, body: {} };
    }
    if (req.method === 'GET' && url.pathname.startsWith('/gmail/v1/users/me/messages')) {
      const at = auth?.replace(/^Bearer /, '') ?? '';
      if (!this.access.has(at)) return { status: 401, body: { error: { code: 401, status: 'UNAUTHENTICATED' } } };
      const rest = url.pathname.slice('/gmail/v1/users/me/messages'.length);
      if (rest === '' || rest === '/') {
        return { status: 200, body: { messages: [...this.messages.keys()].map((id) => ({ id, threadId: `t-${id}` })), resultSizeEstimate: this.messages.size } };
      }
      const att = /^\/([^/]+)\/attachments\/([^/]+)$/.exec(rest);
      if (att) {
        const text = this.attachments.get(decodeURIComponent(att[2]!));
        return text === undefined ? { status: 404, body: {} } : { status: 200, body: { size: text.length, data: b64url(text) } };
      }
      const m = this.messages.get(decodeURIComponent(rest.slice(1)));
      return m ? { status: 200, body: m } : { status: 404, body: { error: { code: 404 } } };
    }
    return { status: 404, body: { error: 'not_found' } };
  }
}
