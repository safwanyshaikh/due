import { registerHandler } from '../queue/index.js';
import { runGmailScan } from './scan.js';

export { runGmailScan } from './scan.js';
export { revokeAllForAccount, gmailStatus, GMAIL_CONSENT_VERSION } from './service.js';

/**
 * Registers the `gmail.scan` queue handler (idempotent: re-registering replaces it). Call it in every
 * process that runs the queue worker. The handler uses the worker's own deps (pool, config, clock, log).
 */
export function registerGmailJobs(): void {
  registerHandler('gmail.scan', async (job) => {
    const { pool, config, clock } = job.deps;
    await runGmailScan({ pool, config, clock, log: job.log }, job.payload);
  });
}
