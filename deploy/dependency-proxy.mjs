// Jobs reach this proxy through a read-only Unix socket mount. Only CONNECT
// is supported so package clients retain end-to-end TLS verification.
import { lookup } from 'node:dns/promises';
import { chmod, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection, isIP } from 'node:net';
import { isPublicAddress } from './dist/tools/ssh.js';

import { dependencyHosts } from './dist/tools/dependency-hosts.js';

const hostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const hosts = dependencyHosts();
for (const host of hosts) {
  if (!hostname.test(host) || isIP(host)) throw new Error('Invalid dependency registry hostname');
}

const path = '/run/builder-dependencies/proxy.sock';
const gatewaySocket = process.env.BUILDER_UPSTREAM_PROXY_SOCKET;
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
    // Both transports connect to the validated IP, without resolving the name again.
    const address = records[0].address;
    function tunnel(upstream, initialBytes) {
      if (client.destroyed) return upstream.destroy();
      client.once('close', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      upstream.setTimeout(120_000, () => upstream.destroy(new Error('Upstream timeout')));
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (initialBytes?.length) client.write(initialBytes);
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    }
    const reject = () => client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    if (gatewaySocket) {
      const authority = address + ':443';
      const connect = httpRequest({
        socketPath: gatewaySocket, method: 'CONNECT', path: authority,
        headers: { Host: authority }, agent: false,
      });
      client.once('close', () => connect.destroy());
      connect.setTimeout(20_000, () => connect.destroy(new Error('Gateway timeout')));
      connect.once('error', reject);
      connect.once('connect', (response, socket, bytes) => {
        if (response.statusCode === 200) return tunnel(socket, bytes);
        socket.destroy();
        reject();
      });
      connect.end();
    } else {
      const upstream = createConnection({ host: address, port: 443 });
      client.once('close', () => upstream.destroy());
      upstream.setTimeout(120_000, () => upstream.destroy(new Error('Upstream timeout')));
      upstream.once('error', reject);
      upstream.once('connect', () => {
        upstream.removeListener('error', reject);
        tunnel(upstream);
      });
    }
  } catch {
    client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  }
});
await rm(path, { force: true });
server.listen(path, async () => { await chmod(path, 0o666); });
