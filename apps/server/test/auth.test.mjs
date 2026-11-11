import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { createApp } from '../dist/app.js';
import { startDatabase, closeDatabase } from '../dist/db/client.js';
import { hashPassword } from '../dist/modules/auth/password.js';

process.umask(0o077);
const origin = 'http://127.0.0.1:5173';
let fixture;
let address = 1;
async function createFixture(appOrigin = origin) {
  const directory = await mkdtemp(join(tmpdir(), 'builder-auth-'));
  let database = await startDatabase(directory);
  let app = await createApp(
    {
      host: '127.0.0.1',
      port: 3000,
      dataDirectory: directory,
      logLevel: 'silent',
      appOrigin,
    },
    database,
  );
  return {
    directory,
    get app() {
      return app;
    },
    async restart() {
      await app.close();
      await closeDatabase(database);
      database = await startDatabase(directory);
      app = await createApp(
        {
          host: '127.0.0.1',
          port: 3000,
          dataDirectory: directory,
          logLevel: 'silent',
          appOrigin,
        },
        database,
      );
    },
    async close() {
      await app.close();
      await closeDatabase(database);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
function sql(target, callback) {
  const db = new Database(join(target.directory, 'platform.db'));
  try {
    return callback(db);
  } finally {
    db.close();
  }
}
function inject(options, target = fixture) {
  return target.app.inject({
    remoteAddress: `127.0.0.${address++}`,
    ...options,
  });
}
async function signIn(target = fixture, appOrigin = origin) {
  const response = await inject(
    {
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: appOrigin },
      payload: { username: 'admin', password: 'admin123456' },
    },
    target,
  );
  assert.equal(response.statusCode, 200);
  const setCookie = response.headers['set-cookie'];
  assert.equal(typeof setCookie, 'string');
  return { cookie: setCookie.split(';')[0], body: response.json(), setCookie };
}
before(async () => {
  fixture = await createFixture();
});
after(async () => {
  await fixture?.close();
});

test('default admin is hashed; successful login returns safe data and opaque cookie', async () => {
  const stored = sql(fixture, (db) =>
    db.prepare('SELECT username, password_hash, role FROM users').get(),
  );
  assert.equal(stored.username, 'admin');
  assert.equal(stored.role, 'admin');
  assert.match(stored.password_hash, /^scrypt\$/);
  assert.notEqual(stored.password_hash, 'admin123456');
  const session = await signIn();
  assert.match(session.setCookie, /HttpOnly/);
  assert.match(session.setCookie, /SameSite=Strict/);
  assert.match(session.setCookie, /Max-Age=28800/);
  assert.deepEqual(Object.keys(session.body).sort(), ['csrfToken', 'user']);
  assert.deepEqual(Object.keys(session.body.user).sort(), [
    'id',
    'role',
    'username',
  ]);
  const raw = session.cookie.split('=')[1];
  assert.match(raw, /^[a-f0-9]{64}$/);
  const saved = sql(fixture, (db) =>
    db
      .prepare('SELECT token_hash FROM sessions WHERE token_hash = ?')
      .get(createHash('sha256').update(raw).digest('hex')),
  );
  assert.ok(saved);
  assert.notEqual(saved.token_hash, raw);
  const me = await inject({
    url: '/api/auth/me',
    headers: { cookie: session.cookie },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().csrfToken, session.body.csrfToken);
  assert.equal(me.headers['cache-control'], 'no-store');
});

test('invalid credentials and invalid input cannot log in', async () => {
  for (const payload of [
    { username: 'admin', password: 'wrong' },
    { username: 'missing', password: 'wrong' },
  ]) {
    const response = await inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload,
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().message, '账号或密码错误。');
    assert.equal(response.headers['set-cookie'], undefined);
  }
  const invalid = await inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { username: 'admin' },
  });
  assert.equal(invalid.statusCode, 400);
});

test('management API requires authentication; public namespace stays anonymous', async () => {
  for (const url of ['/api/auth/me', '/api/projects', '/api/users'])
    assert.equal((await inject({ url })).statusCode, 401);
  assert.equal((await inject({ url: '/api/health' })).statusCode, 200);
  // Download data is not implemented: public routes return 404 rather than demanding login.
  assert.equal((await inject({ url: '/api/public/projects' })).statusCode, 404);
  const session = await signIn();
  assert.equal(
    (
      await inject({
        url: '/api/projects',
        headers: { cookie: session.cookie },
      })
    ).statusCode,
    404,
  );
});

test('origin validation and CSRF reject foreign, missing or malformed tokens', async () => {
  for (const headers of [{}, { origin: 'https://foreign.example' }]) {
    assert.equal(
      (
        await inject({
          method: 'POST',
          url: '/api/auth/login',
          headers,
          payload: { username: 'admin', password: 'admin123456' },
        })
      ).statusCode,
      403,
    );
  }
  const session = await signIn();
  for (const headers of [
    { origin, cookie: session.cookie },
    { origin, cookie: session.cookie, 'x-csrf-token': 'wrong' },
    { origin, cookie: session.cookie, 'x-csrf-token': 'é'.repeat(64) },
    {
      origin: 'https://foreign.example',
      cookie: session.cookie,
      'x-csrf-token': session.body.csrfToken,
    },
  ])
    assert.equal(
      (
        await inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers,
          payload: {},
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (await inject({ url: '/api/auth/me', headers: { cookie: session.cookie } }))
      .statusCode,
    200,
  );
});

test('logout deletes the persisted session and rejects cookie replay', async () => {
  const session = await signIn();
  const response = await inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: {
      origin,
      cookie: session.cookie,
      'x-csrf-token': session.body.csrfToken,
    },
    payload: {},
  });
  assert.equal(response.statusCode, 204);
  assert.match(response.headers['set-cookie'], /Expires=Thu, 01 Jan 1970/);
  assert.equal(
    (await inject({ url: '/api/auth/me', headers: { cookie: session.cookie } }))
      .statusCode,
    401,
  );
});

test('expired or disabled-user sessions are refused', async () => {
  const expired = await signIn();
  const raw = expired.cookie.split('=')[1];
  sql(fixture, (db) =>
    db
      .prepare('UPDATE sessions SET expires_at = 0 WHERE token_hash = ?')
      .run(createHash('sha256').update(raw).digest('hex')),
  );
  assert.equal(
    (await inject({ url: '/api/auth/me', headers: { cookie: expired.cookie } }))
      .statusCode,
    401,
  );
  const disabled = await signIn();
  sql(fixture, (db) =>
    db.prepare('UPDATE users SET enabled = 0 WHERE username = ?').run('admin'),
  );
  try {
    assert.equal(
      (
        await inject({
          url: '/api/auth/me',
          headers: { cookie: disabled.cookie },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { origin },
          payload: { username: 'admin', password: 'admin123456' },
        })
      ).statusCode,
      401,
    );
  } finally {
    sql(fixture, (db) =>
      db
        .prepare('UPDATE users SET enabled = 1 WHERE username = ?')
        .run('admin'),
    );
  }
});

test('relogin rotates the current browser session', async () => {
  const old = await signIn();
  const next = await inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin, cookie: old.cookie },
    payload: { username: 'admin', password: 'admin123456' },
  });
  assert.equal(next.statusCode, 200);
  assert.notEqual(next.headers['set-cookie'].split(';')[0], old.cookie);
  assert.equal(
    (await inject({ url: '/api/auth/me', headers: { cookie: old.cookie } }))
      .statusCode,
    401,
  );
});

test('login is rate limited per client', async () => {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fixture.app.inject({
      remoteAddress: '192.0.2.1',
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { username: 'admin', password: 'wrong' },
    });
    assert.equal(response.statusCode, attempt < 5 ? 401 : 429);
  }
});

test('restart preserves sessions and never resets an existing admin password', async () => {
  const target = await createFixture();
  try {
    const session = await signIn(target);
    await target.restart();
    assert.equal(
      (
        await inject(
          { url: '/api/auth/me', headers: { cookie: session.cookie } },
          target,
        )
      ).statusCode,
      200,
    );
    const changedHash = await hashPassword('replacement-password');
    sql(target, (db) =>
      db
        .prepare('UPDATE users SET password_hash = ? WHERE username = ?')
        .run(changedHash, 'admin'),
    );
    await target.restart();
    assert.equal(
      sql(target, (db) =>
        db
          .prepare('SELECT password_hash FROM users WHERE username = ?')
          .get('admin'),
      ).password_hash,
      changedHash,
    );
    const oldPassword = await inject(
      {
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin },
        payload: { username: 'admin', password: 'admin123456' },
      },
      target,
    );
    assert.equal(oldPassword.statusCode, 401);
    assert.equal(
      (
        await inject(
          {
            method: 'POST',
            url: '/api/auth/login',
            headers: { origin },
            payload: { username: 'admin', password: 'replacement-password' },
          },
          target,
        )
      ).statusCode,
      200,
    );
  } finally {
    await target.close();
  }
});

test('HTTPS deployment sets a Secure session cookie', async () => {
  const target = await createFixture('https://builder.example');
  try {
    assert.match(
      (await signIn(target, 'https://builder.example')).setCookie,
      /; Secure/,
    );
  } finally {
    await target.close();
  }
});
