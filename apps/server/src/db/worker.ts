import Database from 'better-sqlite3';
import {
  initializePlatform,
  createPlatformStore,
} from '../modules/platform/store.js';
import { parentPort, workerData } from 'node:worker_threads';
import { hashPassword } from '../modules/auth/password.js';
import type { DatabaseRequest, StoredUser, User } from './protocol.js';

const port = parentPort;
if (!port) throw new Error('Database must run in a Worker');
const { filename } = workerData as { filename: string };
const database = new Database(filename);
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.pragma('synchronous = FULL');
database.pragma('busy_timeout = 5000');

const version = database.pragma('user_version', { simple: true }) as number;
if (version > 4) throw new Error('Unsupported database version');
if (version === 0) {
  const passwordHash = await hashPassword('admin123456');
  database
    .transaction(() => {
      database.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX sessions_expiry ON sessions(expires_at);
    `);
      database
        .prepare(
          'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
        )
        .run('admin', passwordHash, 'admin');
      database.pragma('user_version = 1');
    })
    .immediate();
}

initializePlatform(database);
const platform = createPlatformStore(database);

const findUser = database.prepare(
  'SELECT id, username, role, enabled, password_hash FROM users WHERE username = ?',
);
const findUserById = database.prepare(
  'SELECT id, username, role, enabled, password_hash FROM users WHERE id = ?',
);
const findSession = database.prepare(
  'SELECT user_id, expires_at FROM sessions WHERE token_hash = ?',
);
const insertSession = database.prepare(
  'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
);
const deleteSession = database.prepare(
  'DELETE FROM sessions WHERE token_hash = ?',
);
const publicUser = (user: StoredUser): User => ({
  id: user.id,
  username: user.username,
  role: user.role,
});

function execute(message: DatabaseRequest): unknown {
  switch (message.operation) {
    case 'platform':
      return platform(message.input);
    case 'backup':
      return database.backup(message.input.filename).then(() => null);
    case 'findUser':
      return (
        (findUser.get(message.input.username) as StoredUser | undefined) ?? null
      );
    case 'createSession':
      return database
        .transaction(() => {
          const input = message.input;
          const user = findUserById.get(input.userId) as StoredUser | undefined;
          if (
            !user?.enabled ||
            user.password_hash !== input.expectedPasswordHash
          )
            return null;
          database
            .prepare('DELETE FROM sessions WHERE expires_at <= ?')
            .run(Date.now());
          if (input.previousTokenHash)
            deleteSession.run(input.previousTokenHash);
          insertSession.run(input.tokenHash, user.id, input.expiresAt);
          database
            .prepare('UPDATE users SET last_login_at=? WHERE id=?')
            .run(Date.now(), user.id);
          return publicUser(user);
        })
        .immediate();
    case 'getSession':
      return database.transaction(() => {
        const session = findSession.get(message.input.tokenHash) as
          { user_id: number; expires_at: number } | undefined;
        if (!session) return null;
        if (session.expires_at <= message.input.now) {
          deleteSession.run(message.input.tokenHash);
          return null;
        }
        const user = findUserById.get(session.user_id) as
          StoredUser | undefined;
        return user?.enabled ? publicUser(user) : null;
      })();
    case 'deleteSession':
      deleteSession.run(message.input.tokenHash);
      return null;
  }
}

port.on('message', async (message: DatabaseRequest | 'close') => {
  if (message === 'close') {
    database.close();
    port.close();
    return;
  }
  try {
    port.postMessage({ id: message.id, result: await execute(message) });
  } catch (error) {
    const known = error instanceof Error && 'statusCode' in error;
    port.postMessage({
      id: message.id,
      error: known ? error.message : '数据库操作失败，请核对操作结果后重试。',
      statusCode: known ? error.statusCode : 503,
    });
  }
});
port.postMessage('ready');
