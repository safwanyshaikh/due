import { z } from 'zod';

/** The only product events the server accepts (activation/retention measures from the spec). */
export const TELEMETRY_EVENTS = [
  'first_obligation_completed',
  'import_approved',
  'import_ignored',
  'reminder_resolved',
  'correction_made',
  'missed_or_late',
  'trial_converted',
  'churn_reason',
  'notification_opt_out',
] as const;
export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number];

const PII_KEYS = /(e-?mail|phone|mobile|name|address|card|pan|aadhaar|upi|account|password|token|ip)/i;

/**
 * Props must be a small flat map of enum-like tokens, numbers or booleans. Free text, e-mail
 * addresses and long digit runs (phone/card/account numbers) are rejected so no PII is stored.
 */
const propValue = z.union([
  z.boolean(),
  z.number().finite(),
  z
    .string()
    .max(40)
    .regex(/^[a-z0-9_.:-]*$/i, 'Only short enum-like tokens are allowed')
    .refine((v) => !/\d{6,}/.test(v), 'Long digit sequences are not allowed'),
]);

export const TelemetryBatch = z
  .object({
    anonId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'anonId must be 8-64 URL-safe characters'),
    events: z
      .array(
        z
          .object({
            name: z.string().max(64),
            props: z
              .record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), propValue)
              .refine((p) => Object.keys(p).length <= 10, 'At most 10 props')
              .refine((p) => Object.keys(p).every((k) => !PII_KEYS.test(k)), 'Prop names that suggest personal data are not allowed')
              .default({}),
            at: z.string().datetime({ offset: true }).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(25),
  })
  .strict();
export type TelemetryBatch = z.infer<typeof TelemetryBatch>;

export function unknownEventNames(batch: TelemetryBatch): string[] {
  const allowed = new Set<string>(TELEMETRY_EVENTS);
  return [...new Set(batch.events.map((e) => e.name).filter((n) => !allowed.has(n)))];
}
