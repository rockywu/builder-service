let csrfToken = '';
export function setCsrfToken(token: string) {
  csrfToken = token;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    key?: string;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...(options.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(!['GET', 'HEAD'].includes(method)
          ? { 'X-CSRF-Token': csrfToken }
          : {}),
        ...(options.key ? { 'Idempotency-Key': options.key } : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
        : AbortSignal.timeout(120_000),
    });
  } catch {
    throw new ApiError(0, '无法连接服务，请核对操作结果后重试。');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      data.message ?? '请求失败，请稍后重试。',
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export async function all<T>(path: string, signal?: AbortSignal) {
  const result: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await request<{
      items: T[];
      total: number;
      nextOffset: number;
    }>(
      `${path}${path.includes('?') ? '&' : '?'}offset=${offset}&limit=100`,
      signal ? { signal } : {},
    );
    result.push(...page.items);
    if (page.nextOffset >= page.total || page.nextOffset <= offset) break;
    offset = page.nextOffset;
  }
  return result;
}
export function downloadArtifact(id: number) {
  const link = document.createElement('a');
  link.href = `/api/public/artifacts/${id}/download`;
  link.download = '';
  document.body.append(link);
  link.click();
  link.remove();
}
