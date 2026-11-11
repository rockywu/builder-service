import { ref } from 'vue';

interface User {
  id: number;
  username: string;
  role: 'admin' | 'user';
}
interface Session {
  user: User;
  csrfToken: string;
}
export const currentUser = ref<User | null>(null);
let csrfToken: string | null = null;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError('无法连接服务，请稍后重试。', 0);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      message?: string;
    };
    if (response.status === 401) {
      currentUser.value = null;
      csrfToken = null;
    }
    const message =
      response.status === 429
        ? '登录尝试过于频繁，请稍后再试。'
        : (body.message ?? '请求失败，请稍后重试。');
    throw new ApiError(message, response.status);
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}
function saveSession(session: Session) {
  currentUser.value = session.user;
  csrfToken = session.csrfToken;
}
export async function refreshSession() {
  try {
    saveSession(await request<Session>('/api/auth/me'));
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return false;
    throw error;
  }
}
export async function login(username: string, password: string) {
  saveSession(
    await request<Session>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
  );
}
export async function logout() {
  try {
    await request<void>('/api/auth/logout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken ?? '',
      },
      body: '{}',
    });
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) throw error;
  }
  currentUser.value = null;
  csrfToken = null;
}
