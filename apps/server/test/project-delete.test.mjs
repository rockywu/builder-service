import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { createApp } from '../dist/app.js';
import { startDatabase, closeDatabase } from '../dist/db/client.js';
import { PlatformService } from '../dist/modules/platform/service.js';
import { buildDirectoryName } from '../dist/tools/build-directory.js';
process.umask(0o077);
const origin = 'http://localhost:5173';
const input = {
  name: 'Delete fixture',
  description: '',
  repository: 'https://example.invalid/repository.git',
  defaultBranch: 'main',
  workdir: './',
  buildScript: 'printf fixture',
  artifactPath: './dist',
  timeout: 5,
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'builder-project-delete-'));
  const config = {
    host: '127.0.0.1',
    port: 3000,
    appOrigin: origin,
    dataDirectory: join(directory, 'data'),
    logLevel: 'silent',
    runner: 'local',
    secretKey: randomBytes(32).toString('base64'),
  };
  let db = await startDatabase(config.dataDirectory),
    app = await createApp(config, db);
  t.after(async () => {
    await app.close();
    await closeDatabase(db);
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    config,
    get app() {
      return app;
    },
    get db() {
      return db;
    },
    async restart() {
      await app.close();
      await closeDatabase(db);
      db = await startDatabase(config.dataDirectory);
      app = await createApp(config, db);
    },
  };
}
async function login(f, username = 'admin', password = 'admin123456') {
  const r = await f.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { username, password },
    remoteAddress: '127.0.0.2',
  });
  assert.equal(r.statusCode, 200, r.body);
  return {
    user: r.json().user,
    headers: {
      origin,
      cookie: r.headers['set-cookie'].split(';')[0],
      'x-csrf-token': r.json().csrfToken,
    },
  };
}
const call = (f, s, method, url, payload, headers = {}) =>
  f.app.inject({
    method,
    url,
    headers: { ...s?.headers, ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
async function ok(f, s, method, url, payload) {
  const r = await call(f, s, method, url, payload);
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
const command = (f, action, data = {}, s) =>
  f.db.request('platform', { action, data, ...(s ? { actor: s.user } : {}) });
async function queue(f, s, p) {
  await command(
    f,
    'fetched',
    {
      id: p.id,
      repository: p.repository,
      fetched: {
        branch: 'main',
        sha: 'a'.repeat(40),
        message: 'fixture',
        at: Date.now(),
      },
      branches: ['main'],
    },
    s,
  );
  const key = randomUUID();
  return command(
    f,
    'enqueue',
    { projectId: p.id, branch: 'main', sha: 'a'.repeat(40), key, hash: key },
    s,
  );
}
async function completed(f, s, p, { legacy = false } = {}) {
  const job = await queue(f, s, p);
  assert.equal((await command(f, 'claim')).id, job.id);
  const dir = join(
    f.config.dataDirectory,
    'builds',
    legacy ? String(job.id) : buildDirectoryName(job),
  );
  await mkdir(join(dir, 'artifacts'), { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'artifacts', '0'), 'fixture', { mode: 0o600 });
  await writeFile(join(dir, 'build.log'), 'fixture log\n', { mode: 0o600 });
  const artifacts = [
    {
      name: 'result.txt',
      size: 7,
      sha256: createHash('sha256').update('fixture').digest('hex'),
      storageKey: 'artifacts/0',
    },
  ];
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(artifacts), {
    mode: 0o600,
  });
  await command(f, 'finish', { id: job.id, status: 'succeeded', artifacts });
  const release = (await ok(f, s, 'GET', '/api/releases')).items.find(
    (r) => r.jobId === job.id,
  );
  return { job, dir, release };
}
function counts(f, projectId) {
  const db = new Database(join(f.config.dataDirectory, 'platform.db'), {
    readonly: true,
  });
  try {
    return {
      projects: db
        .prepare('SELECT COUNT(*) AS n FROM projects WHERE id=?')
        .get(projectId).n,
      jobs: db
        .prepare('SELECT COUNT(*) AS n FROM build_jobs WHERE project_id=?')
        .get(projectId).n,
      releases: db
        .prepare('SELECT COUNT(*) AS n FROM releases WHERE project_id=?')
        .get(projectId).n,
    };
  } finally {
    db.close();
  }
}

test(
  'project deletion is admin-only, CSRF-protected, and preserves shared SSH keys',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      s = await login(f);
    const key = await ok(f, s, 'POST', '/api/ssh-keys', {
      name: 'keep-key',
      mode: 'generate',
    });
    const p = await ok(f, s, 'POST', '/api/projects', {
      ...input,
      sshKeyId: key.id,
    });
    await ok(f, s, 'POST', '/api/users', {
      username: 'delete-user',
      password: 'password12345',
      role: 'user',
    });
    const user = await login(f, 'delete-user', 'password12345');
    assert.equal(
      (
        await call(f, null, 'DELETE', `/api/projects/${p.id}`, undefined, {
          origin,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (await call(f, user, 'DELETE', `/api/projects/${p.id}`)).statusCode,
      403,
    );
    assert.equal(
      (
        await call(f, s, 'DELETE', `/api/projects/${p.id}`, undefined, {
          'x-csrf-token': '',
        })
      ).statusCode,
      403,
    );
    assert.equal(counts(f, p.id).projects, 1);
    await ok(f, s, 'DELETE', `/api/projects/${p.id}`);
    assert.deepEqual(counts(f, p.id), { projects: 0, jobs: 0, releases: 0 });
    assert.equal((await ok(f, s, 'GET', '/api/ssh-keys')).items[0].id, key.id);
    assert.deepEqual(
      (await ok(f, s, 'GET', '/api/ssh-keys')).items[0].projectIds,
      [],
    );
    assert.equal(
      (await call(f, s, 'DELETE', `/api/projects/${p.id}`)).statusCode,
      404,
    );
  },
);

test(
  'confirmed deletion cleans completed and queued jobs, versions, files and unshared icon, leaving other projects intact',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      s = await login(f);
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: '#345678' },
    })
      .png()
      .toBuffer();
    const p = await ok(f, s, 'POST', '/api/projects', {
      ...input,
      icon: 'data:image/png;base64,' + png.toString('base64'),
    });
    const icons = join(f.config.dataDirectory, 'icons');
    const replacement = await ok(f, s, 'PUT', `/api/projects/${p.id}`, {
      ...input,
      icon: 'data:image/png;base64,' + png.toString('base64'),
    });
    assert.notEqual(replacement.icon, p.icon);
    await assert.rejects(access(join(icons, p.icon.split('/').at(-1))), {
      code: 'ENOENT',
    });
    const failedSave = await call(f, s, 'PUT', `/api/projects/${p.id}`, {
      ...input,
      sshKeyId: 99999,
      icon: 'data:image/png;base64,' + png.toString('base64'),
    });
    assert.equal(failedSave.statusCode, 400);
    assert.deepEqual(await readdir(icons), [
      replacement.icon.split('/').at(-1),
    ]);
    const finished = await completed(f, s, p);
    const legacy = await completed(f, s, p, { legacy: true });
    const other = await ok(f, s, 'POST', '/api/projects', {
      ...input,
      name: 'Keep other project',
    });
    const otherHistory = await completed(f, s, other);
    const transient = (prefix) =>
      join(f.config.dataDirectory, 'builds', `${prefix}-${randomUUID()}`);
    const owned = transient(`fetch-${p.id}`),
      retained = [
        transient(`fetch-${other.id}`),
        transient('fetch'),
        transient('scan'),
      ];
    for (const dir of [owned, ...retained])
      await mkdir(join(dir, 'repo'), { recursive: true });
    for (const subdir of ['source/node_modules', '.home/.cache/pnpm']) {
      await mkdir(join(finished.dir, subdir), { recursive: true });
      await writeFile(join(finished.dir, subdir, 'cached'), 'project cache');
    }
    const activeOther = await queue(f, s, other);
    assert.equal((await command(f, 'claim')).id, activeOther.id);
    const queued = await queue(f, s, p);
    await ok(f, s, 'DELETE', `/api/projects/${p.id}`);
    assert.deepEqual(counts(f, p.id), { projects: 0, jobs: 0, releases: 0 });
    await assert.rejects(access(finished.dir));
    await assert.rejects(access(legacy.dir));
    await assert.rejects(access(owned), { code: 'ENOENT' });
    for (const dir of retained) await access(join(dir, 'repo'));
    const disk = new Database(join(f.config.dataDirectory, 'platform.db'), {
      readonly: true,
    });
    try {
      const count = disk.prepare(
        'SELECT COUNT(*) AS n FROM artifacts WHERE release_id=?',
      );
      for (const { release } of [finished, legacy])
        assert.equal(count.get(release.id).n, 0);
      assert.equal(count.get(otherHistory.release.id).n, 1);
    } finally {
      disk.close();
    }
    assert.equal(
      await readFile(join(otherHistory.dir, 'artifacts', '0'), 'utf8'),
      'fixture',
    );
    await assert.rejects(
      access(join(icons, replacement.icon.split('/').at(-1))),
    );
    assert.equal(
      (await call(f, null, 'GET', `/api/public/projects/${p.slug}/releases`))
        .statusCode,
      404,
    );
    assert.equal(
      (
        await call(
          f,
          null,
          'GET',
          `/api/public/artifacts/${finished.release.artifacts[0].id}/download`,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await call(f, s, 'GET', `/api/jobs/${queued.id}`)).statusCode,
      404,
    );
    assert.equal(
      (await ok(f, s, 'GET', '/api/projects')).items[0].id,
      other.id,
    );
    assert.equal(
      (await ok(f, s, 'GET', `/api/jobs/${activeOther.id}`)).status,
      'running',
    );
    await command(f, 'finish', {
      id: activeOther.id,
      status: 'failed',
      error: 'fixture end',
    });
  },
);

test(
  'running and canceling projects cannot be deleted; queue claim and deletion remain transactional',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      s = await login(f),
      p = await ok(f, s, 'POST', '/api/projects', input);
    const j = await queue(f, s, p);
    await command(f, 'claim');
    assert.equal(
      (await call(f, s, 'DELETE', `/api/projects/${p.id}`)).statusCode,
      409,
    );
    assert.equal(
      (await ok(f, s, 'GET', '/api/projects')).items[0].deleting,
      undefined,
    );
    await command(f, 'stop', { id: j.id }, s);
    assert.equal(
      (await call(f, s, 'DELETE', `/api/projects/${p.id}`)).statusCode,
      409,
    );
    await command(f, 'finish', { id: j.id, status: 'failed' });
    await ok(f, s, 'DELETE', `/api/projects/${p.id}`);
    const p2 = await ok(f, s, 'POST', '/api/projects', {
      ...input,
      name: 'queued race',
    });
    await queue(f, s, p2);
    await command(f, 'markProjectDelete', { id: p2.id }, s);
    assert.equal(await command(f, 'claim'), null);
    await new PlatformService(f.db, f.config).deleteProject(p2.id);
  },
);

test(
  'download blocks physical cleanup, deletion stays visible for retry, and new writes/public downloads are refused',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      s = await login(f),
      p = await ok(f, s, 'POST', '/api/projects', input),
      done = await completed(f, s, p);
    const service = new PlatformService(f.db, f.config),
      held = await service.openArtifact(done.release.artifacts[0].id);
    try {
      await assert.rejects(
        () => service.deleteProject(p.id, s.user),
        /删除未完成/,
      );
      assert.equal(counts(f, p.id).projects, 1);
      await access(done.dir);
      const retained = (await ok(f, s, 'GET', '/api/projects')).items[0];
      assert.equal(retained.deleting, true);
      assert.match(retained.deletionError, /删除未完成/);
      assert.equal(
        (await ok(f, null, 'GET', '/api/public/projects')).some(
          (v) => v.id === p.id,
        ),
        false,
      );
      assert.equal(
        (await call(f, null, 'GET', `/api/public/projects/${p.slug}/releases`))
          .statusCode,
        404,
      );
      assert.equal(
        (await call(f, s, 'PUT', `/api/projects/${p.id}`, input)).statusCode,
        409,
      );
      assert.equal(
        (
          await call(f, s, 'POST', `/api/projects/${p.id}/fetch`, {
            branch: 'main',
          })
        ).statusCode,
        409,
      );
      await assert.rejects(
        () =>
          command(
            f,
            'enqueue',
            {
              projectId: p.id,
              branch: 'main',
              sha: 'a'.repeat(40),
              key: randomUUID(),
              hash: 'late',
            },
            s,
          ),
        /正在删除/,
      );
      await assert.rejects(
        () => command(f, 'completeProjectDelete', { id: p.id }),
        /尚未清理/,
      );
    } finally {
      const closed = once(held.stream, 'close');
      held.stream.destroy();
      await closed;
      held.release();
    }
    await service.deleteProject(p.id, s.user);
    assert.equal(counts(f, p.id).projects, 0);
    await assert.rejects(access(done.dir));
  },
);

test(
  'failed cleanup is resumable after restart and a shared project icon remains available',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      s = await login(f),
      p = await ok(f, s, 'POST', '/api/projects', input),
      done = await completed(f, s, p, { legacy: true });
    const icon = `/api/public/icons/${randomUUID()}.png`;
    await mkdir(join(f.config.dataDirectory, 'icons'), { mode: 0o700 });
    await writeFile(
      join(f.config.dataDirectory, 'icons', icon.split('/').at(-1)),
      'shared',
      { mode: 0o600 },
    );
    await command(f, 'saveProject', { id: p.id, input: { ...input, icon } }, s);
    const other = await ok(f, s, 'POST', '/api/projects', {
      ...input,
      name: 'shared icon owner',
    });
    await command(
      f,
      'saveProject',
      { id: other.id, input: { ...input, name: 'shared icon owner', icon } },
      s,
    );
    const service = new PlatformService(f.db, f.config);
    service.runner.remove = async () => {
      throw new Error('controlled I/O failure');
    };
    await assert.rejects(
      () => service.deleteProject(p.id, s.user),
      /删除未完成/,
    );
    await access(done.dir);
    await f.restart();
    assert.deepEqual(counts(f, p.id), { projects: 0, jobs: 0, releases: 0 });
    await assert.rejects(access(done.dir));
    await assert.rejects(
      access(
        join(f.config.dataDirectory, 'builds', buildDirectoryName(done.job)),
      ),
    );
    assert.equal(
      await readFile(
        join(f.config.dataDirectory, 'icons', icon.split('/').at(-1)),
        'utf8',
      ),
      'shared',
    );
    assert.equal(
      (await ok(f, await login(f), 'GET', '/api/projects')).items[0].id,
      other.id,
    );
  },
);

test(
  'retention limits apply per project only after an admin confirms a current plan',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      admin = await login(f);
    const p = await ok(f, admin, 'POST', '/api/projects', input);
    const other = await ok(f, admin, 'POST', '/api/projects', {
      ...input,
      name: 'Other history',
    });
    const otherBuild = await completed(f, admin, other);
    const preview = () => ok(f, admin, 'GET', '/api/maintenance/retention');
    const submit = (project, token, session = admin, headers = {}) =>
      call(
        f,
        session,
        'POST',
        `/api/projects/${project.id}/retention-cleanup`,
        { token },
        headers,
      );
    async function failed() {
      const j = await queue(f, admin, p);
      assert.equal((await command(f, 'claim')).id, j.id);
      await command(f, 'finish', { id: j.id, status: 'failed' });
      return j;
    }
    const first = await failed();
    assert.deepEqual(await preview(), []);
    const oldest = await completed(f, admin, p);
    const middle = await completed(f, admin, p);
    for (let n = 0; n < 8; n++) await completed(f, admin, p);
    let [plan] = await preview();
    assert.equal(plan.limit, 10);
    assert.equal(plan.kept.length, 10);
    assert.deepEqual(
      plan.candidates.map((c) => c.jobId),
      [first.id],
    );
    const { job: last } = await completed(f, admin, p);
    const newestFailure = await failed();
    assert.equal((await submit(p, plan.token)).statusCode, 409);
    [plan] = await preview();
    assert.deepEqual(
      plan.candidates.map((c) => c.jobId),
      [oldest.job.id, first.id],
    );
    // Changing an existing release into a rejected version changes the cutoff.
    const status = await call(
      f,
      admin,
      'PATCH',
      `/api/releases/${middle.release.id}/test-status`,
      { status: 'rejected', revision: middle.release.revision },
    );
    assert.equal(status.statusCode, 200, status.body);
    assert.equal((await submit(p, plan.token)).statusCode, 409);
    [plan] = await preview();
    assert.deepEqual(
      plan.candidates.map((c) => c.jobId),
      [middle.job.id, first.id],
    );
    assert.ok(
      plan.kept.includes(last.number) && plan.kept.includes(oldest.job.number),
    );
    assert.equal((await submit(other, plan.token)).statusCode, 409);
    await ok(f, admin, 'POST', '/api/users', {
      username: 'retention-user',
      password: 'password12345',
      role: 'user',
    });
    const user = await login(f, 'retention-user', 'password12345');
    assert.equal(
      (await call(f, user, 'GET', '/api/maintenance/retention')).statusCode,
      403,
    );
    assert.equal((await submit(p, plan.token, user)).statusCode, 403);
    assert.equal(
      (await submit(p, plan.token, admin, { 'x-csrf-token': '' })).statusCode,
      403,
    );
    assert.equal(counts(f, p.id).jobs, 13);
    const extra = await completed(f, admin, p);
    const protectedFailure = await failed();
    [plan] = await preview();
    assert.deepEqual(
      plan.candidates.map((c) => c.jobId),
      [newestFailure.id, middle.job.id, oldest.job.id, first.id],
    );
    const res = await submit(p, plan.token);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { removed: 4, unfinished: [] });
    assert.equal((await submit(p, plan.token)).statusCode, 409);
    assert.deepEqual(await preview(), []);
    assert.deepEqual(counts(f, p.id), { projects: 1, jobs: 11, releases: 10 });
    await assert.rejects(access(oldest.dir), { code: 'ENOENT' });
    await assert.rejects(access(middle.dir), { code: 'ENOENT' });
    await access(extra.dir);
    await access(otherBuild.dir);
    assert.equal(
      (
        await call(
          f,
          null,
          'GET',
          `/api/public/artifacts/${oldest.release.artifacts[0].id}/download`,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await ok(f, admin, 'GET', `/api/jobs/${protectedFailure.id}`)).status,
      'failed',
    );
  },
);
