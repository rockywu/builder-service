import { lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { requireValue } from '../modules/platform/errors.js';
import type { Job } from '../modules/platform/types.js';
import { syncDirectory } from './paths.js';

type BuildLocation = Pick<
  Job,
  'id' | 'projectId' | 'branch' | 'sha' | 'repository' | 'refType'
>;

const label = (value: string) =>
  value
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '');

export function buildDirectoryName(job: BuildLocation) {
  requireValue(Number.isSafeInteger(job.id) && job.id > 0, '无效任务编号。');
  requireValue(
    Number.isSafeInteger(job.projectId) && job.projectId > 0,
    '无效项目编号。',
  );
  const repo = job.repository
    ?.split(/[?#]/, 1)[0]
    ?.split(/[/:]/)
    .filter(Boolean)
    .at(-1);
  const project =
    label(repo?.replace(/\.git$/i, '') ?? '') || `project-${job.projectId}`;
  const branch = label(job.branch) || 'branch';
  // The resolved SHA is only known after the task has started writing here.
  if (job.refType === 'tag' || job.refType === 'branch')
    return `${project}--${job.refType}-${branch}--job-${job.id}`;
  const sha = /^[a-f0-9]{40,64}$/i.test(job.sha)
    ? job.sha.slice(0, 8)
    : 'unknown-sha';
  return `${project}--${branch}--${sha}--job-${job.id}`;
}

export async function buildDirectoryExists(path: string) {
  try {
    requireValue(
      (await lstat(path)).isDirectory(),
      '构建目录必须是普通目录。',
      409,
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  }
}

async function locations(root: string, job: BuildLocation) {
  const named = join(root, buildDirectoryName(job));
  const legacy = join(root, String(job.id));
  if (!(await buildDirectoryExists(root)))
    return { named, legacy, hasLegacy: false };
  const [hasNamed, hasLegacy] = await Promise.all([
    buildDirectoryExists(named),
    buildDirectoryExists(legacy),
  ]);
  requireValue(
    !hasNamed || !hasLegacy,
    `构建 #${job.id} 有两个目录，请核对后重试。`,
    409,
  );
  return { named, legacy, hasLegacy };
}

export async function resolveBuildDirectory(root: string, job: BuildLocation) {
  const { named, legacy, hasLegacy } = await locations(root, job);
  return hasLegacy ? legacy : named;
}

// Called only at startup under the scheduler lock, after interrupted jobs
// have been stopped. The expected name is derived from immutable job data,
// so an interrupted rename needs no separate database update to resume.
export async function migrateBuildDirectory(root: string, job: BuildLocation) {
  const { named, legacy, hasLegacy } = await locations(root, job);
  if (hasLegacy) {
    await rename(legacy, named);
    await syncDirectory(root);
  }
}
