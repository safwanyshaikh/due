import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Mailer } from '../src/alerts.js';
import { buildApp, loggerOptions } from '../src/app.js';
import type { Pool } from '../src/db.js';
import { BASE, freshDb, testConfig, TestClock } from './helpers.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(c, _e, cb) {
      lines.push(c.toString());
      cb();
    },
  });
  return { lines, stream };
}

function smtpRejected(): Error {
  // Shape of a nodemailer "all recipients rejected" error (EENVELOPE), plus a pg-style detail.
  return Object.assign(new Error("Can't send mail - all recipients were rejected: 550 5.1.1 <victim@example.in>: Recipient address rejected"), {
    code: 'EENVELOPE',
    responseCode: 550,
    command: 'RCPT TO',
    rejected: ['victim@example.in'],
    response: '550 5.1.1 <victim@example.in>: Recipient address rejected',
    detail: 'Key (email)=(victim@example.in) already exists.',
  });
}

describe('M1: redacted error logs', () => {
  it('a rejected-recipient SMTP error never logs the address (serializer + formatter)', async () => {
    const { lines, stream } = capture();
    const app = Fastify({ logger: { ...loggerOptions(true), stream } as never });
    app.get('/x', async (req) => {
      req.log.error({ err: smtpRejected(), to: 'victim@example.in', note: 'sent to victim@example.in token=abcdefgh12345' }, 'magic link email failed for victim@example.in');
      return { ok: true };
    });
    await app.inject({ method: 'GET', url: '/x?token=abc' });
    await app.close();
    const out = lines.join('');
    const line = JSON.parse(lines.find((l) => l.includes('magic link'))!);
    expect(out).not.toContain('victim@example.in');
    expect(out).not.toContain('abcdefgh12345');
    expect(line.err).toMatchObject({ type: 'Error', code: 'EENVELOPE', responseCode: 550 });
    expect(line.err.message).toContain('[email]');
    expect(line.err.rejected).toBeUndefined();
    expect(line.err.detail).toBeUndefined();
    expect(line.err.stack).toMatch(/\n\s+at /);
  });

  it('the magic-link route logs an SMTP failure without the recipient', async () => {
    const pool: Pool = await freshDb();
    const { lines, stream } = capture();
    const mailer: Mailer = {
      async send() {
        throw smtpRejected();
      },
    } as Mailer;
    const app = await buildApp({ pool, config: testConfig(), clock: new TestClock(new Date('2026-11-25T10:00:00Z')).fn, mailer, logger: { ...loggerOptions(true), stream } as never });
    await app.ready();
    const r = await app.inject({
      method: 'POST',
      url: '/api/account/magic-link',
      payload: { email: 'victim@example.in' },
      headers: { 'x-requested-with': 'due-app', origin: BASE },
    });
    expect(r.statusCode).toBe(502);
    await app.close();
    await pool.end();
    const out = lines.join('');
    expect(out).toContain('magic link email failed');
    expect(out).not.toContain('victim@example.in');
  });
});

