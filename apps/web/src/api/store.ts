import { reactive, ref } from 'vue';
import type {
  Project,
  ProjectInput,
  Job,
  JobStatus,
  Release,
  User,
  Role,
  TestStatus,
  LogLine,
  SshKey,
  KnownHost,
  ScannedHostKey,
} from './types';
import { all, request, ApiError } from './client';
import { ElMessage } from 'element-plus';

export const db = reactive({
  projects: [] as Project[],
  jobs: [] as Job[],
  releases: [] as Release[],
  users: [] as User[],
  settings: { maxConcurrent: 1 },
  /** 仅管理员按需加载，不参与全局轮询刷新。 */
  sshKeys: [] as SshKey[],
  knownHosts: [] as KnownHost[],
});
export const now = ref(Date.now());
export const OCCUPYING: JobStatus[] = ['running', 'canceling'];
export type PublicRelease = Omit<
  Release,
  'triggeredBy' | 'testUpdatedBy' | 'testUpdatedAt'
>;
export type PublicProjectView = Pick<
  Project,
  'id' | 'slug' | 'name' | 'description' | 'icon' | 'color'
>;
export const publicDb = reactive({
  projects: [] as PublicProjectView[],
  releases: [] as PublicRelease[],
});
export const publicCounts = reactive<Record<number, number>>({});
export function scriptCommands(source: string) {
  return source
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'));
}
let role: Role | null = null,
  generation = 0,
  controller: AbortController | undefined,
  refreshing: Promise<void> | undefined;
const logs = new Map<
  number,
  { lines: LogLine[]; offset: number; done: boolean }
>();
let lastError = '';
function merge<T extends { id: number }>(previous: T[], items: T[]) {
  const map = new Map(previous.map((item) => [item.id, item]));
  return items.map((item) => {
    const old = map.get(item.id);
    return old ? Object.assign(old, item) : item;
  });
}
export function clearAdmin() {
  role = null;
  generation++;
  controller?.abort();
  logs.clear();
  watched.clear();
  enqueueKeys.clear();
  db.projects = [];
  db.jobs = [];
  db.releases = [];
  db.users = [];
  db.sshKeys = [];
  db.knownHosts = [];
}
async function performRefresh() {
  if (!role) return;
  const epoch = generation;
  controller = new AbortController();
  const signal = controller.signal;
  const [projects, jobs, releases, queue, users] = await Promise.all([
    all<Project>('/projects', signal),
    all<Job>('/jobs', signal),
    all<Release>('/releases', signal),
    request<{ maxConcurrent: number; error: string | null }>('/queue', {
      signal,
    }),
    role === 'admin' ? all<User>('/users', signal) : Promise.resolve([]),
  ]);
  if (epoch !== generation) return;
  const liveJobs = new Set(jobs.map((j) => j.id));
  for (const id of logs.keys()) if (!liveJobs.has(id)) logs.delete(id);
  for (const id of watched) if (!liveJobs.has(id)) watched.delete(id);
  const liveProjects = new Set(projects.map((p) => p.id));
  for (const [signature, pending] of enqueueKeys)
    if (!liveProjects.has(pending.projectId)) enqueueKeys.delete(signature);
  const slugs = new Set(projects.map((p) => p.slug));
  try {
    // Another session may have deleted the project while this browser was offline.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      const slug = key?.match(/^builder:build-branch:\d+:([^:]+)$/)?.[1];
      if (key && slug && !slugs.has(slug)) localStorage.removeItem(key);
    }
  } catch {
    // Optional storage can be disabled by the browser.
  }
  for (const j of jobs) {
    const cached = logs.get(j.id);
    j.script = cached?.lines ?? [];
    j.visibleLines = j.script.length;
  }
  db.projects = merge(db.projects, projects);
  db.jobs = merge(db.jobs, jobs);
  db.releases = merge(db.releases, releases);
  db.users = merge(db.users, users);
  db.settings.maxConcurrent = queue.maxConcurrent;
  if (queue.error && queue.error !== lastError) {
    lastError = queue.error;
    ElMessage.error(queue.error);
  } else if (!queue.error) lastError = '';
}
async function refreshAdmin(force = false): Promise<void> {
  if (!role || (!force && document.visibilityState === 'hidden')) return;
  if (refreshing) {
    await refreshing;
    if (force) return refreshAdmin(true);
    return;
  }
  const pending = performRefresh();
  refreshing = pending;
  try {
    await pending;
  } finally {
    if (refreshing === pending) refreshing = undefined;
  }
}
export async function loadAdmin(nextRole: Role) {
  if (role !== nextRole) {
    generation++;
    role = nextRole;
  }
  await refreshAdmin(true);
}
export async function refreshData() {
  await refreshAdmin();
}
async function mutation<T>(
  path: string,
  method: string,
  body?: unknown,
  key?: string,
): Promise<T> {
  try {
    const result = await request<T>(path, {
      method,
      ...(body !== undefined ? { body } : {}),
      ...(key ? { key } : {}),
    });
    await refreshAdmin(true).catch(() =>
      ElMessage.error('操作已完成，但数据刷新失败，请刷新页面核对。'),
    );
    return result;
  } catch (e) {
    await refreshAdmin(true).catch(() => {});
    throw e;
  }
}
export async function saveProject(input: ProjectInput, id?: number) {
  return mutation<Project>(
    id ? `/projects/${id}` : '/projects',
    id ? 'PUT' : 'POST',
    { ...input, icon: input.icon ?? null },
  );
}
export async function deleteProject(id: number) {
  return mutation<{ ok: boolean }>(`/projects/${id}`, 'DELETE');
}
export async function fetchCode(projectId: number, branch: string) {
  const result = await mutation<Project['fetched']>(
    `/projects/${projectId}/fetch`,
    'POST',
    { branch },
  );
  const p = db.projects.find((p) => p.id === projectId);
  if (p) p.fetched = result;
  return result;
}
const enqueueKeys = new Map<string, { projectId: number; key: string }>();
export async function enqueueBuild(
  projectId: number,
  branch: string,
  sha: string,
  _message: string,
  _by: string,
) {
  const input = { projectId, branch, sha },
    signature = JSON.stringify(input);
  const key = enqueueKeys.get(signature)?.key ?? crypto.randomUUID();
  enqueueKeys.set(signature, { projectId, key });
  try {
    const job = await mutation<Job>('/jobs', 'POST', input, key);
    enqueueKeys.delete(signature);
    if (
      db.projects.some((p) => p.id === projectId) &&
      !db.jobs.some((j) => j.id === job.id)
    )
      db.jobs.push(job);
    return db.jobs.find((j) => j.id === job.id) ?? job;
  } catch (e) {
    if (e instanceof ApiError && e.status >= 400 && e.status < 500)
      enqueueKeys.delete(signature);
    throw e;
  }
}
export async function stopJob(id: number) {
  return mutation(`/jobs/${id}/stop`, 'POST');
}
export async function deleteJob(id: number) {
  logs.delete(id);
  return mutation(`/jobs/${id}`, 'DELETE');
}
export async function deleteRelease(id: number) {
  return mutation(`/releases/${id}`, 'DELETE');
}
export async function setTestStatus(
  id: number,
  status: TestStatus,
  revision: number,
  _by: string,
) {
  return mutation(`/releases/${id}/test-status`, 'PATCH', { status, revision });
}
export async function createUser(input: {
  username: string;
  displayName: string;
  role: Role;
  password: string;
}) {
  return mutation('/users', 'POST', input);
}
export async function updateUser(
  id: number,
  patch: Partial<Pick<User, 'role' | 'enabled' | 'displayName'>> & {
    password?: string;
  },
) {
  if (patch.password !== undefined)
    return mutation(`/users/${id}/password`, 'POST', {
      password: patch.password,
    });
  return mutation(`/users/${id}`, 'PATCH', patch);
}
export async function deleteUser(id: number, _operatorId: number) {
  return mutation(`/users/${id}`, 'DELETE');
}
export async function saveSettings(maxConcurrent: number) {
  return mutation('/settings', 'PUT', { maxConcurrent });
}
/* Git SSH 密钥与受信任主机：独立加载，失败只影响所在区域。 */
export async function loadSshKeys() {
  db.sshKeys = merge(db.sshKeys, await all<SshKey>('/ssh-keys'));
}
export async function loadKnownHosts() {
  db.knownHosts = merge(db.knownHosts, await all<KnownHost>('/known-hosts'));
}
async function keyMutation<T>(path: string, method: string, body?: unknown) {
  const result = await mutation<T>(path, method, body);
  await loadSshKeys().catch(() => {});
  return result;
}
export type SshKeyCreateInput =
  | { name: string; mode: 'generate' }
  | { name: string; mode: 'import'; privateKey: string };
export async function createSshKey(input: SshKeyCreateInput) {
  return keyMutation<SshKey>('/ssh-keys', 'POST', input);
}
export async function updateSshKey(
  id: number,
  patch: { name: string; privateKey?: string },
) {
  return keyMutation<SshKey>(`/ssh-keys/${id}`, 'PATCH', patch);
}
export async function deleteSshKey(id: number) {
  return keyMutation<void>(`/ssh-keys/${id}`, 'DELETE');
}
export async function scanKnownHost(host: string, port: number) {
  const result = await request<{ items: ScannedHostKey[] }>(
    '/known-hosts/scan',
    { method: 'POST', body: { host, port } },
  );
  return result.items;
}
export async function addKnownHosts(
  host: string,
  port: number,
  keys: ScannedHostKey[],
) {
  const result = await request<KnownHost[]>('/known-hosts', {
    method: 'POST',
    body: { host, port, keys },
  });
  await loadKnownHosts().catch(() => {});
  return result;
}
export async function deleteKnownHost(id: number) {
  await request<void>(`/known-hosts/${id}`, { method: 'DELETE' });
  await loadKnownHosts().catch(() => {});
}
/** 从 git@host:path 或 ssh://[user@]host[:port]/path 解析主机与端口；HTTPS 返回 null。 */
export function sshHostOf(repository: string) {
  const scp = /^git@([^:\s/]+):/.exec(repository);
  const address = scp ? `ssh://${scp[1]}/` : repository;
  if (!address.startsWith('ssh://')) return null;
  try {
    const url = new URL(address);
    return {
      host: url.hostname
        .replace(/^\[|\]$/g, '')
        .toLowerCase()
        .replace(/\.$/, ''),
      port: Number(url.port || 22),
    };
  } catch {
    return null;
  }
}

export function publicReleases(projectId: number, status: TestStatus | 'all') {
  return publicDb.releases
    .filter(
      (r) =>
        r.projectId === projectId &&
        (status === 'all' || r.testStatus === status),
    )
    .sort((a, b) => b.createdAt - a.createdAt || b.jobId - a.jobId);
}

type PublicProject = Pick<
  Project,
  'id' | 'slug' | 'name' | 'description' | 'icon'
> & { releaseCount: number; latestRelease: PublicRelease | null };
export async function loadPublicProjects() {
  const items = await request<PublicProject[]>('/public/projects');
  // View-only defaults keep the established avatar component API; internal fields are never sent by the public API.
  publicDb.projects = items.map((p) => ({ ...p, color: '#2563eb' }));
  for (const id of Object.keys(publicCounts)) delete publicCounts[Number(id)];
  for (const p of items) publicCounts[p.id] = p.releaseCount;
  publicDb.releases = items.flatMap((p) =>
    p.latestRelease ? [p.latestRelease] : [],
  );
}
export interface PublicPage {
  project: PublicProjectView;
  items: PublicRelease[];
  total: number;
  hasAny: boolean;
  page: number;
  pageSize: number;
}
export async function loadPublicPage(
  slug: string,
  status: TestStatus | 'all',
  page: number,
) {
  const data = await request<PublicPage>(
    `/public/projects/${encodeURIComponent(slug)}/releases?status=${status}&page=${page}&pageSize=5`,
  );
  data.project.color = '#2563eb';
  return data;
}
const watched = new Set<number>();
export function watchLog(id: number) {
  watched.add(id);
  void pollLogs().catch(report);
  return () => watched.delete(id);
}
let logsBusy = false;
async function pollLogs() {
  if (logsBusy || !role || document.visibilityState === 'hidden') return;
  logsBusy = true;
  try {
    for (const id of watched) {
      const cached = logs.get(id) ?? { lines: [], offset: 0, done: false };
      if (cached.done) continue;
      const chunk = await request<{
        lines: LogLine[];
        nextOffset: number;
        done: boolean;
      }>(`/jobs/${id}/log?offset=${cached.offset}`);
      if (!watched.has(id) || !db.jobs.some((j) => j.id === id)) continue;
      cached.lines.push(...chunk.lines);
      cached.offset = chunk.nextOffset;
      cached.done = chunk.done && chunk.lines.length < 500;
      logs.set(id, cached);
      const job = db.jobs.find((j) => j.id === id);
      if (job) {
        job.script = [...cached.lines];
        job.visibleLines = cached.lines.length;
      }
    }
  } finally {
    logsBusy = false;
  }
}
function report(e: unknown) {
  const message = e instanceof Error ? e.message : '数据刷新失败。';
  if (message !== lastError) {
    lastError = message;
    ElMessage.error(message);
  }
}
window.setInterval(() => {
  now.value = Date.now();
  void pollLogs().catch(report);
}, 1000);
window.setInterval(() => {
  if (location.pathname.startsWith('/admin/'))
    void refreshAdmin().catch(report);
}, 3000);
document.addEventListener('visibilitychange', () => {
  if (
    document.visibilityState === 'visible' &&
    location.pathname.startsWith('/admin/')
  )
    void refreshAdmin().catch(report);
});
