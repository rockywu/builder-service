import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { JobStatus, TestStatus } from './types.js';

const keepLimit = 12;
type Candidate = { jobId: number; number: number; reason: string };
type Plan = {
  projectId: number;
  limit: number;
  name: string;
  kept: number[];
  candidates: Candidate[];
  token: string;
};

// All three single-table reads run in the same worker transaction. Read only
// the fields needed for retention, never job scripts, logs or artifact blobs.
export function cleanupPlans(
  db: Database.Database,
  projectId?: number,
): Plan[] {
  const args = projectId === undefined ? [] : [projectId];
  const where = (column: string) =>
    args.length ? ' AND ' + column + '=?' : '';
  const projects = db
    .prepare(
      "SELECT id,json_extract(payload,'$.name') AS name FROM projects WHERE COALESCE(json_extract(payload,'$.deleting'),0)=0" +
        where('id') +
        ' ORDER BY id',
    )
    .all(...args) as { id: number; name: string }[];
  const releases = db
    .prepare(
      "SELECT job_id,json_extract(payload,'$.testStatus') AS status,json_extract(payload,'$.unavailable') AS unavailable FROM releases WHERE deleting=0" +
        where('project_id'),
    )
    .all(...args) as {
    job_id: number;
    status: TestStatus;
    unavailable: number | null;
  }[];
  const jobs = db
    .prepare(
      "SELECT id,project_id,number,status FROM build_jobs WHERE deleting=0 AND status IN ('succeeded','failed','canceled')" +
        where('project_id') +
        ' ORDER BY project_id,number DESC',
    )
    .all(...args) as {
    id: number;
    project_id: number;
    number: number;
    status: JobStatus;
  }[];
  const byJob = new Map(releases.map((r) => [r.job_id, r]));
  const plans = new Map(
    projects.map((p) => [
      p.id,
      {
        projectId: p.id,
        limit: keepLimit,
        name: p.name,
        kept: [] as number[],
        candidates: [] as Candidate[],
        token: '',
      },
    ]),
  );
  for (const j of jobs) {
    const plan = plans.get(j.project_id);
    if (!plan) continue;
    const release = byJob.get(j.id);
    const valid =
      j.status === 'succeeded' &&
      release &&
      !release.unavailable &&
      ['passed', 'testing', 'pending'].includes(release.status);
    if (valid && plan.kept.length < keepLimit) {
      plan.kept.push(j.number);
      continue;
    }
    if (!plan.kept.length) continue; // No newer usable build to fall back to.
    const reason = valid
      ? `超过最近 ${keepLimit} 个有效版本`
      : release?.unavailable
        ? '产物已停用'
        : release?.status === 'rejected'
          ? '测试不通过'
          : j.status === 'failed'
            ? '构建失败'
            : j.status === 'canceled'
              ? '已取消'
              : null;
    if (reason) plan.candidates.push({ jobId: j.id, number: j.number, reason });
  }
  return [...plans.values()]
    .filter((p) => p.candidates.length)
    .map((p) => ({
      ...p,
      token: createHash('sha256').update(JSON.stringify(p)).digest('hex'),
    }));
}
