// Expose the proxy on this job's isolated loopback for standard HTTPS clients.
import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';

const path = '/run/builder-dependencies/proxy.sock';
const server = createServer(client => {
  const relay = createConnection(path);
  relay.on('error', () => client.destroy());
  client.on('error', () => relay.destroy());
  client.on('close', () => relay.destroy());
  relay.on('close', () => client.destroy());
  client.pipe(relay).pipe(client);
});
server.listen(0, '127.0.0.1', () => {
  const proxy = 'http://127.0.0.1:' + server.address().port;
  const child = spawn(process.argv[2], process.argv.slice(3), {
    stdio: 'inherit',
    env: {
      ...process.env,
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
      NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1',
      NODE_USE_ENV_PROXY: '1', ELECTRON_GET_USE_PROXY: '1',
    },
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error.message); process.exit(1); });
  child.on('exit', code => process.exit(code ?? 1));
});
