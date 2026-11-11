// Offline restore only. Never overwrite an existing DATA_DIR.
import { cp, mkdir, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { safePath } from './paths.js';
import { requireValue } from '../modules/platform/errors.js';
const [sourceArg, targetArg] = process.argv.slice(2);
requireValue(
  sourceArg && targetArg,
  'Usage: node dist/tools/restore.js <backup-directory> <new-data-directory>',
);
process.umask(0o077);
const source = resolve(sourceArg),
  target = resolve(targetArg);
requireValue(
  source !== target && !target.startsWith(source + '/'),
  '恢复目标不能位于备份内。',
);
const database = new Database(join(source, 'platform.db'), {
  readonly: true,
  fileMustExist: true,
});
try {
  requireValue(
    database.pragma('quick_check', { simple: true }) === 'ok' &&
      (database.pragma('foreign_key_check') as unknown[]).length === 0,
    '备份数据库完整性校验失败。',
  );
  const releases = database
    .prepare('SELECT id,job_id,payload FROM releases WHERE deleting=0')
    .all() as { id: number; job_id: number; payload: string }[];
  const artifacts = database
    .prepare('SELECT release_id,storage_key,size,sha256 FROM artifacts')
    .all() as {
    release_id: number;
    storage_key: string;
    size: number;
    sha256: string;
  }[];
  const ids = new Map(
    releases
      .filter((r) => !JSON.parse(r.payload).unavailable)
      .map((r) => [r.id, r.job_id]),
  );
  for (const a of artifacts) {
    const jobId = ids.get(a.release_id);
    if (jobId === undefined) continue;
    const path = await safePath(
      join(source, 'builds', String(jobId)),
      a.storage_key,
    );
    const file = await open(path, 'r');
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of file.createReadStream({ autoClose: false })) {
        size += chunk.length;
        hash.update(chunk);
      }
    } finally {
      await file.close();
    }
    requireValue(
      size === a.size && hash.digest('hex') === a.sha256,
      '备份产物完整性校验失败。',
    );
  }
} finally {
  database.close();
}
await mkdir(target, { mode: 0o700 });
for (const name of ['platform.db', 'builds', 'icons']) {
  try {
    await cp(join(source, name), join(target, name), {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
  } catch (e) {
    if (
      name === 'platform.db' ||
      (e as NodeJS.ErrnoException).code !== 'ENOENT'
    )
      throw e;
  }
}
console.log(
  '备份校验完成，恢复副本已写入新目录；启动前请用独立端口和 DATA_DIR 验证。',
);
