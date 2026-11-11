<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { ArrowDown, Delete, Link, Search } from '@element-plus/icons-vue';
import type { Release, TestStatus } from '../../mocks/types';
import { db, now, setTestStatus } from '../../mocks/db';
import { canManage, currentUser } from '../../auth';
import {
  formatDateTime,
  formatSize,
  relativeTime,
  shortSha,
} from '../../utils/format';
import { testStatusMeta, testStatusOrder } from '../../utils/status';
import { confirmDeleteRelease } from '../../utils/jobActions';
import PageHeader from '../../components/PageHeader.vue';
import ProjectAvatar from '../../components/ProjectAvatar.vue';
import StatusTag from '../../components/StatusTag.vue';

const route = useRoute();
const router = useRouter();
const projectId = ref<number | ''>(Number(route.query.project) || '');
const status = ref<TestStatus | 'all'>('all');
const search = ref('');
watch(projectId, (id) => router.replace({ query: id ? { project: id } : {} }));

const scoped = computed(() =>
  db.releases.filter(
    (r) =>
      (!projectId.value || r.projectId === projectId.value) &&
      (!search.value || r.version.includes(search.value.trim())),
  ),
);
const statusOptions = computed(() => [
  { value: 'all', label: `全部 ${scoped.value.length}` },
  ...testStatusOrder.map((s) => ({
    value: s,
    label: `${testStatusMeta[s].label} ${scoped.value.filter((r) => r.testStatus === s).length}`,
  })),
]);
const rows = computed(() =>
  scoped.value
    .filter((r) => status.value === 'all' || r.testStatus === status.value)
    .sort((a, b) => b.createdAt - a.createdAt || b.jobId - a.jobId),
);

/** 各项目最新的成功构建版本 */
const latestIds = computed(() => {
  const ids = new Set<number>();
  for (const p of db.projects) {
    const latest = db.releases
      .filter((r) => r.projectId === p.id)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (latest) ids.add(latest.id);
  }
  return ids;
});

const projectOf = (r: Release) =>
  db.projects.find((p) => p.id === r.projectId)!;
const totalSize = (r: Release) =>
  formatSize(r.artifacts.reduce((sum, a) => sum + a.size, 0));

const saving = ref<number | null>(null);
async function changeStatus(release: Release, next: TestStatus) {
  if (next === release.testStatus) return;
  saving.value = release.id;
  try {
    await setTestStatus(
      release.id,
      next,
      release.revision,
      currentUser.value?.username ?? 'unknown',
    );
    ElMessage.success(
      `${release.version} 已标记为「${testStatusMeta[next].label}」`,
    );
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    saving.value = null;
  }
}
function demoDownload(name: string) {
  ElMessage.info(`演示环境：${name} 不提供实际文件`);
}
</script>

<template>
  <PageHeader
    title="版本"
    description="构建成功后自动公开，默认「待测试」。在此标记测试结果，公开下载页同步展示。"
  >
    <el-input
      v-model="search"
      :prefix-icon="Search"
      clearable
      placeholder="搜索版本号"
      class="!w-52"
      aria-label="搜索版本号"
    />
    <el-select
      v-model="projectId"
      placeholder="全部项目"
      class="!w-44"
      :empty-values="['', null, undefined]"
    >
      <el-option label="全部项目" value="" />
      <el-option
        v-for="p in db.projects"
        :key="p.id"
        :label="p.name"
        :value="p.id"
      />
    </el-select>
  </PageHeader>

  <section class="overflow-hidden rounded-xl border border-slate-200 bg-white">
    <div class="overflow-x-auto border-b border-slate-200 p-4">
      <el-segmented v-model="status" :options="statusOptions" />
    </div>

    <el-table :data="rows" row-key="id" empty-text="暂无符合条件的版本">
      <el-table-column type="expand" width="44">
        <template #default="{ row }">
          <div class="bg-slate-50 px-12 py-3">
            <p class="mb-2 text-xs text-slate-500">
              产物文件 · 由 {{ row.triggeredBy }} 构建于
              {{ formatDateTime(row.createdAt) }}
            </p>
            <ul
              class="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white"
            >
              <li
                v-for="file in row.artifacts"
                :key="file.id"
                class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5"
              >
                <span
                  class="min-w-0 flex-1 truncate font-mono text-sm text-slate-800"
                  >{{ file.name }}</span
                >
                <span class="text-xs tabular-nums text-slate-500">{{
                  formatSize(file.size)
                }}</span>
                <span
                  class="hidden font-mono text-xs text-slate-400 md:inline"
                  :title="file.sha256"
                  >sha256:{{ file.sha256.slice(0, 12) }}…</span
                >
                <el-button
                  size="small"
                  link
                  type="primary"
                  @click="demoDownload(file.name)"
                  >下载</el-button
                >
              </li>
            </ul>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="版本" min-width="230">
        <template #default="{ row }">
          <div class="flex items-center gap-2.5">
            <ProjectAvatar :project="projectOf(row)" size="sm" />
            <div class="min-w-0 leading-tight">
              <p class="flex items-center gap-1.5">
                <span
                  class="truncate font-mono text-sm font-medium text-slate-900"
                  >{{ row.version }}</span
                >
                <span
                  v-if="latestIds.has(row.id)"
                  class="rounded bg-brand-50 px-1.5 text-[11px] font-medium text-brand-700"
                  >最新</span
                >
              </p>
              <p class="truncate text-xs text-slate-500">
                {{ projectOf(row).name }}
              </p>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="来源" min-width="160">
        <template #default="{ row }">
          <span class="font-mono text-xs text-slate-600"
            >{{ row.branch }}<span class="text-slate-400">@</span
            >{{ shortSha(row.sha) }}</span
          >
        </template>
      </el-table-column>
      <el-table-column label="产物" width="130">
        <template #default="{ row }">
          <span class="text-xs text-slate-600"
            >{{ row.artifacts.length }} 个 · {{ totalSize(row) }}</span
          >
        </template>
      </el-table-column>
      <el-table-column label="构建完成" width="120">
        <template #default="{ row }">
          <span
            class="text-xs text-slate-600"
            :title="formatDateTime(row.createdAt)"
            >{{ relativeTime(row.createdAt, now) }}</span
          >
        </template>
      </el-table-column>
      <el-table-column label="测试状态" width="170">
        <template #default="{ row }">
          <el-dropdown
            trigger="click"
            :disabled="saving === row.id"
            @command="(s: TestStatus) => changeStatus(row, s)"
          >
            <button
              type="button"
              class="flex items-center gap-1 rounded-md p-0.5 hover:bg-slate-100"
              :aria-label="`修改 ${row.version} 测试状态`"
            >
              <StatusTag kind="test" :status="row.testStatus" size="small" />
              <el-icon class="text-slate-400"><ArrowDown /></el-icon>
            </button>
            <template #dropdown>
              <p class="px-4 pt-2 pb-1 text-xs text-slate-400">
                {{ row.testUpdatedBy }} ·
                {{ relativeTime(row.testUpdatedAt, now) }}更新
              </p>
              <el-dropdown-menu>
                <el-dropdown-item
                  v-for="s in testStatusOrder"
                  :key="s"
                  :command="s"
                  :disabled="s === row.testStatus"
                >
                  <span class="flex items-center gap-2">
                    <span
                      class="size-2 rounded-full"
                      :class="testStatusMeta[s].dot"
                    />
                    {{ testStatusMeta[s].label }}
                  </span>
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100" align="right">
        <template #default="{ row }">
          <el-tooltip content="公开下载页">
            <el-button
              text
              circle
              :icon="Link"
              aria-label="公开下载页"
              tag="a"
              :href="`/downloads/${projectOf(row).slug}`"
              target="_blank"
            />
          </el-tooltip>
          <el-tooltip v-if="canManage(row.triggeredBy)" content="删除版本">
            <el-button
              text
              circle
              :icon="Delete"
              aria-label="删除版本"
              @click="confirmDeleteRelease(row)"
            />
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>
  </section>
</template>
