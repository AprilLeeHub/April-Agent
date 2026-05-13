/**
 * Summary: Built-in command execution tool that routes local and networked
 * process calls through the safe ShellExecutor with approval gating.
 */

import type { ToolDefinition, ToolApprovalRequirement } from '../../types/index.js';
import { ShellExecutor } from '../shell-executor.js';
import { resolveWorkspacePath, resolveWorkspaceRoot, toWorkspaceRelative } from './workspace-paths.js';

interface BashToolOptions {
  rootDir: string;
  executor?: ShellExecutor;
  defaultTimeoutMs?: number;
  allowedEnvVars?: string[];
}

interface BashInput {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  shellCommand?: string;
}

const bashInputSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'Executable name only, such as "node", "git", or "ls". If args is omitted, a full shell command line is also accepted, including pipes, redirects, and multiple commands.',
    },
    args: {
      type: 'array',
      description: 'Optional argv tokens already split into separate strings. Example: ["-e", "console.log(1)"]. Do not put pipes, redirects, or semicolons here.',
      items: {
        type: 'string',
      },
    },
    cwd: {
      type: 'string',
      description: 'Optional workspace-relative working directory.',
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
    },
    env: {
      type: 'object',
      additionalProperties: {
        type: 'string',
      },
    },
  },
  required: ['command'],
  additionalProperties: false,
} as const;

const NETWORK_COMMANDS = new Set(['curl', 'wget', 'scp', 'ssh']);
const DESTRUCTIVE_COMMANDS = new Set(['rm', 'sudo', 'dd', 'mkfs']);
const GLOBAL_INSTALL_COMMANDS = new Set(['npm', 'pnpm', 'yarn']);

function ensureObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Tool input must be an object.');
  }

  return input as Record<string, unknown>;
}

function tokenizeCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let activeQuote: 'single' | 'double' | undefined;
  let escaping = false;
  let tokenStarted = false;

  for (const char of commandLine) {
    if (escaping) {
      current += char;
      tokenStarted = true;
      escaping = false;
      continue;
    }

    if (activeQuote === 'single') {
      if (char === "'") {
        activeQuote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (activeQuote === 'double') {
      if (char === '"') {
        activeQuote = undefined;
        continue;
      }

      if (char === '\\') {
        escaping = true;
        tokenStarted = true;
        continue;
      }

      current += char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }

    if (char === "'") {
      activeQuote = 'single';
      tokenStarted = true;
      continue;
    }

    if (char === '"') {
      activeQuote = 'double';
      tokenStarted = true;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    current += char;
    tokenStarted = true;
  }

  if (escaping) {
    throw new Error('bash command contains a trailing escape character.');
  }

  if (activeQuote) {
    throw new Error('bash command contains an unterminated quote.');
  }

  if (tokenStarted) {
    tokens.push(current);
  }

  return tokens;
}

function containsShellSyntax(commandLine: string): boolean {
  let activeQuote: 'single' | 'double' | undefined;
  let escaping = false;

  for (const char of commandLine) {
    if (escaping) {
      escaping = false;
      continue;
    }

    if (activeQuote === 'single') {
      if (char === "'") {
        activeQuote = undefined;
      }
      continue;
    }

    if (activeQuote === 'double') {
      if (char === '"') {
        activeQuote = undefined;
        continue;
      }

      if (char === '\\') {
        escaping = true;
      }
      continue;
    }

    if (char === "'") {
      activeQuote = 'single';
      continue;
    }

    if (char === '"') {
      activeQuote = 'double';
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (char === ';' || char === '|' || char === '&' || char === '<' || char === '>') {
      return true;
    }
  }

  return false;
}

function commandAppearsInShell(commandLine: string, commands: Set<string>): boolean {
  return [...commands].some((command) => {
    const pattern = new RegExp(`(^|[\\s;|&()])${command}(?=$|[\\s;|&()])`);
    return pattern.test(commandLine);
  });
}

function normalizeBashInput(input: BashInput): BashInput {
  if (input.args) {
    return input;
  }

  const tokens = tokenizeCommandLine(input.command);
  const [command, ...args] = tokens;
  if (!command) {
    throw new Error('bash requires a non-empty command string.');
  }

  return {
    ...input,
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(containsShellSyntax(input.command) ? { shellCommand: input.command } : {}),
  };
}

function parseBashInput(input: unknown): BashInput {
  const payload = ensureObject(input);
  if (typeof payload.command !== 'string' || payload.command.length === 0) {
    throw new Error('bash requires a non-empty command string.');
  }

  if (payload.args !== undefined && (!Array.isArray(payload.args) || payload.args.some((arg) => typeof arg !== 'string'))) {
    throw new Error('bash args must be a string array when provided.');
  }

  if (payload.cwd !== undefined && typeof payload.cwd !== 'string') {
    throw new Error('bash cwd must be a string when provided.');
  }

  if (payload.timeoutMs !== undefined && (!Number.isInteger(payload.timeoutMs) || Number(payload.timeoutMs) < 1)) {
    throw new Error('bash timeoutMs must be a positive integer when provided.');
  }

  if (payload.env !== undefined) {
    const env = ensureObject(payload.env);
    for (const value of Object.values(env)) {
      if (typeof value !== 'string') {
        throw new Error('bash env values must all be strings.');
      }
    }
  }

  return normalizeBashInput({
    command: payload.command,
    ...(payload.args ? { args: payload.args as string[] } : {}),
    ...(payload.cwd ? { cwd: payload.cwd as string } : {}),
    ...(payload.timeoutMs ? { timeoutMs: Number(payload.timeoutMs) } : {}),
    ...(payload.env ? { env: payload.env as Record<string, string> } : {}),
  });
}

function detectApprovalRequirement(input: BashInput): ToolApprovalRequirement | undefined {
  if (input.shellCommand) {
    if (commandAppearsInShell(input.shellCommand, NETWORK_COMMANDS)) {
      return {
        reason: 'shell_network',
        risk: 'high',
        message: 'The shell command performs external network access and requires approval.',
      };
    }

    if (commandAppearsInShell(input.shellCommand, DESTRUCTIVE_COMMANDS)) {
      return {
        reason: 'shell_destructive',
        risk: 'high',
        message: 'The shell command includes a destructive operation and requires approval.',
      };
    }

    if (/\bnpm\s+install\s+-g\b/.test(input.shellCommand) || /\bpnpm\s+add\s+-g\b/.test(input.shellCommand) || /\byarn\s+global\b/.test(input.shellCommand)) {
      return {
        reason: 'shell_global_install',
        risk: 'high',
        message: 'The shell command includes a global installation and requires approval.',
      };
    }
  }

  // 所有外联、破坏性和全局安装命令都先收口到审批，避免 bash 成为绕过审计的后门。
  if (NETWORK_COMMANDS.has(input.command)) {
    return {
      reason: 'shell_network',
      risk: 'high',
      message: `${input.command} performs external network access and requires approval.`,
    };
  }

  if (DESTRUCTIVE_COMMANDS.has(input.command)) {
    return {
      reason: 'shell_destructive',
      risk: 'high',
      message: `${input.command} is considered destructive and requires approval.`,
    };
  }

  if (GLOBAL_INSTALL_COMMANDS.has(input.command)) {
    const args = input.args ?? [];
    const isGlobalInstall =
      (input.command === 'npm' && args.includes('install') && args.includes('-g'))
      || (input.command === 'pnpm' && args.includes('add') && args.includes('-g'))
      || (input.command === 'yarn' && args[0] === 'global');

    if (isGlobalInstall) {
      return {
        reason: 'shell_global_install',
        risk: 'high',
        message: `${input.command} global installation requires approval.`,
      };
    }
  }

  return undefined;
}

export function createBashTool(options: BashToolOptions): ToolDefinition {
  const executor = options.executor ?? new ShellExecutor();
  const allowedEnvVars = new Set(options.allowedEnvVars ?? []);

  return {
    name: 'bash',
    description: 'Execute a local command through the safe shell executor. Prefer command plus argv args; a full command line string is also accepted when args is omitted.',
    outputKind: 'shell',
    inputSchema: bashInputSchema,
    validate: (input) => {
      parseBashInput(input);
    },
    requiresApproval: (input) => detectApprovalRequirement(parseBashInput(input)),
    execute: async (input) => {
      const parsed = parseBashInput(input);
      const rootPath = await resolveWorkspaceRoot(options.rootDir);
      const cwdPath = parsed.cwd
        ? (await resolveWorkspacePath(options.rootDir, parsed.cwd)).resolvedPath
        : rootPath;
      const env = parsed.env
        ? Object.fromEntries(
            Object.entries(parsed.env).filter(([key]) => allowedEnvVars.has(key)),
          )
        : undefined;

      const result = parsed.shellCommand
        ? await executor.runCommandLine(parsed.shellCommand, {
            cwd: cwdPath,
            timeoutMs: parsed.timeoutMs ?? options.defaultTimeoutMs ?? 15_000,
            ...(env ? { env: { ...process.env, ...env } } : {}),
          })
        : await executor.run(parsed.command, parsed.args ?? [], {
            cwd: cwdPath,
            timeoutMs: parsed.timeoutMs ?? options.defaultTimeoutMs ?? 15_000,
            ...(env ? { env: { ...process.env, ...env } } : {}),
          });

      return {
        command: parsed.command,
        executionPath: parsed.shellCommand ? 'shell.command_line' : 'shell.argv',
        ...(parsed.shellCommand ? { shellCommand: parsed.shellCommand } : {}),
        args: parsed.args ?? [],
        cwd: toWorkspaceRelative(rootPath, cwdPath),
        stdout: result.stdout,
        stderr: result.stderr,
      };
    },
  };
}