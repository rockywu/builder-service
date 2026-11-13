import type Database from 'better-sqlite3';
import type {
  User,
  Project,
  Job,
  Release,
  Artifact,
  SshKey,
  StoredSshKey,
  KnownHost,
  ScannedHostKey,
} from './types.js';
import { PlatformError, requireValue } from './errors.js';

type Actor = { id: number; username: string; role: 'admin' | 'user' };
export interface Command {
  action: string;
  actor?: Actor;
  data?: Record<string, unknown>;
}
interface JobRow {
  id: number;
  project_id: number;
  number: number;
  status: Job['status'];
  deleting: number;
  payload: string;
  request_key: string;
  request_hash: string;
}
interface ReleaseRow {
  id: number;
  job_id: number;
  project_id: number;
  payload: string;
  revision: number;
  deleting: number;
}
interface ArtifactRow extends Artifact {
  release_id: number;
  storage_key: string;
}
const parse = <T>(value: string): T => JSON.parse(value) as T;

export function initializePlatform(db: Database.Database) {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version >= 4) return;
  if (version === 3) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE ssh_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL, source TEXT NOT NULL, fingerprint TEXT NOT NULL, public_key TEXT NOT NULL, encrypted_private_key BLOB NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER);
        CREATE TABLE known_hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL, port INTEGER NOT NULL, key_type TEXT NOT NULL, public_key TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(host,port,key_type));
      `);
      db.pragma('user_version=4');
    }).immediate();
    return;
  }
  if (version === 2) {
    db.transaction(() => {
      db.exec(`ALTER TABLE artifacts RENAME TO artifacts_v2;
        CREATE TABLE artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, release_id INTEGER NOT NULL REFERENCES releases(id), name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, storage_key TEXT NOT NULL, UNIQUE(release_id,storage_key));
        INSERT INTO artifacts SELECT * FROM artifacts_v2;
        DROP TABLE artifacts_v2;`);
      const columns = db.pragma('table_info(system_settings)') as {
        name: string;
      }[];
      if (!columns.some((c) => c.name === 'next_user_id')) {
        db.exec(
          'ALTER TABLE system_settings ADD COLUMN next_user_id INTEGER NOT NULL DEFAULT 1',
        );
        db.prepare('UPDATE system_settings SET next_user_id=?').run(
          (db.prepare('SELECT MAX(id) AS n FROM users').get() as { n: number })
            .n + 1,
        );
      }
      db.pragma('user_version=3');
    }).immediate();
    initializePlatform(db);
    return;
  }
  db.transaction(() => {
    db.exec(`
      ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE users ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN last_login_at INTEGER;
      CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE build_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id), number INTEGER NOT NULL, status TEXT NOT NULL, deleting INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, UNIQUE(project_id, number));
      CREATE INDEX jobs_queue ON build_jobs(status, id);
      CREATE TABLE releases (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL UNIQUE REFERENCES build_jobs(id), project_id INTEGER NOT NULL REFERENCES projects(id), payload TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, deleting INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX releases_project ON releases(project_id, id);
      CREATE TABLE artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, release_id INTEGER NOT NULL REFERENCES releases(id), name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, storage_key TEXT NOT NULL, UNIQUE(release_id,storage_key));
      CREATE TABLE system_settings (id INTEGER PRIMARY KEY CHECK(id=1), max_concurrent INTEGER NOT NULL CHECK(max_concurrent BETWEEN 1 AND 16), next_user_id INTEGER NOT NULL);
      INSERT INTO system_settings VALUES (1, 1, 1);
      CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, actor_id INTEGER, actor_name TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL);
    `);
    db.prepare('UPDATE users SET display_name = username, created_at = ?').run(
      Date.now(),
    );
    db.prepare('UPDATE system_settings SET next_user_id = ? WHERE id=1').run(
      (db.prepare('SELECT MAX(id) AS n FROM users').get() as { n: number }).n +
        1,
    );
    db.pragma('user_version = 3');
  }).immediate();
  initializePlatform(db);
}

export function createPlatformStore(db: Database.Database) {
  db.exec(
    'CREATE INDEX IF NOT EXISTS audit_request_lookup ON audit_logs(action,target,at)',
  );
  const rawProjects = () =>
    (
      db.prepare('SELECT id, payload FROM projects ORDER BY id DESC').all() as {
        id: number;
        payload: string;
      }[]
    ).map((r) => ({
      ...parse<Project>(r.payload),
      id: r.id,
      sshKeyId: parse<Project>(r.payload).sshKeyId ?? null,
    }));
  const allProjects = () => {
    const keys = db.prepare('SELECT id,name FROM ssh_keys').all() as {
      id: number;
      name: string;
    }[];
    const names = new Map(keys.map((k) => [k.id, k.name]));
    return rawProjects().map((p) => ({
      ...p,
      sshKeyName: names.get(p.sshKeyId!) ?? null,
    }));
  };
  const project = (id: number) => {
    const row = db
      .prepare('SELECT id, payload FROM projects WHERE id=?')
      .get(id) as { id: number; payload: string } | undefined;
    requireValue(row, '项目不存在。', 404);
    const p = { ...parse<Project>(row.payload), id: row.id };
    p.sshKeyId ??= null;
    const key =
      p.sshKeyId === null
        ? undefined
        : (db
            .prepare('SELECT name FROM ssh_keys WHERE id=?')
            .get(p.sshKeyId) as { name: string } | undefined);
    return { ...p, sshKeyName: key?.name ?? null };
  };
  const sshKeys = (): SshKey[] => {
    const projects = rawProjects();
    return (
      db
        .prepare(
          'SELECT id,name,type,source,fingerprint,public_key,created_at,updated_at,last_used_at FROM ssh_keys ORDER BY id',
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      type: r.type as SshKey['type'],
      source: r.source as SshKey['source'],
      fingerprint: String(r.fingerprint),
      publicKey: String(r.public_key),
      projectIds: projects.filter((p) => p.sshKeyId === r.id).map((p) => p.id),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
    }));
  };
  const knownHosts = (): KnownHost[] =>
    (
      db.prepare('SELECT * FROM known_hosts ORDER BY id').all() as Record<
        string,
        unknown
      >[]
    ).map((r) => ({
      id: Number(r.id),
      host: String(r.host),
      port: Number(r.port),
      keyType: String(r.key_type),
      publicKey: String(r.public_key),
      fingerprint: String(r.fingerprint),
      createdAt: Number(r.created_at),
    }));
  const jobRow = (id: number) => {
    const r = db.prepare('SELECT * FROM build_jobs WHERE id=?').get(id) as
      JobRow | undefined;
    requireValue(r, '任务不存在。', 404);
    return r;
  };
  const job = (r: JobRow): Job => ({
    ...parse<Job>(r.payload),
    id: r.id,
    seq: r.id,
    number: r.number,
    status: r.deleting ? 'failed' : r.status,
    ...(r.deleting
      ? { error: '删除未完成，请重试删除；对应版本已停止公开。' }
      : {}),
  });
  const jobs = () =>
    (db.prepare('SELECT * FROM build_jobs ORDER BY id').all() as JobRow[]).map(
      job,
    );
  const saveJob = (j: Job) =>
    db
      .prepare('UPDATE build_jobs SET status=?, payload=? WHERE id=?')
      .run(j.status, JSON.stringify(j), j.id);
  const artifacts = (id: number) =>
    db
      .prepare('SELECT * FROM artifacts WHERE release_id=? ORDER BY id')
      .all(id) as ArtifactRow[];
  const releaseRow = (id: number) => {
    const r = db.prepare('SELECT * FROM releases WHERE id=?').get(id) as
      ReleaseRow | undefined;
    requireValue(r, '版本不存在。', 404);
    return r;
  };
  const releases = (): Release[] => {
    const rows = db
      .prepare('SELECT * FROM releases WHERE deleting=0 ORDER BY id DESC')
      .all() as ReleaseRow[];
    const files = db
      .prepare('SELECT * FROM artifacts ORDER BY id')
      .all() as ArtifactRow[];
    return rows
      .filter((r) => !parse<{ unavailable?: boolean }>(r.payload).unavailable)
      .map((r) => ({
        ...parse<Release>(r.payload),
        id: r.id,
        revision: r.revision,
        artifacts: files
          .filter((f) => f.release_id === r.id)
          .map(({ id, name, size, sha256 }) => ({ id, name, size, sha256 })),
      }));
  };
  const users = (): User[] =>
    (
      db
        .prepare(
          'SELECT id, username, role, enabled, display_name, created_at, last_login_at FROM users ORDER BY id',
        )
        .all() as {
        id: number;
        username: string;
        role: User['role'];
        enabled: number;
        display_name: string;
        created_at: number;
        last_login_at: number | null;
      }[]
    ).map((r) => ({
      id: r.id,
      username: r.username,
      role: r.role,
      enabled: !!r.enabled,
      displayName: r.display_name,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
    }));
  const settings = () => ({
    maxConcurrent: (
      db
        .prepare('SELECT max_concurrent FROM system_settings WHERE id=1')
        .get() as { max_concurrent: number }
    ).max_concurrent,
  });
  const audit = (a: Actor, action: string, target: unknown) =>
    db
      .prepare(
        'INSERT INTO audit_logs(actor_id,actor_name,action,target,at) VALUES(?,?,?,?,?)',
      )
      .run(a.id, a.username, action, String(target), Date.now());
  function execute(c: Command): unknown {
    const d = c.data ?? {};
    // Authentication/authorization is rechecked in the same transaction as each mutation.
    let actor: Actor | undefined;
    if (c.actor) {
      actor = users().find((u) => u.id === c.actor!.id && u.enabled);
      requireValue(actor, '登录已失效，请重新登录。', 401);
    }
    const admin = () =>
      requireValue(actor?.role === 'admin', '需要管理员权限。', 403);
    const manage = (j: Job) =>
      requireValue(
        actor && (actor.role === 'admin' || j.triggeredById === actor.id),
        '无权操作该任务。',
        403,
      );
    switch (c.action) {
      case 'sshKeys':
        admin();
        return sshKeys();
      case 'sshKeyCredentials': {
        // Internal runner operation only; no HTTP route exposes encrypted material.
        requireValue(!c.actor, '无权读取凭据。', 403);
        const row = db
          .prepare('SELECT encrypted_private_key FROM ssh_keys WHERE id=?')
          .get(Number(d.id)) as
          { encrypted_private_key: Uint8Array } | undefined;
        requireValue(row, '拉取凭据已删除', 400);
        return {
          encryptedPrivateKey: row.encrypted_private_key,
          hosts: knownHosts(),
        };
      }
      case 'sshKeyUsed':
        requireValue(!c.actor, '无权修改凭据使用记录。', 403);
        db.prepare('UPDATE ssh_keys SET last_used_at=? WHERE id=?').run(
          Date.now(),
          Number(d.id),
        );
        return null;
      case 'saveSshKey': {
        admin();
        const input = d.input as StoredSshKey;
        const previous = d.id
          ? sshKeys().find((k) => k.id === Number(d.id))
          : undefined;
        requireValue(!d.id || previous, '密钥不存在。', 404);
        requireValue(
          !sshKeys().some(
            (k) => k.name === input.name && k.id !== previous?.id,
          ),
          '密钥名称已存在。',
          409,
        );
        const now = Date.now();
        let keyId = previous?.id;
        if (previous) {
          requireValue(
            !input.encryptedPrivateKey || previous.source === 'imported',
            '服务端生成的密钥不能更换私钥。',
          );
          db.prepare('UPDATE ssh_keys SET name=?,updated_at=? WHERE id=?').run(
            input.name,
            now,
            keyId!,
          );
          if (input.encryptedPrivateKey)
            db.prepare(
              'UPDATE ssh_keys SET type=?,fingerprint=?,public_key=?,encrypted_private_key=? WHERE id=?',
            ).run(
              input.type,
              input.fingerprint,
              input.publicKey,
              Buffer.from(input.encryptedPrivateKey),
              keyId!,
            );
        } else {
          keyId = Number(
            db
              .prepare(
                'INSERT INTO ssh_keys(name,type,source,fingerprint,public_key,encrypted_private_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
              )
              .run(
                input.name,
                input.type,
                input.source,
                input.fingerprint,
                input.publicKey,
                Buffer.from(input.encryptedPrivateKey),
                now,
                now,
              ).lastInsertRowid,
          );
        }
        const result = sshKeys().find((k) => k.id === keyId)!;
        audit(
          actor!,
          previous
            ? input.encryptedPrivateKey
              ? 'ssh-key.replace'
              : 'ssh-key.rename'
            : 'ssh-key.create',
          `${result.name} ${result.fingerprint}`,
        );
        return result;
      }
      case 'deleteSshKey': {
        admin();
        const key = sshKeys().find((k) => k.id === Number(d.id));
        requireValue(key, '密钥不存在。', 404);
        for (const p of rawProjects().filter((p) => p.sshKeyId === key.id)) {
          db.prepare('UPDATE projects SET payload=? WHERE id=?').run(
            JSON.stringify({ ...p, sshKeyId: null, sshKeyName: null }),
            p.id,
          );
        }
        db.prepare('DELETE FROM ssh_keys WHERE id=?').run(key.id);
        audit(actor!, 'ssh-key.delete', `${key.name} ${key.fingerprint}`);
        return null;
      }
      case 'knownHosts':
        admin();
        return knownHosts().map(({ publicKey: _key, ...host }) => host);
      case 'saveKnownHosts': {
        admin();
        const result: Omit<KnownHost, 'publicKey'>[] = [];
        for (const k of d.keys as ScannedHostKey[]) {
          db.prepare(
            'INSERT INTO known_hosts(host,port,key_type,public_key,fingerprint,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(host,port,key_type) DO UPDATE SET public_key=excluded.public_key,fingerprint=excluded.fingerprint,created_at=excluded.created_at',
          ).run(
            String(d.host),
            Number(d.port),
            k.keyType,
            k.publicKey,
            k.fingerprint,
            Date.now(),
          );
          const { publicKey: _key, ...host } = knownHosts().find(
            (h) =>
              h.host === d.host && h.port === d.port && h.keyType === k.keyType,
          )!;
          result.push(host);
          audit(
            actor!,
            'known-host.trust',
            `${d.host}:${d.port} ${k.fingerprint}`,
          );
        }
        return result;
      }
      case 'deleteKnownHost': {
        admin();
        const host = knownHosts().find((h) => h.id === Number(d.id));
        requireValue(host, '受信任主机不存在。', 404);
        db.prepare('DELETE FROM known_hosts WHERE id=?').run(host.id);
        audit(
          actor!,
          'known-host.delete',
          `${host.host}:${host.port} ${host.fingerprint}`,
        );
        return null;
      }
      case 'list':
        return {
          projects: allProjects(),
          jobs: jobs(),
          releases: releases(),
          settings: settings(),
          users: actor?.role === 'admin' ? users() : [],
        };
      case 'projects':
        return allProjects();
      case 'markProjectDelete': {
        admin();
        const p = project(Number(d.id));
        const rows = db
          .prepare('SELECT * FROM build_jobs WHERE project_id=?')
          .all(p.id) as JobRow[];
        requireValue(
          !rows.some((j) => ['running', 'canceling'].includes(j.status)),
          '项目有运行中或停止中的构建，请先停止任务后再删除。',
          409,
        );
        db.prepare('UPDATE projects SET payload=? WHERE id=?').run(
          JSON.stringify({ ...p, deleting: true, deletionError: '' }),
          p.id,
        );
        db.prepare('UPDATE build_jobs SET deleting=1 WHERE project_id=?').run(
          p.id,
        );
        db.prepare('UPDATE releases SET deleting=1 WHERE project_id=?').run(
          p.id,
        );
        if (!p.deleting) audit(actor!, 'project.delete.begin', p.id);
        return p;
      }
      case 'projectDeletions':
        return allProjects().filter((p) => p.deleting);
      case 'projectDeletionJobs': {
        const p = project(Number(d.id));
        requireValue(p.deleting, '项目不在清理流程。', 409);
        return (
          db
            .prepare('SELECT id FROM build_jobs WHERE project_id=? ORDER BY id')
            .all(p.id) as { id: number }[]
        ).map((j) => j.id);
      }
      case 'projectDeleteFailed': {
        const p = project(Number(d.id));
        requireValue(p.deleting, '项目不在清理流程。', 409);
        db.prepare('UPDATE projects SET payload=? WHERE id=?').run(
          JSON.stringify({ ...p, deletionError: '删除未完成，请重试删除。' }),
          p.id,
        );
        return null;
      }
      case 'completeProjectDelete': {
        const p = project(Number(d.id));
        requireValue(p.deleting, '项目不在清理流程。', 409);
        requireValue(
          !db
            .prepare('SELECT id FROM build_jobs WHERE project_id=? LIMIT 1')
            .get(p.id),
          '项目任务尚未清理完成。',
          409,
        );
        requireValue(
          !db
            .prepare('SELECT id FROM releases WHERE project_id=? LIMIT 1')
            .get(p.id),
          '项目版本尚未清理完成。',
          409,
        );
        db.prepare('DELETE FROM projects WHERE id=?').run(p.id);
        return null;
      }
      case 'project':
        return project(Number(d.id));
      case 'jobs':
        return jobs();
      case 'job':
        return job(jobRow(Number(d.id)));
      case 'releases':
        return releases();
      case 'users':
        admin();
        return users();
      case 'settings':
        return settings();
      case 'saveProject': {
        admin();
        const input = {
          ...(d.input as Project),
          sshKeyId: (d.input as Project).sshKeyId ?? null,
        };
        if (/^(git@|ssh:\/\/)/.test(input.repository))
          requireValue(input.sshKeyId !== null, 'SSH 地址需要选择密钥');
        if (input.sshKeyId !== null)
          requireValue(
            db
              .prepare('SELECT id FROM ssh_keys WHERE id=?')
              .get(input.sshKeyId),
            '所选 SSH 密钥不存在。',
          );
        input.sshKeyName =
          input.sshKeyId === null
            ? null
            : sshKeys().find((k) => k.id === input.sshKeyId)!.name;
        if (d.id) {
          const p = project(Number(d.id));
          requireValue(!p.deleting, '项目正在删除，不能修改配置。', 409);
          const next = {
            ...p,
            ...input,
            id: p.id,
            slug: p.slug,
            branches: [...new Set([...p.branches, input.defaultBranch])],
            fetched:
              p.repository === input.repository && p.sshKeyId === input.sshKeyId
                ? p.fetched
                : { branch: '', sha: '', message: '', at: 0 },
          };
          db.prepare('UPDATE projects SET payload=? WHERE id=?').run(
            JSON.stringify(next),
            p.id,
          );
          audit(actor!, 'project.update', p.id);
          return next;
        }
        const slugBase =
          input.repository
            .split('/')
            .pop()
            ?.replace(/\.git$/, '')
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '-') || 'project';
        const p = {
          ...input,
          slug: slugBase,
          branches: [input.defaultBranch],
          fetched: { branch: '', sha: '', message: '', at: 0 },
          color: '#2563eb',
        };
        const id = Number(
          db
            .prepare('INSERT INTO projects(slug,payload) VALUES(?,?)')
            .run(
              `${slugBase}-${crypto.randomUUID().slice(0, 8)}`,
              JSON.stringify(p),
            ).lastInsertRowid,
        );
        p.slug = (
          db.prepare('SELECT slug FROM projects WHERE id=?').get(id) as {
            slug: string;
          }
        ).slug;
        db.prepare('UPDATE projects SET payload=? WHERE id=?').run(
          JSON.stringify({ ...p, id }),
          id,
        );
        audit(actor!, 'project.create', id);
        return { ...p, id };
      }
      case 'fetched': {
        const p = project(Number(d.id));
        requireValue(!p.deleting, '项目正在删除，不能拉取代码。', 409);
        requireValue(
          p.repository === d.repository &&
            (d.sshKeyId === undefined || p.sshKeyId === d.sshKeyId),
          '仓库配置已变化，请重新拉取。',
          409,
        );
        p.fetched = d.fetched as Project['fetched'];
        p.branches = d.branches as string[];
        db.prepare('UPDATE projects SET payload=? WHERE id=?').run(
          JSON.stringify(p),
          p.id,
        );
        return p.fetched;
      }
      case 'enqueue': {
        requireValue(actor, '请先登录。', 401);
        const previous = db
          .prepare('SELECT * FROM build_jobs WHERE request_key=?')
          .get(String(d.key)) as JobRow | undefined;
        if (previous) {
          const j = job(previous);
          requireValue(
            j.triggeredById === actor.id && previous.request_hash === d.hash,
            '幂等键已用于其他请求。',
            409,
          );
          return j;
        }
        db.prepare(
          "DELETE FROM audit_logs WHERE action='job.request' AND at<?",
        ).run(Date.now() - 7 * 24 * 60 * 60_000);
        const receipt = db
          .prepare(
            "SELECT id FROM audit_logs WHERE action='job.request' AND target=? LIMIT 1",
          )
          .get(String(d.key));
        requireValue(
          !receipt,
          '该请求已处理且任务已删除，请重新发起构建。',
          409,
        );
        const p = project(Number(d.projectId));
        requireValue(!p.deleting, '项目正在删除，不能发起构建。', 409);
        requireValue(
          p.fetched.sha === d.sha &&
            p.fetched.branch === d.branch &&
            p.fetched.at > 0,
          '请先拉取所选分支的最新提交。',
          409,
        );
        const number =
          ((
            db
              .prepare(
                'SELECT MAX(number) AS n FROM build_jobs WHERE project_id=?',
              )
              .get(p.id) as { n: number | null }
          ).n ?? 0) + 1;
        // Keep numbering monotonic after physical deletion.
        const previousNumber = Number(
          (p as Project & { nextNumber?: number }).nextNumber ?? 1,
        );
        const n = Math.max(number, previousNumber);
        (p as Project & { nextNumber: number }).nextNumber = n + 1;
        db.prepare('UPDATE projects SET payload=? WHERE id=?').run(
          JSON.stringify(p),
          p.id,
        );
        const j: Job & { repository: string } = {
          id: 0,
          seq: 0,
          number: n,
          projectId: p.id,
          branch: String(d.branch),
          sha: String(d.sha),
          message: p.fetched.message,
          status: 'queued',
          triggeredBy: actor.username,
          triggeredById: actor.id,
          createdAt: Date.now(),
          startedAt: null,
          finishedAt: null,
          snapshot: {
            workdir: p.workdir,
            buildScript: p.buildScript,
            artifactPath: p.artifactPath,
            timeout: p.timeout,
            sshKeyId: p.sshKeyId,
          },
          repository: p.repository,
          steps: ['拉取源码', '执行构建脚本', '收集产物'],
          script: [],
          visibleLines: 0,
          phase: 0,
          progress: 0,
        };
        const id = Number(
          db
            .prepare(
              'INSERT INTO build_jobs(project_id,number,status,payload,request_key,request_hash) VALUES(?,?,?,?,?,?)',
            )
            .run(
              p.id,
              n,
              'queued',
              JSON.stringify(j),
              String(d.key),
              String(d.hash),
            ).lastInsertRowid,
        );
        audit(actor, 'job.request', d.key);
        return { ...j, id, seq: id };
      }
      case 'claim': {
        const occupied = (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM build_jobs WHERE status IN ('running','canceling')",
            )
            .get() as { n: number }
        ).n;
        if (occupied >= settings().maxConcurrent) return null;
        const r = db
          .prepare(
            "SELECT * FROM build_jobs WHERE status='queued' AND deleting=0 ORDER BY id LIMIT 1",
          )
          .get() as JobRow | undefined;
        if (!r) return null;
        const j = job(r);
        j.status = 'running';
        j.startedAt = Date.now();
        saveJob(j);
        return j;
      }
      case 'phase': {
        const r = jobRow(Number(d.id));
        if (r.status !== 'running' || r.deleting) return false;
        const j = job(r);
        j.phase = d.phase as Job['phase'];
        j.progress = Number(d.progress);
        saveJob(j);
        return true;
      }
      case 'stop': {
        const j = job(jobRow(Number(d.id)));
        manage(j);
        requireValue(
          j.status === 'running',
          '任务状态已变化，请刷新后重试。',
          409,
        );
        j.status = 'canceling';
        saveJob(j);
        return j;
      }
      case 'finish': {
        const r = jobRow(Number(d.id));
        if (r.deleting || !['running', 'canceling'].includes(r.status))
          return false;
        const j = job(r);
        j.finishedAt = Date.now();
        j.status =
          r.status === 'canceling' ? 'canceled' : (d.status as Job['status']);
        j.error = d.error as string | undefined;
        if (j.status === 'succeeded') j.progress = 100;
        if (j.status === 'succeeded') {
          const p = project(j.projectId);
          const rel: Release = {
            id: 0,
            jobId: j.id,
            projectId: j.projectId,
            version: `${p.slug}-b${j.number}`,
            branch: j.branch,
            sha: j.sha,
            createdAt: j.finishedAt,
            triggeredBy: j.triggeredBy,
            testStatus: 'pending',
            testUpdatedBy: j.triggeredBy,
            testUpdatedAt: j.finishedAt,
            revision: 1,
            artifacts: [],
          };
          const id = Number(
            db
              .prepare(
                'INSERT INTO releases(job_id,project_id,payload) VALUES(?,?,?)',
              )
              .run(j.id, j.projectId, JSON.stringify(rel)).lastInsertRowid,
          );
          const files = d.artifacts as (Artifact & { storageKey: string })[];
          requireValue(files.length, '没有找到构建产物。');
          for (const f of files)
            db.prepare(
              'INSERT INTO artifacts(release_id,name,size,sha256,storage_key) VALUES(?,?,?,?,?)',
            ).run(id, f.name, f.size, f.sha256, f.storageKey);
        }
        saveJob(j);
        return true;
      }
      case 'markDelete': {
        const r = jobRow(Number(d.id));
        const j = job(r);
        manage(j);
        requireValue(
          !['running', 'canceling'].includes(r.status),
          '任务已开始执行，请先停止构建。',
          409,
        );
        db.prepare('UPDATE build_jobs SET deleting=1 WHERE id=?').run(j.id);
        db.prepare('UPDATE releases SET deleting=1 WHERE job_id=?').run(j.id);
        return j;
      }
      case 'deletions':
        return (
          db
            .prepare('SELECT * FROM build_jobs WHERE deleting=1')
            .all() as JobRow[]
        ).map(job);
      case 'completeDelete': {
        const r = jobRow(Number(d.id));
        requireValue(r.deleting, '任务不在清理流程。', 409);
        const rel = db
          .prepare('SELECT id FROM releases WHERE job_id=?')
          .get(r.id) as { id: number } | undefined;
        if (rel) {
          db.prepare(
            "DELETE FROM audit_logs WHERE action='release.testStatus' AND target=?",
          ).run(String(rel.id));
          db.prepare('DELETE FROM artifacts WHERE release_id=?').run(rel.id);
          db.prepare('DELETE FROM releases WHERE id=?').run(rel.id);
        }
        db.prepare(
          "UPDATE audit_logs SET at=? WHERE action='job.request' AND target=?",
        ).run(Date.now(), r.request_key);
        if (
          !db
            .prepare(
              "SELECT id FROM audit_logs WHERE action='job.request' AND target=? LIMIT 1",
            )
            .get(r.request_key)
        ) {
          const original = job(r);
          audit(
            {
              id: original.triggeredById,
              username: original.triggeredBy,
              role: 'user',
            },
            'job.request',
            r.request_key,
          );
        }
        db.prepare('DELETE FROM build_jobs WHERE id=? AND deleting=1').run(
          r.id,
        );
        return null;
      }
      case 'releaseJob':
        return releaseRow(Number(d.id)).job_id;
      case 'testStatus': {
        requireValue(actor, '请先登录。', 401);
        const r = releaseRow(Number(d.id));
        requireValue(!r.deleting, '版本正在删除。', 409);
        requireValue(
          r.revision === d.revision,
          '该版本状态已被他人修改，请确认后重试。',
          409,
        );
        const rel = parse<Release>(r.payload);
        rel.testStatus = d.status as Release['testStatus'];
        rel.testUpdatedBy = actor.username;
        rel.testUpdatedAt = Date.now();
        db.prepare(
          'UPDATE releases SET payload=?,revision=revision+1 WHERE id=? AND revision=?',
        ).run(JSON.stringify(rel), r.id, r.revision);
        audit(actor, 'release.testStatus', r.id);
        return null;
      }
      case 'quarantine': {
        const r = jobRow(Number(d.id)),
          j = job(r);
        j.status = 'failed';
        j.error =
          '已发布产物完整性核验失败，已暂停公开，请删除该任务后重新构建。';
        saveJob(j);
        const release = db
          .prepare('SELECT * FROM releases WHERE job_id=?')
          .get(j.id) as ReleaseRow | undefined;
        if (release) {
          const rel = parse<Release & { unavailable?: boolean }>(
            release.payload,
          );
          rel.unavailable = true;
          db.prepare('UPDATE releases SET payload=? WHERE id=?').run(
            JSON.stringify(rel),
            release.id,
          );
        }
        return null;
      }
      case 'artifact': {
        const f = db
          .prepare('SELECT * FROM artifacts WHERE id=?')
          .get(Number(d.id)) as ArtifactRow | undefined;
        requireValue(f, '文件不存在。', 404);
        const r = releaseRow(f.release_id);
        requireValue(
          !r.deleting &&
            !parse<{ unavailable?: boolean }>(r.payload).unavailable,
          '文件不存在。',
          404,
        );
        return f;
      }
      case 'saveSettings':
        admin();
        db.prepare(
          'UPDATE system_settings SET max_concurrent=? WHERE id=1',
        ).run(Number(d.maxConcurrent));
        audit(actor!, 'settings.update', 'concurrency');
        return settings();
      case 'createUser': {
        admin();
        const u = d.input as Record<string, unknown>;
        requireValue(
          !users().some((x) => x.username === u.username),
          '账号已存在。',
          409,
        );
        const id = (
          db
            .prepare('SELECT next_user_id FROM system_settings WHERE id=1')
            .get() as { next_user_id: number }
        ).next_user_id;
        db.prepare(
          'UPDATE system_settings SET next_user_id=next_user_id+1 WHERE id=1',
        ).run();
        db.prepare(
          'INSERT INTO users(id,username,password_hash,role,enabled,display_name,created_at) VALUES(?,?,?,?,1,?,?)',
        ).run(
          id,
          String(u.username),
          String(u.passwordHash),
          String(u.role),
          String(u.displayName),
          Date.now(),
        );
        audit(actor!, 'user.create', id);
        return users().find((u) => u.id === id);
      }
      case 'updateUser':
      case 'deleteUser': {
        admin();
        const id = Number(d.id);
        const u = users().find((x) => x.id === id);
        requireValue(u, '用户不存在。', 404);
        const patch = d.patch as
          (Partial<User> & { passwordHash?: string }) | undefined;
        requireValue(
          id !== actor!.id ||
            (c.action === 'updateUser' &&
              patch?.role === undefined &&
              patch?.enabled === undefined),
          '不能修改自己的角色、启用状态或删除自己。',
          409,
        );
        const next = { ...u, ...patch };
        if (c.action === 'deleteUser' || !next.enabled || next.role !== 'admin')
          requireValue(
            u.role !== 'admin' ||
              !u.enabled ||
              users().some(
                (x) => x.id !== id && x.enabled && x.role === 'admin',
              ),
            '至少需要保留一个启用的管理员。',
            409,
          );
        if (c.action === 'deleteUser')
          db.prepare('DELETE FROM users WHERE id=?').run(id);
        else {
          db.prepare(
            'UPDATE users SET display_name=?,role=?,enabled=? WHERE id=?',
          ).run(next.displayName, next.role, Number(next.enabled), id);
          if (patch?.passwordHash)
            db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(
              patch.passwordHash,
              id,
            );
        }
        if (
          c.action === 'deleteUser' ||
          patch?.role !== undefined ||
          patch?.enabled !== undefined ||
          patch?.passwordHash
        )
          db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
        audit(actor!, c.action, id);
        return null;
      }
      default:
        throw new PlatformError(400, '未知数据库操作。');
    }
  }
  // Every command has one short synchronous transaction; no SQL joins or external I/O.
  return (command: Command) =>
    db.transaction(() => execute(command)).immediate();
}
