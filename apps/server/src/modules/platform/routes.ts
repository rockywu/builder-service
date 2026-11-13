import type { FastifyInstance, FastifyRequest } from 'fastify';
import { mkdir, readFile, opendir, lstat, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { hashPassword } from '../auth/password.js';
import { PlatformService } from './service.js';
import type { State } from './service.js';
import type { Job, Project, ProjectInput, Release, User } from './types.js';
import { requireValue } from './errors.js';
import { relativePath, syncDirectory } from '../../tools/paths.js';
import type { DatabaseClient } from '../../db/client.js';
import type { AppConfig } from '../../config.js';
import { normalizeHost, publicAddresses, sshHostOf } from '../../tools/ssh.js';
import type { SshKey, ScannedHostKey } from './types.js';

const testStatuses = ['passed', 'pending', 'testing', 'rejected'];
const actor = (r: FastifyRequest) => r.sessionContext!.user;
function object(value: unknown): Record<string, unknown> {
  requireValue(
    value && typeof value === 'object' && !Array.isArray(value),
    '请求数据无效。',
  );
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, min: number, max: number): string {
  requireValue(
    typeof value === 'string' &&
      value.trim().length >= min &&
      value.length <= max &&
      !value.includes('\0'),
    `${label}长度或格式无效。`,
  );
  return value;
}
function integer(value: unknown, min: number, max: number, label: string) {
  const n = Number(value);
  requireValue(
    Number.isSafeInteger(n) && n >= min && n <= max,
    `${label}超出允许范围。`,
  );
  return n;
}
function id(r: FastifyRequest) {
  return integer(object(r.params).id, 1, Number.MAX_SAFE_INTEGER, '编号');
}
function branch(value: unknown) {
  const b = text(value, '分支', 1, 200);
  requireValue(
    !b.startsWith('-') &&
      !/[\s~^:?*\[\\]/.test(b) &&
      !b.includes('..') &&
      !b.includes('@{') &&
      !b.endsWith('/') &&
      !b.endsWith('.') &&
      !b.endsWith('.lock'),
    '分支格式无效。',
  );
  return b;
}
function admin(r: FastifyRequest) {
  requireValue(actor(r).role === 'admin', '需要管理员权限。', 403);
}
const publicRelease = (r: Release) => ({
  id: r.id,
  jobId: r.jobId,
  projectId: r.projectId,
  version: r.version,
  branch: r.branch,
  sha: r.sha,
  createdAt: r.createdAt,
  testStatus: r.testStatus,
  revision: r.revision,
  artifacts: r.artifacts,
});
const publicProject = (p: Project) => ({
  id: p.id,
  slug: p.slug,
  name: p.name,
  description: p.description,
  icon: p.icon,
});

export async function registerPlatform(
  app: FastifyInstance,
  db: DatabaseClient,
  config: AppConfig,
) {
  const service = new PlatformService(db, config);
  await service.start();
  // Only remove old unreferenced generated icons, never user paths or active references.
  const iconsDirectory = join(config.dataDirectory, 'icons');
  try {
    const referenced = new Set(
      (await service.command<Project[]>('projects')).map((p) => p.icon),
    );
    const directory = await opendir(iconsDirectory);
    let examined = 0;
    for await (const entry of directory) {
      if (++examined > 500) break;
      if (
        !entry.isFile() ||
        !/^[a-f0-9-]{36}\.png$/.test(entry.name) ||
        referenced.has(`/api/public/icons/${entry.name}`)
      )
        continue;
      const path = join(iconsDirectory, entry.name);
      const info = await lstat(path);
      if (
        !info.isSymbolicLink() &&
        Date.now() - info.mtimeMs > 24 * 60 * 60_000
      )
        await rm(path);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      app.log.warn('未引用图标清理未完成，文件已保留。');
  }
  app.addHook('onClose', async () => service.close());
  app.decorateRequest('platformMutation', false);
  app.addHook('preHandler', async (r) => {
    if (!r.url.startsWith('/api/') || ['GET', 'HEAD'].includes(r.method))
      return;
    requireValue(!service.busy, '备份正在进行，请稍后重试。', 409);
    if (!r.url.startsWith('/api/maintenance/backup')) {
      service.mutations++;
      (r as FastifyRequest & { platformMutation: boolean }).platformMutation =
        true;
    }
  });
  app.addHook('onResponse', async (r) => {
    const tracked = r as FastifyRequest & { platformMutation: boolean };
    if (tracked.platformMutation) {
      tracked.platformMutation = false;
      service.mutations--;
    }
  });
  const list = async <T>(action: string, r: FastifyRequest) =>
    service.command<T>(action, {}, actor(r));
  function paginate<T>(rows: T[], r: FastifyRequest) {
    const q = object(r.query);
    const offset = integer(q.offset ?? 0, 0, 1_000_000, '偏移量'),
      limit = integer(q.limit ?? 100, 1, 100, '每页数量');
    return {
      items: rows.slice(offset, offset + limit),
      total: rows.length,
      nextOffset: Math.min(rows.length, offset + limit),
    };
  }
  function sshAdmin(r: FastifyRequest) {
    admin(r);
    service.ssh.secret();
  }
  function keyName(value: unknown) {
    const name = text(value, '密钥名称', 1, 40).trim();
    requireValue(!/[\x00-\x1f\x7f]/.test(name), '密钥名称格式无效。');
    return name;
  }
  function hostInput(r: FastifyRequest) {
    const body = object(r.body);
    return {
      body,
      host: normalizeHost(body.host),
      port: integer(body.port ?? 22, 1, 65535, '端口'),
    };
  }
  app.get('/api/ssh-keys', async (r) => {
    sshAdmin(r);
    return paginate(await list<SshKey[]>('sshKeys', r), r);
  });
  app.post('/api/ssh-keys', { bodyLimit: 24 * 1024 }, async (r) => {
    sshAdmin(r);
    const body = object(r.body),
      name = keyName(body.name);
    requireValue(
      body.mode === 'generate' || body.mode === 'import',
      '密钥创建方式无效。',
    );
    const material = await service.ssh.keyMaterial(
      name,
      body.mode,
      body.privateKey,
    );
    return service.command(
      'saveSshKey',
      { input: { name, ...material } },
      actor(r),
    );
  });
  app.patch('/api/ssh-keys/:id', { bodyLimit: 24 * 1024 }, async (r) => {
    sshAdmin(r);
    const body = object(r.body),
      name = keyName(body.name);
    const key = (await list<SshKey[]>('sshKeys', r)).find(
      (k) => k.id === id(r),
    );
    requireValue(key, '密钥不存在。', 404);
    requireValue(
      body.privateKey === undefined || key.source === 'imported',
      '服务端生成的密钥不能更换私钥。',
    );
    const material =
      body.privateKey === undefined
        ? {}
        : await service.ssh.keyMaterial(name, 'import', body.privateKey);
    return service.command(
      'saveSshKey',
      { id: key.id, input: { name, ...material } },
      actor(r),
    );
  });
  app.delete('/api/ssh-keys/:id', async (r, reply) => {
    sshAdmin(r);
    await service.command('deleteSshKey', { id: id(r) }, actor(r));
    return reply.code(204).send();
  });
  app.get('/api/known-hosts', async (r) => {
    sshAdmin(r);
    return paginate(await list<unknown[]>('knownHosts', r), r);
  });
  app.post('/api/known-hosts/scan', async (r) => {
    sshAdmin(r);
    const { host, port } = hostInput(r);
    const addresses = await publicAddresses(host);
    const output = await service.runner.scanHost(addresses, port);
    const keys = new Map<string, ScannedHostKey>();
    for (const line of output
      .split('\n')
      .filter((s) => s && !s.startsWith('#'))) {
      const fields = line.trim().split(/\s+/);
      requireValue(fields.length === 3, '主机返回了无效公钥。');
      const { bits: _bits, ...key } = await service.ssh.publicKey(
        `${fields[1]} ${fields[2]}`,
      );
      requireValue(
        !keys.has(key.keyType) ||
          keys.get(key.keyType)!.fingerprint === key.fingerprint,
        '同一主机的多个地址返回了不同公钥，请核对。',
      );
      keys.set(key.keyType, key);
    }
    requireValue(
      keys.size,
      '主机未返回 SSH 公钥，请检查地址、端口和出口策略。',
    );
    return { items: [...keys.values()] };
  });
  app.post('/api/known-hosts', async (r) => {
    sshAdmin(r);
    const { body, host, port } = hostInput(r);
    requireValue(
      Array.isArray(body.keys) && body.keys.length > 0 && body.keys.length <= 5,
      '请选择 1–5 条主机公钥。',
    );
    const keys: ScannedHostKey[] = [];
    for (const value of body.keys) {
      const supplied = object(value);
      const { bits: _bits, ...key } = await service.ssh.publicKey(
        supplied.publicKey,
      );
      requireValue(
        supplied.keyType === key.keyType &&
          supplied.fingerprint === key.fingerprint,
        '主机公钥指纹不一致，请重新扫描。',
      );
      requireValue(
        !keys.some((k) => k.keyType === key.keyType),
        '同一算法只能信任一条主机公钥。',
      );
      keys.push(key);
    }
    return service.command('saveKnownHosts', { host, port, keys }, actor(r));
  });
  app.delete('/api/known-hosts/:id', async (r, reply) => {
    sshAdmin(r);
    await service.command('deleteKnownHost', { id: id(r) }, actor(r));
    return reply.code(204).send();
  });
  app.get('/api/projects', async (r) =>
    paginate(await list<Project[]>('projects', r), r),
  );
  async function icon(input: unknown, previous?: string) {
    if (input === undefined || input === null || input === '') return undefined;
    if (input === previous) return previous;
    const value = text(input, '图标', 1, 3_000_000);
    const match =
      /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    requireValue(match, '图标格式无效。');
    const raw = Buffer.from(match[2]!, 'base64');
    requireValue(raw.length <= 2 * 1024 * 1024, '图片不能超过 2 MB。');
    let encoded: Buffer;
    try {
      const image = sharp(raw, {
        limitInputPixels: 16_000_000,
        animated: false,
      });
      const meta = await image.metadata();
      requireValue(
        ['png', 'jpeg', 'webp'].includes(meta.format ?? '') &&
          (meta.pages ?? 1) === 1,
        '仅支持静态 PNG、JPEG、WebP 图片。',
      );
      encoded = await image
        .rotate()
        .resize({
          width: 512,
          height: 512,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .png()
        .toBuffer();
    } catch {
      throw Object.assign(new Error('图标损坏、格式不支持或像素超限。'), {
        statusCode: 400,
      });
    }
    const key = `${crypto.randomUUID()}.png`;
    await mkdir(join(config.dataDirectory, 'icons'), {
      recursive: true,
      mode: 0o700,
    });
    const output = await open(
      join(config.dataDirectory, 'icons', key),
      'wx',
      0o600,
    );
    try {
      await output.writeFile(encoded);
      await output.sync();
    } finally {
      await output.close();
    }
    await syncDirectory(join(config.dataDirectory, 'icons'));
    await syncDirectory(config.dataDirectory);
    return `/api/public/icons/${key}`;
  }
  async function saveProject(r: FastifyRequest, projectId?: number) {
    admin(r);
    const body = object(r.body);
    const repository = text(body.repository, '仓库地址', 1, 2048);
    requireValue(
      /^(git@[a-zA-Z0-9.-]+:[^\s]+|ssh:\/\/[^\s]+|https:\/\/[^\s]+)$/.test(
        repository,
      ),
      '仓库地址仅支持 git@、ssh://、https://。',
    );
    const u = repository.startsWith('git@') ? null : new URL(repository);
    sshHostOf(repository);
    requireValue(
      !u || (!u.password && (u.protocol !== 'https:' || !u.username)),
      '仓库地址不能内嵌凭据。',
    );
    relativePath(body.workdir, true);
    relativePath(body.artifactPath);
    const script = text(body.buildScript, '构建脚本', 1, 64 * 1024);
    requireValue(
      script.split('\n').some((s) => s.trim() && !s.trim().startsWith('#')),
      '构建脚本至少需要一条命令。',
    );
    const previous = projectId
      ? await service.command<Project>('project', { id: projectId })
      : undefined;
    const image = Object.hasOwn(body, 'icon')
      ? await icon(body.icon, previous?.icon)
      : previous?.icon;
    const input: ProjectInput = {
      name: text(body.name, '项目名称', 1, 40).trim(),
      description: text(body.description ?? '', '描述', 0, 120),
      repository,
      sshKeyId:
        body.sshKeyId == null
          ? null
          : integer(body.sshKeyId, 1, Number.MAX_SAFE_INTEGER, 'SSH 密钥编号'),
      defaultBranch: branch(body.defaultBranch),
      workdir: body.workdir,
      buildScript: script,
      artifactPath: body.artifactPath,
      timeout: integer(body.timeout, 5, 180, '超时'),
      icon: image,
    };
    return service.command(
      'saveProject',
      { input, ...(projectId ? { id: projectId } : {}) },
      actor(r),
    );
  }
  app.post('/api/projects', { bodyLimit: 3 * 1024 * 1024 }, (r) =>
    saveProject(r),
  );
  app.put('/api/projects/:id', { bodyLimit: 3 * 1024 * 1024 }, (r) =>
    saveProject(r, id(r)),
  );
  const fetching = new Set<number>();
  app.delete('/api/projects/:id', async (r) => {
    admin(r);
    const projectId = id(r);
    requireValue(
      !fetching.has(projectId),
      '项目正在拉取代码，请稍后重试删除。',
      409,
    );
    await service.deleteProject(projectId, actor(r));
    return { ok: true };
  });
  app.post('/api/projects/:id/fetch', async (r) => {
    const projectId = id(r);
    requireValue(!fetching.has(projectId), '该项目正在拉取，请稍后重试。', 409);
    fetching.add(projectId);
    try {
      const p = await service.command<Project>('project', { id: projectId });
      requireValue(!p.deleting, '项目正在删除，不能拉取代码。', 409);
      const b = branch(object(r.body).branch);
      const result = await service.runner.fetch(p, b);
      return service.command(
        'fetched',
        {
          id: projectId,
          repository: p.repository,
          sshKeyId: p.sshKeyId,
          ...result,
        },
        actor(r),
      );
    } finally {
      fetching.delete(projectId);
    }
  });
  app.post('/api/jobs', async (r) => {
    const d = object(r.body);
    const key = text(r.headers['idempotency-key'], '请求标识', 8, 128);
    const data = {
      projectId: integer(d.projectId, 1, Number.MAX_SAFE_INTEGER, '项目编号'),
      branch: branch(d.branch),
      sha: text(d.sha, '提交', 40, 64),
    };
    requireValue(/^[a-f0-9]{40,64}$/.test(data.sha), '提交格式无效。');
    const j = await service.command<Job>(
      'enqueue',
      { ...data, key, hash: JSON.stringify(data) },
      actor(r),
    );
    void service.pump();
    return j;
  });
  app.get('/api/jobs', async (r) => {
    let rows = await list<Job[]>('jobs', r);
    const q = object(r.query);
    if (q.project) rows = rows.filter((j) => j.projectId === Number(q.project));
    if (q.status) rows = rows.filter((j) => j.status === q.status);
    return paginate(rows, r);
  });
  app.get('/api/jobs/:id', (r) =>
    service.command('job', { id: id(r) }, actor(r)),
  );
  app.get('/api/jobs/:id/log', async (r) => {
    const job = await service.command<Job>('job', { id: id(r) }, actor(r));
    const offset = integer(
      object(r.query).offset ?? 0,
      0,
      1_000_000,
      '日志位置',
    );
    return {
      ...(await service.runner.log(job.id, offset)),
      done: !['queued', 'running', 'canceling'].includes(job.status),
    };
  });
  app.get('/api/queue', async (r) => {
    const jobs = await list<Job[]>('jobs', r);
    const settings = await list<State['settings']>('settings', r);
    const slots = jobs.filter((j) =>
      ['running', 'canceling'].includes(j.status),
    );
    return {
      ...settings,
      occupied: slots.length,
      queued: jobs.filter((j) => j.status === 'queued').length,
      slots,
      error: service.error,
      runner: service.runner.mode,
    };
  });
  app.post('/api/jobs/:id/stop', (r) => service.stop(id(r), actor(r)));
  app.delete('/api/jobs/:id', async (r) => {
    await service.delete(id(r), actor(r));
    return { ok: true };
  });
  app.get('/api/releases', async (r) => {
    const q = object(r.query);
    let rows = await list<Release[]>('releases', r);
    if (q.project) rows = rows.filter((x) => x.projectId === Number(q.project));
    if (q.status) rows = rows.filter((x) => x.testStatus === q.status);
    if (q.q) rows = rows.filter((x) => x.version.includes(String(q.q)));
    return paginate(rows, r);
  });
  app.patch('/api/releases/:id/test-status', (r) => {
    const d = object(r.body);
    requireValue(testStatuses.includes(String(d.status)), '测试状态无效。');
    return service.command(
      'testStatus',
      {
        id: id(r),
        status: d.status,
        revision: integer(d.revision, 1, Number.MAX_SAFE_INTEGER, '版本号'),
      },
      actor(r),
    );
  });
  app.delete('/api/releases/:id', async (r) => {
    const jobId = await service.command<number>(
      'releaseJob',
      { id: id(r) },
      actor(r),
    );
    await service.delete(jobId, actor(r));
    return { ok: true };
  });
  app.get('/api/settings', (r) => list('settings', r));
  app.put('/api/settings', async (r) => {
    admin(r);
    const maxConcurrent = integer(
      object(r.body).maxConcurrent,
      1,
      16,
      '并行构建数',
    );
    const result = await service.command(
      'saveSettings',
      { maxConcurrent },
      actor(r),
    );
    void service.pump();
    return result;
  });
  app.get('/api/users', async (r) => {
    admin(r);
    return paginate(await list<User[]>('users', r), r);
  });
  app.post('/api/users', async (r) => {
    admin(r);
    const d = object(r.body);
    const username = text(d.username, '账号', 3, 32);
    requireValue(/^[a-z][a-z0-9._-]{2,31}$/.test(username), '账号格式无效。');
    requireValue(['admin', 'user'].includes(String(d.role)), '角色无效。');
    return service.command(
      'createUser',
      {
        input: {
          username,
          displayName: text(d.displayName ?? username, '显示名称', 0, 80),
          role: d.role,
          passwordHash: await hashPassword(text(d.password, '密码', 8, 256)),
        },
      },
      actor(r),
    );
  });
  app.patch('/api/users/:id', async (r) => {
    admin(r);
    const d = object(r.body),
      patch: Record<string, unknown> = {};
    requireValue(
      Object.keys(d).every((k) =>
        ['role', 'enabled', 'displayName'].includes(k),
      ),
      '用户修改字段无效。',
    );
    if (d.role !== undefined) {
      requireValue(['admin', 'user'].includes(String(d.role)), '角色无效。');
      patch.role = d.role;
    }
    if (d.enabled !== undefined) {
      requireValue(typeof d.enabled === 'boolean', '启用状态无效。');
      patch.enabled = d.enabled;
    }
    if (d.displayName !== undefined)
      patch.displayName = text(d.displayName, '显示名称', 0, 80);
    return service.command('updateUser', { id: id(r), patch }, actor(r));
  });
  app.post('/api/users/:id/password', async (r) => {
    admin(r);
    return service.command(
      'updateUser',
      {
        id: id(r),
        patch: {
          passwordHash: await hashPassword(
            text(object(r.body).password, '密码', 8, 256),
          ),
        },
      },
      actor(r),
    );
  });
  app.delete('/api/users/:id', (r) => {
    admin(r);
    return service.command('deleteUser', { id: id(r) }, actor(r));
  });
  app.post('/api/maintenance/backup', (r) => {
    admin(r);
    return service.backup();
  });
  app.get('/api/public/projects', async () => {
    const state = await service.command<State>('list');
    return state.projects
      .filter((p) => !p.deleting)
      .map((p) => {
        const releases = state.releases
          .filter((x) => x.projectId === p.id)
          .sort((a, b) => b.createdAt - a.createdAt || b.jobId - a.jobId);
        return {
          ...publicProject(p),
          releaseCount: releases.length,
          latestRelease: releases[0] ? publicRelease(releases[0]) : null,
        };
      });
  });
  app.get('/api/public/projects/:slug/releases', async (r) => {
    const slug = text(object(r.params).slug, '项目标识', 1, 200),
      q = object(r.query);
    const state = await service.command<State>('list');
    const p = state.projects.find((x) => x.slug === slug && !x.deleting);
    requireValue(p, '项目不存在。', 404);
    const status = String(q.status ?? 'all');
    requireValue(
      status === 'all' || testStatuses.includes(status),
      '测试状态无效。',
    );
    const all = state.releases.filter((x) => x.projectId === p.id);
    const filtered = all
      .filter((x) => status === 'all' || x.testStatus === status)
      .sort((a, b) => b.createdAt - a.createdAt || b.jobId - a.jobId);
    const page = integer(q.page ?? 1, 1, 1_000_000, '页码'),
      size = integer(q.pageSize ?? 5, 1, 5, '每页数量');
    return {
      project: publicProject(p),
      items: filtered.slice((page - 1) * size, page * size).map(publicRelease),
      total: filtered.length,
      hasAny: all.length > 0,
      page,
      pageSize: size,
    };
  });
  app.get('/api/public/icons/:key', async (r, reply) => {
    const key = text(object(r.params).key, '图标标识', 1, 64);
    requireValue(/^[a-f0-9-]{36}\.png$/.test(key), '图标不存在。', 404);
    try {
      return reply
        .header('Content-Type', 'image/png')
        .header('X-Content-Type-Options', 'nosniff')
        .send(await readFile(join(config.dataDirectory, 'icons', key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        return reply.code(404).send({ message: '图标不存在。' });
      throw e;
    }
  });
  app.get('/api/public/artifacts/:id/download', async (r, reply) => {
    const { file, stream, release } = await service.openArtifact(id(r));
    reply.raw.once('close', () => {
      stream.destroy();
      release();
    });
    const name = file.name
      .split('/')
      .at(-1)!
      .replace(/[\r\n"\\]/g, '_');
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header(
        'Content-Disposition',
        `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      .header('Content-Length', file.size)
      .header('X-Content-Type-Options', 'nosniff')
      .send(stream);
  });
  return service;
}
