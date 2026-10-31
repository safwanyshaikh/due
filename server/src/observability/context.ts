import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Correlation id for the current request or job (propagated to enqueued jobs and error reports). */
const store = new AsyncLocalStorage<{ correlationId: string }>();

const VALID_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Accepts a caller-supplied x-request-id only when it is a short opaque token; otherwise makes a new one. */
export function requestIdFrom(header: unknown): string {
  return typeof header === 'string' && VALID_ID.test(header) ? header : randomUUID();
}

export function currentCorrelationId(): string | null {
  return store.getStore()?.correlationId ?? null;
}

export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  return store.run({ correlationId }, fn);
}

/** Binds the rest of the current async flow (used from a Fastify onRequest hook). */
export function enterCorrelation(correlationId: string): void {
  store.enterWith({ correlationId });
}
