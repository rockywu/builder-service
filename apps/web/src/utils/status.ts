import type { JobStatus, TestStatus } from '../api/types';

type TagType = 'primary' | 'success' | 'warning' | 'danger' | 'info';

export const jobStatusMeta: Record<
  JobStatus,
  { label: string; type: TagType; dot: string }
> = {
  queued: { label: '排队中', type: 'info', dot: 'bg-slate-400' },
  running: { label: '构建中', type: 'primary', dot: 'bg-blue-500' },
  canceling: { label: '停止中', type: 'warning', dot: 'bg-amber-500' },
  succeeded: { label: '成功', type: 'success', dot: 'bg-emerald-500' },
  failed: { label: '失败', type: 'danger', dot: 'bg-red-500' },
  canceled: { label: '已停止', type: 'info', dot: 'bg-slate-400' },
};

/** 设计文档第 7 节：四种测试状态及固定颜色 */
export const testStatusMeta: Record<
  TestStatus,
  { label: string; type: TagType; dot: string }
> = {
  passed: { label: '已测试', type: 'success', dot: 'bg-emerald-500' },
  pending: { label: '待测试', type: 'warning', dot: 'bg-amber-400' },
  testing: { label: '测试中', type: 'primary', dot: 'bg-blue-500' },
  rejected: { label: '测试不通过', type: 'danger', dot: 'bg-red-500' },
};

export const testStatusOrder: TestStatus[] = [
  'passed',
  'pending',
  'testing',
  'rejected',
];
