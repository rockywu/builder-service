<script setup lang="ts">
import AppLogo from '../components/AppLogo.vue';
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-slate-50">
    <header class="border-b border-slate-200 bg-white">
      <div
        class="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6"
      >
        <RouterLink to="/downloads" aria-label="下载中心首页">
          <AppLogo subtitle="下载中心" />
        </RouterLink>
        <RouterLink
          to="/login"
          class="text-sm text-slate-500 transition hover:text-slate-900"
          >管理端登录 →</RouterLink
        >
      </div>
    </header>
    <main class="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
      <RouterView />
    </main>
    <footer class="py-6 text-center text-xs text-slate-400">
      公开下载无需登录 · 产物以附件形式下载
    </footer>
  </div>
</template>
