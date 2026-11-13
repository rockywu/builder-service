import {
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
  stat,
  open,
  readdir,
  chmod,
} from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import {
  runProcess,
  groupAlive,
  confirmGroupStopped,
  ExecutionUnconfirmedError,
  ProcessExitError,
} from './process.js';
import { safePath, collectArtifacts, syncDirectory } from './paths.js';
import type { AppConfig } from '../config.js';
import type { Job, Project, LogLine } from '../modules/platform/types.js';
import { requireValue, PlatformError } from '../modules/platform/errors.js';
import { SshService, sshCommand } from './ssh.js';
import type { SshCredentials } from './ssh.js';

export class BuildRunner {
  readonly root: string;
  readonly mode: 'local' | 'docker';
  constructor(
    readonly config: AppConfig,
    readonly ssh?: SshService,
  ) {
    this.root = join(config.dataDirectory, 'builds');
    this.mode = config.runner ?? 'local';
    requireValue(
      process.env.NODE_ENV !== 'production' || this.mode === 'docker',
      '生产环境必须使用 Docker 隔离构建。',
      503,
    );
  }
  name(id: number | string) {
    return `builder-${createHash('sha256').update(resolve(this.root)).digest('hex').slice(0, 12)}-${id}`;
  }
  directory(id: number) {
    requireValue(Number.isSafeInteger(id) && id > 0, '无效任务编号。');
    return join(this.root, String(id));
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await syncDirectory(this.config.dataDirectory);
    if (this.mode === 'docker') {
      requireValue(
        (process.getuid?.() ?? 0) > 0,
        'Docker 构建服务必须以非 root 账号运行。',
        503,
      );
      requireValue(
        this.config.buildNetwork === 'none',
        '构建容器网络必须为 none；联网构建需先提供受限出口方案。',
        503,
      );
      requireValue(
        this.config.gitNetwork &&
          this.config.gitNetwork !== 'bridge' &&
          this.config.gitNetwork !== 'host',
        'Git 容器需要配置禁止管理网和元数据访问的专用网络。',
        503,
      );
      await runProcess('docker', [
        'image',
        'inspect',
        this.config.buildImage ?? 'builder-runtime:node24',
      ]);
    }
  }
  async command(
    id: number | string,
    directory: string,
    args: string[],
    signal?: AbortSignal,
    output?: (s: string, e: boolean) => void,
    network?: string,
    timeout = 120_000,
    credentials?: SshCredentials,
  ) {
    requireValue(
      !credentials || args[0] === 'git',
      '凭据只允许提供给 Git 步骤。',
    );
    if (this.mode === 'local') {
      await mkdir(join(directory, '.home'), { recursive: true, mode: 0o700 });
      return runProcess(args[0]!, args.slice(1), {
        cwd: directory,
        homeDirectory: join(directory, '.home'),
        markerDirectory: directory,
        ...(credentials
          ? { gitSshCommand: sshCommand(credentials.directory) }
          : {}),
        ...(signal ? { signal } : {}),
        ...(output ? { output } : {}),
        timeout,
      });
    }
    const name = this.name(id);
    const abort = () => {
      void runProcess('docker', ['stop', '--time', '2', name], {
        timeout: 10_000,
      }).catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await runProcess(
        'docker',
        [
          'run',
          '--name',
          name,
          '--label',
          `builder.scope=${this.name('scope')}`,
          '--user',
          `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--read-only',
          '--pids-limit=256',
          '--memory=2g',
          '--cpus=2',
          '--network',
          network ?? 'none',
          ...(credentials
            ? [
                '--mount',
                `type=bind,src=${credentials.directory},dst=/run/creds,readonly`,
              ]
            : []),
          '--tmpfs',
          '/tmp:rw,nosuid,nodev,size=256m',
          ...(args[0] === 'bash'
            ? [
                '--mount',
                `type=bind,src=${join(directory, 'source')},dst=/workspace/source`,
                '--mount',
                `type=bind,src=${join(directory, 'build.sh')},dst=/runner/build.sh,readonly`,
              ]
            : ['--mount', `type=bind,src=${directory},dst=/workspace`]),
          '--workdir',
          '/workspace',
          '--env',
          'HOME=/tmp',
          '--env',
          'GIT_CONFIG_NOSYSTEM=1',
          '--env',
          'GIT_CONFIG_GLOBAL=/dev/null',
          '--env',
          'GIT_TERMINAL_PROMPT=0',
          '--env',
          `GIT_SSH_COMMAND=${credentials ? sshCommand('/run/creds') : 'ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=none -o IdentityAgent=none -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes'}`,
          this.config.buildImage ?? 'builder-runtime:node24',
          ...args,
        ],
        {
          ...(signal ? { signal } : {}),
          ...(output ? { output } : {}),
          timeout,
        },
      );
    } finally {
      signal?.removeEventListener('abort', abort);
      // Never release a slot until the container is confirmed absent.
      try {
        await runProcess('docker', ['rm', '--force', name], {
          timeout: 15_000,
        });
      } catch {
        throw new ExecutionUnconfirmedError(
          '容器停止结果未确认，保留执行槽位。',
        );
      }
    }
  }
  private async remote<T>(
    repository: string,
    keyId: number | null | undefined,
    operation: (credentials?: SshCredentials) => Promise<T>,
  ) {
    const credentials = await this.ssh?.credentials(repository, keyId);
    requireValue(
      credentials || !/^(git@|ssh:\/\/)/.test(repository),
      'SSH 凭据服务不可用。',
      503,
    );
    try {
      const result = await operation(credentials);
      if (credentials) await this.ssh!.used(credentials.keyId);
      return result;
    } catch (e) {
      if (credentials && e instanceof ProcessExitError) {
        if (
          /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .*host key is known/.test(
            e.output,
          )
        )
          throw new PlatformError(
            400,
            `主机 ${credentials.host} 未受信任或主机公钥已变化`,
          );
        if (/Permission denied|Authentication failed/.test(e.output))
          throw new PlatformError(
            400,
            'SSH 认证失败，请检查项目密钥和 Deploy Key 授权。',
          );
      }
      throw e;
    } finally {
      if (credentials)
        await rm(credentials.directory, { recursive: true, force: true });
    }
  }
  async scanHost(addresses: string[], port: number) {
    await this.initialize();
    const id = `scan-${crypto.randomUUID()}`,
      dir = join(this.root, id);
    await mkdir(dir, { mode: 0o700 });
    let confirmed = true;
    try {
      return await this.command(
        id,
        dir,
        ['ssh-keyscan', '-T', '5', '-p', String(port), ...addresses],
        undefined,
        undefined,
        this.config.gitNetwork,
        10_000,
      );
    } catch (error) {
      if (error instanceof ExecutionUnconfirmedError) {
        confirmed = false;
        throw error;
      }
      throw Object.assign(
        new Error('SSH 主机扫描失败或超时，请检查地址、端口和出口策略。'),
        { statusCode: 400 },
      );
    } finally {
      if (confirmed) await rm(dir, { recursive: true, force: true });
    }
  }
  async fetch(project: Project, branch: string) {
    await this.initialize();
    const id = `fetch-${crypto.randomUUID()}`;
    const dir = join(this.root, id);
    await mkdir(dir, { mode: 0o700 });
    let confirmed = true;
    try {
      const args = [
        'git',
        '-c',
        'protocol.file.allow=never',
        'ls-remote',
        '--heads',
        project.repository,
      ];
      const refs = await this.remote(
        project.repository,
        project.sshKeyId,
        (credentials) =>
          this.command(
            id,
            dir,
            args,
            undefined,
            undefined,
            this.config.gitNetwork,
            120_000,
            credentials,
          ),
      );
      const branches = refs
        .split('\n')
        .filter(Boolean)
        .map((s) => s.split('\t')[1]?.replace(/^refs\/heads\//, ''))
        .filter((s): s is string => !!s);
      const sha = refs
        .split('\n')
        .find((s) => s.endsWith(`\trefs/heads/${branch}`))
        ?.split('\t')[0];
      requireValue(
        sha && /^[a-f0-9]{40,64}$/.test(sha),
        '所选分支不存在或无法拉取。',
        400,
      );
      await this.command(id, dir, ['git', 'init', 'repo']);
      await this.remote(project.repository, project.sshKeyId, (credentials) =>
        this.command(
          id,
          dir,
          [
            'git',
            '-C',
            'repo',
            '-c',
            'protocol.file.allow=never',
            'fetch',
            '--depth=1',
            '--no-tags',
            project.repository,
            sha,
          ],
          undefined,
          undefined,
          this.config.gitNetwork,
          120_000,
          credentials,
        ),
      );
      const message = (
        await this.command(id, dir, [
          'git',
          '-C',
          'repo',
          'log',
          '-1',
          '--format=%s',
          'FETCH_HEAD',
        ])
      ).trim();
      return { fetched: { branch, sha, message, at: Date.now() }, branches };
    } catch (error) {
      if (error instanceof ExecutionUnconfirmedError) confirmed = false;
      throw error;
    } finally {
      if (confirmed) await rm(dir, { recursive: true, force: true });
    }
  }
  async log(id: number, offset: number) {
    let text = '';
    try {
      text = await readFile(join(this.directory(id), 'build.log'), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const lines = text
      .slice(0, text.lastIndexOf('\n') + 1)
      .split('\n')
      .filter(Boolean)
      .map((s) => JSON.parse(s) as LogLine);
    return {
      lines: lines.slice(offset, offset + 500),
      nextOffset: Math.min(lines.length, offset + 500),
    };
  }
  async execute(
    job: Job & { repository?: string },
    signal: AbortSignal,
    phase: (n: 0 | 1 | 2) => Promise<void>,
  ) {
    const dir = this.directory(job.id);
    await mkdir(dir, { mode: 0o700 });
    await syncDirectory(this.root);
    const log = await open(join(dir, 'build.log'), 'a', 0o600);
    let logBytes = (await log.stat()).size;
    const logAbort = new AbortController();
    signal = AbortSignal.any([signal, logAbort.signal]);
    let logFailure: Error | undefined;
    let pending = Promise.resolve(),
      current: 0 | 1 | 2 = 0,
      buffered = '';
    const append = (text: string, kind?: LogLine['kind']) => {
      const entry =
        JSON.stringify({ step: current, text, ...(kind ? { kind } : {}) }) +
        '\n';
      logBytes += Buffer.byteLength(entry);
      requireValue(logBytes <= 10 * 1024 * 1024, '日志超出 10 MB 限额。');
      pending = pending
        .then(async () => {
          if (logFailure) throw logFailure;
          await log.write(entry);
        })
        .catch((error) => {
          logFailure = error as Error;
          logAbort.abort();
        });
    };
    const output = (text: string, _error: boolean) => {
      buffered += text;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines)
        append(line, line.startsWith('+ ') ? 'cmd' : undefined);
    };
    const command = async (
      args: string[],
      network?: string,
      credentials?: SshCredentials,
    ) => {
      const result = await this.command(
        job.id,
        dir,
        args,
        signal,
        output,
        network,
        job.snapshot.timeout * 60_000,
        credentials,
      );
      if (buffered) {
        append(buffered);
        buffered = '';
      }
      await pending;
      return result;
    };
    try {
      append(`$ git fetch ${job.branch}@${job.sha}`, 'cmd');
      await phase(0);
      await command(['git', 'init', 'source']);
      // File transport is prohibited for user repositories. Tests may use a local HTTP Git fixture.
      await this.remote(job.repository!, job.snapshot.sshKeyId, (credentials) =>
        command(
          [
            'git',
            '-C',
            'source',
            '-c',
            'protocol.file.allow=never',
            'fetch',
            '--depth=1',
            '--no-tags',
            job.repository!,
            job.sha,
          ],
          this.config.gitNetwork,
          credentials,
        ),
      );
      await command([
        'git',
        '-C',
        'source',
        '-c',
        'advice.detachedHead=false',
        'checkout',
        '--detach',
        job.sha,
      ]);
      const source = join(dir, 'source');
      const workdir = await safePath(source, job.snapshot.workdir);
      requireValue((await stat(workdir)).isDirectory(), '工作目录不存在。');
      await writeFile(join(dir, 'build.sh'), job.snapshot.buildScript, {
        mode: 0o600,
        flag: 'wx',
      });
      current = 1;
      await phase(1);
      append(`$ cd ${job.snapshot.workdir} && bash -e build.sh`, 'cmd');
      if (this.mode === 'docker') {
        const wd = `/workspace/source/${job.snapshot.workdir.slice(2)}`;
        await command([
          'bash',
          '-c',
          'cd -- "$1" && exec bash -ex /runner/build.sh',
          'builder',
          wd,
        ]);
      } else {
        await runProcess('bash', ['-ex', join(dir, 'build.sh')], {
          cwd: workdir,
          markerDirectory: dir,
          homeDirectory: join(dir, '.home'),
          signal,
          output,
          timeout: job.snapshot.timeout * 60_000,
        });
        if (buffered) {
          append(buffered);
          buffered = '';
        }
        await pending;
      }
      requireValue(!signal.aborted, '任务已请求停止。');
      current = 2;
      await phase(2);
      append('$ collect artifacts', 'cmd');
      const artifactSource = await safePath(workdir, job.snapshot.artifactPath);
      const staging = join(dir, 'staging');
      const files = await collectArtifacts(dir, artifactSource, staging);
      requireValue(!signal.aborted, '任务已请求停止。');
      await rename(staging, join(dir, 'artifacts'));
      await syncDirectory(dir);
      const final = files.map((f) => ({
        ...f,
        storageKey: f.storageKey.replace(/^staging\//, 'artifacts/'),
      }));
      // Manifest is the durable boundary between file publication and the database commit.
      const manifest = await open(join(dir, 'manifest.tmp'), 'wx', 0o600);
      try {
        await manifest.writeFile(JSON.stringify(final));
        await manifest.sync();
      } finally {
        await manifest.close();
      }
      await rename(join(dir, 'manifest.tmp'), join(dir, 'manifest.json'));
      await syncDirectory(dir);
      append('构建成功，产物已收集', 'ok');
      await pending;
      if (logFailure) throw logFailure;
      return final;
    } catch (e) {
      append(e instanceof Error ? e.message : '构建失败。', 'error');
      await pending;
      throw e;
    } finally {
      await pending;
      await log.sync();
      await log.close();
    }
  }
  private async stopLocal(directory: string) {
    // Local child identity is recorded separately; an unconfirmed process keeps its slot.
    const marker = join(directory, 'process');
    try {
      const [pid, started] = (await readFile(marker, 'utf8'))
        .trim()
        .split('\n');
      requireValue(
        pid !== 'pending' && pid && started,
        '本机构建进程身份尚未确认，保留槽位待核对。',
        503,
      );
      const data = { pid: Number(pid), started: started.trim() };
      let actual = '';
      try {
        actual = (
          await runProcess('ps', ['-p', String(data.pid), '-o', 'lstart='])
        ).trim();
      } catch (e) {
        if (!(e instanceof Error) || !e.message.includes('退出码 1')) throw e;
      }
      if (actual === data.started) {
        process.kill(-data.pid, 'SIGKILL');
        await confirmGroupStopped(data.pid);
      } else if (await groupAlive(data.pid)) {
        throw new ExecutionUnconfirmedError(
          '原任务进程组仍存在但身份无法确认，保留槽位。',
        );
      }
      await rm(marker, { force: true });
    } catch (e) {
      if (
        !['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')
      )
        throw e;
    }
  }
  async cleanupTransient() {
    for (const name of await readdir(this.root)) {
      if (!/^(fetch|scan)-[a-f0-9-]{36}$/.test(name)) continue;
      if (this.mode === 'local') await this.stopLocal(join(this.root, name));
      else {
        const ids = (
          await runProcess('docker', [
            'ps',
            '-aq',
            '--filter',
            `name=^/${this.name(name)}$`,
          ])
        ).trim();
        if (ids) await runProcess('docker', ['rm', '--force', this.name(name)]);
      }
      await rm(join(this.root, name), { recursive: true, force: true });
    }
  }
  async recover(job: Job) {
    if (this.mode === 'docker') {
      const name = this.name(job.id);
      const ids = (
        await runProcess('docker', ['ps', '-aq', '--filter', `name=^/${name}$`])
      ).trim();
      if (ids) await runProcess('docker', ['rm', '--force', name]);
    } else {
      await this.stopLocal(this.directory(job.id));
    }
    try {
      const files = JSON.parse(
        await readFile(join(this.directory(job.id), 'manifest.json'), 'utf8'),
      ) as { name: string; size: number; sha256: string; storageKey: string }[];
      for (const f of files) {
        const path = await safePath(this.directory(job.id), f.storageKey);
        const hash = createHash('sha256');
        const file = await open(path, 'r');
        let size = 0;
        try {
          for await (const chunk of file.createReadStream({
            autoClose: false,
          })) {
            size += chunk.length;
            hash.update(chunk);
          }
        } finally {
          await file.close();
        }
        requireValue(
          size === f.size && hash.digest('hex') === f.sha256,
          '恢复核验发现产物损坏。',
        );
      }
      return files;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async remove(id: number) {
    await rm(this.directory(id), { recursive: true, force: true });
  }
  async artifact(id: number, key: string) {
    return safePath(this.directory(id), key);
  }
}
