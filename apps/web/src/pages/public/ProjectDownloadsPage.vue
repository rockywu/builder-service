<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import { ArrowLeft, Download } from '@element-plus/icons-vue';
import type { Artifact, TestStatus } from '../../mocks/types';
import { db, now, publicReleases } from '../../mocks/db';
import { formatDateTime, formatSize, relativeTime } from '../../utils/format';
import { testStatusMeta, testStatusOrder } from '../../utils/status';
import ProjectAvatar from '../../components/ProjectAvatar.vue';
import StatusTag from '../../components/StatusTag.vue';

const PAGE_SIZE = 5;
const route = useRoute();
const project = computed(() =>
  db.projects.find((p) => p.slug === route.params.projectSlug),
);
const status = ref<TestStatus | 'all'>('all');
const page = ref(1);
watch(status, () => (page.value = 1));

const hasAny = computed(
  () => project.value && publicReleases(project.value.id, 'all').length > 0,
);
const filtered = computed(() =>
  project.value ? publicReleases(project.value.id, status.value) : [],
);
const pageItems = computed(() =>
  filtered.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
);
const featured = computed(() =>
  page.value === 1 ? pageItems.value[0] : undefined,
);
const history = computed(() =>
  page.value === 1 ? pageItems.value.slice(1) : pageItems.value,
);
const options = [
  { value: 'all', label: '全部' },
  ...testStatusOrder.map((s) => ({ value: s, label: testStatusMeta[s].label })),
];

function download(file: Artifact) {
  ElMessage.info(`演示环境：${file.name} 不提供实际文件`);
}
</script>

<template>
  <RouterLink
    to="/downloads"
    class="mb-6 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900"
  >
    <el-icon><ArrowLeft /></el-icon>全部项目
  </RouterLink>

  <template v-if="project">
    <header class="mb-8 flex items-center gap-4">
      <ProjectAvatar :project="project" size="xl" />
      <div class="min-w-0">
        <h1 class="truncate text-2xl font-semibold text-slate-900">
          {{ project.name }}
        </h1>
        <p class="mt-1 text-sm text-slate-500">{{ project.description }}</p>
      </div>
    </header>

    <el-empty v-if="!hasAny" description="暂无可下载版本" />

    <template v-else>
      <div class="mb-4 overflow-x-auto">
        <el-segmented v-model="status" :options="options" />
      </div>

      <el-empty v-if="!filtered.length" description="暂无符合条件的版本" />

      <!-- 首条：最新版本，突出展示 -->
      <article
        v-if="featured"
        class="mb-6 overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-sm ring-4 ring-brand-50"
      >
        <div
          class="flex flex-wrap items-center gap-3 border-b border-slate-100 p-5"
        >
          <span
            class="rounded-full bg-brand-600 px-2.5 py-0.5 text-xs font-medium text-white"
          >
            {{
              status === 'all'
                ? '最新版本'
                : `最新「${testStatusMeta[status].label}」版本`
            }}
          </span>
          <h2 class="font-mono text-lg font-semibold text-slate-900">
            {{ featured.version }}
          </h2>
          <StatusTag kind="test" :status="featured.testStatus" />
          <span
            class="ml-auto text-sm text-slate-500"
            :title="formatDateTime(featured.createdAt)"
            >构建于 {{ relativeTime(featured.createdAt, now) }}</span
          >
        </div>
        <ul class="divide-y divide-slate-100">
          <li
            v-for="file in featured.artifacts"
            :key="file.id"
            class="flex flex-wrap items-center gap-3 px-5 py-3"
          >
            <span
              class="min-w-0 flex-1 truncate font-mono text-sm text-slate-800"
              >{{ file.name }}</span
            >
            <span class="text-xs tabular-nums text-slate-500">{{
              formatSize(file.size)
            }}</span>
            <el-button type="primary" :icon="Download" @click="download(file)"
              >下载</el-button
            >
          </li>
        </ul>
      </article>

      <!-- 历史版本 -->
      <section v-if="history.length">
        <h2 class="mb-3 text-sm font-medium text-slate-500">
          {{ page === 1 ? '历史版本' : `历史版本 · 第 ${page} 页` }}
        </h2>
        <ul class="space-y-3">
          <li
            v-for="release in history"
            :key="release.id"
            class="rounded-xl border border-slate-200 bg-white p-4"
          >
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span class="font-mono font-medium text-slate-900">{{
                release.version
              }}</span>
              <StatusTag
                kind="test"
                :status="release.testStatus"
                size="small"
              />
              <span class="ml-auto text-xs text-slate-500">{{
                formatDateTime(release.createdAt)
              }}</span>
            </div>
            <ul class="mt-3 space-y-1.5">
              <li
                v-for="file in release.artifacts"
                :key="file.id"
                class="flex items-center gap-3 rounded-lg bg-slate-50 px-3 py-2"
              >
                <span
                  class="min-w-0 flex-1 truncate font-mono text-xs text-slate-700"
                  >{{ file.name }}</span
                >
                <span class="text-xs tabular-nums text-slate-400">{{
                  formatSize(file.size)
                }}</span>
                <el-button
                  size="small"
                  link
                  type="primary"
                  :icon="Download"
                  @click="download(file)"
                  >下载</el-button
                >
              </li>
            </ul>
          </li>
        </ul>
      </section>

      <el-pagination
        v-if="filtered.length > PAGE_SIZE"
        v-model:current-page="page"
        :page-size="PAGE_SIZE"
        :total="filtered.length"
        layout="prev, pager, next"
        background
        class="mt-6 justify-center"
      />
    </template>
  </template>

  <el-result
    v-else
    icon="warning"
    title="项目不存在"
    sub-title="请从项目列表重新进入"
  >
    <template #extra>
      <RouterLink to="/downloads"
        ><el-button type="primary">返回项目列表</el-button></RouterLink
      >
    </template>
  </el-result>
</template>
