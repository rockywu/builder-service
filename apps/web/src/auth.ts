import { computed, ref } from 'vue';
import type { User } from './api/types';
import { request, setCsrfToken, ApiError } from './api/client';
import { loadAdmin, clearAdmin, db } from './api/store';

export const currentUser = ref<User | null>(null);
export const isAdmin = computed(() => currentUser.value?.role === 'admin');
type Session = {
  user: Pick<User, 'id' | 'username' | 'role'> & Partial<User>;
  csrfToken: string;
};
function accept(data: Session) {
  currentUser.value = {
    displayName: data.user.username,
    enabled: true,
    createdAt: 0,
    lastLoginAt: null,
    ...data.user,
  };
  setCsrfToken(data.csrfToken);
}
export async function refreshSession() {
  try {
    const data = await request<Session>('/auth/me');
    accept(data);
    await loadAdmin(data.user.role);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      currentUser.value = null;
      setCsrfToken('');
      clearAdmin();
      return false;
    }
    throw e;
  }
}
export async function login(username: string, password: string) {
  const data = await request<Session>('/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  accept(data);
  await loadAdmin(data.user.role);
}
export async function logout() {
  await request<void>('/auth/logout', { method: 'POST' });
  currentUser.value = null;
  setCsrfToken('');
  clearAdmin();
}
export function canManage(_triggeredBy: string, jobId: number) {
  return (
    isAdmin.value ||
    db.jobs.some(
      (j) => j.id === jobId && j.triggeredById === currentUser.value?.id,
    )
  );
}
