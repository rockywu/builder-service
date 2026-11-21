import {
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
  stat,
  open,
  readdir,
  rmdir,
  chmod,
  realpath,
} from 'node:fs/promises';
import { join, resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  runProcess,
  nodeRegistryEnvironment,
  groupAlive,
  confirmGroupStopped,
  ExecutionUnconfirmedError,
  ProcessExitError,
} from './process.js';
import { safePath, collectArtifacts, syncDirectory } from './paths.js';
import {
  artifactFile,
  versionOutput,
  ensureProjectDirectories,
  ensureDirectory,
  projectDirectory,
  buildDirectoryExists,
  resolveBuildDirectory,
} from './build-directory.js';
import type { AppConfig } from '../config.js';
import type {
  GitRefType,
  Job,
  Project,
  LogLine,
} from '../modules/platform/types.js';
import { requireValue, PlatformError } from '../modules/platform/errors.js';
import { SshService, sshCommand } from './ssh.js';
import type { SshCredentials } from './ssh.js';

const remoteRef = (type: GitRefType, name: string) =>
  `refs/${type === 'tag' ? 'tags' : 'heads'}/${name}`;
const fetchRevision = (
  worktree: string,
  repository: string,
  revision: string,
) => [
  'git',
  '-C',
  worktree,
  '-c',
  'protocol.file.allow=never',
  'fetch',
  '--depth=1',
  '--no-tags',
  '--',
  repository,
  revision,
];
const fetchedCommit = (worktree: string) => [
  'git',
  '-C',
  worktree,
  'rev-parse',
  '--verify',
  'FETCH_HEAD^{commit}',
];
const missingRemoteRef = (error: unknown) =>
  error instanceof ProcessExitError &&
  /couldn't find remote ref/.test(error.output);

export class BuildRunner {
  readonly root: string;
  readonly mode: 'local' | 'docker';
  workspaceRoot: string;
  constructor(
    readonly config: AppConfig,
    readonly ssh?: SshService,
  ) {
    this.root = join(config.dataDirectory, 'builds');
    this.mode = config.runner ?? 'local';
    this.workspaceRoot = this.root;
    requireValue(
      process.env.NODE_ENV !== 'production' || this.mode === 'docker',
      '生产环境必须使用 Docker 隔离构建。',
      503,
    );
  }
  name(id: number | string) {
    return `builder-${createHash('sha256').update(resolve(this.root)).digest('hex').slice(0, 12)}-${id}`;
  }
  directory(job: Job) {
    return resolveBuildDirectory(this.root, job);
  }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await buildDirectoryExists(this.root);
    await chmod(this.root, 0o700);
    await syncDirectory(this.config.dataDirectory);
    if (this.config.workspaceDirectory && this.mode === 'local') {
      const base = this.config.workspaceDirectory;
      await mkdir(base, { recursive: true, mode: 0o700 });
      await buildDirectoryExists(base);
      const access = await stat(base);
      requireValue(
        access.uid === process.getuid?.() && (access.mode & 0o077) === 0,
        '请为独立工作区指定服务账号专用的私有目录（0700）。',
      );
      const canonicalBase = await realpath(base);
      const data = await realpath(this.config.dataDirectory);
      requireValue(
        canonicalBase !== data && !canonicalBase.startsWith(data + '/'),
        '独立工作区必须位于 DATA_DIR 之外。',
      );
      const namespace = createHash('sha256')
        .update(data)
        .digest('hex')
        .slice(0, 16);
      const root = join(canonicalBase, namespace);
      await ensureDirectory(root);
      const info = await stat(root);
      requireValue(
        info.uid === process.getuid?.() && (info.mode & 0o077) === 0,
        '独立工作区必须由服务账号所有，且仅该账号可访问。',
      );
      this.workspaceRoot = root;
    }
    if (this.mode === 'docker') {
      requireValue(
        (process.getuid?.() ?? 0) > 0,
        'Docker 构建服务必须以非 root 账号运行。',
        503,
      );
      requireValue(
        this.config.buildNetwork === 'none',
        '构建容器网络必须为 none，依赖下载通过专用代理。',
        503,
      );
      requireValue(
        this.config.gitNetwork &&
          this.config.gitNetwork !== 'bridge' &&
          this.config.gitNetwork !== 'host',
        'Git 容器需要配置禁止管理网和元数据访问的专用网络。',
        503,
      );
      if (this.config.dependencyProxyVolume) {
        requireValue(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(this.config.dependencyProxyVolume),
          '依赖代理卷名称无效。', 503);
      }
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
    task?: { history: string; workspace: string; nodeRegistry?: string },
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
        markerDirectory: task?.history ?? directory,
        ...(credentials ? { gitSshCommand: sshCommand(credentials) } : {}),
        ...(signal ? { signal } : {}),
        ...(output ? { output } : {}),
        timeout,
      });
    }
    const name = this.name(id);
    const relay = credentials?.host === 'gitee.com' && credentials.port === 22 &&
      (network ?? 'none') === 'none' ? this.config.giteeRelayVolume : undefined;
    if (relay) requireValue(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(relay), 'Git 中继卷名称无效。', 503);
    if (args[0] === 'git' && (args.includes('ls-remote') || args.includes('fetch')) &&
        (network ?? 'none') === 'none' && !relay)
      throw new PlatformError(503, '远端拉取需要配置 Git 专用网络，或为 gitee.com SSH 启用专用中继。');
    const dependencyProxy = args[0] === 'bash' && task && !credentials && !network
      ? this.config.dependencyProxyVolume : undefined;
    const newHostFile = '/run/builder-known-hosts';
    const dns =
      network && network !== 'none' && network === this.config.gitNetwork
        ? (this.config.gitDns ?? []).flatMap((address) => ['--dns', address])
        : [];
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
          ...dns,
          ...(args[0] === 'bash' ? Object.entries(nodeRegistryEnvironment(task?.nodeRegistry))
            .flatMap(([key, value]) => ['--env', `${key}=${value}`]) : []),
          ...(relay ? ['--mount', `type=volume,src=${relay},dst=/run/builder-gitee,readonly`] : []),
          ...(dependencyProxy ? [
            '--mount', `type=volume,src=${dependencyProxy},dst=/run/builder-dependencies,readonly`,
          ] : []),
          ...(credentials
            ? [
                '--mount',
                `type=bind,src=${credentials.directory},dst=/run/creds,readonly`,
                ...(credentials.firstConnection
                  ? [
                      '--mount',
                      `type=bind,src=${join(credentials.directory, 'known_hosts')},dst=${newHostFile}`,
                    ]
                  : []),
              ]
            : []),
          '--tmpfs',
          '/tmp:rw,nosuid,nodev,size=256m',
          ...(args[0] === 'bash'
            ? [
                ...(task
                  ? [
                      '--mount',
                      `type=bind,src=${join(task.workspace, 'home')},dst=/build-home`,
                      '--mount',
                      `type=bind,src=${join(task.history, 'output-draft')},dst=/output`,
                      '--env',
                      'OUTPUT_DIR=/output',
                      '--mount',
                      `type=bind,src=${join(task.workspace, 'gitdb', '.git')},dst=/workspace/workspace/gitdb/.git,readonly`,
                    ]
                  : []),
                '--mount',
                `type=bind,src=${join(task ? dirname(task.workspace) : directory, 'source')},dst=/workspace/source`,
                '--mount',
                `type=bind,src=${join(task?.history ?? directory, 'build.sh')},dst=/runner/build.sh,readonly`,
              ]
            : [
                '--mount',
                `type=bind,src=${directory},dst=/workspace`,
                ...(task && directory === task.workspace
                  ? [
                      '--mount',
                      `type=bind,src=${join(dirname(task.workspace), 'source')},dst=/source`,
                    ]
                  : []),
              ]),
          '--workdir',
          '/workspace',
          '--env',
          args[0] === 'bash' && task ? 'HOME=/build-home' : 'HOME=/tmp',
          '--env',
          'GIT_CONFIG_NOSYSTEM=1',
          '--env',
          'GIT_CONFIG_GLOBAL=/dev/null',
          '--env',
          'GIT_TERMINAL_PROMPT=0',
          '--env',
          `GIT_SSH_COMMAND=${credentials ? sshCommand(credentials, '/run/creds', credentials.firstConnection ? newHostFile : undefined) + (relay ? " -o 'ProxyCommand=node /usr/local/lib/builder/git-relay-client.cjs'" : '') : 'ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=none -o IdentityAgent=none -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes'}`,
          this.config.buildImage ?? 'builder-runtime:node24',
          ...(dependencyProxy ? ['node', '/usr/local/lib/builder/with-dependency-proxy.mjs'] : []),
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
      if (credentials) {
        await this.ssh!.rememberHost(credentials);
        await this.ssh!.used(credentials.keyId);
      }
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
            `主机 ${credentials.host} 的 SSH 公钥与已记录的公钥不一致。请联系管理员核实。`,
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
  async testFetch(project: Project, refType: GitRefType, name: string) {
    await this.initialize();
    const id = `fetch-${project.id}-${crypto.randomUUID()}`;
    const dir = join(this.root, id);
    await mkdir(dir, { mode: 0o700 });
    let confirmed = true;
    const ref = remoteRef(refType, name);
    const git = (
      args: string[],
      credentials?: SshCredentials,
      network?: string,
    ) =>
      this.command(
        id,
        dir,
        args,
        undefined,
        undefined,
        network,
        120_000,
        credentials,
      );
    try {
      await git(['git', 'init', 'repo']);
      return await this.remote(
        project.repository,
        project.sshKeyId,
        async (credentials) => {
          const refs = await git(
            [
              'git',
              '-c',
              'protocol.file.allow=never',
              'ls-remote',
              '--refs',
              '--heads',
              '--tags',
              '--',
              project.repository,
            ],
            credentials,
            this.config.gitNetwork,
          );
          const branches: string[] = [],
            tags: string[] = [];
          for (const line of refs.split('\n')) {
            const [sha, remote] = line.trim().split('\t');
            if (!sha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) continue;
            if (remote?.startsWith('refs/heads/'))
              branches.push(remote.slice(11));
            if (remote?.startsWith('refs/tags/')) tags.push(remote.slice(10));
          }
          requireValue(
            (refType === 'tag' ? tags : branches).includes(name),
            refType === 'tag' ? '远端标签不存在。' : '远端分支不存在。',
            404,
          );
          await git(
            fetchRevision('repo', project.repository, ref),
            credentials,
            this.config.gitNetwork,
          );
          // An annotated tag must peel to a commit; a tag on a tree/blob cannot build.
          await git(fetchedCommit('repo'));
          return { ok: true as const, branches, tags };
        },
      );
    } catch (error) {
      if (error instanceof ExecutionUnconfirmedError) confirmed = false;
      if (missingRemoteRef(error))
        throw new PlatformError(404, '所选分支或标签已不存在，请重新选择。');
      if (error instanceof ProcessExitError)
        throw new PlatformError(
          400,
          '测试拉取失败，请检查仓库访问权限和所选分支或标签。',
        );
      throw error;
    } finally {
      if (confirmed) await rm(dir, { recursive: true, force: true });
    }
  }
  async fetch(project: Project, branch: string) {
    await this.initialize();
    const id = `fetch-${project.id}-${crypto.randomUUID()}`;
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
  async log(job: Job, offset: number) {
    let text = '';
    try {
      text = await readFile(
        join(await this.directory(job), 'build.log'),
        'utf8',
      );
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
    job: Job,
    signal: AbortSignal,
    phase: (n: 0 | 1 | 2) => Promise<void>,
    recordCommit?: (sha: string, message: string) => Promise<void>,
  ) {
    const project = await ensureProjectDirectories(this.root, job.projectId);
    const checkout = projectDirectory(this.workspaceRoot, job.projectId);
    if (checkout !== project) {
      await ensureDirectory(checkout);
      // Both directories contain relative Git links. Move them before cache lookup;
      // a restart after either rename can finish the other without losing offline commits.
      const moves = [];
      for (const name of ['workspace', 'source']) {
        const old = join(project, name);
        if (!(await buildDirectoryExists(old))) continue;
        const target = join(checkout, name);
        requireValue(
          !(await buildDirectoryExists(target)),
          '新旧工作区目录冲突。',
          409,
        );
        moves.push({ old, target });
      }
      if (moves.length) {
        requireValue(
          (await stat(project)).dev === (await stat(checkout)).dev,
          '迁移现有缓存需要位于同一文件系统的工作区。',
          409,
        );
        await syncDirectory(this.workspaceRoot);
        for (const { old, target } of moves) {
          await rename(old, target);
          await syncDirectory(checkout);
          await syncDirectory(project);
        }
      }
    }
    const workspace = join(checkout, 'workspace');
    const source = join(checkout, 'source');
    const gitdb = join(workspace, 'gitdb');
    const home = join(workspace, 'home');
    const dir = await this.directory(job);
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
      cwd = workspace,
    ) => {
      const result = await this.command(
        job.id,
        cwd,
        args,
        signal,
        output,
        network,
        job.snapshot.timeout * 60_000,
        credentials,
        { history: dir, workspace, nodeRegistry: job.snapshot.nodeRegistry ?? '' },
      );
      if (buffered) {
        append(buffered);
        buffered = '';
      }
      await pending;
      return result;
    };
    try {
      const ref = job.refType ? remoteRef(job.refType, job.branch) : job.sha;
      await phase(0);
      const identity = JSON.stringify([
        job.repository,
        job.snapshot.sshKeyId,
        job.refType ?? 'sha',
        ref,
        this.mode,
        this.mode === 'docker' ? this.config.buildImage : null,
        ...(job.snapshot.nodeRegistry ? [job.snapshot.nodeRegistry] : []),
      ]);
      const statePath = join(workspace, 'cache.json');
      let cache: { identity: string; sha: string } | undefined;
      if (await buildDirectoryExists(workspace)) {
        try {
          cache = JSON.parse(
            await readFile(await safePath(workspace, 'cache.json'), 'utf8'),
          );
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
      const reusable =
        cache?.identity === identity &&
        /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(cache.sha) &&
        (await buildDirectoryExists(source)) &&
        (await buildDirectoryExists(gitdb)) &&
        (await buildDirectoryExists(join(gitdb, '.git')));
      if (!reusable) {
        // This directory contains only disposable project workspace data, never job history.
        await rm(workspace, { force: true, recursive: true });
        await rm(source, { force: true, recursive: true });
        await ensureDirectory(workspace);
        await ensureDirectory(source);
        await ensureDirectory(gitdb);
        await command(['git', 'init', '.'], undefined, undefined, gitdb);
      }
      const keepDependencies = reusable && job.snapshot.useCache === true;
      const git = (...args: string[]) =>
        command([
          'git',
          '--git-dir=gitdb/.git',
          '--work-tree=../source',
          '-c',
          'core.hooksPath=/dev/null',
          ...args,
        ]);
      // Never let a script-provided .git pointer/config become the repository used with credentials.
      await rm(join(source, '.git'), { recursive: true, force: true });
      await writeFile(
        join(source, '.git'),
        'gitdir: ../workspace/gitdb/.git\n',
        { flag: 'wx', mode: 0o600 },
      );
      let sha: string;
      if (!job.refType && keepDependencies && cache!.sha === job.sha) {
        sha = job.sha;
        append(`使用已固定的提交：${sha}`);
      } else {
        append(
          `$ git fetch ${job.refType ? ref : job.branch + '@' + job.sha}`,
          'cmd',
        );
        if (!keepDependencies) {
          await rm(statePath, { force: true });
          if (reusable) {
            await git('reset', '--hard', cache!.sha);
            await git('clean', '-ffdX');
          }
          await rm(home, { recursive: true, force: true });
        }
        try {
          await this.remote(
            job.repository!,
            job.snapshot.sshKeyId,
            (credentials) =>
              command(
                fetchRevision('.', job.repository!, ref),
                this.config.gitNetwork,
                credentials,
                gitdb,
              ),
          );
        } catch (error) {
          if (job.refType && missingRemoteRef(error))
            throw new PlatformError(
              404,
              '远端分支或标签已不存在，无法开始构建。',
            );
          throw error;
        }
        sha = (
          await command(fetchedCommit('.'), undefined, undefined, gitdb)
        ).trim();
        requireValue(
          /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha) &&
            (job.refType || sha === job.sha),
          '拉取结果与指定提交不一致。',
        );
      }
      await git('checkout', '--force', '--detach', sha);
      if (!keepDependencies) await git('clean', '-ffdX');
      if (!keepDependencies || cache!.sha !== sha) {
        await rm(statePath, { force: true });
        await writeFile(statePath, JSON.stringify({ identity, sha }), {
          mode: 0o600,
          flag: 'wx',
        });
      }
      await ensureDirectory(home);
      if (job.refType) {
        const message = (await git('log', '-1', '--format=%s', sha)).trim();
        requireValue(recordCommit, '无法记录实际构建提交。', 503);
        await recordCommit(sha, message);
        append(`已从远端更新 ${ref}，本次构建提交：${sha}`);
      }
      const workdir = await safePath(source, job.snapshot.workdir);
      requireValue((await stat(workdir)).isDirectory(), '工作目录不存在。');
      await writeFile(join(dir, 'build.sh'), job.snapshot.buildScript, {
        mode: 0o600,
        flag: 'wx',
      });
      const draft = join(dir, 'output-draft');
      await mkdir(draft, { mode: 0o700 });
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
          homeDirectory: home,
          outputDirectory: draft,
          nodeRegistry: job.snapshot.nodeRegistry ?? '',
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
      const outputDraft = await safePath(dir, 'output-draft');
      const direct = (await readdir(outputDraft)).length > 0;
      const artifactSource = direct
        ? outputDraft
        : await safePath(workdir, job.snapshot.artifactPath);
      const staging = join(dir, 'staging');
      const files = await collectArtifacts(dir, artifactSource, staging, true);
      requireValue(!signal.aborted, '任务已请求停止。');
      const parent = await safePath(project, 'outputs');
      const dest = versionOutput(this.root, job);
      requireValue(
        !(await buildDirectoryExists(dest)),
        '该任务的输出目录已存在。',
        409,
      );
      await rename(staging, dest);
      await syncDirectory(parent);
      await rm(draft, { recursive: true, force: true });
      const final = files.map((f) => ({
        ...f,
        storageKey: 'outputs/' + f.name,
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
  async cleanupTransient(projectId?: number) {
    if (!(await buildDirectoryExists(this.root))) return;
    for (const name of await readdir(this.root)) {
      const match =
        /^(?:fetch(?:-([1-9]\d*))?|scan)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.exec(
          name,
        );
      if (!match || (projectId !== undefined && match[1] !== String(projectId)))
        continue;
      if (!(await buildDirectoryExists(join(this.root, name)))) continue;
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
      await syncDirectory(this.root);
    }
  }
  async recover(job: Job) {
    const directory = await this.directory(job);
    if (this.mode === 'docker') {
      const name = this.name(job.id);
      const ids = (
        await runProcess('docker', ['ps', '-aq', '--filter', `name=^/${name}$`])
      ).trim();
      if (ids) await runProcess('docker', ['rm', '--force', name]);
    } else {
      await this.stopLocal(directory);
    }
    try {
      const files = JSON.parse(
        await readFile(join(directory, 'manifest.json'), 'utf8'),
      ) as { name: string; size: number; sha256: string; storageKey: string }[];
      for (const f of files) {
        const path = await artifactFile(this.root, job, f.storageKey);
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
  async removeWorkspace(id: number) {
    if (!(await buildDirectoryExists(this.root))) return;
    const project = projectDirectory(this.root, id);
    if (this.workspaceRoot !== this.root) {
      const checkout = projectDirectory(this.workspaceRoot, id);
      if (await buildDirectoryExists(checkout)) {
        await rm(join(checkout, 'source'), { recursive: true, force: true });
        await rm(join(checkout, 'workspace'), { recursive: true, force: true });
        await rmdir(checkout);
        await syncDirectory(this.workspaceRoot);
      }
    }
    if (!(await buildDirectoryExists(project))) return;
    await rm(join(project, 'source'), { recursive: true, force: true });
    await rm(join(project, 'workspace'), { recursive: true, force: true });
    // Refuse to remove unexpected history; only the verified jobs have been deleted.
    try {
      await rmdir(join(project, 'jobs'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    try {
      await rmdir(join(project, 'outputs'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await rmdir(project);
    await syncDirectory(this.root);
  }
  async remove(job: Job) {
    const dir = await this.directory(job);
    const project = projectDirectory(this.root, job.projectId);
    if (
      (await buildDirectoryExists(this.root)) &&
      (await buildDirectoryExists(project)) &&
      (await buildDirectoryExists(join(project, 'outputs')))
    ) {
      await rm(versionOutput(this.root, job), { recursive: true, force: true });
      await syncDirectory(join(project, 'outputs'));
    }
    await rm(dir, { recursive: true, force: true });
    const parent = dirname(dir);
    if (await buildDirectoryExists(parent)) await syncDirectory(parent);
  }
  async artifact(job: Job, key: string) {
    return artifactFile(this.root, job, key);
  }
}
