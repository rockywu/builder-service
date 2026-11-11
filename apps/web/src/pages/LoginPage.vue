<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { User, Lock, Download, ArrowRight } from '@element-plus/icons-vue';
import { login } from '../auth';
import AppLogo from '../components/AppLogo.vue';

const router = useRouter();
const route = useRoute();
const username = ref('');
const password = ref('');
const pending = ref(false);
const error = ref(
  route.query.error === 'service' ? '无法确认登录状态，请重新登录。' : '',
);

const demoAccounts = [
  { username: 'admin', password: 'admin123456', role: '管理员' },
  { username: 'tester', password: 'tester123456', role: '普通用户' },
];
function fill(account: (typeof demoAccounts)[number]) {
  username.value = account.username;
  password.value = account.password;
  error.value = '';
}

async function submit() {
  if (pending.value) return;
  if (!username.value.trim() || !password.value) {
    error.value = '请输入账号和密码';
    return;
  }
  error.value = '';
  pending.value = true;
  try {
    await login(username.value.trim(), password.value);
    await router.replace('/admin/projects');
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : '登录失败，请稍后重试';
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div
    class="relative flex min-h-dvh flex-col bg-slate-50 bg-[radial-gradient(circle_at_1px_1px,var(--color-slate-200)_1px,transparent_0)] bg-[size:24px_24px]"
  >
    <header class="flex items-center justify-between px-6 py-5">
      <AppLogo subtitle="Builder Service" />
      <RouterLink
        to="/downloads"
        class="flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-200 transition hover:text-brand-600 hover:ring-brand-200"
      >
        <el-icon><Download /></el-icon>项目下载
      </RouterLink>
    </header>

    <main class="flex flex-1 items-center justify-center px-4 pb-16">
      <div class="w-full max-w-sm">
        <div
          class="rounded-2xl bg-white p-8 shadow-xl ring-1 shadow-slate-200/60 ring-slate-200"
        >
          <h1 class="text-xl font-semibold text-slate-900">登录管理端</h1>
          <p class="mt-1 text-sm text-slate-500">
            管理项目、发起构建、标记测试结果
          </p>

          <form
            class="mt-6 space-y-4"
            :aria-busy="pending"
            @submit.prevent="submit"
          >
            <div>
              <label for="username" class="mb-1.5 block text-sm text-slate-700"
                >账号</label
              >
              <el-input
                id="username"
                v-model="username"
                size="large"
                :prefix-icon="User"
                autocomplete="username"
                maxlength="64"
                placeholder="请输入账号"
              />
            </div>
            <div>
              <label for="password" class="mb-1.5 block text-sm text-slate-700"
                >密码</label
              >
              <el-input
                id="password"
                v-model="password"
                size="large"
                type="password"
                show-password
                :prefix-icon="Lock"
                autocomplete="current-password"
                maxlength="256"
                placeholder="请输入密码"
              />
            </div>
            <p v-if="error" class="text-sm text-red-600" role="alert">
              {{ error }}
            </p>
            <el-button
              type="primary"
              size="large"
              native-type="submit"
              class="w-full"
              :loading="pending"
              >登录</el-button
            >
          </form>

          <div class="mt-6 border-t border-dashed border-slate-200 pt-4">
            <p class="mb-2 text-xs text-slate-500">演示账号（点击填入）</p>
            <div class="grid grid-cols-2 gap-2">
              <button
                v-for="account in demoAccounts"
                :key="account.username"
                type="button"
                class="rounded-lg border border-slate-200 px-3 py-2 text-left transition hover:border-brand-300 hover:bg-brand-50"
                @click="fill(account)"
              >
                <span class="block font-mono text-sm text-slate-800">{{
                  account.username
                }}</span>
                <span class="text-xs text-slate-500">{{ account.role }}</span>
              </button>
            </div>
          </div>
        </div>

        <RouterLink
          to="/downloads"
          class="group mt-4 flex items-center gap-3 rounded-2xl bg-brand-600 p-4 text-white shadow-lg shadow-brand-600/20 transition hover:bg-brand-700"
        >
          <span class="grid size-10 place-items-center rounded-xl bg-white/15">
            <el-icon :size="20"><Download /></el-icon>
          </span>
          <span class="flex-1">
            <span class="block text-sm font-medium">只需要下载构建版本？</span>
            <span class="block text-xs text-white/75"
              >无需登录，直接前往项目下载</span
            >
          </span>
          <el-icon class="transition group-hover:translate-x-0.5"
            ><ArrowRight
          /></el-icon>
        </RouterLink>
      </div>
    </main>
  </div>
</template>
