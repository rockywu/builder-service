<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  CircleCheckFilled,
  CircleCloseFilled,
  Loading,
  VideoPause,
  Delete,
  Box,
} from '@element-plus/icons-vue';
import { OCCUPYING, db, now } from '../mocks/db';
import { canManage } from '../auth';
import {
  formatDateTime,
  formatDuration,
  relativeTime,
  shortSha,
} from '../utils/format';
import { confirmDeleteJob, confirmStop } from '../utils/jobActions';
import ProjectAvatar from './ProjectAvatar.vue';
import StatusTag from './StatusTag.vue';

const props = defineProps<{ jobId: number | null }>();
const open = defineModel<boolean>({ required: true });
const router = useRouter();

const job = computed(() => db.jobs.find((item) => item.id === props.jobId));
const project = computed(() =>
  db.projects.find((item) => item.id === job.value?.projectId),
);
const release = computed(() =>
  db.releases.find((item) => item.jobId === job.value?.id),
);
const lines = computed(
  () => job.value?.script.slice(0, job.value.visibleLines) ?? [],
);
const currentStep = computed(() => lines.value.at(-1)?.step ?? -1);
const queuePosition = computed(() => {
  if (job.value?.status !== 'queued') return 0;
  return (
    db.jobs.filter((j) => j.status === 'queued' && j.seq < job.value!.seq)
      .length + 1
  );
});
const duration = computed(() => {
  const j = job.value;
  if (!j?.startedAt) return '—';
  return formatDuration((j.finishedAt ?? now.value) - j.startedAt);
});

type StepState = 'done' | 'active' | 'failed' | 'pending';
function stepState(index: number): StepState {
  const j = job.value;
  if (!j || j.status === 'queued') return 'pending';
  if (index < currentStep.value) return 'done';
  if (index > currentStep.value) return 'pending';
  if (j.status === 'succeeded') return 'done';
  if (j.status === 'failed' || j.status === 'canceled') return 'failed';
  return 'active';
}

// 运行中自动滚动到日志底部；用户上滑后暂停跟随
const logBox = ref<HTMLElement>();
const follow = ref(true);
function onScroll() {
  const el = logBox.value;
  if (el) follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}
watch(
  () => [lines.value.length, open.value],
  async () => {
    if (!follow.value) return;
    await nextTick();
    logBox.value?.scrollTo({ top: logBox.value.scrollHeight });
  },
);
watch(open, (v) => v && (follow.value = true));

async function remove() {
  if (job.value && (await confirmDeleteJob(job.value))) open.value = false;
}
function viewRelease() {
  open.value = false;
  void router.push({
    path: '/admin/releases',
    query: { project: job.value?.projectId },
  });
}
</script>

<template>
  <el-drawer v-model="open" size="min(760px, 100vw)" :with-header="false">
    <div v-if="job && project" class="flex h-full flex-col">
      <!-- 头部 -->
      <header class="border-b border-slate-200 pb-4">
        <div class="flex items-start gap-3">
          <ProjectAvatar :project="project" />
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-lg font-semibold text-slate-900">
                {{ project.name }}
                <span class="font-normal text-slate-400"
                  >#{{ job.number }}</span
                >
              </h2>
              <StatusTag kind="job" :status="job.status" />
              <span v-if="queuePosition" class="text-xs text-slate-500"
                >队列第 {{ queuePosition }} 位</span
              >
            </div>
            <p class="mt-0.5 truncate text-sm text-slate-500">
              {{ job.message }}
            </p>
          </div>
          <el-button text circle aria-label="关闭" @click="open = false"
            >✕</el-button
          >
        </div>
        <dl
          class="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4"
        >
          <div>
            <dt class="text-xs text-slate-500">分支 / 提交</dt>
            <dd class="mt-0.5 truncate font-mono text-slate-800">
              {{ job.branch }}@{{ shortSha(job.sha) }}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-slate-500">发起人</dt>
            <dd class="mt-0.5 text-slate-800">{{ job.triggeredBy }}</dd>
          </div>
          <div>
            <dt class="text-xs text-slate-500">入队时间</dt>
            <dd
              class="mt-0.5 text-slate-800"
              :title="formatDateTime(job.createdAt)"
            >
              {{ relativeTime(job.createdAt, now) }}
            </dd>
          </div>
          <div>
            <dt class="text-xs text-slate-500">耗时</dt>
            <dd class="mt-0.5 tabular-nums text-slate-800">{{ duration }}</dd>
          </div>
        </dl>
      </header>

      <!-- 步骤 -->
      <ol class="flex gap-1 overflow-x-auto py-4" aria-label="构建步骤">
        <li
          v-for="(step, index) in job.steps"
          :key="index"
          class="flex min-w-28 flex-1 flex-col gap-1.5"
        >
          <span
            class="h-1 rounded-full"
            :class="{
              'bg-emerald-500': stepState(index) === 'done',
              'animate-pulse bg-brand-500': stepState(index) === 'active',
              'bg-red-500': stepState(index) === 'failed',
              'bg-slate-200': stepState(index) === 'pending',
            }"
          />
          <span class="flex items-center gap-1 text-xs">
            <el-icon v-if="stepState(index) === 'done'" class="text-emerald-500"
              ><CircleCheckFilled
            /></el-icon>
            <el-icon
              v-else-if="stepState(index) === 'failed'"
              class="text-red-500"
              ><CircleCloseFilled
            /></el-icon>
            <el-icon
              v-else-if="stepState(index) === 'active'"
              class="is-loading text-brand-600"
              ><Loading
            /></el-icon>
            <span
              class="truncate font-mono"
              :class="
                stepState(index) === 'pending'
                  ? 'text-slate-400'
                  : 'text-slate-700'
              "
              :title="step"
              >{{ step }}</span
            >
          </span>
        </li>
      </ol>

      <!-- 日志 -->
      <div class="relative min-h-0 flex-1">
        <div
          ref="logBox"
          class="h-full overflow-auto rounded-lg bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-300"
          role="log"
          aria-live="polite"
          @scroll="onScroll"
        >
          <p v-if="job.status === 'queued'" class="text-slate-500">
            等待执行槽位…（当前并行上限 {{ db.settings.maxConcurrent }}）
          </p>
          <p
            v-for="(line, index) in lines"
            :key="index"
            class="whitespace-pre-wrap break-all"
            :class="{
              'mt-2 text-sky-300': line.kind === 'cmd',
              'text-red-400': line.kind === 'error',
              'font-semibold text-emerald-400': line.kind === 'ok',
            }"
          >
            {{ line.text }}
          </p>
          <p
            v-if="OCCUPYING.includes(job.status)"
            class="mt-1 animate-pulse text-slate-500"
          >
            ▍
          </p>
        </div>
        <button
          v-if="!follow && OCCUPYING.includes(job.status)"
          type="button"
          class="absolute right-4 bottom-4 rounded-full bg-brand-600 px-3 py-1 text-xs text-white shadow-lg"
          @click="
            follow = true;
            logBox?.scrollTo({ top: logBox.scrollHeight });
          "
        >
          跟随最新日志 ↓
        </button>
      </div>

      <!-- 操作 -->
      <footer class="flex flex-wrap items-center justify-between gap-2 pt-4">
        <p v-if="job.error" class="text-sm text-red-600">{{ job.error }}</p>
        <span v-else />
        <div class="flex gap-2">
          <el-button v-if="release" :icon="Box" @click="viewRelease"
            >查看版本 {{ release.version }}</el-button
          >
          <el-button
            v-if="job.status === 'running' && canManage(job.triggeredBy)"
            type="danger"
            plain
            :icon="VideoPause"
            @click="confirmStop(job)"
            >停止构建</el-button
          >
          <el-button
            v-if="!OCCUPYING.includes(job.status) && canManage(job.triggeredBy)"
            type="danger"
            text
            :icon="Delete"
            @click="remove"
            >删除任务</el-button
          >
        </div>
      </footer>
    </div>
    <el-empty v-else description="任务不存在或已被删除" />
  </el-drawer>
</template>
