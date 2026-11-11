import { Worker } from 'node:worker_threads';
import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DatabaseOperations,
  DatabaseResponse,
  Operation,
} from './protocol.js';

export class DatabaseClient {
  private sequence = 0;
  private unavailable = false;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(readonly worker: Worker) {
    worker.on('message', (message: DatabaseResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          Object.assign(new Error(message.error), {
            statusCode: message.statusCode ?? 503,
          }),
        );
      else pending.resolve(message.result);
    });
    const fail = () => {
      this.unavailable = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('数据库暂不可用。'));
      }
      this.pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', fail);
  }
  async request<K extends Operation>(
    operation: K,
    input: DatabaseOperations[K]['input'],
  ): Promise<DatabaseOperations[K]['result']> {
    if (this.unavailable || this.pending.size >= 128)
      throw new Error('数据库暂不可用。');
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('数据库响应超时，请核对操作结果后重试。'));
      }, 5000);
      this.pending.set(id, {
        resolve: (value) => resolve(value as DatabaseOperations[K]['result']),
        reject,
        timer,
      });
      try {
        this.worker.postMessage({ id, operation, input });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
}

export async function startDatabase(dataDirectory: string) {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);
  const worker = new Worker(new URL('./worker.js', import.meta.url), {
    workerData: { filename: join(dataDirectory, 'platform.db') },
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Database Worker startup timed out'));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timer);
      worker.off('error', onError);
      worker.off('exit', onExit);
      worker.off('message', onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`Database Worker exited before readiness (${code})`));
    };
    const onMessage = (message: unknown) => {
      if (message === 'ready') {
        cleanup();
        resolve();
      }
    };
    worker.once('error', onError);
    worker.once('exit', onExit);
    worker.on('message', onMessage);
  });
  return new DatabaseClient(worker);
}

export async function closeDatabase(database: DatabaseClient) {
  const { worker } = database;
  if (worker.threadId === -1) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
    }, 5000);
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Database Worker shutdown failed (${code})`));
    });
    worker.postMessage('close');
  });
}
