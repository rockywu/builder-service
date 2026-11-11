import { createApp } from 'vue';
import ElementPlus, { ElMessage } from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import { router } from './router';
import './styles.css';

const app = createApp(App);
app.config.errorHandler = (error) =>
  ElMessage.error(
    error instanceof Error ? error.message : '操作失败，请稍后重试。',
  );
app.use(router).use(ElementPlus).mount('#app');
