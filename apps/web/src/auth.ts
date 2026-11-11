import { computed, ref } from 'vue';
import { authenticate, findUser } from './mocks/db';
import type { User } from './mocks/types';

/** 纯前端演示：会话保存在内存中，刷新页面即退出。 */
export const currentUser = ref<User | null>(null);
export const isAdmin = computed(() => currentUser.value?.role === 'admin');

const wait = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export async function refreshSession() {
  await wait(80);
  const user = currentUser.value && findUser(currentUser.value.username);
  if (!user?.enabled) currentUser.value = null;
  return Boolean(currentUser.value);
}

export async function login(username: string, password: string) {
  currentUser.value = await authenticate(username, password);
}

export async function logout() {
  await wait(200);
  currentUser.value = null;
}

/** 管理员可操作任意任务；普通用户只能操作自己发起的任务及其版本。 */
export function canManage(triggeredBy: string) {
  return isAdmin.value || currentUser.value?.username === triggeredBy;
}
