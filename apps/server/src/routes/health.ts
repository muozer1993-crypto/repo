/**
 * GET /health — the app's "Bağlantıyı test et" target (SPEC 2.2), and where it
 * learns whether a newer Android build has been published (`app`), so an old
 * install can say "yeni sürüm var" instead of quietly missing features.
 */
import type { FastifyInstance } from 'fastify';
import { currentRelease } from '../services/appRelease.js';
import { LOOPBACK_URL, publicOrigin } from '../services/origin.js';

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  const { config } = app;
  app.get('/health', async (request) => {
    const release = currentRelease(app.config, publicOrigin(request, app.config));
    return {
      ok: true,
      version: app.config.version,
      time: app.now().toISOString(),
      app: release ? { latestVersion: release.version, downloadUrl: release.downloadUrl, notes: release.notes } : null,
      // the address friends elsewhere should use (npm run internet sets it);
      // the app builds invite links from it even when this phone is on the LAN
      publicUrl: config.publicUrlExplicit && !LOOPBACK_URL.test(config.publicUrl) ? config.publicUrl : null,
    };
  });
}
