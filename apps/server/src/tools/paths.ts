import { lstat, realpath, readdir, open, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { requireValue } from '../modules/platform/errors.js';

export function relativePath(
  value: unknown,
  workdir = false,
): asserts value is string {
  requireValue(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 512 &&
      !value.includes('\0') &&
      !value.includes('\\') &&
      !isAbsolute(value) &&
      !value.split('/').includes('..') &&
      (!workdir || value.startsWith('./')),
    '路径必须是仓库内相对路径，不能包含 ..。',
  );
}
export function inside(root: string, path: string) {
  const r = relative(resolve(root), resolve(path));
  requireValue(!r.startsWith('..') && !isAbsolute(r), '路径超出允许范围。');
  return resolve(path);
}
export async function safePath(root: string, rel: string) {
  relativePath(rel);
  requireValue(!(await lstat(root)).isSymbolicLink(), '不允许符号链接。');
  const target = inside(root, resolve(root, rel));
  let part = resolve(root);
  for (const segment of relative(root, target).split('/').filter(Boolean)) {
    part = join(part, segment);
    requireValue(!(await lstat(part)).isSymbolicLink(), '不允许符号链接。');
  }
  inside(await realpath(root), await realpath(target));
  return target;
}
export async function collectArtifacts(
  root: string,
  source: string,
  destination: string,
) {
  const result: {
    name: string;
    size: number;
    sha256: string;
    storageKey: string;
  }[] = [];
  let total = 0;
  await mkdir(destination, { recursive: true, mode: 0o700 });
  async function visit(path: string, name: string) {
    const stat = await lstat(path);
    requireValue(!stat.isSymbolicLink(), '产物不能是符号链接。');
    if (stat.isDirectory()) {
      for (const child of await readdir(path))
        await visit(join(path, child), name ? `${name}/${child}` : child);
      return;
    }
    requireValue(
      stat.isFile() && stat.nlink === 1,
      '产物必须是普通文件，不能是硬链接。',
    );
    requireValue(
      result.length < 100 && (total += stat.size) <= 512 * 1024 * 1024,
      '产物超过 100 个文件或 512 MB 限额。',
    );
    const sourceFile = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const targetFile = await open(
      join(destination, String(result.length)),
      'wx',
      0o600,
    );
    const hash = createHash('sha256');
    let size = 0;
    try {
      for await (const chunk of sourceFile.createReadStream({
        autoClose: false,
      })) {
        size += chunk.length;
        requireValue(size <= stat.size, '收集期间产物发生变化。');
        hash.update(chunk);
        await targetFile.write(chunk);
      }
      requireValue(size === stat.size, '收集期间产物发生变化。');
      await targetFile.sync();
    } finally {
      await sourceFile.close();
      await targetFile.close();
    }
    result.push({
      name,
      size,
      sha256: hash.digest('hex'),
      storageKey: relative(root, join(destination, String(result.length))),
    });
  }
  const stat = await lstat(source);
  await visit(source, stat.isDirectory() ? '' : source.split('/').at(-1)!);
  await syncDirectory(destination);
  requireValue(result.length > 0, '没有找到构建产物。');
  return result;
}

export async function syncDirectory(path: string) {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
