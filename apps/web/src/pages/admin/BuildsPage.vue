<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Document, VideoPause, Delete, Setting } from '@element-plus/icons-vue';
import type { Job, JobStatus } from '../../api/types';
import { OCCUPYING, db, now } from '../../api/store';
import { canManage, isAdmin } from '../../auth';
import {
  formatDateTime,
  formatDuration,
  relativeTime,
  shortSha,
} from '../../utils/format';
import { confirmDeleteJob, confirmStop } from '../../utils/jobActions';
import PageHeader from '../../components/PageHeader.vue';
import ProjectAvatar from '../../components/ProjectAvatar.vue';
import StatusTag from '../../components/StatusTag.vue';
import JobDrawer from '../../components/JobDrawer.vue';

const route = useRoute();
const router = useRouter();

type Filter = 'active' | 'all' | 'succeeded' | 'failed' | 'canceled';
const filter = ref<Filter>('all');
const projectId = ref<number | ''>(Number(route.query.project) || '');
watch(projectId, (id) => router.replace({ query: id ? { project: id } : {} }));

const filterGroups: Record<Filter, JobStatus[] | null> = {
  all: null,
  active: ['queued', 'running', 'canceling'],
  succeeded: ['succeeded'],
  failed: ['failed'],
  canceled: ['canceled'],
};

const scoped = computed(() =>
  db.jobs.filter(
    (job) => !projectId.value || job.projectId === projectId.value,
  ),
);
const count = (statuses: JobStatus[] | null) =>
  statuses
    ? scoped.value.filter((job) => statuses.includes(job.status)).length
    : scoped.value.length;
const filterOptions = computed(() => [
  { value: 'all', label: `全部 ${count(null)}` },
  { value: 'active', label: `进行中 ${count(filterGroups.active)}` },
  { value: 'succeeded', label: `成功 ${count(filterGroups.succeeded)}` },
  { value: 'failed', label: `失败 ${count(filterGroups.failed)}` },
  { value: 'canceled', label: `已停止 ${count(filterGroups.canceled)}` },
]);

/** 进行中的任务排在最前（执行中 → 排队按序号），其余按入队序号倒序 */
const rank = (job: Job) =>
  OCCUPYING.includes(job.status) ? 0 : job.status === 'queued' ? 1 : 2;
const rows = computed(() => {
  const statuses = filterGroups[filter.value];
  return scoped.value
    .filter((job) => !statuses || statuses.includes(job.status))
    .sort((a, b) => {
      const r = rank(a) - rank(b);
      if (r) return r;
      return rank(a) === 1 ? a.seq - b.seq : b.seq - a.seq;
    });
});

const occupied = computed(
  () => db.jobs.filter((job) => OCCUPYING.includes(job.status)).length,
);
/** 每个槽位对应的执行中任务；调低上限后可能暂时超出 */
const slotJobs = computed(() => {
  const busy = db.jobs.filter((job) => OCCUPYING.includes(job.status));
  const size = Math.max(db.settings.maxConcurrent, busy.length);
  return Array.from({ length: size }, (_, i) => busy[i] ?? null);
});
const queuedJobs = computed(() =>
  db.jobs
    .filter((job) => job.status === 'queued')
    .sort((a, b) => a.seq - b.seq),
);
const dayAgo = computed(() => now.value - 24 * 3600_000);
const recent = computed(() =>
  db.jobs.filter((job) => job.finishedAt && job.finishedAt > dayAgo.value),
);
const successRate = computed(() => {
  const finished = recent.value.filter((j) => j.status !== 'canceled');
  if (!finished.length) return '—';
  const ok = finished.filter((j) => j.status === 'succeeded').length;
  return `${Math.round((ok / finished.length) * 100)}%`;
});

const projectOf = (job: Job) =>
  db.projects.find((p) => p.id === job.projectId)!;
const progress = (job: Job) => job.progress ?? 0;
const queuePos = (job: Job) => queuedJobs.value.indexOf(job) + 1;
const elapsed = (job: Job) =>
  job.startedAt
    ? formatDuration((job.finishedAt ?? now.value) - job.startedAt)
    : '—';

const drawerOpen = ref(false);
const activeJobId = ref<number | null>(null);
function openJob(job: Job) {
  activeJobId.value = job.id;
  drawerOpen.value = true;
}
</script>

<template>
  <PageHeader
    title="构建队列"
    description="任务按入队顺序领取执行槽位；点击任意行查看实时日志。"
  >
    <el-button
      v-if="isAdmin"
      :icon="Setting"
      @click="router.push('/admin/settings')"
      >并行设置</el-button
    >
  </PageHeader>

  <!-- 概览 -->
  <section class="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    <div class="rounded-xl border border-slate-200 bg-white p-4 lg:col-span-2">
      <div class="flex items-center justify-between">
        <span class="text-sm text-slate-500">执行槽位</span>
        <span class="text-xs text-slate-400"
          >上限 {{ db.settings.maxConcurrent }}</span
        >
      </div>
      <div class="mt-3 flex gap-2">
        <template
          v-for="(j, index) in slotJobs"
          :key="j?.id ?? `idle-${index}`"
        >
          <button
            v-if="j"
            type="button"
            class="h-14 min-w-0 flex-1 rounded-lg border border-brand-200 bg-brand-50 p-2 text-left text-xs transition hover:bg-brand-100"
            @click="openJob(j)"
          >
            <span class="block truncate font-medium text-slate-800"
              >{{ projectOf(j).name }} #{{ j.number }}</span
            >
            <span
              class="mt-1.5 block h-1 overflow-hidden rounded-full bg-brand-100"
            >
              <span
                class="block h-full rounded-full bg-brand-500 transition-all duration-700"
                :style="{ width: `${progress(j)}%` }"
              />
            </span>
          </button>
          <span
            v-else
            class="grid h-14 flex-1 place-items-center rounded-lg border border-dashed border-slate-200 text-xs text-slate-400"
            >空闲</span
          >
        </template>
      </div>
    </div>
    <div class="rounded-xl border border-slate-200 bg-white p-4">
      <span class="text-sm text-slate-500">排队等待</span>
      <p class="mt-2 text-3xl font-semibold tabular-nums text-slate-900">
        {{ queuedJobs.length }}
      </p>
      <p class="mt-1 truncate text-xs text-slate-500">
        <template v-if="queuedJobs[0]"
          >下一个：{{ projectOf(queuedJobs[0]).name }} #{{
            queuedJobs[0].number
          }}</template
        >
        <template v-else>队列为空</template>
      </p>
    </div>
    <div class="rounded-xl border border-slate-200 bg-white p-4">
      <span class="text-sm text-slate-500">近 24 小时成功率</span>
      <p class="mt-2 text-3xl font-semibold tabular-nums text-slate-900">
        {{ successRate }}
      </p>
      <p class="mt-1 text-xs text-slate-500">
        共结束 {{ recent.length }} 个任务
      </p>
    </div>
  </section>

  <!-- 列表 -->
  <section class="overflow-hidden rounded-xl border border-slate-200 bg-white">
    <div
      class="flex flex-col gap-3 border-b border-slate-200 p-4 lg:flex-row lg:items-center lg:justify-between"
    >
      <el-segmented v-model="filter" :options="filterOptions" />
      <el-select
        v-model="projectId"
        placeholder="全部项目"
        clearable
        class="!w-48"
        :empty-values="['', null, undefined]"
        :value-on-clear="''"
      >
        <el-option label="全部项目" value="" />
        <el-option
          v-for="p in db.projects"
          :key="p.id"
          :label="p.name"
          :value="p.id"
        />
      </el-select>
    </div>

    <el-table
      :data="rows"
      row-key="id"
      class="cursor-pointer"
      empty-text="没有符合条件的任务"
      @row-click="openJob"
    >
      <el-table-column label="序号" width="90">
        <template #default="{ row }">
          <span class="font-mono text-xs text-slate-500">{{ row.seq }}</span>
        </template>
      </el-table-column>
      <el-table-column label="项目 / 构建" min-width="200">
        <template #default="{ row }">
          <div class="flex items-center gap-2.5">
            <ProjectAvatar :project="projectOf(row)" size="sm" />
            <div class="min-w-0 leading-tight">
              <p class="truncate font-medium text-slate-900">
                {{ projectOf(row).name }}
                <span class="font-normal text-slate-400"
                  >#{{ row.number }}</span
                >
              </p>
              <p class="truncate text-xs text-slate-500">{{ row.message }}</p>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="分支 / 提交" min-width="170">
        <template #default="{ row }">
          <span class="font-mono text-xs text-slate-600"
            >{{ row.branch }}<span class="text-slate-400">@</span
            >{{ shortSha(row.sha) }}</span
          >
        </template>
      </el-table-column>
      <el-table-column label="状态" min-width="170">
        <template #default="{ row }">
          <div class="flex items-center gap-2">
            <StatusTag kind="job" :status="row.status" size="small" />
            <span v-if="row.status === 'queued'" class="text-xs text-slate-500"
              >第 {{ queuePos(row) }} 位</span
            >
            <el-progress
              v-if="row.status === 'running'"
              :percentage="progress(row)"
              :show-text="false"
              :stroke-width="4"
              class="w-16"
            />
          </div>
        </template>
      </el-table-column>
      <el-table-column label="发起人" width="100" prop="triggeredBy" />
      <el-table-column label="入队" width="110">
        <template #default="{ row }">
          <span
            class="text-xs text-slate-600"
            :title="formatDateTime(row.createdAt)"
            >{{ relativeTime(row.createdAt, now) }}</span
          >
        </template>
      </el-table-column>
      <el-table-column label="耗时" width="100">
        <template #default="{ row }">
          <span class="text-xs tabular-nums text-slate-600">{{
            elapsed(row)
          }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="120" align="right" fixed="right">
        <template #default="{ row }">
          <div class="flex justify-end" @click.stop>
            <el-tooltip content="查看日志">
              <el-button
                text
                circle
                :icon="Document"
                aria-label="查看日志"
                @click="openJob(row)"
              />
            </el-tooltip>
            <el-tooltip
              v-if="
                row.status === 'running' && canManage(row.triggeredBy, row.id)
              "
              content="停止构建"
            >
              <el-button
                text
                circle
                type="danger"
                :icon="VideoPause"
                aria-label="停止构建"
                @click="confirmStop(row)"
              />
            </el-tooltip>
            <el-tooltip
              v-if="
                !OCCUPYING.includes(row.status) &&
                canManage(row.triggeredBy, row.id)
              "
              content="删除任务"
            >
              <el-button
                text
                circle
                :icon="Delete"
                aria-label="删除任务"
                @click="confirmDeleteJob(row)"
              />
            </el-tooltip>
          </div>
        </template>
      </el-table-column>
    </el-table>
  </section>

  <JobDrawer v-model="drawerOpen" :job-id="activeJobId" />
</template>
