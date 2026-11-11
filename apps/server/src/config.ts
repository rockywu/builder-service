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
  return {
    appOrigin,
    host: process.env.HOST ?? '127.0.0.1',
    port,
    dataDirectory: resolve(process.env.DATA_DIR ?? '../../var'),
    logLevel: process.env.LOG_LEVEL ?? 'info',
  };
}
