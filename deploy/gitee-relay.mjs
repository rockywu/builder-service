// Git jobs receive only the Unix socket. Its single upstream is Gitee SSH.
import { lookup } from 'node:dns/promises';
import { chmod, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { isPublicAddress } from './dist/tools/ssh.js';

const path = '/run/builder-gitee/ssh.sock';
await rm(path, { force: true });
const server = createServer({ allowHalfOpen: true }, (client) => {
  const upstream = createConnection({
    host: 'gitee.com',
    port: 22,
    family: 4,
    autoSelectFamily: false,
    allowHalfOpen: true,
    lookup(host, options, callback) {
      lookup(host, { family: 4 }).then(({ address }) => {
        if (!isPublicAddress(address)) throw new Error('Gitee resolved to a restricted address');
        callback(null, address, 4);
      }).catch(callback);
    },
  });
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  upstream.setTimeout(120_000, () => upstream.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
  client.pipe(upstream).pipe(client);
});
server.maxConnections = 32;
server.listen(path, async () => { await chmod(path, 0o666); });
