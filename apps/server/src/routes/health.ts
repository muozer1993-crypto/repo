/**
 * GET /health — the app's "Bağlantıyı test et" target (SPEC 2.2), and where it
 * learns whether a newer Android build has been published (`app`), so an old
 * install can say "yeni sürüm var" instead of quietly missing features.
 */
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { currentRelease } from '../services/appRelease.js';
import { LOOPBACK_URL, publicOrigin } from '../services/origin.js';

/**
 * Who this server is, independent of the address it is reached at. A quick
 * tunnel hands out a new address on every start, and without this the app had
 * no way to tell "same server, new address" from "another server", so it
 * logged every friend out. Derived from the JWT secret (which persists in
 * DATA_DIR/secret), it changes exactly when the old tokens stop working, and a
 * one-way hash of it gives nothing away about the secret.
 */
function serverIdFor(jwtSecret: string): string {
  return createHmac('sha256', jwtSecret).update('koydum-server-id').digest('hex').slice(0, 16);
}

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  const { config } = app;
  const serverId = serverIdFor(config.jwtSecret);
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
      serverId,
    };
  });
}
