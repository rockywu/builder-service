import Fastify from 'fastify';
import type { loadConfig } from './config.js';
import type { DatabaseClient } from './db/client.js';
import { registerAuth } from './modules/auth/routes.js';

export async function createApp(
  config: ReturnType<typeof loadConfig>,
  database: DatabaseClient,
) {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
        'req.body.password',
      ],
    },
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000,
  });
  await registerAuth(app, database, config.appOrigin);
  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'builder-service',
  }));
  return app;
}
