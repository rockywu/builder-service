import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { startDatabase, closeDatabase } from './db/client.js';

process.umask(0o077);
const config = loadConfig();
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let database: Awaited<ReturnType<typeof startDatabase>> | undefined;
let closing = false;
function report(error: unknown) {
  if (app) app.log.error(error);
  else console.error(error);
}
async function shutdown(exitCode: number) {
  if (closing) return;
  closing = true;
  process.exitCode = exitCode;
  try {
    await app?.close();
  } catch (error) {
    report(error);
    process.exitCode = 1;
  } finally {
    if (database) {
      try {
        await closeDatabase(database);
      } catch (error) {
        report(error);
        process.exitCode = 1;
      }
    }
  }
}
process.once('SIGINT', () => {
  void shutdown(0);
});
process.once('SIGTERM', () => {
  void shutdown(0);
});
try {
  database = await startDatabase(config.dataDirectory);
  database.worker.on('error', (error) => {
    report(error);
    void shutdown(1);
  });
  database.worker.on('exit', (code) => {
    if (!closing) {
      report(new Error(`Database Worker exited unexpectedly (${code})`));
      void shutdown(1);
    }
  });
  if (closing) await closeDatabase(database);
  else {
    app = await createApp(config, database);
    if (closing) await app.close();
    else await app.listen({ host: config.host, port: config.port });
  }
} catch (error) {
  report(error);
  await shutdown(1);
}
