<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { login } from '../auth';

const username = ref('');
const password = ref('');
const pending = ref(false);
const error = ref('');
const router = useRouter();
const route = useRoute();

async function submit() {
  if (pending.value) return;
  error.value = '';
  pending.value = true;
  try {
    await login(username.value.trim(), password.value);
    password.value = '';
    await router.replace('/admin/projects');
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : '登录失败，请稍后重试。';
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <section class="login-page">
    <h1>登录构建平台</h1>
    <p class="page-description">使用账号和密码进入管理端。</p>
    <form class="login-form" @submit.prevent="submit" :aria-busy="pending">
      <div class="form-field">
        <label for="username">账号</label>
        <input
          id="username"
          v-model="username"
          name="username"
          autocomplete="username"
          required
          maxlength="64"
          :readonly="pending"
        />
      </div>
      <div class="form-field">
        <label for="password">密码</label>
        <input
          id="password"
          v-model="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          maxlength="256"
          :readonly="pending"
        />
      </div>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <p
        v-else-if="route.query.error === 'service'"
        class="form-error"
        role="alert"
      >
        无法确认登录状态，请检查服务后重新登录。
      </p>
      <button class="primary-button" type="submit" :disabled="pending">
        {{ pending ? '正在登录…' : '登录' }}
      </button>
    </form>
    <div class="login-download-entry">
      <h2>下载构建版本</h2>
      <p>公开下载页面无需账号或密码。</p>
      <RouterLink to="/downloads">前往项目下载</RouterLink>
    </div>
  </section>
</template>
