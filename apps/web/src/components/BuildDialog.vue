<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Refresh } from '@element-plus/icons-vue';
import type { GitRefType, Job, Project } from '../api/types';
import {
  OCCUPYING,
  db,
  enqueueBuild,
  testFetch,
  scriptCommands,
  isSshRepository,
} from '../api/store';
import { currentUser, isAdmin } from '../auth';
import NoticeBar from './NoticeBar.vue';
import ProjectAvatar from './ProjectAvatar.vue';

const props = defineProps<{ project: Project | null }>();
const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{
  created: [job: Job];
  configure: [project: Project];
}>();

const branch = ref('');
const refType = ref<GitRefType>('branch');
const fetching = ref(false);
const pending = ref(false);
const useCache = ref(true);
const tested = ref<{ selection: string; error?: string } | null>(null);
const refs = ref<{
  project: string;
  branches: string[];
  tags: string[];
} | null>(null);
const repositoryKey = computed(() =>
  props.project
    ? JSON.stringify([
        props.project.id,
        props.project.repository,
        props.project.sshKeyId,
      ])
    : '',
);
const selection = computed(() =>
  JSON.stringify([repositoryKey.value, refType.value, branch.value]),
);
const result = computed(() =>
  tested.value?.selection === selection.value ? tested.value : null,
);
const refOptions = computed(() => {
  const available =
    refs.value?.project === repositoryKey.value ? refs.value : null;
  return refType.value === 'tag'
    ? (available?.tags ?? [])
    : (available?.branches ?? props.project?.branches ?? []);
});

const branchPreferenceKey = computed(() =>
  props.project && currentUser.value
    ? `builder:build-branch:${currentUser.value.id}:${props.project.slug}`
    : '',
);
const cachePreferenceKey = computed(() =>
  props.project && currentUser.value
    ? `builder:build-cache:${currentUser.value.id}:${props.project.slug}`
    : '',
);

watch(open, (visible) => {
  if (!visible || !props.project) return;
  tested.value = null;
  useCache.value = true;
  let previous: string | null = null;
  try {
    if (branchPreferenceKey.value)
      previous = localStorage.getItem(branchPreferenceKey.value);
    if (cachePreferenceKey.value)
      useCache.value =
        localStorage.getItem(cachePreferenceKey.value) !== 'false';
  } catch {
    // Storage can be unavailable; use the dialog defaults.
  }
  refType.value = previous?.startsWith('refs/tags/') ? 'tag' : 'branch';
  branch.value =
    previous?.replace(/^refs\/(?:heads|tags)\//, '') ||
    (refType.value === 'branch' ? props.project.fetched.branch : '');
});

function rememberRef(value: string) {
  if (!value || !branchPreferenceKey.value) return;
  try {
    localStorage.setItem(
      branchPreferenceKey.value,
      `refs/${refType.value === 'tag' ? 'tags' : 'heads'}/${value}`,
    );
  } catch {
    // Storage is optional and must not interrupt the build flow.
  }
}

function rememberCache() {
  if (!cachePreferenceKey.value) return;
  try {
    localStorage.setItem(cachePreferenceKey.value, String(useCache.value));
  } catch {
    // Storage is optional and must not interrupt the build flow.
  }
}

function changeRefType() {
  tested.value = null;
  branch.value =
    refType.value === 'branch' ? (props.project?.fetched.branch ?? '') : '';
  rememberRef(branch.value);
}

/** 缺少密钥时提示，不阻止点击拉取。 */
const missingKey = computed(
  () =>
    props.project &&
    isSshRepository(props.project.repository) &&
    props.project.sshKeyId == null,
);

function configure() {
  if (!props.project) return;
  open.value = false;
  emit('configure', props.project);
}

const occupied = computed(
  () => db.jobs.filter((job) => OCCUPYING.includes(job.status)).length,
);
const queued = computed(
  () => db.jobs.filter((job) => job.status === 'queued').length,
);
const projectBusy = computed(() =>
  db.jobs.some(
    (j) =>
      j.projectId === props.project?.id &&
      (OCCUPYING.includes(j.status) || j.status === 'queued'),
  ),
);
const willWait = computed(
  () => projectBusy.value || occupied.value >= db.settings.maxConcurrent,
);

async function refresh() {
  if (!props.project || !branch.value || fetching.value) return;
  const requested = selection.value;
  const project = repositoryKey.value;
  tested.value = null;
  fetching.value = true;
  try {
    const available = await testFetch(
      props.project.id,
      branch.value,
      refType.value,
    );
    if (open.value && repositoryKey.value === project)
      refs.value = { project, ...available };
    if (open.value && selection.value === requested) {
      tested.value = { selection: requested };
      ElMessage.success('测试拉取成功');
    }
  } catch (error) {
    if (open.value && selection.value === requested) {
      const message = error instanceof Error ? error.message : '测试拉取失败';
      tested.value = { selection: requested, error: message };
      ElMessage.error(message);
    }
  } finally {
    fetching.value = false;
  }
}

async function submit() {
  if (!props.project || !branch.value || pending.value) return;
  pending.value = true;
  try {
    const job = await enqueueBuild(
      props.project.id,
      branch.value,
      refType.value,
      useCache.value,
    );
    open.value = false;
    emit('created', job);
  } catch (error) {
    ElMessage.error(
      error instanceof Error ? error.message : '加入构建队列失败',
    );
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

      <NoticeBar v-if="missingKey" tone="warning">
        该仓库使用 SSH 地址但未绑定拉取密钥，拉取会失败。
        <button
          v-if="isAdmin"
          type="button"
          class="font-medium whitespace-nowrap underline"
          @click="configure"
        >
          去配置
        </button>
        <template v-else>请联系管理员配置。</template>
      </NoticeBar>

      <div>
        <label class="mb-1.5 block text-sm text-slate-700" for="build-branch"
          >构建分支或标签</label
        >
        <div class="flex gap-2">
          <el-select
            v-model="refType"
            aria-label="引用类型"
            class="!w-24 shrink-0"
            @change="changeRefType"
          >
            <el-option label="分支" value="branch" />
            <el-option label="标签" value="tag" />
          </el-select>
          <el-select
            id="build-branch"
            v-model="branch"
            filterable
            allow-create
            default-first-option
            class="min-w-0 flex-1"
            :placeholder="
              refType === 'tag' ? '选择或输入标签' : '选择或输入分支'
            "
            @change="rememberRef"
          >
            <el-option
              v-for="item in refOptions"
              :key="item"
              :label="item"
              :value="item"
            />
          </el-select>
          <el-button
            :icon="Refresh"
            :loading="fetching"
            :disabled="!branch"
            @click="refresh"
            >测试拉取</el-button
          >
        </div>
      </div>

      <NoticeBar v-if="result" :tone="result.error ? 'warning' : 'success'">
        {{ result.error || '测试拉取成功。' }}
      </NoticeBar>
      <el-checkbox v-model="useCache" @change="rememberCache"
        >使用构建缓存</el-checkbox
      >
      <p class="text-sm text-slate-500">
        {{
          useCache
            ? '每次从远端更新所选分支或标签，缓存命中时保留已安装的依赖。'
            : '从远端更新所选分支或标签，清理 Git 忽略的文件和依赖缓存后构建。'
        }}
      </p>

      <dl class="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
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
        <div>
          <dt class="text-slate-500">拉取凭据</dt>
          <dd
            class="mt-0.5 truncate text-slate-800"
            :title="project.sshKeyName ?? '匿名'"
          >
            {{ project.sshKeyName ?? '匿名' }}
          </dd>
        </div>
      </dl>

      <NoticeBar :tone="willWait ? 'warning' : 'success'">
        <template v-if="projectBusy"
          >同一项目一次只执行一个构建，此任务将排队。</template
        >
        <template v-else-if="willWait"
          >执行槽位已满（{{ occupied }}/{{
            db.settings.maxConcurrent
          }}），将排在 {{ queued }} 个任务之后</template
        >
        <template v-else
          >当前有空闲槽位（{{ occupied }}/{{
            db.settings.maxConcurrent
          }}），入队后立即开始</template
        >
      </NoticeBar>
    </div>
    <template #footer>
      <el-button @click="open = false">取消</el-button>
      <el-button
        type="primary"
        :disabled="!branch"
        :loading="pending"
        @click="submit"
        >加入构建队列</el-button
      >
    </template>
  </el-dialog>
</template>
