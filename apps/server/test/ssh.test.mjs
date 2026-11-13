import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  readdir,
} from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, connect } from 'node:net';
import Database from 'better-sqlite3';
import { createApp } from '../dist/app.js';
import { startDatabase, closeDatabase } from '../dist/db/client.js';
import { SshService, isPublicAddress, sshHostOf } from '../dist/tools/ssh.js';
import { BuildRunner } from '../dist/tools/runner.js';
import { runProcess } from '../dist/tools/process.js';
const exec = promisify(execFile),
  origin = 'http://127.0.0.1:5173';
process.umask(0o077);
const pause = (n) => new Promise((r) => setTimeout(r, n));
async function fixture(t, secretKey = randomBytes(32).toString('base64')) {
  const directory = await mkdtemp(join(tmpdir(), 'builder-ssh-'));
  const config = {
    host: '127.0.0.1',
    port: 3000,
    dataDirectory: join(directory, 'data'),
    logLevel: 'silent',
    appOrigin: origin,
    runner: 'local',
    secretKey,
  };
  let db = await startDatabase(config.dataDirectory),
    app = await createApp(config, db);
  const f = {
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
  return f;
}
async function login(f, username = 'admin', password = 'admin123456') {
  const r = await f.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { username, password },
    remoteAddress: `127.0.0.${Math.floor(Math.random() * 200) + 1}`,
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
async function ok(f, s, method, url, payload, headers) {
  const r = await call(f, s, method, url, payload, headers);
  assert.equal(r.statusCode, 200, `${method} ${url}: ${r.body}`);
  return r.json();
}
const projectInput = {
  name: 'SSH test',
  description: '',
  repository: 'git@example.invalid:repo.git',
  defaultBranch: 'main',
  workdir: './',
  buildScript: 'mkdir -p dist\nprintf success > dist/result.txt',
  artifactPath: './dist',
  timeout: 5,
};
async function keyFile(directory, name, type = 'ed25519', options = []) {
  const path = join(directory, name);
  await exec('ssh-keygen', [
    '-q',
    '-t',
    type,
    ...options,
    '-N',
    '',
    '-f',
    path,
  ]);
  return {
    path,
    privateKey: await readFile(path, 'utf8'),
    publicKey: (await readFile(path + '.pub', 'utf8')).trim(),
  };
}
function inspect(f, fn) {
  const db = new Database(join(f.config.dataDirectory, 'platform.db'), {
    readonly: true,
  });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
async function until(read, check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (check(value)) return value;
    await pause(75);
  } while (Date.now() < deadline);
  throw new Error('SSH fixture condition timed out');
}

// Encryption, private-key parsing, and network policy are trust boundaries independent of HTTP.
test(
  'SSH encryption and key validation reject invalid secrets, ciphertext, weak and protected keys',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t),
      ssh = new SshService(f.config, f.db);
    const key = await keyFile(f.directory, 'ed25519');
    const a = ssh.encrypt(key.privateKey),
      b = ssh.encrypt(key.privateKey);
    assert.notDeepEqual(a, b);
    assert.equal(ssh.decrypt(a).toString(), key.privateKey);
    assert.equal(a.includes(Buffer.from('PRIVATE KEY')), false);
    a[15] ^= 1;
    assert.throws(() => ssh.decrypt(a), /解密失败/);
    for (const secretKey of [
      '',
      randomBytes(31).toString('base64'),
      '!'.repeat(44),
    ])
      assert.throws(
        () => new SshService({ ...f.config, secretKey }, f.db).encrypt('x'),
        /BUILDER_SECRET_KEY/,
      );
    const parsed = await ssh.keyMaterial('imported', 'import', key.privateKey);
    const fingerprint = (
      await exec('ssh-keygen', ['-l', '-E', 'sha256', '-f', key.path + '.pub'])
    ).stdout.split(/\s+/)[1];
    assert.equal(parsed.fingerprint, fingerprint);
    assert.equal(parsed.type, 'ed25519');
    const rsa = await keyFile(f.directory, 'rsa', 'rsa', [
      '-b',
      '2048',
      '-m',
      'PEM',
    ]);
    assert.equal(
      (await ssh.keyMaterial('rsa', 'import', rsa.privateKey)).type,
      'rsa',
    );
    const ec = await keyFile(f.directory, 'ec', 'ecdsa', ['-b', '256']);
    assert.equal(
      (await ssh.keyMaterial('ec', 'import', ec.privateKey)).type,
      'ecdsa',
    );
    const weak = await keyFile(f.directory, 'weak', 'rsa', ['-b', '1024']);
    await assert.rejects(
      () => ssh.keyMaterial('weak', 'import', weak.privateKey),
      /2048/,
    );
    const protectedPath = join(f.directory, 'protected');
    await exec('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      'fixture-passphrase',
      '-f',
      protectedPath,
    ]);
    for (const input of [
      'invalid',
      'x'.repeat(16385),
      await readFile(protectedPath, 'utf8'),
    ])
      await assert.rejects(
        () => ssh.keyMaterial('invalid', 'import', input),
        /无口令/,
      );
    assert.deepEqual(sshHostOf('git@example.com:repo.git'), {
      host: 'example.com',
      port: 22,
    });
    assert.deepEqual(sshHostOf('ssh://git@[2001:4860:4860::8888]:2222/repo'), {
      host: '2001:4860:4860::8888',
      port: 2222,
    });
    assert.equal(sshHostOf('https://example.com/repo'), null);
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '100.100.100.200',
      '192.168.1.1',
      '::1',
      '::ffff:127.0.0.1',
      'fc00::1',
      'fe80::1',
      '2002:7f00:1::',
    ])
      assert.equal(isPublicAddress(ip), false, ip);
    assert.equal(isPublicAddress('8.8.8.8'), true);
    assert.equal(isPublicAddress('2001:4860:4860::8888'), true);
    assert.deepEqual(await readdir(ssh.root), []);
  },
);

test(
  'SSH APIs enforce authorization, CSRF, key lifecycle, project binding and private material secrecy',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t),
      s = await login(f);
    await ok(f, s, 'POST', '/api/users', {
      username: 'ssh-user',
      displayName: 'SSH user',
      password: 'password12345',
      role: 'user',
    });
    const user = await login(f, 'ssh-user', 'password12345');
    const apiCases = [
      ['GET', '/api/ssh-keys'],
      ['POST', '/api/ssh-keys', { name: 'x', mode: 'generate' }],
      ['PATCH', '/api/ssh-keys/1', { name: 'x' }],
      ['DELETE', '/api/ssh-keys/1'],
      ['GET', '/api/known-hosts'],
      ['POST', '/api/known-hosts/scan', { host: '127.0.0.1', port: 22 }],
      ['POST', '/api/known-hosts', { host: 'x', port: 22, keys: [] }],
      ['DELETE', '/api/known-hosts/1'],
    ];
    for (const [method, url, payload] of apiCases) {
      assert.equal(
        (await call(f, null, method, url, payload, { origin })).statusCode,
        401,
      );
      assert.equal((await call(f, user, method, url, payload)).statusCode, 403);
      if (method !== 'GET')
        assert.equal(
          (await call(f, s, method, url, payload, { 'x-csrf-token': '' }))
            .statusCode,
          403,
        );
    }
    const generated = await ok(f, s, 'POST', '/api/ssh-keys', {
      name: 'generated',
      mode: 'generate',
    });
    assert.equal(generated.source, 'generated');
    assert.equal(generated.type, 'ed25519');
    assert.equal(generated.lastUsedAt, null);
    assert.equal(
      (
        await call(f, s, 'POST', '/api/ssh-keys', {
          name: 'generated',
          mode: 'generate',
        })
      ).statusCode,
      409,
    );
    const material = await keyFile(f.directory, 'imported');
    const imported = await ok(f, s, 'POST', '/api/ssh-keys', {
      name: 'imported',
      mode: 'import',
      privateKey: material.privateKey,
    });
    assert.equal(
      (
        await call(f, s, 'PATCH', `/api/ssh-keys/${generated.id}`, {
          name: 'generated',
          privateKey: material.privateKey,
        })
      ).statusCode,
      400,
    );
    const replacement = await keyFile(f.directory, 'replacement');
    const changed = await ok(f, s, 'PATCH', `/api/ssh-keys/${imported.id}`, {
      name: 'replacement',
      privateKey: replacement.privateKey,
    });
    assert.notEqual(changed.fingerprint, imported.fingerprint);
    const project = await ok(f, s, 'POST', '/api/projects', {
      ...projectInput,
      sshKeyId: generated.id,
    });
    assert.equal(project.sshKeyId, generated.id);
    assert.equal(
      (await call(f, s, 'POST', '/api/projects', projectInput)).statusCode,
      400,
    );
    assert.equal(
      (
        await call(f, s, 'POST', '/api/projects', {
          ...projectInput,
          sshKeyId: 99999,
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await ok(f, user, 'GET', '/api/projects')).items[0].sshKeyName,
      'generated',
    );
    const publicResponse = await call(f, null, 'GET', '/api/public/projects');
    assert.equal(publicResponse.statusCode, 200);
    assert.equal(publicResponse.body.includes('sshKey'), false);
    assert.deepEqual(
      (await ok(f, s, 'GET', '/api/ssh-keys')).items.find(
        (k) => k.id === generated.id,
      ).projectIds,
      [project.id],
    );
    assert.equal(
      (await ok(f, s, 'GET', '/api/ssh-keys?limit=1&offset=1')).items.length,
      1,
    );
    await ok(f, s, 'PATCH', `/api/ssh-keys/${generated.id}`, {
      name: 'renamed',
    });
    assert.equal(
      (await ok(f, user, 'GET', '/api/projects')).items[0].sshKeyName,
      'renamed',
    );
    // Direct store operations complete before the scheduler timer can claim this queued snapshot.
    await f.db.request('platform', {
      action: 'fetched',
      actor: s.user,
      data: {
        id: project.id,
        repository: project.repository,
        sshKeyId: generated.id,
        fetched: {
          branch: 'main',
          sha: 'a'.repeat(40),
          message: 'fixture',
          at: Date.now(),
        },
        branches: ['main'],
      },
    });
    const queued = await f.db.request('platform', {
      action: 'enqueue',
      actor: s.user,
      data: {
        projectId: project.id,
        branch: 'main',
        sha: 'a'.repeat(40),
        key: randomUUID(),
        hash: 'fixture',
      },
    });
    assert.equal(queued.snapshot.sshKeyId, generated.id);
    assert.equal(
      (await call(f, s, 'DELETE', `/api/ssh-keys/${generated.id}`)).statusCode,
      204,
    );
    assert.equal(
      (await ok(f, user, 'GET', '/api/projects')).items[0].sshKeyId,
      null,
    );
    const snapshot = await f.db.request('platform', {
      action: 'job',
      data: { id: queued.id },
    });
    assert.equal(snapshot.snapshot.sshKeyId, generated.id);
    await assert.rejects(
      () =>
        new SshService(f.config, f.db).credentials(
          project.repository,
          generated.id,
        ),
      /拉取凭据已删除/,
    );
    const runner = new BuildRunner(f.config, new SshService(f.config, f.db));
    await assert.rejects(
      () =>
        runner.execute(
          { ...snapshot, id: 900001 },
          new AbortController().signal,
          async () => {},
        ),
      /拉取凭据已删除/,
    );
    // Cancel before the fixture scheduler can claim this deliberately remote-free queued task.
    assert.equal(
      (await call(f, s, 'DELETE', `/api/jobs/${queued.id}`)).statusCode,
      200,
    );
    const rows = inspect(f, (db) =>
      db.prepare('SELECT encrypted_private_key FROM ssh_keys').all(),
    );
    for (const row of rows)
      assert.equal(
        Buffer.from(row.encrypted_private_key).includes(
          Buffer.from('PRIVATE KEY'),
        ),
        false,
      );
    const responses = JSON.stringify([
      generated,
      imported,
      changed,
      await ok(f, s, 'GET', '/api/ssh-keys'),
    ]);
    for (const token of [
      'PRIVATE KEY',
      material.privateKey,
      replacement.privateKey,
      'encryptedPrivateKey',
      'encrypted_private_key',
    ])
      assert.equal(responses.includes(token), false);
    const audit = inspect(f, (db) =>
      db.prepare('SELECT action,target FROM audit_logs').all(),
    );
    assert.ok(audit.some((a) => a.action === 'ssh-key.replace'));
    assert.ok(audit.some((a) => a.action === 'ssh-key.delete'));
    assert.equal(JSON.stringify(audit).includes('PRIVATE KEY'), false);
    await f.restart();
    assert.equal(
      (await ok(f, await login(f), 'GET', '/api/ssh-keys')).items.length,
      1,
    );
  },
);

test(
  'known-host APIs validate fingerprints, replace one algorithm and reject restricted scan destinations',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t),
      s = await login(f),
      ssh = new SshService(f.config, f.db);
    const hostKey = await keyFile(f.directory, 'host');
    const { bits, ...key } = await ssh.publicKey(hostKey.publicKey);
    assert.equal(
      (
        await call(f, s, 'POST', '/api/known-hosts', {
          host: 'example.com',
          port: 2222,
          keys: [{ ...key, fingerprint: 'SHA256:wrong' }],
        })
      ).statusCode,
      400,
    );
    const hosts = await ok(f, s, 'POST', '/api/known-hosts', {
      host: 'EXAMPLE.com',
      port: 2222,
      keys: [key],
    });
    assert.equal(hosts[0].host, 'example.com');
    assert.equal(Object.hasOwn(hosts[0], 'publicKey'), false);
    const other = await keyFile(f.directory, 'host-other'),
      next = await ssh.publicKey(other.publicKey);
    await ok(f, s, 'POST', '/api/known-hosts', {
      host: 'example.com',
      port: 2222,
      keys: [next],
    });
    const listing = await ok(f, s, 'GET', '/api/known-hosts');
    assert.equal(listing.total, 1);
    assert.equal(listing.items[0].fingerprint, next.fingerprint);
    for (const host of [
      '127.0.0.1',
      '169.254.169.254',
      '::1',
      'localhost',
      '-oProxyCommand=whoami',
    ])
      assert.equal(
        (await call(f, s, 'POST', '/api/known-hosts/scan', { host, port: 22 }))
          .statusCode,
        400,
      );
    const id = listing.items[0].id;
    assert.equal(
      (await call(f, s, 'DELETE', `/api/known-hosts/${id}`)).statusCode,
      204,
    );
    assert.equal((await ok(f, s, 'GET', '/api/known-hosts')).total, 0);
  },
);

test(
  'invalid master key degrades SSH APIs only and preserves anonymous HTTPS projects',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, ''),
      s = await login(f);
    for (const url of ['/api/ssh-keys', '/api/known-hosts']) {
      const r = await call(f, s, 'GET', url);
      assert.equal(r.statusCode, 503);
      assert.match(r.json().message, /BUILDER_SECRET_KEY/);
    }
    const project = await ok(f, s, 'POST', '/api/projects', {
      ...projectInput,
      repository: 'https://example.invalid/repo.git',
    });
    assert.equal(project.sshKeyId, null);
    assert.equal((await ok(f, s, 'GET', '/api/projects')).total, 1);
    assert.equal((await f.app.inject({ url: '/api/health' })).statusCode, 200);
    f.config.secretKey = randomBytes(31).toString('base64');
    assert.equal((await call(f, s, 'GET', '/api/ssh-keys')).statusCode, 503);
  },
);

async function sshServer(f, t, authorizedPublicKey) {
  const host = await keyFile(f.directory, 'server-host');
  const authorized = join(f.directory, 'authorized_keys');
  await writeFile(authorized, authorizedPublicKey + '\n', { mode: 0o600 });
  const socket = createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const configPath = join(f.directory, 'sshd_config');
  await writeFile(
    configPath,
    [
      `Port ${port}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${host.path}`,
      `PidFile ${join(f.directory, 'sshd.pid')}`,
      `AuthorizedKeysFile ${authorized}`,
      'StrictModes no',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'UsePAM no',
      'PubkeyAuthentication yes',
      'PermitRootLogin no',
      'LogLevel ERROR',
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
  let errors = '';
  const child = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', configPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (s) => {
    errors += s;
  });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null)
      await new Promise((r) => child.once('close', r));
  });
  await until(
    async () => {
      if (child.exitCode !== null)
        throw new Error(`Fixture sshd could not start: ${errors}`);
      return new Promise((resolve) => {
        const c = connect({ host: '127.0.0.1', port });
        c.once('connect', () => {
          c.destroy();
          resolve(true);
        });
        c.once('error', () => resolve(false));
      });
    },
    Boolean,
    5000,
  );
  return {
    port,
    host,
    authorized,
    get errors() {
      return errors;
    },
  };
}

test(
  'real SSH fetch/build isolates credentials, reports host/key failures and supports independent concurrent keys',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t),
      s = await login(f),
      ssh = new SshService(f.config, f.db);
    const imported = await ok(f, s, 'POST', '/api/ssh-keys', {
      name: 'deploy',
      mode: 'generate',
    });
    const encrypted = await f.db.request('platform', {
      action: 'sshKeyCredentials',
      data: { id: imported.id },
    });
    const key = {
      publicKey: imported.publicKey,
      privateKey: ssh.decrypt(encrypted.encryptedPrivateKey).toString(),
    };
    const server = await sshServer(f, t, key.publicKey);
    const scanned = await new BuildRunner(f.config, ssh).scanHost(
      ['127.0.0.1'],
      server.port,
    );
    assert.ok(
      scanned
        .split('\n')
        .some((line) => line.includes(server.host.publicKey.split(' ')[1])),
    );
    const repo = join(f.directory, 'repository');
    await mkdir(repo);
    await exec('git', ['init', '-b', 'main', repo]);
    await writeFile(join(repo, 'marker.txt'), 'ssh-value');
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
      'SSH fixture',
    ]);
    const repository = `ssh://${userInfo().username}@127.0.0.1:${server.port}${repo}`;
    const parsed = await ssh.publicKey(server.host.publicKey);
    const hosts = await ok(f, s, 'POST', '/api/known-hosts', {
      host: '127.0.0.1',
      port: server.port,
      keys: [parsed],
    });
    const project = await ok(f, s, 'POST', '/api/projects', {
      ...projectInput,
      repository,
      sshKeyId: imported.id,
      buildScript:
        'test ! -e /run/creds\ntest ! -e "$HOME/.ssh"\ntest -z "${BUILDER_SECRET_KEY-}"\nmkdir -p dist\nenv > dist/environment.txt\ncp marker.txt dist/result.txt\nsleep 2',
    });
    const fetched = await ok(
      f,
      s,
      'POST',
      `/api/projects/${project.id}/fetch`,
      { branch: 'main' },
    );
    assert.match(fetched.sha, /^[a-f0-9]{40}$/);
    assert.deepEqual(await readdir(ssh.root), []);
    const creds = await ssh.credentials(repository, imported.id);
    assert.equal((await stat(creds.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(creds.directory, 'id'))).mode & 0o777, 0o600);
    assert.equal(
      (await stat(join(creds.directory, 'known_hosts'))).mode & 0o777,
      0o600,
    );
    assert.match(
      await readFile(join(creds.directory, 'known_hosts'), 'utf8'),
      new RegExp(`^\\[127\\.0\\.0\\.1\\]:${server.port} `),
    );
    await rm(creds.directory, { recursive: true });
    const job = await ok(
      f,
      s,
      'POST',
      '/api/jobs',
      { projectId: project.id, branch: 'main', sha: fetched.sha },
      { 'idempotency-key': randomUUID() },
    );
    const done = await until(
      () => ok(f, s, 'GET', '/api/jobs'),
      (data) => data.items.find((j) => j.id === job.id)?.status === 'succeeded',
    );
    assert.equal(
      done.items.find((j) => j.id === job.id).snapshot.sshKeyId,
      imported.id,
    );
    const manifest = JSON.parse(
      await readFile(
        join(f.config.dataDirectory, 'builds', String(job.id), 'manifest.json'),
        'utf8',
      ),
    );
    const artifactPath = (name) =>
      join(
        f.config.dataDirectory,
        'builds',
        String(job.id),
        manifest.find((f) => f.name === name).storageKey,
      );
    assert.equal(
      await readFile(artifactPath('result.txt'), 'utf8'),
      'ssh-value',
    );
    assert.ok((await ok(f, s, 'GET', '/api/ssh-keys')).items[0].lastUsedAt > 0);
    assert.deepEqual(await readdir(ssh.root), []);
    const logs = await readFile(
      join(f.config.dataDirectory, 'builds', String(job.id), 'build.log'),
      'utf8',
    );
    assert.equal(logs.includes('PRIVATE KEY'), false);
    const environment = await readFile(artifactPath('environment.txt'), 'utf8');
    assert.equal(environment.includes('BUILDER_SECRET_KEY='), false);
    assert.equal(environment.includes('ssh-temporary'), false);
    assert.equal(environment.includes(key.privateKey), false);
    assert.equal(logs.includes(key.privateKey), false);
    assert.equal(logs.includes(key.privateKey.split('\n')[1]), false);
    // Replacing trust with another key must fail before executing a build.
    const wrong = await keyFile(f.directory, 'wrong-host');
    await ok(f, s, 'POST', '/api/known-hosts', {
      host: '127.0.0.1',
      port: server.port,
      keys: [await ssh.publicKey(wrong.publicKey)],
    });
    let failed = await call(f, s, 'POST', `/api/projects/${project.id}/fetch`, {
      branch: 'main',
    });
    assert.equal(failed.statusCode, 400);
    assert.match(failed.json().message, /未受信任或主机公钥已变化/);
    assert.deepEqual(await readdir(ssh.root), []);
    await ok(f, s, 'POST', '/api/known-hosts', {
      host: '127.0.0.1',
      port: server.port,
      keys: [parsed],
    });
    await writeFile(server.authorized, '', { mode: 0o600 });
    failed = await call(f, s, 'POST', `/api/projects/${project.id}/fetch`, {
      branch: 'main',
    });
    assert.equal(failed.statusCode, 400);
    assert.match(failed.json().message, /SSH 认证失败/);
    assert.deepEqual(await readdir(ssh.root), []);
    const key2 = await keyFile(f.directory, 'deploy2'),
      imported2 = await ok(f, s, 'POST', '/api/ssh-keys', {
        name: 'deploy2',
        mode: 'import',
        privateKey: key2.privateKey,
      });
    const repo2 = join(f.directory, 'repository2');
    await exec('git', ['clone', repo, repo2]);
    await writeFile(join(repo2, 'marker.txt'), 'second-key-value');
    await exec('git', ['-C', repo2, 'add', '.']);
    await exec('git', [
      '-C',
      repo2,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'second key',
    ]);
    await writeFile(
      server.authorized,
      `restrict,command="git-upload-pack '${repo}'" ${key.publicKey}\nrestrict,command="git-upload-pack '${repo2}'" ${key2.publicKey}\n`,
      { mode: 0o600 },
    );
    const repository2 = `ssh://${userInfo().username}@127.0.0.1:${server.port}${repo2}`;
    const project2 = await ok(f, s, 'POST', '/api/projects', {
      ...projectInput,
      name: 'SSH second',
      repository: repository2,
      sshKeyId: imported2.id,
      buildScript: 'mkdir -p dist\ncp marker.txt dist/result.txt\nsleep 2',
    });
    await Promise.all([
      ok(f, s, 'POST', `/api/projects/${project.id}/fetch`, { branch: 'main' }),
      ok(f, s, 'POST', `/api/projects/${project2.id}/fetch`, {
        branch: 'main',
      }),
    ]);
    await ok(f, s, 'PUT', '/api/settings', { maxConcurrent: 2 });
    const latest = (await ok(f, s, 'GET', '/api/projects')).items;
    const parallel = [];
    for (const p of [project, project2])
      parallel.push(
        await ok(
          f,
          s,
          'POST',
          '/api/jobs',
          {
            projectId: p.id,
            branch: 'main',
            sha: latest.find((v) => v.id === p.id).fetched.sha,
          },
          { 'idempotency-key': randomUUID() },
        ),
      );
    await until(
      () => ok(f, s, 'GET', '/api/jobs'),
      (data) =>
        parallel.every(
          (j) => data.items.find((v) => v.id === j.id)?.status === 'running',
        ),
    );
    await until(
      () => ok(f, s, 'GET', '/api/jobs'),
      (data) =>
        parallel.every(
          (j) => data.items.find((v) => v.id === j.id)?.status === 'succeeded',
        ),
    );
    for (let i = 0; i < parallel.length; i++) {
      const dir = join(
        f.config.dataDirectory,
        'builds',
        String(parallel[i].id),
      );
      const manifest = JSON.parse(
        await readFile(join(dir, 'manifest.json'), 'utf8'),
      );
      assert.equal(
        await readFile(
          join(dir, manifest.find((a) => a.name === 'result.txt').storageKey),
          'utf8',
        ),
        i === 0 ? 'ssh-value' : 'second-key-value',
      );
    }
    assert.deepEqual(await readdir(ssh.root), []);
    // Startup cleanup removes only owned transient credential directories after process recovery.
    const stale = await ssh.temporary();
    await writeFile(join(stale, 'id'), 'stale-secret', { mode: 0o600 });
    await f.restart();
    assert.deepEqual(await readdir(ssh.root), []);
    assert.equal(
      (
        await call(
          f,
          await login(f),
          'DELETE',
          `/api/known-hosts/${hosts[0].id}`,
        )
      ).statusCode,
      204,
    );
    await assert.rejects(
      () => new SshService(f.config, f.db).credentials(repository, imported.id),
      /未受信任/,
    );
  },
);

test(
  'credential lifetimes include failure, cancellation and timeout; Docker git mounts are read-only and absent from build commands',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      s = await login(f),
      ssh = new SshService(f.config, f.db),
      runner = new BuildRunner(f.config, ssh);
    const generated = await ok(f, s, 'POST', '/api/ssh-keys', {
      name: 'lifetime',
      mode: 'generate',
    });
    const host = await keyFile(f.directory, 'lifetime-host');
    await ok(f, s, 'POST', '/api/known-hosts', {
      host: 'example.com',
      port: 22,
      keys: [await ssh.publicKey(host.publicKey)],
    });
    const repository = 'git@example.com:repo.git';
    for (const reason of ['failure', 'abort', 'timeout']) {
      const controller = new AbortController();
      let timer;
      await assert.rejects(() =>
        runner.remote(repository, generated.id, async (creds) => {
          assert.equal((await stat(creds.directory)).mode & 0o777, 0o700);
          if (reason === 'failure') throw new Error('fixture failure');
          if (reason === 'abort')
            timer = setTimeout(() => controller.abort(), 100);
          return runProcess('sleep', ['10'], {
            signal: controller.signal,
            timeout: reason === 'timeout' ? 100 : 5000,
          });
        }),
      );
      clearTimeout(timer);
      assert.deepEqual(await readdir(ssh.root), []);
    }
    const bin = join(f.directory, 'fake-bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'docker'),
      '#!/usr/bin/env node\nif(process.argv[2] === "run") console.log(JSON.stringify(process.argv.slice(2)));\n',
      { mode: 0o700 },
    );
    const originalPath = process.env.PATH;
    process.env.PATH = bin + ':' + originalPath;
    try {
      const docker = new BuildRunner({ ...f.config, runner: 'docker' }, ssh),
        dir = join(f.directory, 'docker-job');
      await mkdir(dir);
      const creds = await ssh.credentials(repository, generated.id);
      try {
        const gitArgs = JSON.parse(
          await docker.command(
            'fixture',
            dir,
            ['git', 'ls-remote', repository],
            undefined,
            undefined,
            'restricted',
            1000,
            creds,
          ),
        );
        assert.ok(
          gitArgs.includes(
            `type=bind,src=${creds.directory},dst=/run/creds,readonly`,
          ),
        );
        assert.ok(
          gitArgs.some(
            (a) =>
              a.startsWith('GIT_SSH_COMMAND=') && a.includes('/run/creds/id'),
          ),
        );
        const buildArgs = JSON.parse(
          await docker.command('fixture', dir, ['bash', '-c', 'true']),
        );
        assert.equal(
          buildArgs.some(
            (a) => a.includes('/run/creds') || a.includes(creds.directory),
          ),
          false,
        );
        assert.ok(buildArgs.includes('none'));
        await assert.rejects(
          () =>
            docker.command(
              'fixture',
              dir,
              ['bash', '-c', 'true'],
              undefined,
              undefined,
              'none',
              1000,
              creds,
            ),
          /只允许/,
        );
      } finally {
        await rm(creds.directory, { recursive: true, force: true });
      }
    } finally {
      process.env.PATH = originalPath;
    }
  },
);

test(
  'version 3 migration preserves old projects and encrypted keys survive offline backup/restore with the original master key',
  { timeout: 30000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'builder-ssh-migration-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const data = join(directory, 'data');
    let db = await startDatabase(data);
    await closeDatabase(db);
    const old = new Database(join(data, 'platform.db'));
    old.exec(
      'DROP TABLE ssh_keys; DROP TABLE known_hosts; PRAGMA user_version=3;',
    );
    old.prepare('INSERT INTO projects(slug,payload) VALUES(?,?)').run(
      'old',
      JSON.stringify({
        ...projectInput,
        repository: 'https://example.invalid/repo',
        branches: ['main'],
        color: '#2563eb',
        fetched: { branch: '', sha: '', message: '', at: 0 },
      }),
    );
    old.close();
    db = await startDatabase(data);
    const config = {
      host: '127.0.0.1',
      port: 3000,
      dataDirectory: data,
      logLevel: 'silent',
      appOrigin: origin,
      runner: 'local',
      secretKey: randomBytes(32).toString('base64'),
    };
    const app = await createApp(config, db);
    let closed = false;
    t.after(async () => {
      if (!closed) {
        await app.close();
        await closeDatabase(db);
      }
    });
    const f = { app, db, config },
      s = await login(f);
    const migrated = (await ok(f, s, 'GET', '/api/projects')).items[0];
    assert.equal(migrated.sshKeyId, null);
    assert.equal(migrated.sshKeyName, null);
    const generated = await ok(f, s, 'POST', '/api/ssh-keys', {
      name: 'backup-key',
      mode: 'generate',
    });
    const before = await db.request('platform', {
      action: 'sshKeyCredentials',
      data: { id: generated.id },
    });
    const original = new SshService(config, db).decrypt(
      before.encryptedPrivateKey,
    );
    const backup = await ok(f, s, 'POST', '/api/maintenance/backup');
    const backupPath = join(data, 'backups', backup.id);
    const backupDb = new Database(join(backupPath, 'platform.db'), {
      readonly: true,
    });
    assert.equal(backupDb.pragma('user_version', { simple: true }), 4);
    assert.equal(
      backupDb.prepare('SELECT COUNT(*) AS n FROM ssh_keys').get().n,
      1,
    );
    backupDb.close();
    assert.equal((await readdir(backupPath)).includes('ssh-temporary'), false);
    await app.close();
    await closeDatabase(db);
    closed = true;
    const restored = join(directory, 'restored');
    await exec(
      process.execPath,
      [
        fileURLToPath(new URL('../dist/tools/restore.js', import.meta.url)),
        backupPath,
        restored,
      ],
      { cwd: process.cwd() },
    );
    const restoredDb = await startDatabase(restored);
    try {
      const credentials = await restoredDb.request('platform', {
        action: 'sshKeyCredentials',
        data: { id: generated.id },
      });
      const restoredSsh = new SshService(
        { ...config, dataDirectory: restored },
        restoredDb,
      );
      assert.deepEqual(
        restoredSsh.decrypt(credentials.encryptedPrivateKey),
        original,
      );
      assert.throws(
        () =>
          new SshService(
            { ...config, secretKey: randomBytes(32).toString('base64') },
            restoredDb,
          ).decrypt(credentials.encryptedPrivateKey),
        /解密失败/,
      );
    } finally {
      original.fill(0);
      await closeDatabase(restoredDb);
    }
  },
);
