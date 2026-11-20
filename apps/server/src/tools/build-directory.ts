import { lstat, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { requireValue } from '../modules/platform/errors.js';
import type { Job } from '../modules/platform/types.js';
import { safePath, syncDirectory } from './paths.js';

type BuildLocation = Pick<
  Job,
  'id' | 'projectId' | 'branch' | 'sha' | 'repository' | 'refType'
>;

const label = (value: string) =>
  value
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .slice(0, 48)
    .replace(/^-+|-+$/g, '');

export function legacyBuildDirectoryName(job: BuildLocation) {
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

export function projectDirectory(root: string, projectId: number) {
  requireValue(
    Number.isSafeInteger(projectId) && projectId > 0,
    '无效项目编号。',
  );
  return join(root, `project-${projectId}`);
}

export function buildDirectoryName(job: BuildLocation) {
  requireValue(Number.isSafeInteger(job.id) && job.id > 0, '无效任务编号。');
  return join(projectDirectory('', job.projectId), 'jobs', String(job.id));
}

export async function ensureDirectory(path: string) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  requireValue(await buildDirectoryExists(path), '无法创建构建目录。', 409);
}
export async function ensureProjectDirectories(root: string, id: number) {
  requireValue(await buildDirectoryExists(root), '构建目录不存在。');
  const project = projectDirectory(root, id);
  await ensureDirectory(project);
  await ensureDirectory(join(project, 'jobs'));
  await ensureDirectory(join(project, 'outputs'));
  return project;
}

export async function resolveBuildDirectory(root: string, job: BuildLocation) {
  const path = join(root, buildDirectoryName(job));
  if (!(await buildDirectoryExists(root))) return path;
  const project = projectDirectory(root, job.projectId);
  const current =
    (await buildDirectoryExists(project)) &&
    (await buildDirectoryExists(join(project, 'jobs'))) &&
    (await buildDirectoryExists(path));
  const old = [
    join(root, legacyBuildDirectoryName(job)),
    join(root, String(job.id)),
  ];
  const existing = current ? [path] : [];
  for (const p of old) if (await buildDirectoryExists(p)) existing.push(p);
  requireValue(
    existing.length <= 1,
    `构建 #${job.id} 有多个目录，请核对后重试。`,
    409,
  );
  return existing[0] ?? path;
}

export async function migrateBuildDirectory(root: string, job: BuildLocation) {
  const old = await resolveBuildDirectory(root, job);
  const path = join(root, buildDirectoryName(job));
  if (!(await buildDirectoryExists(old))) return;
  const project = await ensureProjectDirectories(root, job.projectId);
  if (old !== path) {
    await rename(old, path);
    await syncDirectory(join(project, 'jobs'));
    await syncDirectory(project);
    await syncDirectory(root);
  }
  // A crash between the two renames resumes here. Never overwrite another publication.
  const archived = join(path, 'artifacts');
  if (await buildDirectoryExists(archived)) {
    const target = versionOutput(root, job);
    requireValue(
      !(await buildDirectoryExists(target)),
      '历史产物存在两份，请核对后重试。',
      409,
    );
    await rename(archived, target);
    await syncDirectory(path);
    await syncDirectory(join(project, 'outputs'));
  }
}

export function versionOutput(
  root: string,
  job: Pick<Job, 'projectId' | 'id'>,
) {
  requireValue(Number.isSafeInteger(job.id) && job.id > 0, '无效任务编号。');
  return join(projectDirectory(root, job.projectId), 'outputs', String(job.id));
}
export async function artifactFile(
  root: string,
  job: BuildLocation,
  key: string,
) {
  if (key.startsWith('outputs/')) {
    const base = await safePath(root, versionOutput('', job));
    return safePath(base, key.slice('outputs/'.length));
  }
  const history = await resolveBuildDirectory(root, job);
  requireValue(/^artifacts\/\d+$/.test(key), '无效历史产物路径。');
  if (await buildDirectoryExists(join(history, 'artifacts')))
    return safePath(history, key);
  return safePath(
    await safePath(root, versionOutput('', job)),
    key.slice('artifacts/'.length),
  );
}
