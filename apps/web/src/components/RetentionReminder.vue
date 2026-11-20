<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { ApiError, request } from '../api/client';
import { refreshData } from '../api/store';
import ConfirmDialog from './ConfirmDialog.vue';

type Plan = {
  projectId: number;
  limit: number;
  name: string;
  kept: number[];
  token: string;
  candidates: { jobId: number; number: number; reason: string }[];
};
const props = defineProps<{ userId: number }>();
const interval = 15 * 60_000;
const plan = ref<Plan>();
let busy = false,
  active = true,
  timer: number;
const dismissed = new Map<number, number>();
const key = (p: Plan) => `builder:retention:${props.userId}:${p.projectId}`;
function lastShown(p: Plan) {
  try {
    return (
      Number(sessionStorage.getItem(key(p))) || dismissed.get(p.projectId) || 0
    );
  } catch {
    return dismissed.get(p.projectId) || 0;
  }
}
async function check() {
  if (
    !active ||
    busy ||
    plan.value ||
    document.hidden ||
    document
      .querySelector('[aria-modal="true"]:not([aria-hidden="true"])')
      ?.getClientRects().length
  )
    return;
  busy = true;
  try {
    const plans = await request<Plan[]>('/maintenance/retention');
    if (active && !document.hidden)
      plan.value = plans
        .filter((p) => Date.now() - lastShown(p) >= interval)
        .sort((a, b) => lastShown(a) - lastShown(b))[0];
  } catch {
    // A reminder has no side effects; the next scheduled check can retry.
  } finally {
    busy = false;
  }
}
async function decide(ok: boolean) {
  const selected = plan.value;
  if (!active || !selected || busy) return;
  plan.value = undefined;
  if (!ok) {
    const time = Date.now();
    dismissed.set(selected.projectId, time);
    try {
      sessionStorage.setItem(key(selected), String(time));
    } catch {
      /* optional */
    }
    return;
  }
  busy = true;
  let stale = false;
  try {
    const result = await request<{ removed: number; unfinished: number[] }>(
      `/projects/${selected.projectId}/retention-cleanup`,
      { method: 'POST', body: { token: selected.token } },
    );
    if (active) {
      if (result.unfinished.length)
        ElMessage.warning(
          `已清理 ${result.removed} 项，另有 ${result.unfinished.length} 项未完成。请在构建队列重试删除。`,
        );
      else
        ElMessage.success(
          `已清理「${selected.name}」的 ${result.removed} 项旧构建。`,
        );
    }
  } catch (error) {
    stale = error instanceof ApiError && error.status === 409;
    if (active)
      ElMessage.error(
        error instanceof Error ? error.message : '清理未完成，请重新核对。',
      );
  } finally {
    busy = false;
    if (active) {
      await refreshData().catch(() =>
        ElMessage.warning('请刷新页面核对清理结果。'),
      );
      if (stale) void check();
    }
  }
}
onMounted(() => {
  void check();
  timer = window.setInterval(check, interval);
  document.addEventListener('visibilitychange', check);
});
onBeforeUnmount(() => {
  active = false;
  clearInterval(timer);
  document.removeEventListener('visibilitychange', check);
});
</script>

<template>
  <ConfirmDialog
    v-if="plan"
    :key="plan.token"
    title="旧版本清理方案"
    :target="`「${plan.name}」有 ${plan.candidates.length} 项旧构建可清理`"
    :description="`最多保留最近 ${plan.limit} 个有效版本，本次保留：${plan.kept.map((n) => '#' + n).join('、')}。有效指构建成功、产物可用且未被标记为测试不通过。`"
    :scope="plan.candidates.map((c) => '#' + c.number + '：' + c.reason)"
    note="确认后将删除所列构建的记录、任务专属文件、日志和产物（保留项目共享缓存），相关下载链接立即失效。取消后稍后再提醒。"
    confirm-text="确认清理"
    tone="danger"
    :on-result="decide"
  />
</template>
