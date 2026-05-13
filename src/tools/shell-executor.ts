/**
 * Summary: Safe shell and git execution via execFile plus argv arrays, never
 * string-built shell commands, to keep command injection out of the runtime.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ShellExecutionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface ShellExecutionResult {
  stdout: string;
  stderr: string;
}

export class ShellExecutionError extends Error {
  constructor(message: string, readonly stdout: string, readonly stderr: string) {
    super(message);
    this.name = 'ShellExecutionError';
  }
}

export class ShellExecutor {
  async run(command: string, args: string[], options: ShellExecutionOptions = {}): Promise<ShellExecutionResult> {
    if (!Array.isArray(args)) {
      throw new Error('ShellExecutor.run requires argv as a string array.');
    }

    return this.execute(command, args, options);
  }

  async runCommandLine(
    commandLine: string,
    options: ShellExecutionOptions = {},
    shellPath = process.env.SHELL ?? '/bin/sh',
  ): Promise<ShellExecutionResult> {
    if (!commandLine.trim()) {
      throw new Error('ShellExecutor.runCommandLine requires a non-empty command string.');
    }

    return this.execute(shellPath, ['-lc', commandLine], options);
  }

  private async execute(command: string, args: string[], options: ShellExecutionOptions): Promise<ShellExecutionResult> {
    try {
      const result = await execFileAsync(command, args, {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        shell: false,
      });

      return {
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      const stdout = error instanceof Error && 'stdout' in error ? String((error as { stdout?: unknown }).stdout ?? '') : '';
      const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : '';
      throw new ShellExecutionError(error instanceof Error ? error.message : String(error), stdout, stderr);
    }
  }
}