import type { FastifyInstance } from 'fastify';

export const ANDROID_PACKAGE = 'com.karigarai.due';
export const IOS_BUNDLE_ID = 'com.karigarai.due';
/** Only the e-mailed sign-in link opens the app; nothing else on the site is claimed. */
export const APP_LINK_PATH = '/api/account/verify';

/**
 * App Links (Android) and Universal Links (iOS) association files. Each is 404 until its env value is set,
 * so an unconfigured server never claims links for an app it cannot vouch for.
 */
export async function wellKnownRoutes(app: FastifyInstance): Promise<void> {
  const { config } = app.deps;
  const notFound = (reply: import('fastify').FastifyReply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });

  app.get('/.well-known/assetlinks.json', async (_req, reply) => {
    if (config.androidCertFingerprints.length === 0) return notFound(reply);
    reply.header('Cache-Control', 'public, max-age=3600').type('application/json');
    return [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: ANDROID_PACKAGE,
          sha256_cert_fingerprints: config.androidCertFingerprints,
        },
      },
    ];
  });

  // Apple requires application/json (no extension) and no redirect.
  app.get('/.well-known/apple-app-site-association', async (_req, reply) => {
    if (!config.appleTeamId) return notFound(reply);
    reply.header('Cache-Control', 'public, max-age=3600').type('application/json');
    return {
      applinks: {
        details: [
          {
            appIDs: [`${config.appleTeamId}.${IOS_BUNDLE_ID}`],
            components: [{ '/': APP_LINK_PATH }],
          },
        ],
      },
    };
  });
}
