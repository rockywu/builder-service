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
} from './types';
import { all, request, ApiError } from './client';
import { ElMessage } from 'element-plus';

export const db = reactive({
  projects: [] as Project[],
  jobs: [] as Job[],
  releases: [] as Release[],
  users: [] as User[],
  settings: { maxConcurrent: 1 },
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
  db.projects = [];
  db.jobs = [];
  db.releases = [];
  db.users = [];
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
const enqueueKeys = new Map<string, string>();
export async function enqueueBuild(
  projectId: number,
  branch: string,
  sha: string,
  _message: string,
  _by: string,
) {
  const input = { projectId, branch, sha },
    signature = JSON.stringify(input);
  const key = enqueueKeys.get(signature) ?? crypto.randomUUID();
  enqueueKeys.set(signature, key);
  try {
    const job = await mutation<Job>('/jobs', 'POST', input, key);
    enqueueKeys.delete(signature);
    if (!db.jobs.some((j) => j.id === job.id)) db.jobs.push(job);
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
      if (!watched.has(id)) continue;
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
