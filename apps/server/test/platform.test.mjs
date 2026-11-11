import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  access,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { PlatformService } from '../dist/modules/platform/service.js';
import { createApp } from '../dist/app.js';
import { startDatabase, closeDatabase } from '../dist/db/client.js';
import sharp from 'sharp';
import { utimes } from 'node:fs/promises';
import { runProcess } from '../dist/tools/process.js';
import { collectArtifacts, safePath } from '../dist/tools/paths.js';
const exec = promisify(execFile),
  origin = 'http://127.0.0.1:5173';
process.umask(0o077);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, predicate, timeout = 25000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await pause(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${JSON.stringify(value)}`);
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'builder-platform-'));
  let db = await startDatabase(join(directory, 'data'));
  const config = {
    host: '127.0.0.1',
    port: 3000,
    dataDirectory: join(directory, 'data'),
    logLevel: 'silent',
    appOrigin: origin,
    runner: 'local',
  };
  let app = await createApp(config, db);
  const target = {
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
  t.after(async () => {
    await app.close();
    await closeDatabase(db);
    await rm(directory, { recursive: true, force: true });
  });
  return target;
}
async function login(f, username = 'admin', password = 'admin123456') {
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { username, password },
    remoteAddress: `127.0.0.${Math.floor(Math.random() * 200) + 1}`,
  });
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json();
  return {
    user: data.user,
    headers: {
      origin,
      cookie: response.headers['set-cookie'].split(';')[0],
      'x-csrf-token': data.csrfToken,
    },
  };
}
function call(f, s, method, url, payload, headers = {}) {
  return f.app.inject({
    method,
    url,
    headers: { ...s?.headers, ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
}
async function ok(f, s, method, url, payload, headers) {
  const r = await call(f, s, method, url, payload, headers);
  assert.equal(r.statusCode, 200, `${method} ${url}: ${r.body}`);
  return r.json();
}
const input = {
  name: 'Fixture',
  description: 'real local build',
  repository: 'https://example.invalid/repo.git',
  defaultBranch: 'main',
  workdir: './',
  buildScript:
    'mkdir -p dist\nnode -e \'require("fs").writeFileSync("dist/result.txt", "main")\'\nsleep 1',
  artifactPath: './dist',
  timeout: 5,
};
async function gitFixture(f, t) {
  const repo = join(f.directory, 'repo');
  await mkdir(repo);
  await exec('git', ['init', '-b', 'main', repo]);
  await writeFile(join(repo, 'marker.txt'), 'main');
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify({
      name: 'builder-fixture',
      version: '1.0.0',
      scripts: {
        build:
          'node -e \'require("fs").mkdirSync("dist",{recursive:true});require("fs").copyFileSync("marker.txt","dist/result.txt")\'',
      },
    }),
  );
  await writeFile(
    join(repo, 'package-lock.json'),
    JSON.stringify({
      name: 'builder-fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'builder-fixture', version: '1.0.0' } },
    }),
  );

  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', [
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'main fixture',
  ]);
  await exec('git', ['-C', repo, 'checkout', '-b', 'other']);
  await writeFile(join(repo, 'marker.txt'), 'other');
  await exec('git', ['-C', repo, 'add', '.']);
  await exec('git', [
    '-C',
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'other fixture',
  ]);
  await exec('git', ['-C', repo, 'checkout', 'main']);
  await exec('git', ['clone', '--bare', repo, join(f.directory, 'repo.git')]);
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const child = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH,
        HOME: f.directory,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_PROJECT_ROOT: f.directory,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: req.method,
        PATH_INFO: u.pathname,
        QUERY_STRING: u.search.slice(1),
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        REMOTE_ADDR: '127.0.0.1',
      },
    });
    let head = Buffer.alloc(0),
      started = false;
    child.stdout.on('data', (chunk) => {
      if (started) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const i = head.indexOf('\r\n\r\n');
      if (i < 0) return;
      for (const line of head.subarray(0, i).toString().split('\r\n')) {
        const c = line.indexOf(':');
        if (c > 0) {
          const key = line.slice(0, c),
            val = line.slice(c + 1).trim();
          if (key.toLowerCase() === 'status')
            res.statusCode = Number(val.split(' ')[0]);
          else res.setHeader(key, val);
        }
      }
      started = true;
      res.write(head.subarray(i + 4));
    });
    child.on('close', () => res.end());
    req.pipe(child.stdin);
    child.stdin.on('error', () => {});
    child.stderr.resume();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${server.address().port}/repo.git`, repo };
}
async function setupProject(f, s, git, patch = {}) {
  const p = await ok(f, s, 'POST', '/api/projects', { ...input, ...patch });
  // A local smart HTTP fixture replaces the stored remote only in test setup.
  // Public project validation is tested independently and still rejects http/file paths.
  await f.db.request('platform', {
    action: 'saveProject',
    actor: s.user,
    data: { id: p.id, input: { ...input, ...patch, repository: git.url } },
  });
  return p;
}
async function enqueue(f, s, p, branch = 'main') {
  const fetched = await ok(f, s, 'POST', `/api/projects/${p.id}/fetch`, {
    branch,
  });
  return ok(
    f,
    s,
    'POST',
    '/api/jobs',
    { projectId: p.id, branch, sha: fetched.sha },
    { 'idempotency-key': randomUUID() },
  );
}
const getJobs = async (f) =>
  (await f.app.inject({ url: '/api/health' })).json();

test(
  'real Git → queue (2 slots / 5 jobs), Bash + Node → artifacts → anonymous download; branch isolation, revision conflict and physical delete',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t),
      s = await login(f),
      git = await gitFixture(f, t);
    await ok(f, s, 'PUT', '/api/settings', { maxConcurrent: 2 });
    const p = await setupProject(f, s, git, {
      buildScript:
        'mkdir -p dist\nnode -e \'require("fs").copyFileSync("marker.txt","dist/result.txt")\'\nsleep 1.5',
    });
    const fetched = await ok(f, s, 'POST', `/api/projects/${p.id}/fetch`, {
      branch: 'main',
    });
    const jobs = [];
    for (let n = 0; n < 5; n++)
      jobs.push(
        await ok(
          f,
          s,
          'POST',
          '/api/jobs',
          { projectId: p.id, branch: 'main', sha: fetched.sha },
          { 'idempotency-key': randomUUID() },
        ),
      );
    // Change config and branch fetch while jobs are waiting: existing jobs must keep snapshots.
    await ok(f, s, 'PUT', `/api/projects/${p.id}`, {
      ...input,
      repository: git.url.replace('http:', 'https:'),
      buildScript: 'false',
    });
    const snapshot = (await ok(f, s, 'GET', '/api/jobs')).items;
    assert.ok(
      snapshot.every((j) => j.snapshot.buildScript.includes('copyFileSync')),
    );
    assert.equal(snapshot.filter((j) => j.status === 'running').length, 2);
    assert.equal(snapshot.filter((j) => j.status === 'queued').length, 3);
    // Lowering the cap keeps existing jobs alive and stops replacement until occupancy drops.
    await ok(f, s, 'PUT', '/api/settings', { maxConcurrent: 1 });
    const queue = await ok(f, s, 'GET', '/api/queue');
    assert.equal(queue.occupied, 2);
    await ok(f, s, 'PUT', '/api/settings', { maxConcurrent: 2 });
    let max = 0;
    const final = await until(
      async () => {
        const rows = (await ok(f, s, 'GET', '/api/jobs')).items;
        max = Math.max(
          max,
          rows.filter((j) => ['running', 'canceling'].includes(j.status))
            .length,
        );
        return rows;
      },
      (rows) => rows.every((j) => j.status === 'succeeded'),
      40000,
    );
    assert.equal(max, 2);
    const ordered = [...final].sort((a, b) => a.seq - b.seq);
    for (let n = 1; n < ordered.length; n++)
      assert.ok(ordered[n].startedAt >= ordered[n - 1].startedAt);
    const p2 = await setupProject(f, s, git, {
      name: 'Other',
      buildScript: 'npm ci --offline --ignore-scripts\nnpm run build',
    });
    const other = await enqueue(f, s, p2, 'other');
    await until(
      () => ok(f, s, 'GET', `/api/jobs/${other.id}`),
      (j) => j.status === 'succeeded',
    );
    const releases = (await ok(f, s, 'GET', '/api/releases')).items;
    assert.equal(releases.length, 6);
    for (const rel of releases) {
      const file = rel.artifacts[0];
      const response = await call(
        f,
        null,
        'GET',
        `/api/public/artifacts/${file.id}/download`,
      );
      assert.equal(response.statusCode, 200);
      assert.equal(response.body, rel.projectId === p.id ? 'main' : 'other');
      assert.equal(
        createHash('sha256').update(response.rawPayload).digest('hex'),
        file.sha256,
      );
      assert.match(response.headers['content-disposition'], /^attachment/);
    }
    const rel = releases.find((r) => r.projectId === p.id);
    await ok(f, s, 'PATCH', `/api/releases/${rel.id}/test-status`, {
      status: 'passed',
      revision: 1,
    });
    assert.equal(
      (
        await call(f, s, 'PATCH', `/api/releases/${rel.id}/test-status`, {
          status: 'failed',
          revision: 1,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await call(f, s, 'PATCH', `/api/releases/${rel.id}/test-status`, {
          status: 'testing',
          revision: 1,
        })
      ).statusCode,
      409,
    );
    const pub = (await call(f, null, 'GET', '/api/public/projects')).json();
    assert.ok(pub.length === 2);
    assert.doesNotMatch(
      JSON.stringify(pub),
      /repository|buildScript|triggeredBy|workdir/,
    );
    const page = await ok(
      f,
      null,
      'GET',
      `/api/public/projects/${p.slug}/releases?status=passed&page=1`,
    );
    assert.equal(page.total, 1);
    assert.equal(page.items[0].testStatus, 'passed');
    const fileId = rel.artifacts[0].id;
    await ok(f, s, 'DELETE', `/api/releases/${rel.id}`);
    assert.equal(
      (await call(f, null, 'GET', `/api/public/artifacts/${fileId}/download`))
        .statusCode,
      404,
    );
    await assert.rejects(
      access(join(f.config.dataDirectory, 'builds', String(rel.jobId))),
    );
    assert.equal(
      (await ok(f, s, 'GET', '/api/jobs')).items.some(
        (j) => j.id === rel.jobId,
      ),
      false,
    );
    await f.restart();
    const again = await login(f);
    assert.equal((await ok(f, again, 'GET', '/api/releases')).items.length, 5);
    const logs = await ok(
      f,
      again,
      'GET',
      `/api/jobs/${ordered[1].id}/log?offset=0`,
    );
    assert.ok(logs.lines.some((l) => l.text.includes('node -e')));
    assert.equal(logs.done, true);
    const backup = await ok(f, again, 'POST', '/api/maintenance/backup');
    const restored = join(f.directory, 'restored');
    await exec(
      process.execPath,
      [
        'dist/tools/restore.js',
        join(f.config.dataDirectory, 'backups', backup.id),
        restored,
      ],
      { cwd: new URL('..', import.meta.url).pathname },
    );
    const restoredDb = await startDatabase(restored);
    try {
      const state = await restoredDb.request('platform', {
        action: 'list',
        actor: again.user,
      });
      assert.equal(state.releases.length, 5);
      const a = state.releases[0].artifacts[0];
      const content = await readFile(
        join(
          restored,
          'builds',
          String(state.releases[0].jobId),
          'artifacts',
          '0',
        ),
      );
      assert.equal(
        createHash('sha256').update(content).digest('hex'),
        a.sha256,
      );
    } finally {
      await closeDatabase(restoredDb);
    }
    // A damaged published artifact must disappear from anonymous listings after restart.
    const published = (await ok(f, again, 'GET', '/api/releases')).items[0];
    await writeFile(
      join(
        f.config.dataDirectory,
        'builds',
        String(published.jobId),
        'artifacts',
        '0',
      ),
      'tampered',
    );
    await f.restart();
    const afterCorruption = await login(f);
    assert.equal(
      (await ok(f, afterCorruption, 'GET', '/api/releases')).items.some(
        (r) => r.id === published.id,
      ),
      false,
    );
    assert.equal(
      (
        await call(
          f,
          null,
          'GET',
          `/api/public/artifacts/${published.artifacts[0].id}/download`,
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await ok(f, afterCorruption, 'GET', `/api/jobs/${published.jobId}`))
        .status,
      'failed',
    );
  },
);

test(
  'authorization, immutable commit snapshot, idempotency, canceling slot, deletion and failure boundaries',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t),
      s = await login(f),
      git = await gitFixture(f, t);
    assert.equal((await call(f, null, 'GET', '/api/projects')).statusCode, 401);
    assert.equal(
      (
        await call(
          f,
          s,
          'PUT',
          '/api/settings',
          { maxConcurrent: 2 },
          { 'x-csrf-token': 'wrong' },
        )
      ).statusCode,
      403,
    );
    await ok(f, s, 'POST', '/api/users', {
      username: 'tester',
      displayName: 'Tester',
      role: 'user',
      password: 'tester123456',
    });
    const user = await login(f, 'tester', 'tester123456');
    assert.equal(
      (await call(f, user, 'POST', '/api/projects', input)).statusCode,
      403,
    );
    assert.equal(
      (
        await call(f, s, 'POST', '/api/projects', {
          ...input,
          workdir: './../escape',
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await call(f, s, 'POST', '/api/projects', {
          ...input,
          repository: 'https://user:secret@example.invalid/repo',
        })
      ).statusCode,
      400,
    );
    const p = await setupProject(f, s, git, {
      buildScript: 'sleep 20\nmkdir -p dist\necho okay > dist/out',
    });
    assert.equal(
      (
        await call(
          f,
          s,
          'POST',
          '/api/jobs',
          { projectId: p.id, branch: 'main', sha: 'a'.repeat(40) },
          { 'idempotency-key': randomUUID() },
        )
      ).statusCode,
      409,
    );
    const fetched = await ok(f, s, 'POST', `/api/projects/${p.id}/fetch`, {
      branch: 'main',
    });
    const key = randomUUID(),
      body = { projectId: p.id, branch: 'main', sha: fetched.sha };
    const job = await ok(f, s, 'POST', '/api/jobs', body, {
      'idempotency-key': key,
    });
    assert.equal(
      (await ok(f, s, 'POST', '/api/jobs', body, { 'idempotency-key': key }))
        .id,
      job.id,
    );
    await until(
      () => ok(f, s, 'GET', `/api/jobs/${job.id}`),
      (j) => j.phase === 1,
    );
    assert.equal(
      (await call(f, user, 'POST', `/api/jobs/${job.id}/stop`)).statusCode,
      403,
    );
    assert.equal(
      (await call(f, s, 'DELETE', `/api/jobs/${job.id}`)).statusCode,
      409,
    );
    const queued = await ok(f, s, 'POST', '/api/jobs', body, {
      'idempotency-key': randomUUID(),
    });
    await ok(f, s, 'DELETE', `/api/jobs/${queued.id}`);
    const stop = await ok(f, s, 'POST', `/api/jobs/${job.id}/stop`);
    assert.equal(stop.status, 'canceling');
    await until(
      () => ok(f, s, 'GET', `/api/jobs/${job.id}`),
      (j) => j.status === 'canceled',
    );
    assert.equal((await ok(f, s, 'GET', '/api/queue')).occupied, 0);
    await ok(f, s, 'DELETE', `/api/jobs/${job.id}`);
    assert.equal(
      (await call(f, s, 'POST', '/api/jobs', body, { 'idempotency-key': key }))
        .statusCode,
      409,
    );

    await assert.rejects(
      access(join(f.config.dataDirectory, 'builds', String(job.id))),
    );
    const failed = await setupProject(f, s, git, {
      name: 'Failed',
      buildScript: 'mkdir -p dist\necho before\nfalse\necho after > dist/out',
    });
    const bad = await enqueue(f, s, failed);
    const done = await until(
      () => ok(f, s, 'GET', `/api/jobs/${bad.id}`),
      (j) => j.status === 'failed',
    );
    assert.match(done.error, /退出码/);
    assert.equal((await ok(f, s, 'GET', '/api/releases')).items.length, 0);
    const escaped = await setupProject(f, s, git, {
      name: 'Symlink',
      buildScript: 'ln -s /tmp dist',
    });
    const e = await enqueue(f, s, escaped);
    assert.match(
      (
        await until(
          () => ok(f, s, 'GET', `/api/jobs/${e.id}`),
          (j) => j.status === 'failed',
        )
      ).error,
      /符号链接/,
    );
    const created = (await ok(f, s, 'GET', '/api/users')).items.find(
      (u) => u.username === 'tester',
    );
    assert.equal(
      (await call(f, s, 'DELETE', `/api/users/${s.user.id}`)).statusCode,
      409,
    );
    await ok(f, s, 'POST', `/api/users/${created.id}/password`, {
      password: 'newpassword123',
    });
    assert.equal((await call(f, user, 'GET', '/api/jobs')).statusCode, 401);
    const owner = await login(f, 'tester', 'newpassword123');
    const owned = await enqueue(f, owner, failed);
    await until(
      () => ok(f, s, 'GET', `/api/jobs/${owned.id}`),
      (j) => j.status === 'failed',
    );
    await ok(f, s, 'DELETE', `/api/users/${created.id}`);
    const newer = await ok(f, s, 'POST', '/api/users', {
      username: 'tester',
      displayName: 'Again',
      role: 'user',
      password: 'tester123456',
    });
    assert.notEqual(newer.id, created.id);
    const replacement = await login(f, 'tester', 'tester123456');
    assert.equal(
      (await call(f, replacement, 'DELETE', `/api/jobs/${owned.id}`))
        .statusCode,
      403,
    );

    assert.doesNotMatch(
      JSON.stringify((await ok(f, s, 'GET', '/api/users')).items),
      /password/,
    );
  },
);

test(
  'process timeout, environment isolation and path/artifact integrity limits',
  { timeout: 15000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'builder-tools-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    process.env.BUILDER_TEST_SECRET = 'must-not-inherit';
    const output = await runProcess('node', [
      '-e',
      'console.log(process.env.BUILDER_TEST_SECRET ?? "clean")',
    ]);
    delete process.env.BUILDER_TEST_SECRET;
    assert.equal(output.trim(), 'clean');
    const began = Date.now();
    await assert.rejects(
      runProcess('bash', ['-c', 'sleep 30 & wait'], { timeout: 100 }),
      /超时/,
    );
    assert.ok(Date.now() - began < 5000);
    await assert.rejects(safePath(dir, '../outside'), /相对路径/);
    await mkdir(join(dir, 'source'));
    await writeFile(join(dir, 'source', 'result'), 'content');
    const files = await collectArtifacts(
      dir,
      join(dir, 'source'),
      join(dir, 'staging'),
    );
    assert.equal(files.length, 1);
    assert.equal(
      files[0].sha256,
      createHash('sha256').update('content').digest('hex'),
    );
  },
);

test(
  'image decoding/limits, queued-delete race, backup failure release and interrupted publication recovery',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      s = await login(f);
    const png = await sharp({
      create: { width: 8, height: 8, channels: 4, background: '#2563eb' },
    })
      .png()
      .toBuffer();
    const data = `data:image/png;base64,${png.toString('base64')}`;
    const p = await ok(f, s, 'POST', '/api/projects', { ...input, icon: data });
    assert.match(p.icon, /^\/api\/public\/icons\/[a-f0-9-]+\.png$/);
    assert.equal((await call(f, null, 'GET', p.icon)).statusCode, 200);
    const retained = await ok(f, s, 'PUT', `/api/projects/${p.id}`, input);
    assert.equal(retained.icon, p.icon);
    const cleared = await ok(f, s, 'PUT', `/api/projects/${p.id}`, {
      ...input,
      icon: null,
    });
    assert.equal(cleared.icon, undefined);
    assert.equal(
      (
        await call(f, s, 'POST', '/api/projects', {
          ...input,
          icon: 'data:image/png;base64,PHN2Zz48L3N2Zz4=',
        })
      ).statusCode,
      400,
    );
    const huge = await sharp({
      create: { width: 4001, height: 4001, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    assert.equal(
      (
        await call(f, s, 'POST', '/api/projects', {
          ...input,
          icon: `data:image/png;base64,${huge.toString('base64')}`,
        })
      ).statusCode,
      400,
    );
    // Simulate permission/disk failure at first backup directory creation.
    await writeFile(join(f.config.dataDirectory, 'backups'), 'not-a-directory');
    assert.equal(
      (await call(f, s, 'POST', '/api/maintenance/backup')).statusCode,
      500,
    );
    await ok(f, s, 'PUT', '/api/settings', { maxConcurrent: 1 });
    await rm(join(f.config.dataDirectory, 'backups'));
    const retainedIcon = await ok(f, s, 'POST', '/api/projects', {
      ...input,
      name: 'retained icon',
      icon: data,
    });
    const old = new Date(Date.now() - 48 * 60 * 60_000);
    const oldIconFile = join(
      f.config.dataDirectory,
      'icons',
      p.icon.split('/').at(-1),
    );
    const referencedFile = join(
      f.config.dataDirectory,
      'icons',
      retainedIcon.icon.split('/').at(-1),
    );
    await utimes(oldIconFile, old, old);
    await utimes(referencedFile, old, old);
    // Pause the live scheduler by closing the HTTP app, then seed interrupted DB state.
    await f.app.close();
    const fetched = {
      branch: 'main',
      sha: 'a'.repeat(40),
      message: 'fixture',
      at: Date.now(),
    };
    await f.db.request('platform', {
      action: 'fetched',
      actor: s.user,
      data: { id: p.id, repository: p.repository, fetched, branches: ['main'] },
    });
    const createQueued = () =>
      f.db.request('platform', {
        action: 'enqueue',
        actor: s.user,
        data: {
          projectId: p.id,
          branch: 'main',
          sha: fetched.sha,
          key: randomUUID(),
          hash: 'fixture',
        },
      });
    const race = await createQueued();
    const outcomes = await Promise.allSettled([
      f.db.request('platform', { action: 'claim' }),
      f.db.request('platform', {
        action: 'markDelete',
        actor: s.user,
        data: { id: race.id },
      }),
    ]);
    assert.equal(outcomes[0].status, 'fulfilled');
    assert.equal(outcomes[1].status, 'rejected');
    await f.db.request('platform', {
      action: 'finish',
      data: { id: race.id, status: 'failed', error: 'fixture race cleanup' },
    });
    const noProcess = await createQueued();
    await f.db.request('platform', { action: 'claim' });
    const pendingGuard = new PlatformService(f.db, f.config);
    await pendingGuard.stop(noProcess.id, s.user);
    assert.equal(
      (
        await f.db.request('platform', {
          action: 'job',
          data: { id: noProcess.id },
        })
      ).status,
      'canceled',
    );
    let job;
    for (let n = 0; n < 6; n++) {
      job = await createQueued();
      const claimed = await f.db.request('platform', { action: 'claim' });
      assert.equal(claimed.id, job.id);
      const dir = join(f.config.dataDirectory, 'builds', String(job.id));
      await mkdir(join(dir, 'artifacts'), { recursive: true });
      await writeFile(join(dir, 'artifacts', '0'), 'recovered');
      const files = [
        {
          name: 'result.txt',
          size: 9,
          sha256: createHash('sha256').update('recovered').digest('hex'),
          storageKey: 'artifacts/0',
        },
      ];
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(files));
      if (n < 5)
        await f.db.request('platform', {
          action: 'finish',
          data: { id: job.id, status: 'succeeded', artifacts: files },
        });
    }
    await f.restart();
    const again = await login(f);
    assert.equal(
      (await ok(f, again, 'GET', `/api/jobs/${job.id}`)).status,
      'succeeded',
    );
    await assert.rejects(access(oldIconFile));
    await access(referencedFile);
    const page1 = await ok(
      f,
      null,
      'GET',
      `/api/public/projects/${p.slug}/releases?page=1`,
    );
    const page2 = await ok(
      f,
      null,
      'GET',
      `/api/public/projects/${p.slug}/releases?page=2`,
    );
    assert.equal(page1.total, 6);
    assert.equal(page1.items.length, 5);
    assert.equal(page2.items.length, 1);
    assert.ok(page1.items[0].jobId > page2.items[0].jobId);
    const empty = await ok(
      f,
      null,
      'GET',
      `/api/public/projects/${p.slug}/releases?status=passed`,
    );
    assert.equal(empty.total, 0);
    assert.equal(empty.hasAny, true);
    const rel = (await ok(f, again, 'GET', '/api/releases')).items[0];
    assert.equal(
      (
        await call(
          f,
          null,
          'GET',
          `/api/public/artifacts/${rel.artifacts[0].id}/download`,
        )
      ).body,
      'recovered',
    );
    // Hold a real file reader: delete must hide downloads but keep a retryable admin task.
    const guard = new PlatformService(f.db, f.config);
    const held = await guard.openArtifact(rel.artifacts[0].id);
    await assert.rejects(
      guard.delete(rel.jobId, again.user),
      (e) => e.statusCode === 409,
    );
    const retryable = await ok(f, again, 'GET', `/api/jobs/${rel.jobId}`);
    assert.equal(retryable.status, 'failed');
    assert.match(retryable.error, /删除未完成/);
    assert.equal(
      (
        await call(
          f,
          null,
          'GET',
          `/api/public/artifacts/${rel.artifacts[0].id}/download`,
        )
      ).statusCode,
      404,
    );
    await new Promise((resolve) => {
      held.stream.once('close', resolve);
      held.stream.destroy();
    });
    await guard.delete(rel.jobId, again.user);
    await assert.rejects(
      access(join(f.config.dataDirectory, 'builds', String(rel.jobId))),
    );
    // Restart continues a partially marked cleanup without reviving its release.
    const remaining = (await ok(f, again, 'GET', '/api/releases')).items[0];
    await f.db.request('platform', {
      action: 'markDelete',
      actor: again.user,
      data: { id: remaining.jobId },
    });
    await f.restart();
    const resumed = await login(f);
    assert.equal(
      (await call(f, resumed, 'GET', `/api/jobs/${remaining.jobId}`))
        .statusCode,
      404,
    );
    await assert.rejects(
      access(join(f.config.dataDirectory, 'builds', String(remaining.jobId))),
    );
  },
);

test(
  'hard service restart terminates the orphan build before releasing its slot and preserves queued config',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t),
      admin = await login(f),
      git = await gitFixture(f, t);
    const project = await setupProject(f, admin, git, {
      buildScript: 'mkdir -p dist\necho running\nsleep 25\necho old > dist/out',
    });
    const fetched = await ok(
      f,
      admin,
      'POST',
      `/api/projects/${project.id}/fetch`,
      { branch: 'main' },
    );
    await f.app.close();
    // An isolated real HTTP server child is killed without a graceful shutdown.
    const portServer = createServer();
    await new Promise((r) => portServer.listen(0, '127.0.0.1', r));
    const port = portServer.address().port;
    await new Promise((r) => portServer.close(r));
    let child;
    const stop = async (signal) => {
      if (!child || child.exitCode !== null || child.signalCode !== null)
        return;
      await new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill(signal);
      });
    };
    t.after(() => stop('SIGTERM'));
    async function start() {
      child = spawn(process.execPath, ['dist/index.js'], {
        cwd: new URL('..', import.meta.url).pathname,
        env: {
          PATH: process.env.PATH,
          HOME: f.directory,
          PORT: String(port),
          HOST: '127.0.0.1',
          DATA_DIR: f.config.dataDirectory,
          APP_ORIGIN: origin,
          LOG_LEVEL: 'silent',
          BUILDER_RUNNER: 'local',
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      await until(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${port}/api/health`)).status;
          } catch {
            return 0;
          }
        },
        (s) => s === 200,
        10000,
      );
    }
    async function api(method, path, body, session) {
      const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
        method,
        headers: {
          origin,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(session
            ? { cookie: session.cookie, 'x-csrf-token': session.csrf }
            : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { response, data: await response.json() };
    }
    await start();
    let logged = await api('POST', '/auth/login', {
      username: 'admin',
      password: 'admin123456',
    });
    let session = {
      cookie: logged.response.headers.get('set-cookie').split(';')[0],
      csrf: logged.data.csrfToken,
    };
    const enq = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
        method: 'POST',
        headers: {
          origin,
          'Content-Type': 'application/json',
          cookie: session.cookie,
          'x-csrf-token': session.csrf,
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({
          projectId: project.id,
          branch: 'main',
          sha: fetched.sha,
        }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    const running = await enq();
    await until(
      async () => (await api('GET', `/jobs/${running.id}`, null, session)).data,
      (j) => j.phase === 1,
    );
    // Future tasks get a new snapshot, while the existing process is still running the old script.
    await f.db.request('platform', {
      action: 'saveProject',
      actor: admin.user,
      data: {
        id: project.id,
        input: {
          ...input,
          repository: git.url,
          buildScript: 'mkdir -p dist\necho queued > dist/out',
        },
      },
    });
    const queued = await enq();
    assert.equal(queued.status, 'queued');
    await stop('SIGKILL');
    await start();
    logged = await api('POST', '/auth/login', {
      username: 'admin',
      password: 'admin123456',
    });
    session = {
      cookie: logged.response.headers.get('set-cookie').split(';')[0],
      csrf: logged.data.csrfToken,
    };
    assert.equal(
      (await api('GET', `/jobs/${running.id}`, null, session)).data.status,
      'failed',
    );
    const completed = await until(
      async () => (await api('GET', `/jobs/${queued.id}`, null, session)).data,
      (j) => j.status === 'succeeded',
      15000,
    );
    assert.ok(completed.startedAt >= running.createdAt);
    const releases = (await api('GET', '/releases', null, session)).data.items;
    assert.equal(releases.length, 1);
    assert.equal(releases[0].jobId, queued.id);
    await stop('SIGTERM');
  },
);
