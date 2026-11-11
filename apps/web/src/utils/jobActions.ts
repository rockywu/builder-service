import { ElMessage } from 'element-plus';
import type { Job, Release } from '../mocks/types';
import { db, deleteJob, deleteRelease, stopJob } from '../mocks/db';
import { confirmDelete, openConfirm } from './confirm';

const projectName = (id: number) =>
  db.projects.find((p) => p.id === id)?.name ?? '未知项目';

export async function confirmStop(job: Job) {
  const ok = await openConfirm({
    title: '停止构建',
    target: `${projectName(job.projectId)} · 构建 #${job.number}`,
    description: '任务与日志会保留，停止后可以再删除。',
    confirmText: '停止构建',
    tone: 'warning',
  });
  if (!ok) return false;
  try {
    await stopJob(job.id);
    ElMessage.info('已发送停止请求，正在终止进程');
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '停止失败');
    return false;
  }
}

export async function confirmDeleteJob(job: Job) {
  const release = db.releases.find((r) => r.jobId === job.id);
  const scope =
    job.status === 'queued'
      ? ['从构建队列移除', '任务记录及配置快照']
      : [
          '该任务独立克隆的源码与依赖目录',
          '构建日志与临时文件',
          ...(release
            ? [
                `版本 ${release.version} 及 ${release.artifacts.length} 个产物文件（公开下载立即失效）`,
              ]
            : []),
          '任务数据库记录',
        ];
  const ok = await confirmDelete({
    title: job.status === 'queued' ? '删除排队任务' : '删除构建任务',
    target: `${projectName(job.projectId)} · 构建 #${job.number}`,
    scope,
  });
  if (!ok) return false;
  try {
    await deleteJob(job.id);
    ElMessage.success('已删除');
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除未完成');
    return false;
  }
}

export async function confirmDeleteRelease(release: Release) {
  const ok = await confirmDelete({
    title: '删除版本',
    target: `${projectName(release.projectId)} · ${release.version}`,
    scope: [
      `${release.artifacts.length} 个产物文件（公开下载立即失效）`,
      '对应构建任务、日志与源码副本',
      '测试状态变更记录',
    ],
  });
  if (!ok) return false;
  try {
    await deleteRelease(release.id);
    ElMessage.success('版本已删除');
    return true;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除未完成');
    return false;
  }
}
