// Jobs reach this proxy through a read-only Unix socket mount. Only CONNECT
// is supported so package clients retain end-to-end TLS verification.
import { lookup } from 'node:dns/promises';
import { chmod, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection, isIP } from 'node:net';
import { isPublicAddress } from './dist/tools/ssh.js';

import { dependencyHosts } from './dist/tools/dependency-hosts.js';

const hostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const hosts = dependencyHosts();
for (const host of hosts) {
  if (!hostname.test(host) || isIP(host)) throw new Error('Invalid dependency registry hostname');
}

const path = '/run/builder-dependencies/proxy.sock';
const server = createServer({ maxHeaderSize: 8192 }, (_request, response) => {
  response.writeHead(403, { Connection: 'close' }).end('HTTPS CONNECT required\n');
});
server.maxConnections = 256;
server.setTimeout(120_000, socket => socket.destroy());
server.on('connect', async (request, client, head) => {
  client.on('error', () => client.destroy());
  const target = /^([a-z0-9.-]+):443$/i.exec(request.url);
  const host = target?.[1].toLowerCase();
  if (!hosts.has(host)) {
    if (host && hostname.test(host)) console.warn('Dependency host denied:', host);
    client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  try {
    const records = await lookup(host, { all: true, family: 4 });
    if (!records.length || records.some(({ address }) =>
      !isPublicAddress(address) || address === '168.63.129.16' || address.startsWith('192.88.99.'))) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (client.destroyed) return;
    // Dial a validated address directly to prevent a second DNS resolution.
    const upstream = createConnection({ host: records[0].address, port: 443 });
    client.on('close', () => upstream.destroy());
    upstream.on('error', () => {
      if (upstream.bytesWritten) client.destroy();
      else client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    upstream.setTimeout(120_000, () => upstream.destroy(new Error('Upstream timeout')));
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  } catch {
    client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  }
});
await rm(path, { force: true });
server.listen(path, async () => { await chmod(path, 0o666); });
