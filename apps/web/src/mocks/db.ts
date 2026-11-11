/**
 * 浏览器内存 Mock：模拟项目、SQLite 队列、并行调度、版本与用户。
 * 刷新页面后恢复初始演示数据，不访问后端、不执行 Git 或构建。
 */
import { reactive, ref } from 'vue';
import type {
  Artifact,
  Job,
  JobStatus,
  LogLine,
  Project,
  ProjectInput,
  Release,
  Role,
  TestStatus,
  User,
} from './types';

const MINUTE = 60_000;
const start = Date.now();
const ago = (minutes: number) => start - minutes * MINUTE;

let hexSeed = 0x5a17c3;
function hex(length: number) {
  let out = '';
  while (out.length < length) {
    hexSeed = (hexSeed * 1103515245 + 12345) & 0x7fffffff;
    out += hexSeed.toString(16);
  }
  return out.slice(0, length);
}

const commitMessages = [
  'feat: 新增工作台快捷入口',
  'fix: 修复构建脚本在空目录下的退出码',
  'chore: 升级依赖并更新锁文件',
  'refactor: 拆分打包配置',
  'docs: 更新发布说明',
  'perf: 优化首屏资源体积',
];
let messageIndex = 0;
const nextMessage = () =>
  commitMessages[messageIndex++ % commitMessages.length]!;

/* ---------------- 种子数据 ---------------- */

const users: User[] = [
  {
    id: 1,
    username: 'admin',
    displayName: '系统管理员',
    role: 'admin',
    enabled: true,
    password: 'admin123456',
    createdAt: ago(60 * 24 * 40),
    lastLoginAt: ago(60 * 3),
  },
  {
    id: 2,
    username: 'tester',
    displayName: '测试 · 林夏',
    role: 'user',
    enabled: true,
    password: 'tester123456',
    createdAt: ago(60 * 24 * 21),
    lastLoginAt: ago(60 * 26),
  },
  {
    id: 3,
    username: 'zhou.dev',
    displayName: '前端 · 周屿',
    role: 'user',
    enabled: true,
    password: 'zhou123456',
    createdAt: ago(60 * 24 * 14),
    lastLoginAt: ago(40),
  },
  {
    id: 4,
    username: 'old.ops',
    displayName: '运维 · 已离职',
    role: 'user',
    enabled: false,
    password: 'ops123456',
    createdAt: ago(60 * 24 * 90),
    lastLoginAt: ago(60 * 24 * 32),
  },
];

function project(
  id: number,
  data: Omit<Project, 'id' | 'fetched'>,
  fetchedMinutesAgo: number,
): Project {
  return {
    id,
    ...data,
    fetched: {
      branch: data.defaultBranch,
      sha: hex(40),
      message: nextMessage(),
      at: ago(fetchedMinutesAgo),
    },
  };
}

const projects: Project[] = [
  project(
    1,
    {
      slug: 'nebula-web',
      name: '星云工作台',
      description: '面向内部团队的一站式运营与协作平台',
      repository: 'git@git.example.com:studio/nebula-web.git',
      defaultBranch: 'main',
      branches: ['main', 'release/2.8', 'feature/workspace'],
      workdir: './apps/web',
      buildScript: '#!/usr/bin/env bash\nnpm ci\nnpm run build\n',
      artifactPath: './dist',
      timeout: 30,
      color: '#4f46e5',
    },
    12,
  ),
  project(
    2,
    {
      slug: 'open-portal',
      name: '开放平台',
      description: '统一开放能力、开发者文档与 API 门户',
      repository: 'git@git.example.com:platform/open-portal.git',
      defaultBranch: 'main',
      branches: ['main', 'release/4.1', 'feature/api-docs'],
      workdir: './',
      buildScript:
        '#!/usr/bin/env bash\nexport NODE_ENV=production\nnpm ci\nnpm run build:portal\nnode scripts/pack.mjs\n',
      artifactPath: './output',
      timeout: 45,
      color: '#0f766e',
    },
    5,
  ),
  project(
    3,
    {
      slug: 'desktop',
      name: '桌面客户端',
      description: 'Linux 客户端安装包与更新产物构建',
      repository: 'git@git.example.com:clients/desktop.git',
      defaultBranch: 'develop',
      branches: ['develop', 'main', 'release/1.6'],
      workdir: './',
      buildScript:
        '#!/usr/bin/env bash\nnpm ci\nbash scripts/build.sh --target linux\n',
      artifactPath: './release',
      timeout: 60,
      color: '#c2410c',
    },
    30,
  ),
  project(
    4,
    {
      slug: 'insight',
      name: '数据洞察',
      description: '业务数据分析与可视化报表应用',
      repository: 'git@git.example.com:analytics/insight.git',
      defaultBranch: 'main',
      branches: ['main', 'release/3.2'],
      workdir: './frontend',
      buildScript: '#!/usr/bin/env bash\nnpm ci\nnpm run build\n',
      artifactPath: './dist',
      timeout: 30,
      color: '#0369a1',
    },
    60,
  ),
  project(
    5,
    {
      slug: 'brand-docs',
      name: '品牌文档中心',
      description: '品牌规范、组件指南与团队知识库',
      repository: 'git@git.example.com:design/brand-docs.git',
      defaultBranch: 'main',
      branches: ['main', 'feature/new-brand'],
      workdir: './',
      buildScript: '#!/usr/bin/env bash\nnpm ci\nnpm run docs:build\n',
      artifactPath: './.vitepress/dist',
      timeout: 20,
      color: '#9333ea',
    },
    90,
  ),
];

/* ---------------- 构建脚本与日志模拟 ---------------- */

function commandOutput(command: string): string[] {
  if (command === 'npm ci')
    return [
      'npm warn deprecated inflight@1.0.6: This module is not supported',
      'added 1,284 packages, and audited 1,285 packages in 18s',
      'found 0 vulnerabilities',
    ];
  if (command.startsWith('npm run'))
    return [
      `> ${command.replace('npm run ', '')}`,
      'vite v7.1.4 building for production...',
      'transforming...',
      '✓ 1,532 modules transformed.',
      'rendering chunks...',
      'computing gzip size...',
      'dist/index.html                 0.62 kB │ gzip:  0.38 kB',
      'dist/assets/index-4f2c1a.css   48.10 kB │ gzip:  8.92 kB',
      'dist/assets/index-b81d0e.js   612.44 kB │ gzip: 189.70 kB',
      '✓ built in 12.41s',
    ];
  if (command.startsWith('bash'))
    return [
      '[build.sh] target: linux-x64, linux-arm64',
      '[build.sh] electron-builder 26.0.12',
      '[build.sh] packaging platform=linux arch=x64',
      '[build.sh] packaging platform=linux arch=arm64',
      '[build.sh] building target=AppImage',
      '[build.sh] done',
    ];
  if (command.startsWith('node'))
    return ['[pack] 写入版本清单', '[pack] 压缩文档站点', '[pack] 完成'];
  return ['完成'];
}

function artifactNames(slug: string, version: string): [string, number][] {
  switch (slug) {
    case 'desktop':
      return [
        [`${version}-linux-x64.AppImage`, 98_204_113],
        [`${version}-linux-x64.tar.gz`, 92_513_870],
        [`${version}-linux-arm64.tar.gz`, 90_118_402],
      ];
    case 'open-portal':
      return [
        [`${version}.tar.gz`, 31_402_998],
        [`${version}-docs.zip`, 8_201_334],
      ];
    case 'brand-docs':
      return [[`${version}.zip`, 14_552_009]];
    default:
      return [[`${version}.tar.gz`, 24_118_532]];
  }
}

/** 脚本中实际执行的命令行（忽略空行与注释），用于模拟 bash -x 输出。 */
export function scriptCommands(source: string) {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function buildScript(
  p: Project,
  job: Pick<Job, 'branch' | 'sha' | 'message' | 'number' | 'snapshot'>,
  failAtCommand?: number,
): { steps: string[]; script: LogLine[] } {
  const steps = ['拉取源码', '执行构建脚本', '收集产物'];
  const script: LogLine[] = [
    {
      step: 0,
      kind: 'cmd',
      text: `$ git clone --branch ${job.branch} --single-branch ${p.repository} src`,
    },
    { step: 0, text: "Cloning into 'src'..." },
    { step: 0, text: `HEAD is now at ${job.sha.slice(0, 7)} ${job.message}` },
    {
      step: 1,
      kind: 'cmd',
      text: `$ cd ${job.snapshot.workdir} && bash -e build.sh`,
    },
  ];
  const commands = scriptCommands(job.snapshot.buildScript);
  for (const [index, command] of commands.entries()) {
    script.push({ step: 1, kind: 'cmd', text: `+ ${command}` });
    if (failAtCommand !== undefined && index >= failAtCommand) {
      script.push(
        { step: 1, text: commandOutput(command)[0] ?? '' },
        {
          step: 1,
          kind: 'error',
          text: 'Error: Cannot find module "./config/production.mjs"',
        },
        {
          step: 1,
          kind: 'error',
          text: `构建脚本在「${command}」处失败，退出码 1`,
        },
      );
      return { steps, script };
    }
    for (const text of commandOutput(command)) script.push({ step: 1, text });
  }
  const last = steps.length - 1;
  const version = `${p.slug}-b${job.number}`;
  script.push({
    step: last,
    kind: 'cmd',
    text: `$ collect ${job.snapshot.artifactPath}`,
  });
  for (const [name, size] of artifactNames(p.slug, version))
    script.push({
      step: last,
      text: `${name}  ${(size / 1024 / 1024).toFixed(1)} MB  sha256:${hex(12)}…`,
    });
  script.push({ step: last, kind: 'ok', text: '构建成功，产物已公开发布' });
  return { steps, script };
}

/* ---------------- 数据库状态 ---------------- */

export const db = reactive({
  users,
  projects,
  jobs: [] as Job[],
  releases: [] as Release[],
  settings: { maxConcurrent: 2 },
});

let nextJobId = 1;
let nextSeq = 1001;
let nextReleaseId = 1;
let nextArtifactId = 1;
let nextProjectId = projects.length + 1;
let nextUserId = users.length + 1;
const projectNumbers = new Map<number, number>();
const cancelRequests = new Map<number, number>();

function projectById(id: number) {
  const found = db.projects.find((item) => item.id === id);
  if (!found) throw new Error('项目不存在，请刷新后重试。');
  return found;
}

function createJob(
  p: Project,
  branch: string,
  sha: string,
  message: string,
  triggeredBy: string,
  createdAt: number,
  failAtCommand?: number,
): Job {
  const number = (projectNumbers.get(p.id) ?? 0) + 1;
  projectNumbers.set(p.id, number);
  const snapshot = {
    workdir: p.workdir,
    buildScript: p.buildScript,
    artifactPath: p.artifactPath,
    timeout: p.timeout,
  };
  const { steps, script } = buildScript(
    p,
    { branch, sha, message, number, snapshot },
    failAtCommand,
  );
  return {
    id: nextJobId++,
    seq: nextSeq++,
    number,
    projectId: p.id,
    branch,
    sha,
    message,
    status: 'queued',
    triggeredBy,
    createdAt,
    startedAt: null,
    finishedAt: null,
    snapshot,
    steps,
    script,
    visibleLines: 0,
    plannedMs: 9_000 + script.length * 450,
  };
}

function publishRelease(job: Job, testStatus: TestStatus = 'pending') {
  const p = projectById(job.projectId);
  const version = `${p.slug}-b${job.number}`;
  const artifacts: Artifact[] = artifactNames(p.slug, version).map(
    ([name, size]) => ({
      id: nextArtifactId++,
      name,
      size: size + ((job.number * 7919) % 400_000),
      sha256: hex(64),
    }),
  );
  db.releases.push({
    id: nextReleaseId++,
    jobId: job.id,
    projectId: p.id,
    version,
    branch: job.branch,
    sha: job.sha,
    createdAt: job.finishedAt ?? Date.now(),
    triggeredBy: job.triggeredBy,
    testStatus,
    testUpdatedBy: testStatus === 'pending' ? '系统' : 'tester',
    testUpdatedAt: job.finishedAt ?? Date.now(),
    revision: 1,
    artifacts,
  });
}

/** 历史任务：直接写成已结束状态 */
function seedFinished(
  projectId: number,
  status: Extract<JobStatus, 'succeeded' | 'failed' | 'canceled'>,
  minutesAgo: number,
  durationSec: number,
  by: string,
  extra: { branch?: string; test?: TestStatus } = {},
) {
  const p = projectById(projectId);
  const job = createJob(
    p,
    extra.branch ?? p.defaultBranch,
    hex(40),
    nextMessage(),
    by,
    ago(minutesAgo + 1),
    status === 'failed' ? scriptCommands(p.buildScript).length - 1 : undefined,
  );
  job.startedAt = ago(minutesAgo);
  job.finishedAt = job.startedAt + durationSec * 1000;
  job.status = status;
  if (status === 'canceled') {
    job.script = job.script.slice(0, 6);
    job.script.push({
      step: job.script.at(-1)!.step,
      kind: 'error',
      text: '收到停止请求，已终止任务进程树',
    });
    job.error = '由 admin 手动停止';
  }
  if (status === 'failed') job.error = '步骤执行失败，退出码 1';
  job.visibleLines = job.script.length;
  db.jobs.push(job);
  if (status === 'succeeded') publishRelease(job, extra.test);
}

// 历史记录：按时间顺序写入，保证各项目编号递增
seedFinished(1, 'succeeded', 60 * 24 * 6, 212, 'admin', { test: 'passed' });
seedFinished(3, 'succeeded', 60 * 24 * 5, 534, 'zhou.dev', { test: 'passed' });
seedFinished(2, 'succeeded', 60 * 24 * 5 - 30, 301, 'admin', {
  test: 'passed',
});
seedFinished(4, 'succeeded', 60 * 24 * 4, 188, 'tester', { test: 'rejected' });
seedFinished(1, 'succeeded', 60 * 24 * 3, 205, 'zhou.dev', {
  branch: 'release/2.8',
  test: 'passed',
});
seedFinished(5, 'failed', 60 * 24 * 3 - 20, 64, 'admin');
seedFinished(3, 'failed', 60 * 24 * 2, 98, 'zhou.dev');
seedFinished(3, 'succeeded', 60 * 24 * 2 - 40, 547, 'zhou.dev', {
  branch: 'release/1.6',
  test: 'testing',
});
seedFinished(2, 'canceled', 60 * 24, 41, 'tester');
seedFinished(4, 'succeeded', 60 * 20, 176, 'admin', { test: 'passed' });
seedFinished(1, 'succeeded', 60 * 5, 219, 'zhou.dev', { test: 'testing' });
seedFinished(2, 'succeeded', 60 * 3, 288, 'admin', { test: 'rejected' });
seedFinished(5, 'failed', 60 * 2, 58, 'tester');
seedFinished(1, 'succeeded', 50, 201, 'admin');
seedFinished(3, 'succeeded', 35, 552, 'admin');

// 当前队列：2 个运行中、3 个排队（并行上限 2）
function seedActive(projectId: number, by: string, minutesAgo: number) {
  const p = projectById(projectId);
  const job = createJob(
    p,
    p.defaultBranch,
    p.fetched.sha,
    p.fetched.message,
    by,
    ago(minutesAgo),
  );
  db.jobs.push(job);
  return job;
}
const runningA = seedActive(2, 'admin', 4);
runningA.status = 'running';
runningA.startedAt = Date.now() - runningA.plannedMs * 0.45;
const runningB = seedActive(3, 'zhou.dev', 2);
runningB.status = 'running';
runningB.startedAt = Date.now() - runningB.plannedMs * 0.1;
seedActive(4, 'tester', 1.5);
seedActive(1, 'zhou.dev', 1);
seedActive(5, 'admin', 0.5);

/* ---------------- 调度器 ---------------- */

export const OCCUPYING: JobStatus[] = ['running', 'canceling'];
export const now = ref(Date.now());

function tick() {
  now.value = Date.now();
  for (const job of db.jobs) {
    if (job.status === 'running' && job.startedAt) {
      const fraction = Math.min(1, (now.value - job.startedAt) / job.plannedMs);
      job.visibleLines = Math.max(1, Math.ceil(fraction * job.script.length));
      if (fraction >= 1) {
        const failed = job.script.some((line) => line.kind === 'error');
        job.status = failed ? 'failed' : 'succeeded';
        job.finishedAt = now.value;
        if (failed) job.error = '步骤执行失败，退出码 1';
        else publishRelease(job);
      }
    }
    if (job.status === 'canceling') {
      const requested = cancelRequests.get(job.id) ?? 0;
      if (now.value - requested > 1800) {
        job.script = job.script.slice(0, job.visibleLines);
        job.script.push({
          step: job.script.at(-1)?.step ?? 0,
          kind: 'error',
          text: '收到停止请求，已终止任务进程树',
        });
        job.visibleLines = job.script.length;
        job.status = 'canceled';
        job.finishedAt = now.value;
        cancelRequests.delete(job.id);
      }
    }
  }
  // 按入队序号 FIFO 补位
  let occupied = db.jobs.filter((job) => OCCUPYING.includes(job.status)).length;
  const queued = db.jobs
    .filter((job) => job.status === 'queued')
    .sort((a, b) => a.seq - b.seq);
  for (const job of queued) {
    if (occupied >= db.settings.maxConcurrent) break;
    job.status = 'running';
    job.startedAt = now.value;
    job.visibleLines = 1;
    occupied++;
  }
}
window.setInterval(tick, 1000);

/* ---------------- Mock API ---------------- */

function delay<T>(value: T, ms = 380): Promise<T> {
  return new Promise((resolve) => window.setTimeout(() => resolve(value), ms));
}

export function findUser(username: string) {
  return db.users.find((user) => user.username === username);
}

export async function authenticate(username: string, password: string) {
  await delay(null, 420);
  const user = findUser(username);
  if (!user || user.password !== password || !user.enabled)
    throw new Error('账号或密码错误');
  user.lastLoginAt = Date.now();
  return user;
}

function slugify(name: string) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return base || `project-${nextProjectId}`;
}

export async function saveProject(input: ProjectInput, id?: number) {
  await delay(null, 520);
  if (id) {
    const existing = projectById(id);
    Object.assign(existing, input);
    if (!existing.branches.includes(input.defaultBranch))
      existing.branches.unshift(input.defaultBranch);
    if (!input.icon) delete existing.icon;
    return existing;
  }
  const repoName =
    input.repository
      .split('/')
      .pop()
      ?.replace(/\.git$/, '') ?? input.name;
  const created: Project = {
    id: nextProjectId++,
    slug: slugify(repoName),
    color: '#2563eb',
    branches: [input.defaultBranch],
    fetched: {
      branch: input.defaultBranch,
      sha: hex(40),
      message: 'initial commit',
      at: Date.now(),
    },
    ...input,
  };
  db.projects.unshift(created);
  return created;
}

export async function fetchCode(projectId: number, branch: string) {
  await delay(null, 900);
  const p = projectById(projectId);
  p.fetched = { branch, sha: hex(40), message: nextMessage(), at: Date.now() };
  return p.fetched;
}

export async function enqueueBuild(
  projectId: number,
  branch: string,
  sha: string,
  message: string,
  by: string,
) {
  await delay(null, 420);
  const job = createJob(
    projectById(projectId),
    branch,
    sha,
    message,
    by,
    Date.now(),
  );
  db.jobs.push(job);
  tick();
  return job;
}

export async function stopJob(jobId: number) {
  await delay(null, 300);
  const job = db.jobs.find((item) => item.id === jobId);
  if (!job || job.status !== 'running')
    throw new Error('任务状态已变化，请刷新后重试。');
  job.status = 'canceling';
  cancelRequests.set(job.id, Date.now());
}

export async function deleteJob(jobId: number) {
  await delay(null, 650);
  const job = db.jobs.find((item) => item.id === jobId);
  if (!job) return;
  if (OCCUPYING.includes(job.status))
    throw new Error('任务已开始执行，请先停止构建。');
  db.releases = db.releases.filter((release) => release.jobId !== jobId);
  db.jobs = db.jobs.filter((item) => item.id !== jobId);
}

export async function deleteRelease(releaseId: number) {
  const release = db.releases.find((item) => item.id === releaseId);
  if (release) await deleteJob(release.jobId);
}

export async function setTestStatus(
  releaseId: number,
  status: TestStatus,
  revision: number,
  by: string,
) {
  await delay(null, 300);
  const release = db.releases.find((item) => item.id === releaseId);
  if (!release) throw new Error('版本已被删除。');
  if (release.revision !== revision)
    throw new Error('该版本状态已被他人修改，请确认后重试。');
  release.testStatus = status;
  release.testUpdatedBy = by;
  release.testUpdatedAt = Date.now();
  release.revision++;
}

export async function createUser(input: {
  username: string;
  displayName: string;
  role: Role;
  password: string;
}) {
  await delay(null, 420);
  if (findUser(input.username)) throw new Error('账号已存在');
  db.users.push({
    id: nextUserId++,
    ...input,
    enabled: true,
    createdAt: Date.now(),
    lastLoginAt: null,
  });
}

export async function updateUser(
  id: number,
  patch: Partial<Pick<User, 'role' | 'enabled' | 'displayName' | 'password'>>,
) {
  await delay(null, 320);
  const user = db.users.find((item) => item.id === id);
  if (!user) throw new Error('用户不存在');
  const next = { ...user, ...patch };
  const remainingAdmins = db.users.filter(
    (item) => item.id !== id && item.role === 'admin' && item.enabled,
  ).length;
  if (
    (next.role !== 'admin' || !next.enabled) &&
    user.role === 'admin' &&
    remainingAdmins === 0
  )
    throw new Error('至少需要保留一个启用的管理员');
  Object.assign(user, patch);
}

/** 物理删除账号：撤销会话；历史任务与测试记录保留原账号名。 */
export async function deleteUser(id: number, operatorId: number) {
  await delay(null, 360);
  const user = db.users.find((item) => item.id === id);
  if (!user) throw new Error('用户不存在或已被删除');
  if (id === operatorId) throw new Error('不能删除当前登录的账号');
  const remainingAdmins = db.users.filter(
    (item) => item.id !== id && item.role === 'admin' && item.enabled,
  ).length;
  if (user.role === 'admin' && user.enabled && remainingAdmins === 0)
    throw new Error('至少需要保留一个启用的管理员');
  db.users.splice(db.users.indexOf(user), 1);
}

export async function saveSettings(maxConcurrent: number) {
  await delay(null, 420);
  db.settings.maxConcurrent = maxConcurrent;
  tick();
}

/* ---------------- 公开下载查询 ---------------- */

export function publicReleases(projectId: number, status: TestStatus | 'all') {
  return db.releases
    .filter(
      (release) =>
        release.projectId === projectId &&
        (status === 'all' || release.testStatus === status),
    )
    .sort((a, b) => b.createdAt - a.createdAt || b.jobId - a.jobId);
}
