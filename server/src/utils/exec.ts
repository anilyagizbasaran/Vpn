import { spawn } from 'node:child_process';

export interface RunOptions {
  /** Written to the child's stdin and then closed. Used for `wg pubkey`. */
  input?: string;
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Signature of {@link run}. Injectable so the WireGuard controller can be
 * tested against a recorded argv instead of a real `wg` binary.
 */
export type CommandRunner = (
  file: string,
  args: string[],
  options?: RunOptions,
) => Promise<RunResult>;

export class CommandError extends Error {
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(command: string, exitCode: number | null, stderr: string) {
    super(`Command failed (${command}, exit=${exitCode ?? 'signal'}): ${stderr.trim()}`);
    this.name = 'CommandError';
    this.command = command;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Runs a binary with an argv array — never through a shell — so peer keys and
 * labels coming from users can never be interpreted as shell syntax.
 */
export function run(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { input, timeoutMs = 10_000 } = options;

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new CommandError(`${file} ${args.join(' ')}`, null, `timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CommandError(`${file} ${args.join(' ')}`, null, err.message));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new CommandError(`${file} ${args.join(' ')}`, code, stderr));
    });

    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}
