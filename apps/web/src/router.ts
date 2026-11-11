import { createRouter, createWebHistory } from 'vue-router';
import AdminLayout from './layouts/AdminLayout.vue';
import PublicLayout from './layouts/PublicLayout.vue';
import LoginPage from './pages/LoginPage.vue';
import ProjectsPage from './pages/admin/ProjectsPage.vue';
import BuildsPage from './pages/admin/BuildsPage.vue';
import ReleasesPage from './pages/admin/ReleasesPage.vue';
import UsersPage from './pages/admin/UsersPage.vue';
import SettingsPage from './pages/admin/SettingsPage.vue';
import DownloadsPage from './pages/public/DownloadsPage.vue';
import ProjectDownloadsPage from './pages/public/ProjectDownloadsPage.vue';
import { isAdmin, refreshSession } from './auth';

declare module 'vue-router' {
  interface RouteMeta {
    requiresAuth?: boolean;
    adminOnly?: boolean;
    title?: string;
  }
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/login' },
    { path: '/login', component: LoginPage, meta: { title: '登录' } },
    {
      path: '/admin',
      meta: { requiresAuth: true },
      component: AdminLayout,
      children: [
        { path: '', redirect: '/admin/projects' },
        { path: 'projects', component: ProjectsPage, meta: { title: '项目' } },
        { path: 'builds', component: BuildsPage, meta: { title: '构建队列' } },
        { path: 'releases', component: ReleasesPage, meta: { title: '版本' } },
        {
          path: 'users',
          component: UsersPage,
          meta: { title: '用户', adminOnly: true },
        },
        {
          path: 'settings',
          component: SettingsPage,
          meta: { title: '设置', adminOnly: true },
        },
      ],
    },
    {
      path: '/downloads',
      component: PublicLayout,
      children: [
        { path: '', component: DownloadsPage, meta: { title: '项目下载' } },
        {
          path: ':projectSlug',
          component: ProjectDownloadsPage,
          meta: { title: '项目下载' },
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/downloads' },
  ],
});

router.beforeEach(async (to) => {
  // 公开下载页不调用认证接口
  if (!to.matched.some((record) => record.meta.requiresAuth)) return true;
  try {
    if (!(await refreshSession())) return { path: '/login' };
  } catch {
    return { path: '/login', query: { error: 'service' } };
  }
  if (to.meta.adminOnly && !isAdmin.value) return { path: '/admin/projects' };
  return true;
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · 构建平台` : '构建平台';
});
