/** GET /health — the app's "Bağlantıyı test et" target (SPEC 2.2). */
import type { FastifyInstance } from 'fastify';

export default async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({
    ok: true,
    version: app.config.version,
    time: app.now().toISOString(),
  }));
}
