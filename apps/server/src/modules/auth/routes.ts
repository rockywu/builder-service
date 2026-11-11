import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import type { DatabaseClient } from '../../db/client.js';
import type { User } from '../../db/protocol.js';
import { hashPassword, verifyPassword } from './password.js';

interface SessionContext {
  user: User;
  tokenHash: string;
  csrfToken: string;
}
declare module 'fastify' {
  interface FastifyRequest {
    sessionContext: SessionContext | null;
  }
}
const tokenHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const csrfToken = (value: string) => tokenHash(`csrf:${value}`);
const sessionSeconds = 8 * 60 * 60;
const cookieName = 'builder_session';

export async function registerAuth(
  app: FastifyInstance,
  database: DatabaseClient,
  origin: string,
) {
  const secure = new URL(origin).protocol === 'https:';
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure,
  };
  // A dummy hash keeps unknown usernames on the same expensive verification path.
  const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.decorateRequest('sessionContext', null);

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (!path.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    const readOnly = request.method === 'GET' || request.method === 'HEAD';
    if (
      (readOnly && path === '/api/health') ||
      (readOnly && path.startsWith('/api/public/'))
    )
      return;
    if (!readOnly && request.headers.origin !== origin) {
      return reply.code(403).send({ message: '请求来源不受信任。' });
    }
    if (path === '/api/auth/login' && request.method === 'POST') return;
    const raw = request.cookies[cookieName];
    if (!raw || !/^[a-f0-9]{64}$/.test(raw))
      return reply.code(401).send({ message: '请先登录。' });
    const user = await database.request('getSession', {
      tokenHash: tokenHash(raw),
      now: Date.now(),
    });
    if (!user) {
      reply.clearCookie(cookieName, cookieOptions);
      return reply.code(401).send({ message: '登录已失效，请重新登录。' });
    }
    request.sessionContext = {
      user,
      tokenHash: tokenHash(raw),
      csrfToken: csrfToken(raw),
    };
    if (!readOnly) {
      const supplied = request.headers['x-csrf-token'];
      const expected = request.sessionContext.csrfToken;
      if (
        typeof supplied !== 'string' ||
        !/^[a-f0-9]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
      ) {
        return reply
          .code(403)
          .send({ message: '请求校验失败，请刷新页面后重试。' });
      }
    }
  });

  app.post<{ Body: { username: string; password: string } }>(
    '/api/auth/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
            password: { type: 'string', minLength: 1, maxLength: 256 },
          },
        },
      },
    },
    async (request, reply) => {
      const stored = await database.request('findUser', {
        username: request.body.username.trim(),
      });
      const matches = await verifyPassword(
        request.body.password,
        stored?.password_hash ?? dummyHash,
      );
      if (!matches || !stored?.enabled)
        return reply.code(401).send({ message: '账号或密码错误。' });
      const raw = randomBytes(32).toString('hex');
      const previous = request.cookies[cookieName];
      const user = await database.request('createSession', {
        userId: stored.id,
        expectedPasswordHash: stored.password_hash,
        tokenHash: tokenHash(raw),
        expiresAt: Date.now() + sessionSeconds * 1000,
        previousTokenHash: previous ? tokenHash(previous) : null,
      });
      if (!user) return reply.code(401).send({ message: '账号或密码错误。' });
      reply.setCookie(cookieName, raw, {
        ...cookieOptions,
        maxAge: sessionSeconds,
      });
      return { user, csrfToken: csrfToken(raw) };
    },
  );
  app.get('/api/auth/me', async (request) => ({
    user: request.sessionContext!.user,
    csrfToken: request.sessionContext!.csrfToken,
  }));
  app.post('/api/auth/logout', async (request, reply) => {
    await database.request('deleteSession', {
      tokenHash: request.sessionContext!.tokenHash,
    });
    reply.clearCookie(cookieName, cookieOptions);
    return reply.code(204).send();
  });
}
