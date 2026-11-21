<script setup lang="ts">
import AppLogo from '../components/AppLogo.vue';
</script>

<template>
  <div class="tech flex min-h-dvh flex-col text-slate-200">
    <div class="tech-bg" aria-hidden="true"><i /><i /></div>
    <header
      class="sticky top-0 z-20 border-b border-white/[0.06] bg-[#05070d]/60 backdrop-blur-xl"
    >
      <div
        class="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-8"
      >
        <RouterLink to="/" aria-label="下载中心首页">
          <AppLogo subtitle="下载中心" inverted />
        </RouterLink>
        <nav class="flex items-center gap-2 text-sm">
          <RouterLink
            to="/"
            class="rounded-lg px-3 py-1.5 text-slate-400 transition hover:bg-white/5 hover:text-white"
            >全部项目</RouterLink
          >
          <RouterLink
            to="/login"
            class="rounded-lg border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-slate-200 transition hover:border-cyan-400/50 hover:text-cyan-200 hover:shadow-[0_0_20px_rgb(34_211_238/0.2)]"
            >管理端登录</RouterLink
          >
        </nav>
      </div>
    </header>
    <main
      class="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-10 sm:px-8 sm:pt-16"
    >
      <RouterView />
    </main>
    <footer class="border-t border-white/[0.06]">
      <div
        class="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 font-mono text-xs text-slate-500 sm:px-8"
      >
        <span>BUILDER SERVICE · DOWNLOAD CENTER</span>
        <span>公开下载无需登录 · 产物以附件形式下载</span>
      </div>
    </footer>
  </div>
</template>
