<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { currentUser, logout } from '../auth';
const router = useRouter();
const signingOut = ref(false);
const logoutError = ref('');
async function signOut() {
  if (signingOut.value) return;
  signingOut.value = true;
  logoutError.value = '';
  try {
    await logout();
    await router.replace('/login');
  } catch (error) {
    logoutError.value =
      error instanceof Error ? error.message : '退出失败，请重试。';
  } finally {
    signingOut.value = false;
  }
}
const navigation = [
  { to: '/admin/projects', label: '项目' },
  { to: '/admin/builds', label: '构建任务' },
  { to: '/admin/releases', label: '版本' },
  { to: '/admin/users', label: '用户' },
  { to: '/admin/settings', label: '系统设置' },
];
</script>

<template>
  <a class="skip-link" href="#main-content">跳到内容</a>
  <div class="admin-shell">
    <aside class="sidebar">
      <RouterLink class="brand" to="/admin/projects">构建平台</RouterLink>
      <nav aria-label="管理导航">
        <RouterLink v-for="item in navigation" :key="item.to" :to="item.to">{{
          item.label
        }}</RouterLink>
      </nav>
      <div class="sidebar-footer">
        <RouterLink to="/downloads">公开下载页</RouterLink>
        <p class="signed-in-user">{{ currentUser?.username }}</p>
        <button
          class="text-button"
          type="button"
          :disabled="signingOut"
          @click="signOut"
        >
          {{ signingOut ? '正在退出…' : '退出登录' }}
        </button>
        <p v-if="logoutError" class="form-error" role="alert">
          {{ logoutError }}
        </p>
      </div>
    </aside>
    <main id="main-content" class="main-content" tabindex="-1">
      <RouterView />
    </main>
  </div>
</template>
