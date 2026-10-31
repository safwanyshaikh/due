import type { Queryable } from './db.js';
import { getSettings } from './settings.js';

export interface Mailer {
  /** Resolves with the provider message id when the transport reports one. */
  send(to: string[], subject: string, text: string, options?: MailOptions): Promise<{ messageId?: string } | void>;
}

export interface MailOptions {
  /** Extra headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
}

export interface AlertInput {
  level: 'info' | 'important';
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

export interface AlertLogger {
  error(obj: unknown, msg?: string): void;
}

/**
 * Creates an in-app alert. Important alerts are also emailed only when SMTP is configured
 * (a Mailer exists) and notifications.email_enabled is true with recipients set.
 */
export async function createAlert(
  q: Queryable,
  alert: AlertInput,
  mailer: Mailer | null,
  log?: AlertLogger,
): Promise<number> {
  const r = await q.query<{ id: number }>(
    `INSERT INTO alerts (level, title, body, entity_type, entity_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [alert.level, alert.title, alert.body ?? null, alert.entityType ?? null, alert.entityId ?? null],
  );
  if (mailer && alert.level === 'important') {
    try {
      const s = await getSettings(q);
      if (s.notifications.email_enabled && s.notifications.recipients.length > 0) {
        await mailer.send(
          s.notifications.recipients,
          `[${s.business.app_name}] ${alert.title}`,
          `${alert.title}\n\n${alert.body ?? ''}\n\nThis is an automated message from the source monitor.`,
        );
      }
    } catch (err) {
      log?.error({ err }, 'alert email failed');
    }
  }
  return r.rows[0]!.id;
}

/** Builds an SMTP mailer from SMTP_URL; returns null when SMTP is not configured. */
export async function createMailer(smtpUrl: string | null, from: string | null): Promise<Mailer | null> {
  if (!smtpUrl) return null;
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport(smtpUrl);
  const sender = from ?? 'Due monitor <no-reply@localhost>';
  return {
    async send(to, subject, text, options) {
      // Resolves only after the SMTP server accepted the message (nodemailer rejects otherwise).
      const info = await transport.sendMail({ from: sender, to: to.join(', '), subject, text, headers: options?.headers });
      return { messageId: typeof info.messageId === 'string' ? info.messageId : undefined };
    },
  };
}
