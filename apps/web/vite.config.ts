import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // Docker 开发环境通过 API_PROXY_TARGET 指向 api 容器。
    proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000' },
    // Docker Desktop 收不到 bind mount 文件事件时用 VITE_USE_POLLING=1。
    ...(process.env.VITE_USE_POLLING === '1'
      ? { watch: { usePolling: true } }
      : {}),
  },
});
