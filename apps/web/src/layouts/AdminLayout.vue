<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowDown, Download, SwitchButton } from '@element-plus/icons-vue';
import { OCCUPYING, db } from '../api/store';
import { currentUser, isAdmin, logout } from '../auth';
import AppLogo from '../components/AppLogo.vue';

const router = useRouter();

const navigation = computed(() =>
  [
    { to: '/admin/projects', label: '项目' },
    { to: '/admin/builds', label: '构建队列' },
    { to: '/admin/releases', label: '版本' },
    { to: '/admin/users', label: '用户', admin: true },
    { to: '/admin/settings', label: '设置', admin: true },
  ].filter((item) => !item.admin || isAdmin.value),
);

const running = computed(
  () => db.jobs.filter((job) => OCCUPYING.includes(job.status)).length,
);
const queued = computed(
  () => db.jobs.filter((job) => job.status === 'queued').length,
);
const slots = computed(() =>
  Array.from(
    { length: db.settings.maxConcurrent },
    (_, i) => i < running.value,
  ),
);

async function signOut() {
  await logout();
  await router.replace('/login');
}
</script>

<template>
  <div class="min-h-dvh bg-slate-50">
    <header
      class="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur"
    >
      <div class="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <RouterLink to="/admin/projects" aria-label="构建平台首页">
          <AppLogo />
        </RouterLink>

        <nav
          class="hidden h-full items-stretch gap-1 md:flex"
          aria-label="管理导航"
        >
          <RouterLink
            v-for="item in navigation"
            :key="item.to"
            :to="item.to"
            class="relative flex items-center px-3 text-sm text-slate-600 transition hover:text-slate-900"
            active-class="!text-brand-600 font-medium after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-brand-600"
            >{{ item.label }}</RouterLink
          >
        </nav>

        <div class="ml-auto flex items-center gap-2 sm:gap-3">
          <!-- 执行槽位实时占用 -->
          <RouterLink
            to="/admin/builds"
            class="hidden items-center gap-2 rounded-full border border-slate-200 px-3 py-1 text-xs text-slate-600 transition hover:border-brand-200 hover:bg-brand-50 sm:flex"
            :title="`执行中 ${running} / 上限 ${db.settings.maxConcurrent}，排队 ${queued}`"
          >
            <span class="flex gap-0.5">
              <span
                v-for="(busy, index) in slots"
                :key="index"
                class="h-3 w-1.5 rounded-sm"
                :class="busy ? 'bg-brand-500' : 'bg-slate-200'"
              />
            </span>
            <span class="tabular-nums"
              >{{ running }}/{{ db.settings.maxConcurrent }} 执行中</span
            >
            <span v-if="queued" class="tabular-nums text-amber-600"
              >· {{ queued }} 排队</span
            >
          </RouterLink>

          <el-tooltip content="公开下载页" placement="bottom">
            <RouterLink
              to="/downloads"
              target="_blank"
              class="grid size-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              aria-label="打开公开下载页"
            >
              <el-icon :size="16"><Download /></el-icon>
            </RouterLink>
          </el-tooltip>

          <el-dropdown trigger="click" placement="bottom-end">
            <button
              type="button"
              class="flex items-center gap-2 rounded-md py-1 pr-1.5 pl-1 hover:bg-slate-100"
            >
              <span
                class="grid size-7 place-items-center rounded-full bg-slate-800 text-xs font-medium text-white uppercase"
                >{{ currentUser?.username.slice(0, 1) }}</span
              >
              <span class="hidden text-sm text-slate-700 sm:inline">{{
                currentUser?.username
              }}</span>
              <el-icon class="text-slate-400"><ArrowDown /></el-icon>
            </button>
            <template #dropdown>
              <div class="border-b border-slate-100 px-4 py-2.5">
                <p class="text-sm font-medium text-slate-900">
                  {{ currentUser?.displayName }}
                </p>
                <p class="text-xs text-slate-500">
                  {{ isAdmin ? '管理员' : '普通用户' }}
                </p>
              </div>
              <el-dropdown-menu>
                <el-dropdown-item :icon="SwitchButton" @click="signOut"
                  >退出登录</el-dropdown-item
                >
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>

      <!-- 移动端导航 -->
      <nav
        class="flex gap-1 overflow-x-auto border-t border-slate-100 px-2 md:hidden"
        aria-label="管理导航"
      >
        <RouterLink
          v-for="item in navigation"
          :key="item.to"
          :to="item.to"
          class="shrink-0 border-b-2 border-transparent px-3 py-2.5 text-sm text-slate-600"
          active-class="!border-brand-600 !text-brand-600 font-medium"
          >{{ item.label }}</RouterLink
        >
      </nav>
    </header>

    <main class="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
      <RouterView />
    </main>
  </div>
</template>
