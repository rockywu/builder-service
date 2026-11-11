import { createRouter, createWebHistory } from 'vue-router';
import AdminLayout from './layouts/AdminLayout.vue';
import PublicLayout from './layouts/PublicLayout.vue';
import ScaffoldPage from './pages/ScaffoldPage.vue';
import LoginPage from './pages/LoginPage.vue';
import DownloadsPage from './pages/DownloadsPage.vue';
import ProjectDownloadsPage from './pages/ProjectDownloadsPage.vue';
import { refreshSession } from './auth';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/login' },
    {
      path: '/admin',
      meta: { requiresAuth: true },
      component: AdminLayout,
      children: [
        { path: '', redirect: '/admin/projects' },
        {
          path: 'projects',
          component: ScaffoldPage,
          props: {
            title: '项目',
            description: '仓库、构建配置与项目图标的页面位置。',
          },
        },
        {
          path: 'builds',
          component: ScaffoldPage,
          props: {
            title: '构建任务',
            description: '任务队列、并行执行与构建日志的页面位置。',
          },
        },
        {
          path: 'releases',
          component: ScaffoldPage,
          props: {
            title: '版本',
            description: '构建产物与四种测试状态的管理页面位置。',
          },
        },
        {
          path: 'users',
          component: ScaffoldPage,
          props: { title: '用户', description: '账号与用户管理的页面位置。' },
        },
        {
          path: 'settings',
          component: ScaffoldPage,
          props: {
            title: '系统设置',
            description: '全局构建并行数量的设置页面位置。',
          },
        },
      ],
    },
    {
      path: '/',
      component: PublicLayout,
      children: [
        {
          path: 'login',
          component: LoginPage,
        },
        {
          path: 'downloads',
          component: DownloadsPage,
        },
        {
          path: 'downloads/:projectSlug',
          component: ProjectDownloadsPage,
        },
        {
          path: ':pathMatch(.*)*',
          component: ScaffoldPage,
          props: {
            title: '页面不存在',
            description: '请通过导航进入已有页面。',
          },
        },
      ],
    },
  ],
});

router.beforeEach(async (to) => {
  // Public downloads never depend on the authentication API.
  if (!to.matched.some((record) => record.meta.requiresAuth)) return true;
  try {
    return (await refreshSession()) ? true : { path: '/login' };
  } catch {
    return { path: '/login', query: { error: 'service' } };
  }
});
