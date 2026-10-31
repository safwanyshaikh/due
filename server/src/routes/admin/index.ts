import type { FastifyInstance } from 'fastify';
import { requireRole } from '../../http/context.js';
import { categoryRoutes } from './categories.js';
import { companyRoutes } from './companies.js';
import { consumerAdminRoutes } from './consumer.js';
import { dashboardRoutes } from './dashboard.js';
import { exportRoutes } from './exportRoutes.js';
import { alertRoutes, auditRoutes, jobRoutes, settingsRoutes } from './misc.js';
import { offerRoutes } from './offers.js';
import { privacyRoutes } from './privacy.js';
import { reviewRoutes } from './review.js';
import { recordRoutes } from './records.js';
import { sourceRoutes } from './sources.js';
import { userRoutes } from './users.js';
import { notificationAdminRoutes } from '../../consumer/notifications.js';
import { healthAdminRoutes } from '../../health/index.js';
import { queueAdminRoutes } from '../../queue/adminRoutes.js';

/** Everything under /api/admin requires an authenticated session (viewer or above). */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireRole('viewer'));
  await app.register(dashboardRoutes);
  await app.register(companyRoutes);
  await app.register(sourceRoutes);
  await app.register(recordRoutes);
  await app.register(exportRoutes);
  await app.register(categoryRoutes);
  await app.register(userRoutes);
  await app.register(auditRoutes);
  await app.register(jobRoutes);
  await app.register(alertRoutes);
  await app.register(settingsRoutes);
  await app.register(offerRoutes);
  await app.register(reviewRoutes);
  await app.register(privacyRoutes);
  await app.register(consumerAdminRoutes);
  await app.register(queueAdminRoutes);
  await app.register(healthAdminRoutes);
  await app.register(notificationAdminRoutes);
}
