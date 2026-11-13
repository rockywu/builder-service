import { resolve } from 'node:path';

export function loadConfig() {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const appOrigin = process.env.APP_ORIGIN ?? 'http://127.0.0.1:5173';
  const url = new URL(appOrigin);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== appOrigin) {
    throw new Error('APP_ORIGIN must be an HTTP(S) origin without a path');
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('Production APP_ORIGIN must use HTTPS');
  }
  const runner = process.env.BUILDER_RUNNER ?? 'local';
  if (!['local', 'docker'].includes(runner))
    throw new Error('BUILDER_RUNNER must be local or docker');
  if (process.env.NODE_ENV === 'production' && runner !== 'docker')
    throw new Error('Production builds require Docker isolation');
  return {
    runner: runner as 'local' | 'docker',
    buildImage: process.env.BUILDER_IMAGE ?? 'builder-runtime:node24',
    gitNetwork: process.env.BUILDER_GIT_NETWORK ?? 'none',
    buildNetwork: process.env.BUILDER_BUILD_NETWORK ?? 'none',
    secretKey: process.env.BUILDER_SECRET_KEY ?? '',
    appOrigin,
    host: process.env.HOST ?? '127.0.0.1',
    port,
    dataDirectory: resolve(process.env.DATA_DIR ?? '../../var'),
    logLevel: process.env.LOG_LEVEL ?? 'info',
  };
}

export type AppConfig = Omit<
  ReturnType<typeof loadConfig>,
  'runner' | 'buildImage' | 'gitNetwork' | 'buildNetwork' | 'secretKey'
> &
  Partial<
    Pick<
      ReturnType<typeof loadConfig>,
      'runner' | 'buildImage' | 'gitNetwork' | 'buildNetwork' | 'secretKey'
    >
  >;
