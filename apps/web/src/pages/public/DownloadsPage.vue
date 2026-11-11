<script setup lang="ts">
import { computed, ref } from 'vue';
import { Search, ArrowRight } from '@element-plus/icons-vue';
import { db, now, publicReleases } from '../../mocks/db';
import { relativeTime } from '../../utils/format';
import ProjectAvatar from '../../components/ProjectAvatar.vue';
import StatusTag from '../../components/StatusTag.vue';

const search = ref('');
const items = computed(() => {
  const q = search.value.trim().toLowerCase();
  return db.projects
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.includes(q))
    .map((project) => {
      const releases = publicReleases(project.id, 'all');
      return { project, latest: releases[0], count: releases.length };
    });
});
</script>

<template>
  <div class="mb-8 text-center">
    <h1 class="text-3xl font-semibold tracking-tight text-slate-900">
      项目下载
    </h1>
    <p class="mt-2 text-sm text-slate-500">
      选择项目，获取最新构建版本和历史版本
    </p>
    <el-input
      v-model="search"
      size="large"
      :prefix-icon="Search"
      clearable
      placeholder="搜索项目"
      class="mx-auto mt-6 !max-w-md"
      aria-label="搜索项目"
    />
  </div>

  <ul v-if="items.length" class="grid gap-3 sm:grid-cols-2">
    <li v-for="{ project, latest, count } in items" :key="project.id">
      <RouterLink
        :to="`/downloads/${project.slug}`"
        class="group flex h-full items-center gap-4 rounded-xl border border-slate-200 bg-white p-4 transition hover:border-brand-300 hover:shadow-md"
      >
        <ProjectAvatar :project="project" size="lg" />
        <div class="min-w-0 flex-1">
          <p class="truncate font-medium text-slate-900">{{ project.name }}</p>
          <p
            v-if="latest"
            class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500"
          >
            <span class="font-mono text-slate-700">{{ latest.version }}</span>
            <StatusTag kind="test" :status="latest.testStatus" size="small" />
            <span>{{ relativeTime(latest.createdAt, now) }}</span>
          </p>
          <p v-else class="mt-1 text-xs text-slate-400">暂无可下载版本</p>
        </div>
        <div class="flex flex-col items-end gap-1 text-xs text-slate-400">
          <el-icon
            class="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-500"
            ><ArrowRight
          /></el-icon>
          <span v-if="count">{{ count }} 个版本</span>
        </div>
      </RouterLink>
    </li>
  </ul>
  <el-empty v-else description="没有匹配的项目" />
</template>
