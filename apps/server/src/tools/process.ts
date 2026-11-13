import { spawn, execFile } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const cleanEnvironment = () => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND:
    'ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=none -o IdentityAgent=none -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes',
});

export class ExecutionUnconfirmedError extends Error {}
export class ProcessExitError extends Error {
  constructor(
    public readonly exitCode: number | null,
    public readonly output: string,
  ) {
    super(`命令执行失败（退出码 ${exitCode}）。`);
  }
}
export async function groupAlive(pgid: number): Promise<boolean> {
  return new Promise((resolve, reject) =>
    execFile(
      'ps',
      ['-axo', 'pgid=,stat='],
      { env: cleanEnvironment(), maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(
            new ExecutionUnconfirmedError('无法核对任务进程组，保留执行槽位。'),
          );
          return;
        }
        resolve(
          stdout.split('\n').some((line) => {
            const [group, state] = line.trim().split(/\s+/);
            return Number(group) === pgid && state && !state.startsWith('Z');
          }),
        );
      },
    ),
  );
}
export async function confirmGroupStopped(pgid: number) {
  const deadline = Date.now() + 5000;
  while (await groupAlive(pgid)) {
    if (Date.now() >= deadline)
      throw new ExecutionUnconfirmedError(
        '任务进程组未确认停止，保留执行槽位。',
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    timeout?: number;
    maxBytes?: number;
    markerDirectory?: string;
    homeDirectory?: string;
    gitSshCommand?: string;
    output?: (text: string, error: boolean) => void;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const marker = options.markerDirectory
      ? join(options.markerDirectory, 'process')
      : undefined;
    if (marker) writeFileSync(marker, 'pending\n', { mode: 0o600 });
    const child = spawn(
      marker ? 'bash' : command,
      marker
        ? [
            '-ec',
            'umask 077; printf "%s\\n%s\\n" "$$" "$(ps -p "$$" -o lstart=)" > "$1"; shift; exec "$@"',
            'builder-process',
            marker,
            command,
            ...args,
          ]
        : args,
      {
        cwd: options.cwd,
        env: {
          ...cleanEnvironment(),
          ...(options.homeDirectory ? { HOME: options.homeDirectory } : {}),
          ...(options.gitSshCommand
            ? { GIT_SSH_COMMAND: options.gitSshCommand }
            : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    let text = '',
      bytes = 0,
      failure: Error | undefined,
      escalation: ReturnType<typeof setTimeout> | undefined;
    function kill(signal: NodeJS.Signals) {
      try {
        if (child.pid)
          process.kill(
            process.platform === 'win32' ? child.pid : -child.pid,
            signal,
          );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH')
          failure ??= e as Error;
      }
    }
    function stop(error: Error) {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 1500);
    }
    const abort = () => stop(new Error('任务已请求停止。'));
    const timer = setTimeout(
      () => stop(new Error('命令执行超时。')),
      options.timeout ?? 120_000,
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const consume = (chunk: string, error: boolean) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > (options.maxBytes ?? 10 * 1024 * 1024)) {
        stop(new Error('日志超出 10 MB 限额。'));
        return;
      }
      text += chunk;
      try {
        options.output?.(chunk, error);
      } catch (e) {
        stop(e as Error);
      }
    };
    child.stdout.on('data', (c: string) => consume(c, false));
    child.stderr.on('data', (c: string) => consume(c, true));
    child.once('error', (e) => {
      failure = e;
    });
    child.once('close', async (code) => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener('abort', abort);
      // Terminate any children left behind after the command exits.
      kill('SIGKILL');
      try {
        if (child.pid) await confirmGroupStopped(child.pid);
      } catch (error) {
        reject(error);
        return;
      }
      if (marker) rmSync(marker, { force: true });
      if (failure) reject(failure);
      else if (code !== 0) reject(new ProcessExitError(code, text));
      else resolve(text);
    });
  });
}
