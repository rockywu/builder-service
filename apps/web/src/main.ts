import { createApp } from 'vue';
import { ElTag } from 'element-plus';
import 'element-plus/es/components/tag/style/css';
import App from './App.vue';
import { router } from './router';
import './styles.css';

createApp(App).use(router).component('ElTag', ElTag).mount('#app');
