<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh, Warning } from '@element-plus/icons-vue';
import type { Job, Project } from '../api/types';
import {
  OCCUPYING,
  db,
  enqueueBuild,
  fetchCode,
  now,
  scriptCommands,
} from '../api/store';
import { currentUser } from '../auth';
import { relativeTime, shortSha } from '../utils/format';
import ProjectAvatar from './ProjectAvatar.vue';

const props = defineProps<{ project: Project | null }>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ created: [job: Job] }>();

const branch = ref('');
const fetching = ref(false);
const pending = ref(false);

watch(open, (visible) => {
  if (visible && props.project) branch.value = props.project.defaultBranch;
});

/** 只有当前分支已拉取过的提交才能入队，保证 commit 固定 */
const fetched = computed(() =>
  props.project && props.project.fetched.branch === branch.value
    ? props.project.fetched
    : null,
);
const occupied = computed(
  () => db.jobs.filter((job) => OCCUPYING.includes(job.status)).length,
);
const queued = computed(
  () => db.jobs.filter((job) => job.status === 'queued').length,
);
const willWait = computed(() => occupied.value >= db.settings.maxConcurrent);

async function refresh() {
  if (!props.project) return;
  fetching.value = true;
  try {
    await fetchCode(props.project.id, branch.value);
    ElMessage.success('已获取最新代码');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '拉取失败');
  } finally {
    fetching.value = false;
  }
}

async function submit() {
  if (!props.project || !fetched.value || pending.value) return;
  pending.value = true;
  try {
    const job = await enqueueBuild(
      props.project.id,
      branch.value,
      fetched.value.sha,
      fetched.value.message,
      currentUser.value?.username ?? 'unknown',
    );
    open.value = false;
    emit('created', job);
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <el-dialog
    v-model="open"
    title="发起构建"
    width="min(520px, calc(100vw - 32px))"
    destroy-on-close
  >
    <div v-if="project" class="space-y-5">
      <div class="flex items-center gap-3 rounded-lg bg-slate-50 p-3">
        <ProjectAvatar :project="project" />
        <div class="min-w-0">
          <p class="font-medium text-slate-900">{{ project.name }}</p>
          <p class="truncate font-mono text-xs text-slate-500">
            {{ project.repository }}
          </p>
        </div>
      </div>

      <div>
        <label class="mb-1.5 block text-sm text-slate-700" for="build-branch"
          >构建分支</label
        >
        <div class="flex gap-2">
          <el-select
            id="build-branch"
            v-model="branch"
            filterable
            allow-create
            default-first-option
            class="flex-1"
          >
            <el-option
              v-for="item in project.branches"
              :key="item"
              :label="item"
              :value="item"
            />
          </el-select>
          <el-button :icon="Refresh" :loading="fetching" @click="refresh"
            >拉取代码</el-button
          >
        </div>
      </div>

      <div
        v-if="fetched"
        class="rounded-lg border border-slate-200 p-3 text-sm"
      >
        <div class="flex items-center justify-between text-xs text-slate-500">
          <span>将构建的提交</span>
          <span>拉取于 {{ relativeTime(fetched.at, now) }}</span>
        </div>
        <div class="mt-1.5 flex items-center gap-2">
          <code
            class="rounded bg-brand-50 px-1.5 py-0.5 font-mono text-xs text-brand-700"
            >{{ shortSha(fetched.sha) }}</code
          >
          <span class="truncate text-slate-700">{{ fetched.message }}</span>
        </div>
      </div>
      <el-alert
        v-else
        type="warning"
        :closable="false"
        show-icon
        :icon="Warning"
        title="该分支尚未拉取，请先点击「拉取代码」以固定要构建的提交"
      />

      <dl class="grid grid-cols-3 gap-3 text-xs">
        <div>
          <dt class="text-slate-500">工作目录</dt>
          <dd class="mt-0.5 truncate font-mono text-slate-800">
            {{ project.workdir }}
          </dd>
        </div>
        <div>
          <dt class="text-slate-500">构建脚本</dt>
          <dd class="mt-0.5 text-slate-800">
            {{ scriptCommands(project.buildScript).length }} 条命令
          </dd>
        </div>
        <div>
          <dt class="text-slate-500">超时</dt>
          <dd class="mt-0.5 text-slate-800">{{ project.timeout }} 分钟</dd>
        </div>
      </dl>

      <p
        class="rounded-md px-3 py-2 text-xs"
        :class="
          willWait
            ? 'bg-amber-50 text-amber-800'
            : 'bg-emerald-50 text-emerald-800'
        "
      >
        <template v-if="willWait"
          >执行槽位已满（{{ occupied }}/{{
            db.settings.maxConcurrent
          }}），将排在 {{ queued }} 个任务之后</template
        >
        <template v-else
          >当前有空闲槽位（{{ occupied }}/{{
            db.settings.maxConcurrent
          }}），入队后立即开始</template
        >
      </p>
    </div>
    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button
        type="primary"
        :disabled="!fetched"
        :loading="pending"
        @click="submit"
        >加入构建队列</el-button
      >
    </template>
  </el-dialog>
</template>
