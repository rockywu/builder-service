import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  rm,
  chmod,
  readdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import type { AppConfig } from '../config.js';
import type { DatabaseClient } from '../db/client.js';
import type {
  KnownHost,
  ScannedHostKey,
  SshKey,
} from '../modules/platform/types.js';
import { PlatformError, requireValue } from '../modules/platform/errors.js';
import { runProcess } from './process.js';

const algorithms = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
]);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
export function sshCommand(directory: string) {
  return `ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o GlobalKnownHostsFile=/dev/null -i ${quote(join(directory, 'id'))} -o UserKnownHostsFile=${quote(join(directory, 'known_hosts'))} -o StrictHostKeyChecking=yes`;
}
export function normalizeHost(input: unknown): string {
  requireValue(
    typeof input === 'string' && input.length > 0 && input.length <= 253,
    '主机格式无效。',
  );
  let host = input.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (isIP(host) === 6) return new URL(`ssh://[${host}]`).hostname.slice(1, -1);
  if (isIP(host) === 4) return host;
  host = domainToASCII(host).replace(/\.$/, '');
  requireValue(
    host &&
      host
        .split('.')
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
    '主机格式无效。',
  );
  return host;
}
export function sshHostOf(
  repository: string,
): { host: string; port: number } | null {
  const scp = /^git@([^:\s/]+):/.exec(repository);
  if (scp) return { host: normalizeHost(scp[1]), port: 22 };
  if (!repository.startsWith('ssh://')) return null;
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    throw new PlatformError(400, 'SSH 仓库地址无效。');
  }
  requireValue(!url.password && !url.search && !url.hash, 'SSH 仓库地址无效。');
  const port = Number(url.port || 22);
  requireValue(
    Number.isInteger(port) && port >= 1 && port <= 65535,
    '端口超出允许范围。',
  );
  return { host: normalizeHost(url.hostname), port };
}
const blocked = new BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const)
  blocked.addSubnet(ip, bits, 'ipv4');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
export function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  // Only native global unicast addresses; mapped IPv4, ULA, link-local and transition ranges are denied.
  return (
    family === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !blocked.check(address, 'ipv6')
  );
}
export async function publicAddresses(host: string) {
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => {
        throw new PlatformError(400, '主机解析失败。');
      });
  requireValue(
    addresses.length > 0 &&
      addresses.length <= 16 &&
      addresses.every((a) => isPublicAddress(a.address)),
    '主机扫描拒绝私网、保留地址或元数据地址。',
  );
  return [...new Set(addresses.map((a) => a.address))];
}

export class SshService {
  readonly root: string;
  constructor(
    readonly config: AppConfig,
    readonly db: DatabaseClient,
  ) {
    this.root = join(config.dataDirectory, 'ssh-temporary');
  }
  secret() {
    const value = this.config.secretKey ?? '';
    requireValue(
      /^[A-Za-z0-9+/]{43}=$/.test(value) &&
        Buffer.from(value, 'base64').length === 32 &&
        Buffer.from(value, 'base64').toString('base64') === value,
      'BUILDER_SECRET_KEY 缺失或无效，需要 32 字节 base64 主密钥。',
      503,
    );
    return Buffer.from(value, 'base64');
  }
  encrypt(privateKey: string) {
    const nonce = randomBytes(12);
    const key = this.secret();
    try {
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      return Buffer.concat([
        nonce,
        cipher.update(privateKey, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    } finally {
      key.fill(0);
    }
  }
  decrypt(value: Uint8Array) {
    const key = this.secret();
    try {
      const bytes = Buffer.from(value);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([
        decipher.update(bytes.subarray(12, -16)),
        decipher.final(),
      ]);
    } catch {
      throw new PlatformError(
        503,
        'SSH 私钥解密失败，请核对主密钥或重新导入密钥。',
      );
    } finally {
      key.fill(0);
    }
  }
  async temporary() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    return mkdtemp(join(this.root, 'creds-'));
  }
  async cleanup() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.root)) {
      if (/^creds-[a-zA-Z0-9]+$/.test(name))
        await rm(join(this.root, name), { recursive: true, force: true });
    }
  }
  async publicKey(value: unknown): Promise<ScannedHostKey & { bits: number }> {
    requireValue(
      typeof value === 'string' &&
        value.length <= 16384 &&
        !/[\r\n\0]/.test(value),
      '公钥格式无效。',
    );
    const [keyType, encoded] = value.trim().split(/\s+/);
    requireValue(
      keyType &&
        algorithms.has(keyType) &&
        encoded &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(encoded),
      '公钥格式或算法不支持。',
    );
    const blob = Buffer.from(encoded, 'base64');
    requireValue(
      blob.toString('base64') === encoded &&
        blob.length > 4 &&
        blob.readUInt32BE(0) === keyType.length &&
        blob.subarray(4, 4 + keyType.length).toString() === keyType,
      '公钥格式无效。',
    );
    const dir = await this.temporary();
    try {
      await writeFile(join(dir, 'public'), `${keyType} ${encoded}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
      const result = await runProcess(
        'ssh-keygen',
        ['-l', '-E', 'sha256', '-f', join(dir, 'public')],
        { timeout: 10_000, maxBytes: 16384 },
      );
      const bits = Number(result.trim().split(/\s+/)[0]);
      requireValue(Number.isInteger(bits) && bits > 0, '公钥格式无效。');
      return {
        keyType,
        publicKey: `${keyType} ${encoded}`,
        fingerprint: `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`,
        bits,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        throw new PlatformError(
          503,
          '服务端缺少 ssh-keygen，请安装 openssh-client。',
        );
      throw new PlatformError(400, '公钥格式无效。');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async keyMaterial(
    name: string,
    mode: 'generate' | 'import',
    input?: unknown,
  ) {
    this.secret();
    if (mode === 'import')
      requireValue(
        typeof input === 'string' &&
          Buffer.byteLength(input) <= 16384 &&
          /-----BEGIN (?:OPENSSH |RSA |EC |)PRIVATE KEY-----/.test(input),
        '仅支持无口令的 OpenSSH 私钥',
      );
    const dir = await this.temporary();
    try {
      const path = join(dir, 'id');
      if (mode === 'generate')
        await runProcess(
          'ssh-keygen',
          ['-q', '-t', 'ed25519', '-N', '', '-C', name, '-f', path],
          { timeout: 10_000 },
        );
      else await writeFile(path, input as string, { mode: 0o600, flag: 'wx' });
      const pub = (
        await runProcess('ssh-keygen', ['-y', '-P', '', '-f', path], {
          timeout: 10_000,
          maxBytes: 16384,
        })
      ).trim();
      const parsed = await this.publicKey(pub);
      requireValue(
        parsed.keyType !== 'ssh-rsa' || parsed.bits >= 2048,
        'RSA 私钥至少需要 2048 位。',
      );
      const privateKey = await readFile(path, 'utf8');
      const type: SshKey['type'] =
        parsed.keyType === 'ssh-ed25519'
          ? 'ed25519'
          : parsed.keyType === 'ssh-rsa'
            ? 'rsa'
            : 'ecdsa';
      return {
        type,
        publicKey: `${parsed.publicKey} ${name}`,
        fingerprint: parsed.fingerprint,
        source:
          mode === 'generate' ? ('generated' as const) : ('imported' as const),
        encryptedPrivateKey: this.encrypt(privateKey),
      };
    } catch (e) {
      if (e instanceof PlatformError) throw e;
      if ((e as NodeJS.ErrnoException).code === 'ENOENT')
        throw new PlatformError(
          503,
          '服务端缺少 ssh-keygen，请安装 openssh-client。',
        );
      throw new PlatformError(400, '仅支持无口令的 OpenSSH 私钥');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async credentials(repository: string, keyId: number | null | undefined) {
    const target = sshHostOf(repository);
    if (!target) return undefined;
    requireValue(keyId != null, 'SSH 地址需要选择密钥');
    this.secret();
    const data = (await this.db.request('platform', {
      action: 'sshKeyCredentials',
      data: { id: keyId },
    })) as { encryptedPrivateKey: Uint8Array; hosts: KnownHost[] };
    const hosts = data.hosts.filter(
      (h) => normalizeHost(h.host) === target.host && h.port === target.port,
    );
    requireValue(hosts.length, `主机 ${target.host} 未受信任或主机公钥已变化`);
    const dir = await this.temporary();
    let privateKey: Buffer | undefined;
    try {
      privateKey = this.decrypt(data.encryptedPrivateKey);
      await writeFile(join(dir, 'id'), privateKey, { mode: 0o600, flag: 'wx' });
      const token =
        target.port === 22
          ? `${target.host},[${target.host}]:22`
          : `[${target.host}]:${target.port}`;
      await writeFile(
        join(dir, 'known_hosts'),
        hosts.map((h) => `${token} ${h.publicKey}`).join('\n') + '\n',
        { mode: 0o600, flag: 'wx' },
      );
      return { directory: dir, keyId, host: target.host };
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    } finally {
      privateKey?.fill(0);
    }
  }
  async used(keyId: number) {
    await this.db.request('platform', {
      action: 'sshKeyUsed',
      data: { id: keyId },
    });
  }
}
export type SshCredentials = NonNullable<
  Awaited<ReturnType<SshService['credentials']>>
>;
