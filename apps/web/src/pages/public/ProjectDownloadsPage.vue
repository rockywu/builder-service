<script setup lang="ts">
import { downloadArtifact, ApiError } from '../../api/client';
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  ArrowLeft,
  Download,
  Document,
  CopyDocument,
} from '@element-plus/icons-vue';
import type { Artifact, TestStatus } from '../../api/types';
import { now, loadPublicPage } from '../../api/store';
import type { PublicPage } from '../../api/store';
import { formatDateTime, formatSize, relativeTime } from '../../utils/format';
import { testStatusMeta, testStatusOrder } from '../../utils/status';
import ProjectAvatar from '../../components/ProjectAvatar.vue';
import ReleaseStatus from '../../components/ReleaseStatus.vue';

const PAGE_SIZE = 5;
const route = useRoute();
const data = ref<PublicPage | null>(null);
const project = computed(() => data.value?.project);
const status = ref<TestStatus | 'all'>('all');
const page = ref(1);
watch(status, () => (page.value = 1));
let requestSequence = 0;
async function refresh() {
  const sequence = ++requestSequence;
  try {
    const result = await loadPublicPage(
      String(route.params.projectSlug),
      status.value,
      page.value,
    );
    if (sequence === requestSequence) data.value = result;
  } catch (error) {
    if (sequence !== requestSequence) return;
    if (error instanceof ApiError && error.status === 404) data.value = null;
    else throw error;
  }
}
watch(() => [route.params.projectSlug, status.value, page.value], refresh, {
  immediate: true,
});
const hasAny = computed(() => data.value?.hasAny ?? false);
// Preserve the existing template's count and pagination bindings; the server filters before paging.
const filtered = computed(() => ({ length: data.value?.total ?? 0 }));
const pageItems = computed(() => data.value?.items ?? []);
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
  downloadArtifact(file.id);
}
async function copyHash(file: Artifact) {
  try {
    await navigator.clipboard.writeText(file.sha256);
    ElMessage.success('已复制 SHA-256 校验值');
  } catch {
    ElMessage.error('复制失败，请手动选择');
  }
}
</script>

<template>
  <RouterLink
    to="/"
    class="mb-8 inline-flex items-center gap-1.5 font-mono text-sm text-slate-400 transition hover:text-cyan-300"
  >
    <el-icon><ArrowLeft /></el-icon>全部项目
  </RouterLink>

  <div
    v-if="project"
    class="grid gap-8 lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-12"
  >
    <!-- 左栏：项目信息与筛选 -->
    <aside class="rise lg:sticky lg:top-24 lg:self-start">
      <ProjectAvatar
        :project="project"
        size="xl"
        class="ring-1 ring-white/20 shadow-[0_0_40px_rgb(34_211_238/0.15)]"
      />
      <h1 class="mt-5 text-3xl font-bold tracking-tight text-white">
        {{ project.name }}
      </h1>
      <p class="mt-1 font-mono text-xs text-slate-500">/{{ project.slug }}</p>
      <p class="mt-4 text-sm leading-6 text-slate-400">
        {{ project.description || '暂无项目说明' }}
      </p>

      <div v-if="hasAny" class="mt-8">
        <p
          class="mb-2 font-mono text-[11px] uppercase tracking-[0.2em] text-slate-500"
        >
          测试状态
        </p>
        <div
          role="radiogroup"
          aria-label="按测试状态筛选"
          class="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:gap-1 lg:overflow-visible"
        >
          <button
            v-for="o in options"
            :key="o.value"
            type="button"
            role="radio"
            :aria-checked="status === o.value"
            class="shrink-0 rounded-lg border px-3 py-2 text-left text-sm transition"
            :class="
              status === o.value
                ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-200 shadow-[0_0_18px_rgb(34_211_238/0.15)]'
                : 'border-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200'
            "
            @click="status = o.value as TestStatus | 'all'"
          >
            {{ o.label }}
          </button>
        </div>
      </div>
    </aside>

    <!-- 右栏：版本 -->
    <div class="min-w-0">
      <el-empty v-if="!hasAny" description="暂无可下载版本" />

      <template v-else>
        <el-empty v-if="!filtered.length" description="暂无符合条件的版本" />

        <!-- 最新版本 -->
        <article
          v-if="featured"
          class="rise relative mb-10 overflow-hidden rounded-3xl border border-cyan-400/30 bg-gradient-to-br from-cyan-400/[0.09] via-white/[0.03] to-indigo-400/[0.07] shadow-[0_0_70px_rgb(34_211_238/0.12)]"
          style="--d: 80ms"
        >
          <div
            class="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300 to-transparent"
          />
          <div class="p-6 sm:p-8">
            <div class="flex flex-wrap items-center gap-3">
              <span
                class="rounded-md bg-cyan-400 px-2 py-0.5 font-mono text-[11px] font-bold tracking-wider text-slate-950 shadow-[0_0_14px_rgb(34_211_238/0.6)]"
                >LATEST</span
              >
              <ReleaseStatus :status="featured.testStatus" />
              <span class="text-xs text-slate-400">{{
                status === 'all'
                  ? '最新版本'
                  : `最新「${testStatusMeta[status].label}」版本`
              }}</span>
            </div>
            <h2
              class="mt-4 break-all font-mono text-3xl font-semibold text-white sm:text-4xl"
            >
              {{ featured.version }}
            </h2>
            <dl
              class="mt-4 flex flex-wrap gap-x-8 gap-y-2 font-mono text-xs text-slate-400"
            >
              <div v-if="featured.branch" class="flex gap-2">
                <dt class="text-slate-600">branch</dt>
                <dd class="text-slate-300">{{ featured.branch }}</dd>
              </div>
              <div class="flex gap-2">
                <dt class="text-slate-600">commit</dt>
                <dd class="text-slate-300">{{ featured.sha.slice(0, 8) }}</dd>
              </div>
              <div
                class="flex gap-2"
                :title="formatDateTime(featured.createdAt)"
              >
                <dt class="text-slate-600">built</dt>
                <dd class="text-slate-300">
                  {{ relativeTime(featured.createdAt, now) }}
                </dd>
              </div>
            </dl>
          </div>
          <ul
            class="divide-y divide-white/[0.06] border-t border-white/[0.08] bg-black/20"
          >
            <li
              v-for="file in featured.artifacts"
              :key="file.id"
              class="flex flex-wrap items-center gap-x-4 gap-y-3 px-6 py-4 sm:px-8"
            >
              <div
                class="flex min-w-0 basis-full items-center gap-3 sm:flex-1 sm:basis-0"
              >
                <el-icon class="text-lg text-cyan-300/70"><Document /></el-icon>
                <div class="min-w-0 flex-1">
                  <p
                    class="break-all font-mono text-sm text-slate-100 sm:truncate"
                  >
                    {{ file.name }}
                  </p>
                  <p class="mt-0.5 text-xs tabular-nums text-slate-500">
                    {{ formatSize(file.size) }}
                  </p>
                </div>
              </div>
              <el-button
                text
                :icon="CopyDocument"
                title="复制 SHA-256 校验值"
                @click="copyHash(file)"
                >SHA-256</el-button
              >
              <el-button
                type="primary"
                size="large"
                :icon="Download"
                @click="download(file)"
                >下载</el-button
              >
            </li>
          </ul>
        </article>

        <!-- 历史版本：时间线 -->
        <section v-if="history.length">
          <div class="mb-5 flex items-center gap-4">
            <h2
              class="font-mono text-xs uppercase tracking-[0.2em] text-slate-400"
            >
              {{ page === 1 ? 'History' : `History · 第 ${page} 页` }}
            </h2>
            <span
              class="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent"
            />
          </div>
          <ol
            class="relative ml-2 space-y-5 border-l border-white/10 pl-6 sm:pl-8"
          >
            <li
              v-for="(release, i) in history"
              :key="release.id"
              class="rise relative"
              :style="{ '--d': `${i * 60}ms` }"
            >
              <span
                class="absolute -left-[1.95rem] top-5 size-2.5 rounded-full border-2 border-[#05070d] bg-slate-500 sm:-left-[2.45rem]"
              />
              <div
                class="rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition hover:border-white/20"
              >
                <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <h3
                    class="break-all font-mono text-lg font-semibold text-slate-100"
                  >
                    {{ release.version }}
                  </h3>
                  <ReleaseStatus :status="release.testStatus" />
                  <span
                    class="ml-auto font-mono text-xs text-slate-500"
                    :title="relativeTime(release.createdAt, now)"
                    >{{ formatDateTime(release.createdAt) }}</span
                  >
                </div>
                <p class="mt-1.5 font-mono text-xs text-slate-500">
                  <template v-if="release.branch"
                    >{{ release.branch }} · </template
                  >{{ release.sha.slice(0, 8) }}
                </p>
                <ul class="mt-4 space-y-2">
                  <li
                    v-for="file in release.artifacts"
                    :key="file.id"
                    class="flex items-center gap-3 rounded-xl bg-black/25 px-3.5 py-2.5"
                  >
                    <el-icon class="text-slate-500"><Document /></el-icon>
                    <span
                      class="min-w-0 flex-1 break-all font-mono text-xs text-slate-300 sm:truncate"
                      >{{ file.name }}</span
                    >
                    <span
                      class="hidden text-xs tabular-nums text-slate-500 sm:inline"
                      >{{ formatSize(file.size) }}</span
                    >
                    <el-button
                      size="small"
                      link
                      :icon="CopyDocument"
                      title="复制 SHA-256 校验值"
                      @click="copyHash(file)"
                    />
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
              </div>
            </li>
          </ol>
        </section>

        <el-pagination
          v-if="filtered.length > PAGE_SIZE"
          v-model:current-page="page"
          :page-size="PAGE_SIZE"
          :total="filtered.length"
          layout="prev, pager, next"
          background
          class="mt-8 justify-center"
        />
      </template>
    </div>
  </div>

  <el-result
    v-else
    icon="warning"
    title="项目不存在"
    sub-title="请从项目列表重新进入"
  >
    <template #extra>
      <RouterLink to="/"
        ><el-button type="primary">返回项目列表</el-button></RouterLink
      >
    </template>
  </el-result>
</template>
