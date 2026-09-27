/**
 * GET /health — the app's "Bağlantıyı test et" target (SPEC 2.2), and where it
 * learns whether a newer Android build has been published (`app`), so an old
 * install can say "yeni sürüm var" instead of quietly missing features.
 */
import type { FastifyInstance } from 'fastify';
import { currentRelease } from '../services/appRelease.js';
import { publicOrigin } from '../services/origin.js';

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (request) => {
    const release = currentRelease(app.config, publicOrigin(request, app.config));
    return {
      ok: true,
      version: app.config.version,
      time: app.now().toISOString(),
      app: release ? { latestVersion: release.version, downloadUrl: release.downloadUrl, notes: release.notes } : null,
    };
  });
}
