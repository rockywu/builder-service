import {
  mkdir,
  writeFile,
  readFile,
  rm,
  open,
  statfs,
  readdir,
  cp,
  rename,
} from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { DatabaseClient } from '../../db/client.js';
import type { AppConfig } from '../../config.js';
import type { Command } from './store.js';
import type { Job, Release, User, Project } from './types.js';
import { BuildRunner } from '../../tools/runner.js';
import { SshService } from '../../tools/ssh.js';
import { runProcess, ExecutionUnconfirmedError } from '../../tools/process.js';
import { requireValue, PlatformError } from './errors.js';

export interface State {
  projects: Project[];
  jobs: Job[];
  releases: Release[];
  users: User[];
  settings: { maxConcurrent: number };
}
export class PlatformService {
  readonly runner: BuildRunner;
  readonly ssh: SshService;
  private active = new Map<
    number,
    { controller: AbortController; promise: Promise<void> }
  >();
  private timer: ReturnType<typeof setInterval> | undefined;
  private pumping = false;
  private closing = false;
  private recovering = true;
  private maintenance = false;
  private lockFile: string;
  private lockOwned = false;
  error: string | null = null;
  mutations = 0;
  private readers = new Map<number, number>();
  private deleting = new Map<number, Promise<void>>();
  private deletingProjects = new Map<number, Promise<void>>();
  constructor(
    readonly db: DatabaseClient,
    readonly config: AppConfig,
  ) {
    this.ssh = new SshService(config, db);
    this.runner = new BuildRunner(config, this.ssh);
    this.lockFile = join(config.dataDirectory, 'scheduler.lock');
  }
  async command<T>(
    action: string,
    data: Record<string, unknown> = {},
    actor?: Command['actor'],
  ): Promise<T> {
    return this.db.request('platform', {
      action,
      data,
      ...(actor ? { actor } : {}),
    }) as Promise<T>;
  }
  async start(): Promise<void> {
    await mkdir(this.config.dataDirectory, { recursive: true, mode: 0o700 });
    const guard = await open(`${this.lockFile}.guard`, 'wx', 0o600).catch(
      () => {
        throw new Error(
          '调度器锁正在核对，或上次启动在核对中中断；请先确认没有服务进程。',
        );
      },
    );
    try {
      try {
        const pid = Number(await readFile(this.lockFile, 'utf8'));
        requireValue(
          Number.isSafeInteger(pid) && pid > 0,
          '调度器锁损坏，请核对后恢复。',
          503,
        );
        try {
          process.kill(pid, 0);
          throw new Error('已有构建服务持有调度器锁。');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e;
        }
        await rm(this.lockFile);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      const file = await open(this.lockFile, 'wx', 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
      this.lockOwned = true;
    } finally {
      await guard.close();
      await rm(`${this.lockFile}.guard`);
    }
    try {
      await this.runner.initialize();
      await this.recover();
      await this.runner.cleanupTransient();
      await this.ssh.cleanup();
      this.recovering = false;
    } catch (e) {
      this.error = e instanceof Error ? e.message : '执行器暂不可用。';
    }
    this.timer = setInterval(() => {
      void this.pump();
    }, 2000);
    this.timer.unref();
    void this.pump();
  }
  async recover() {
    for (const j of await this.command<Job[]>('jobs'))
      if (['running', 'canceling'].includes(j.status)) {
        const files = await this.runner.recover(j);
        await this.command('finish', {
          id: j.id,
          status: files ? 'succeeded' : 'failed',
          error: files ? undefined : '服务中断，执行已终止。',
          artifacts: files,
        });
      }
    // Verify successful versions as well as interrupted commits before exposing downloads.
    const releases = await this.command<Release[]>('releases');
    for (const release of releases) {
      const j = await this.command<Job>('job', { id: release.jobId });
      try {
        const files = await this.runner.recover(j);
        requireValue(
          files &&
            files.length === release.artifacts.length &&
            files.every((f) =>
              release.artifacts.some(
                (a) =>
                  a.name === f.name &&
                  a.size === f.size &&
                  a.sha256 === f.sha256,
              ),
            ),
          '产物清单缺失或与数据库不一致。',
        );
      } catch {
        await this.command('quarantine', { id: j.id });
      }
    }
    const deletingProjects = await this.command<Project[]>('projectDeletions');
    for (const j of await this.command<Job[]>('deletions')) {
      if (!deletingProjects.some((p) => p.id === j.projectId))
        await this.delete(j.id);
    }
    for (const p of deletingProjects)
      await this.deleteProject(p.id).catch(() => {});
  }
  async pump() {
    if (this.pumping || this.closing || this.maintenance || this.recovering)
      return;
    this.pumping = true;
    try {
      const space = await statfs(this.config.dataDirectory);
      requireValue(
        space.bavail * space.bsize >= 256 * 1024 * 1024,
        '磁盘可用空间不足 256 MB，暂停领取任务。',
        503,
      );
      while (!this.closing && !this.maintenance && !this.recovering) {
        const j = await this.command<Job | null>('claim');
        if (!j) break;
        const controller = new AbortController();
        const promise = this.execute(j, controller).finally(() => {
          this.active.delete(j.id);
          void this.pump();
        });
        this.active.set(j.id, { controller, promise });
      }
      if (!this.recovering) this.error = null;
    } catch (e) {
      this.error = e instanceof Error ? e.message : '调度暂不可用。';
    } finally {
      this.pumping = false;
    }
  }
  private async execute(j: Job, controller: AbortController) {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, j.snapshot.timeout * 60_000);
    try {
      const files = await this.runner.execute(
        j,
        controller.signal,
        async (n) => {
          const ok = await this.command<boolean>('phase', {
            id: j.id,
            phase: n,
            progress: n * 33,
          });
          requireValue(ok, '任务已停止。', 409);
        },
      );
      try {
        await this.command('finish', {
          id: j.id,
          status: 'succeeded',
          artifacts: files,
        });
      } catch (error) {
        this.recovering = true;
        this.error =
          '产物已收集，但数据库提交结果未确认；保留槽位等待重启核对。';
        return;
      }
    } catch (e) {
      if (e instanceof ExecutionUnconfirmedError) {
        this.recovering = true;
        this.error = e.message;
        return;
      }
      try {
        await this.command('finish', {
          id: j.id,
          status: 'failed',
          error: timedOut
            ? '构建超过配置的超时时间。'
            : e instanceof Error
              ? e.message
              : '构建失败。',
        });
      } catch (dbError) {
        this.recovering = true;
        this.error =
          dbError instanceof Error
            ? dbError.message
            : '构建结果未确认，保留槽位。';
      }
    } finally {
      clearTimeout(timer);
    }
  }
  async stop(id: number, actor: Command['actor']) {
    const j = await this.command<Job>('stop', { id }, actor);
    const active = this.active.get(id);
    if (active) active.controller.abort();
    else {
      // Reconcile a claimed task whose Worker reply or process outcome was uncertain.
      await this.runner.recover(j);
      await this.command('finish', {
        id,
        status: 'failed',
        error: '任务已停止。',
      });
    }
    return j;
  }
  async delete(id: number, actor?: Command['actor']) {
    if (actor) await this.command('markDelete', { id }, actor);
    requireValue(!this.maintenance, '备份正在进行，请稍后重试。', 409);
    const previous = this.deleting.get(id);
    if (previous) return previous;
    const task = (async () => {
      requireValue(
        !this.readers.get(id),
        '文件正在下载，请稍后重试删除。',
        409,
      );
      await this.runner.remove(id);
      await this.command('completeDelete', { id });
    })();
    this.deleting.set(id, task);
    try {
      await task;
    } finally {
      this.deleting.delete(id);
    }
  }
  async deleteProject(id: number, actor?: Command['actor']) {
    requireValue(!this.maintenance, '备份正在进行，请稍后重试。', 409);
    if (actor) await this.command('markProjectDelete', { id }, actor);
    const previous = this.deletingProjects.get(id);
    if (previous) return previous;
    const task = (async () => {
      const project = await this.command<Project>('project', { id });
      requireValue(project.deleting, '项目不在清理流程。', 409);
      try {
        for (const jobId of await this.command<number[]>(
          'projectDeletionJobs',
          { id },
        ))
          await this.delete(jobId);
        if (
          project.icon &&
          /^\/api\/public\/icons\/[a-f0-9-]{36}\.png$/.test(project.icon)
        ) {
          const projects = await this.command<Project[]>('projects');
          if (!projects.some((p) => p.id !== id && p.icon === project.icon)) {
            await rm(
              join(
                this.config.dataDirectory,
                'icons',
                project.icon.split('/').at(-1)!,
              ),
              { force: true },
            );
          }
        }
        await this.command('completeProjectDelete', { id });
      } catch (error) {
        await this.command('projectDeleteFailed', { id });
        throw new PlatformError(
          409,
          '删除未完成：请等待文件下载结束或检查文件权限后重试。',
        );
      }
    })();
    this.deletingProjects.set(id, task);
    try {
      await task;
    } finally {
      this.deletingProjects.delete(id);
    }
  }
  async openArtifact(id: number) {
    const f = await this.command<{
      id: number;
      name: string;
      size: number;
      sha256: string;
      storage_key: string;
      release_id: number;
    }>('artifact', { id });
    const jobId = await this.command<number>('releaseJob', {
      id: f.release_id,
    });
    requireValue(!this.deleting.has(jobId), '文件正在清理。', 404);
    this.readers.set(jobId, (this.readers.get(jobId) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (this.readers.get(jobId) ?? 1) - 1;
      if (n) this.readers.set(jobId, n);
      else this.readers.delete(jobId);
    };
    try {
      // Recheck visibility after registering the reader; a cleanup marker may have raced the initial lookup.
      await this.command('artifact', { id });
      const path = await this.runner.artifact(jobId, f.storage_key);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        requireValue(
          stat.isFile() && stat.size === f.size,
          '文件缺失或损坏。',
          410,
        );
        const hash = createHash('sha256');
        for await (const chunk of file.createReadStream({ autoClose: false }))
          hash.update(chunk);
        requireValue(hash.digest('hex') === f.sha256, '文件校验失败。', 410);
        const stream = file.createReadStream({ start: 0, autoClose: true });
        stream.once('close', release);
        stream.once('error', release);
        return { file: f, stream, release };
      } catch (error) {
        await file.close();
        throw error;
      }
    } catch (e) {
      release();
      throw e;
    }
  }
  async backup() {
    requireValue(
      !this.maintenance &&
        !this.pumping &&
        this.active.size === 0 &&
        this.mutations === 0,
      '存在执行或维护中的任务，请稍后备份。',
      409,
    );
    this.maintenance = true;
    const backupRoot = join(this.config.dataDirectory, 'backups');
    const stamp = crypto.randomUUID();
    const staging = join(backupRoot, `.${stamp}`),
      target = join(backupRoot, stamp);
    try {
      await mkdir(backupRoot, { recursive: true, mode: 0o700 });
      requireValue(!this.deleting.size, '文件清理正在进行。', 409);
      await mkdir(staging, { mode: 0o700 });
      // Freeze platform mutations at the HTTP boundary during this short local backup.
      await this.db.request('backup', {
        filename: join(staging, 'platform.db'),
      });
      await cp(this.runner.root, join(staging, 'builds'), {
        recursive: true,
        dereference: false,
      });
      try {
        await cp(
          join(this.config.dataDirectory, 'icons'),
          join(staging, 'icons'),
          { recursive: true, dereference: false },
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      await rename(staging, target);
      return { id: stamp };
    } finally {
      this.maintenance = false;
      void this.pump();
    }
  }
  get busy() {
    return this.maintenance;
  }
  async close() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    for (const a of this.active.values()) a.controller.abort();
    while (this.pumping)
      await new Promise((resolve) => setTimeout(resolve, 10));
    for (const a of this.active.values()) a.controller.abort();
    await Promise.allSettled([...this.active.values()].map((a) => a.promise));
    await Promise.allSettled([...this.deletingProjects.values()]);
    if (this.lockOwned) {
      await rm(this.lockFile, { force: true });
      this.lockOwned = false;
    }
  }
}
