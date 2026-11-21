<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { Search, ArrowRight } from '@element-plus/icons-vue';
import {
  publicDb as db,
  now,
  publicReleases,
  publicCounts,
  loadPublicProjects,
} from '../../api/store';
import { relativeTime } from '../../utils/format';
import ProjectAvatar from '../../components/ProjectAvatar.vue';
import ReleaseStatus from '../../components/ReleaseStatus.vue';

onMounted(() => loadPublicProjects());
const search = ref('');
const input = ref<HTMLInputElement>();

// 按「/」聚焦搜索框
function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (e.key !== '/' || el?.closest('input,textarea,[contenteditable]')) return;
  e.preventDefault();
  input.value?.focus();
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

function spot(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  el.style.setProperty('--x', `${e.clientX - r.left}px`);
  el.style.setProperty('--y', `${e.clientY - r.top}px`);
}

const all = computed(() =>
  db.projects.map((project) => ({
    project,
    latest: publicReleases(project.id, 'all')[0],
    count: publicCounts[project.id] ?? 0,
  })),
);
const items = computed(() => {
  const q = search.value.trim().toLowerCase();
  return all.value.filter(
    ({ project: p }) =>
      !q || p.name.toLowerCase().includes(q) || p.slug.includes(q),
  );
});
const total = computed(() => all.value.reduce((n, i) => n + i.count, 0));
</script>

<template>
  <section class="flex flex-col items-center text-center">
    <p
      class="rise inline-flex items-center gap-3 font-mono text-xs tracking-[0.25em] text-cyan-300"
    >
      <span class="h-px w-8 bg-gradient-to-r from-transparent to-cyan-400/70" />
      DOWNLOAD CENTER
      <span class="h-px w-8 bg-gradient-to-l from-transparent to-cyan-400/70" />
    </p>
    <h1
      class="rise mt-6 text-4xl font-bold leading-[1.15] tracking-tight text-white sm:text-5xl lg:text-6xl"
      style="--d: 60ms"
    >
      获取最新构建，
      <span
        class="block bg-gradient-to-r from-cyan-300 via-sky-300 to-indigo-400 bg-clip-text text-transparent sm:inline"
        >即刻下载</span
      >
    </h1>
    <p class="rise mt-5 text-base text-slate-400" style="--d: 120ms">
      选择项目，获取最新构建版本和历史版本。
    </p>

    <label
      class="rise group mt-9 flex w-full max-w-xl items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-4 text-left shadow-[0_8px_40px_rgb(0_0_0/0.4)] backdrop-blur transition focus-within:border-cyan-400/60 focus-within:shadow-[0_0_0_4px_rgb(34_211_238/0.12),0_8px_40px_rgb(0_0_0/0.4)]"
      style="--d: 180ms"
    >
      <el-icon class="text-lg text-slate-500 group-focus-within:text-cyan-300"
        ><Search
      /></el-icon>
      <input
        ref="input"
        v-model="search"
        type="text"
        placeholder="搜索项目名称或标识"
        aria-label="搜索项目"
        class="min-w-0 flex-1 bg-transparent text-base text-white outline-none placeholder:text-slate-500"
      />
      <kbd
        class="hidden rounded-md border border-white/15 px-1.5 font-mono text-xs text-slate-500 sm:block"
        >/</kbd
      >
    </label>

    <dl
      class="rise mt-9 flex divide-x divide-white/10 font-mono"
      style="--d: 240ms"
    >
      <div class="px-8">
        <dd class="text-3xl font-semibold text-white">{{ all.length }}</dd>
        <dt class="mt-1 text-[11px] uppercase tracking-widest text-slate-500">
          Projects
        </dt>
      </div>
      <div class="px-8">
        <dd class="text-3xl font-semibold text-white">{{ total }}</dd>
        <dt class="mt-1 text-[11px] uppercase tracking-widest text-slate-500">
          Releases
        </dt>
      </div>
    </dl>
  </section>

  <section class="mt-20">
    <div class="mb-5 flex items-center gap-4">
      <h2 class="font-mono text-xs uppercase tracking-[0.2em] text-slate-400">
        Projects · {{ items.length }}
      </h2>
      <span class="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
    </div>

    <ul v-if="items.length" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <li
        v-for="({ project, latest, count }, i) in items"
        :key="project.id"
        class="rise"
        :style="{ '--d': `${Math.min(i, 8) * 50}ms` }"
      >
        <RouterLink
          :to="`/downloads/${project.slug}`"
          class="spot group flex h-full flex-col rounded-2xl border border-white/10 bg-white/[0.03] p-5 transition duration-200 hover:-translate-y-1 hover:border-cyan-400/40"
          @pointermove="spot"
        >
          <div class="flex items-start gap-3.5">
            <ProjectAvatar
              :project="project"
              size="lg"
              class="ring-1 ring-white/20"
            />
            <div class="min-w-0 flex-1">
              <p class="truncate text-base font-semibold text-white">
                {{ project.name }}
              </p>
              <p class="mt-0.5 truncate font-mono text-xs text-slate-500">
                /{{ project.slug }}
              </p>
            </div>
            <el-icon
              class="mt-1 text-slate-600 transition group-hover:translate-x-1 group-hover:text-cyan-300"
              ><ArrowRight
            /></el-icon>
          </div>
          <p
            class="mt-4 line-clamp-2 min-h-10 text-sm leading-5 text-slate-400"
          >
            {{ project.description || '暂无项目说明' }}
          </p>
          <div
            class="mt-5 flex items-center gap-2 border-t border-white/[0.06] pt-4 text-xs"
          >
            <template v-if="latest">
              <span class="truncate font-mono text-cyan-200">{{
                latest.version
              }}</span>
              <ReleaseStatus :status="latest.testStatus" />
              <span class="ml-auto shrink-0 text-slate-500">{{
                relativeTime(latest.createdAt, now)
              }}</span>
            </template>
            <span v-else class="text-slate-500">暂无可下载版本</span>
          </div>
          <p v-if="count" class="mt-2 font-mono text-[11px] text-slate-600">
            {{ count }} 个版本
          </p>
        </RouterLink>
      </li>
    </ul>
    <el-empty v-else description="没有匹配的项目" />
  </section>
</template>
