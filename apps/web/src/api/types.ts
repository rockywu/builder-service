export type Role = 'admin' | 'user';

export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  enabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface Project {
  id: number;
  slug: string;
  name: string;
  description: string;
  repository: string;
  defaultBranch: string;
  branches: string[];
  /** 构建脚本的执行目录，相对仓库根目录；产物路径也相对此目录。 */
  workdir: string;
  /** 完整构建脚本，以 bash -e 执行，任一命令失败即终止。 */
  buildScript: string;
  artifactPath: string;
  timeout: number;
  color: string;
  icon?: string | undefined;
  /** 最近一次拉取的提交，用于发起构建时固定 commit。 */
  fetched: { branch: string; sha: string; message: string; at: number };
}

export type ProjectInput = Pick<
  Project,
  | 'name'
  | 'description'
  | 'repository'
  | 'defaultBranch'
  | 'workdir'
  | 'buildScript'
  | 'artifactPath'
  | 'timeout'
> & { icon?: string | undefined };

export type JobStatus =
  'queued' | 'running' | 'canceling' | 'succeeded' | 'failed' | 'canceled';

export interface LogLine {
  step: number;
  text: string;
  kind?: 'cmd' | 'error' | 'ok';
}

export interface Job {
  id: number;
  /** 全局入队序号 */
  seq: number;
  /** 项目内构建编号 */
  number: number;
  projectId: number;
  branch: string;
  sha: string;
  message: string;
  status: JobStatus;
  triggeredBy: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** 构建配置快照 */
  snapshot: Pick<
    Project,
    'workdir' | 'buildScript' | 'artifactPath' | 'timeout'
  >;
  steps: string[];
  script: LogLine[];
  visibleLines: number;
  phase: 0 | 1 | 2;
  progress?: number;
  triggeredById: number;
  error?: string;
}

export type TestStatus = 'passed' | 'pending' | 'testing' | 'rejected';

export interface Artifact {
  id: number;
  name: string;
  size: number;
  sha256: string;
}

export interface Release {
  id: number;
  jobId: number;
  projectId: number;
  version: string;
  branch: string;
  sha: string;
  createdAt: number;
  triggeredBy: string;
  testStatus: TestStatus;
  testUpdatedBy: string;
  testUpdatedAt: number;
  revision: number;
  artifacts: Artifact[];
}
