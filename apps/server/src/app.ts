import Fastify from 'fastify';
import type { AppConfig } from './config.js';
import { registerPlatform } from './modules/platform/routes.js';
import type { DatabaseClient } from './db/client.js';
import { registerAuth } from './modules/auth/routes.js';

export async function createApp(config: AppConfig, database: DatabaseClient) {
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
  app.setErrorHandler((error, _request, reply) => {
    const failure = error as { statusCode?: number; message?: string };
    const status = failure.statusCode ?? 500;
    reply.code(status).send({
      message:
        status >= 500
          ? '服务暂不可用，请核对操作结果后重试。'
          : (failure.message ?? '请求失败。'),
    });
  });
  await registerAuth(app, database, config.appOrigin);
  await registerPlatform(app, database, config);
  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'builder-service',
  }));
  return app;
}
