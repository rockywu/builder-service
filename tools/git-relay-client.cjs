// OpenSSH ProxyCommand sends the SSH byte stream through the dedicated relay.
const { createConnection } = require('node:net');
const socket = createConnection('/run/builder-gitee/ssh.sock');
socket.on('error', () => { process.stderr.write('Gitee SSH relay unavailable\n'); process.exitCode = 1; });
process.stdin.pipe(socket).pipe(process.stdout);
socket.on('close', () => { process.stdin.unpipe(socket); process.stdin.pause(); });
