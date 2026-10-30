import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.js';
import { FEATURE_KEYS, listPlans, PLAN_IDS } from '../../consumer/entitlements.js';
import { TELEMETRY_EVENTS } from '../../consumer/telemetry.js';
import { TemplateRules } from '../../intake/parser.js';
import { many, one, withTransaction } from '../../db.js';
import { actorOf, requireRole } from '../../http/context.js';
import { badRequest, notFound, parse } from '../../http/errors.js';
import { camel, camelAll, normaliseKeys } from '../../util.js';
import { count } from './helpers.js';

const price = z.number().min(0).max(1_000_000).multipleOf(0.01).nullable();
const providerId = z.string().trim().regex(/^plan_[A-Za-z0-9]{6,40}$/, 'Razorpay plan ids look like plan_XXXXXXXX');

/** Plans (prices are editable here, never hard-coded in the UI) and consumer counts. */
export async function consumerAdminRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;

  app.get('/plans', async () => {
    const rows = await listPlans(pool);
    return { items: camelAll(rows), total: rows.length, paymentsConfigured: Boolean(app.deps.config.razorpay) };
  });

  app.patch('/plans/:id', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = parse(z.object({ id: z.enum(PLAN_IDS) }), req.params);
    const body = parse(
      z
        .object({
          name: z.string().trim().min(1).max(60).optional(),
          priceInrMonthly: price.optional(),
          priceInrYearly: price.optional(),
          active: z.boolean().optional(),
          features: z.array(z.enum(FEATURE_KEYS)).max(FEATURE_KEYS.length).optional(),
          providerPlanIds: z.object({ monthly: providerId.nullable().optional(), yearly: providerId.nullable().optional() }).strict().optional(),
        })
        .strict(),
      normaliseKeys(req.body),
    );
    const row = await withTransaction(pool, async (c) => {
      const before = await one<Record<string, unknown> & { provider_plan_ids: Record<string, string> }>(c, 'SELECT * FROM plans WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Plan not found');
      let providerIds = before.provider_plan_ids ?? {};
      if (body.providerPlanIds) {
        providerIds = { ...providerIds };
        for (const k of ['monthly', 'yearly'] as const) {
          const v = body.providerPlanIds[k];
          if (v === null) delete providerIds[k];
          else if (v !== undefined) providerIds[k] = v;
        }
      }
      const after = await one(
        c,
        `UPDATE plans SET name = COALESCE($2, name),
            price_inr_monthly = CASE WHEN $3 THEN $4::numeric ELSE price_inr_monthly END,
            price_inr_yearly = CASE WHEN $5 THEN $6::numeric ELSE price_inr_yearly END,
            active = COALESCE($7, active), features = COALESCE($8::jsonb, features), provider_plan_ids = $9, updated_at = $10
          WHERE id = $1 RETURNING *`,
        [
          id,
          body.name ?? null,
          body.priceInrMonthly !== undefined,
          body.priceInrMonthly ?? null,
          body.priceInrYearly !== undefined,
          body.priceInrYearly ?? null,
          body.active ?? null,
          body.features ? JSON.stringify(body.features) : null,
          JSON.stringify(providerIds),
          clock(),
        ],
      );
      await writeAudit(c, actorOf(req), 'plan.update', 'plan', id, before, after);
      return after!;
    });
    return camel(row);
  });

  const rules = TemplateRules.superRefine((r, ctx) => {
    for (const k of ['subjectPattern', 'amountPattern', 'renewalDatePattern', 'trialEndPattern', 'offerExpiryPattern'] as const) {
      const p = r[k];
      if (!p) continue;
      try {
        new RegExp(p, 'i');
      } catch {
        ctx.addIssue({ code: 'custom', path: [k], message: 'Invalid regular expression' });
      }
    }
  });
  const domain = z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Use a bare domain like mailer.example.com');

  app.get('/parser-templates', async () => {
    const rows = await many(pool, 'SELECT * FROM provider_parser_templates ORDER BY sender_domain, message_class, version DESC');
    return { items: camelAll(rows), total: rows.length };
  });

  app.post('/parser-templates', { preHandler: requireRole('editor') }, async (req, reply) => {
    const body = parse(
      z.object({ senderDomain: domain, messageClass: z.string().trim().min(1).max(60), rules, active: z.boolean().default(true) }).strict(),
      normaliseKeys(req.body),
    );
    const row = await withTransaction(pool, async (c) => {
      const v = (await one<{ v: number }>(c, 'SELECT coalesce(max(version), 0) + 1 AS v FROM provider_parser_templates WHERE sender_domain = $1 AND message_class = $2', [
        body.senderDomain,
        body.messageClass,
      ]))!.v;
      const r = await one(
        c,
        `INSERT INTO provider_parser_templates (sender_domain, message_class, version, rules, active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
        [body.senderDomain, body.messageClass, v, JSON.stringify(body.rules), body.active, clock()],
      );
      await writeAudit(c, actorOf(req), 'parser_template.create', 'parser_template', (r as { id: string }).id, null, r);
      return r!;
    });
    return reply.code(201).send(camel(row));
  });

  app.patch('/parser-templates/:id', { preHandler: requireRole('editor') }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({ rules: rules.optional(), active: z.boolean().optional() }).strict(), normaliseKeys(req.body));
    if (body.rules === undefined && body.active === undefined) throw badRequest('No fields to update');
    const row = await withTransaction(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM provider_parser_templates WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Template not found');
      const after = await one(
        c,
        `UPDATE provider_parser_templates SET rules = COALESCE($2::jsonb, rules), active = COALESCE($3, active), updated_at = $4 WHERE id = $1 RETURNING *`,
        [id, body.rules ? JSON.stringify(body.rules) : null, body.active ?? null, clock()],
      );
      await writeAudit(c, actorOf(req), 'parser_template.update', 'parser_template', id, before, after);
      return after!;
    });
    return camel(row);
  });

  app.get('/consumer-stats', async () => {
    const now = clock();
    const d30 = new Date(now.getTime() - 30 * 86_400_000);
    const d7 = new Date(now.getTime() - 7 * 86_400_000);
    const byPlan = await many<{ plan: string; n: number }>(
      pool,
      `SELECT plan, count(*)::int AS n FROM entitlements
        WHERE plan <> 'free' AND status IN ('active','cancelled') AND (current_period_end IS NULL OR current_period_end > $1) GROUP BY plan`,
      [now],
    );
    const deliveries = await many<{ status: string; n: number }>(
      pool,
      'SELECT status, count(*)::int AS n FROM reminder_deliveries WHERE created_at >= $1 GROUP BY status',
      [d7],
    );
    const telemetry = await many<{ name: string; n: number }>(
      pool,
      'SELECT name, count(*)::int AS n FROM telemetry_events WHERE at >= $1 GROUP BY name',
      [d30],
    );
    return {
      generatedAt: now,
      accounts: await count(pool, 'SELECT count(*) AS n FROM consumer_accounts'),
      accountsActive30d: await count(pool, 'SELECT count(*) AS n FROM consumer_accounts WHERE last_login_at >= $1', [d30]),
      activeSessions: await count(pool, 'SELECT count(*) AS n FROM consumer_sessions WHERE revoked_at IS NULL AND expires_at > $1', [now]),
      syncedAccounts: await count(pool, 'SELECT count(*) AS n FROM account_data WHERE version > 0'),
      paidByPlan: Object.fromEntries(byPlan.map((r) => [r.plan, r.n])),
      households: await count(pool, 'SELECT count(*) AS n FROM households'),
      householdMembers: await count(pool, `SELECT count(*) AS n FROM household_members WHERE status = 'active'`),
      reminderDeliveries7d: Object.fromEntries(deliveries.map((r) => [r.status, r.n])),
      intake: {
        tempSessionsActive: await count(pool, 'SELECT count(*) AS n FROM intake_temp_sessions WHERE claimed_at IS NULL AND expires_at > $1', [now]),
        activeAliases: await count(pool, `SELECT count(*) AS n FROM intake_aliases WHERE status = 'active'`),
        events7d: await count(pool, 'SELECT count(*) AS n FROM user_events WHERE created_at >= $1', [d7]),
        confirmed7d: await count(pool, `SELECT count(*) AS n FROM user_events WHERE review_status = 'confirmed' AND created_at >= $1`, [d7]),
      },
      telemetry30d: Object.fromEntries(TELEMETRY_EVENTS.map((n) => [n, telemetry.find((t) => t.name === n)?.n ?? 0])),
    };
  });
}
