export class PlatformError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export function requireValue(
  condition: unknown,
  message: string,
  status = 400,
): asserts condition {
  if (!condition) throw new PlatformError(status, message);
}
