/**
 * Summary: Minimal interactive CLI that runs one prompt, surfaces approval
 * decisions inline, and prints the last message plus session state.
 */

import { stdin as input, stdout as output, stderr, argv, env, cwd, exit } from 'node:process';
import { createInterface } from 'node:readline/promises';

import type { AgentSession, Message, PendingToolApproval } from '../types/index.js';
import { createRuntime } from '../runtime/create-runtime.js';
import { DeepSeekProvider } from '../llm/deepseek.js';
import { formatPendingApproval, formatSessionSnapshot } from './render-output.js';

interface CliOptions {
  help: boolean;
  prompt?: string;
  sessionId?: string;
  maxSteps: number;
}

function parseArgs(args: string[]): CliOptions {
  const promptParts: string[] = [];
  let help = false;
  let sessionId: string | undefined;
  let maxSteps = 30;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (!arg) {
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--session') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('Missing value for --session.');
      }

      sessionId = value;
      index += 1;
      continue;
    }

    if (arg === '--max-steps') {
      const value = args[index + 1];
      if (!value) {
        throw new Error('Missing value for --max-steps.');
      }

      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid --max-steps value: ${value}`);
      }

      maxSteps = parsed;
      index += 1;
      continue;
    }

    promptParts.push(arg);
  }

  const prompt = promptParts.join(' ').trim();

  return {
    help,
    ...(prompt ? { prompt } : {}),
    ...(sessionId ? { sessionId } : {}),
    maxSteps,
  };
}

function printHelp(): void {
  output.write([
    'Minimal runtime CLI',
    '',
    'Usage:',
    '  npm run demo:cli -- "Read package.json and summarize this project."',
    '  npm run demo:cli -- --session demo-1 --max-steps 8 "Create tmp/demo.txt with hello and summarize it."',
    '',
    'Behavior:',
    '  - accepts a prompt from argv, or asks for one interactively',
    '  - pauses on pending approval and asks for approve or deny',
    '  - prints session status, approval summary, and the full message trace after each step',
    '',
    'Approval input:',
    '  approve',
    '  deny',
    '  deny reason for rejection',
    '',
  ].join('\n'));
}

function printPendingApproval(approval: PendingToolApproval, total: number): void {
  output.write(formatPendingApproval(approval, total));
}

function printSessionSnapshot(session: AgentSession): void {
  output.write(formatSessionSnapshot(session));
}

async function resolvePrompt(options: CliOptions, readline: ReturnType<typeof createInterface>): Promise<string> {
  if (options.prompt) {
    return options.prompt;
  }

  if (!input.isTTY) {
    throw new Error('Prompt is required when stdin is not interactive.');
  }

  const prompt = (await readline.question('prompt> ')).trim();
  if (!prompt) {
    throw new Error('Prompt cannot be empty.');
  }

  return prompt;
}

async function decideApproval(
  session: AgentSession,
  readline: ReturnType<typeof createInterface>,
  approve: (sessionId: string, approvalId: string) => Promise<AgentSession>,
  deny: (sessionId: string, approvalId: string, reason: string) => Promise<AgentSession>,
): Promise<AgentSession> {
  let currentSession = session;

  if (currentSession.status === 'awaiting_approval' && !input.isTTY) {
    throw new Error('Interactive approval requires a TTY.');
  }

  while (currentSession.status === 'awaiting_approval' && currentSession.pendingApprovals.length > 0) {
    const approval = currentSession.pendingApprovals[0];
    if (!approval) {
      break;
    }

    printPendingApproval(approval, currentSession.pendingApprovals.length);

    const answer = (await readline.question('approve or deny> ')).trim();
    if (answer === 'approve') {
      currentSession = await approve(currentSession.id, approval.id);
      printSessionSnapshot(currentSession);
      continue;
    }

    if (answer === 'deny' || answer.startsWith('deny ')) {
      const reason = answer === 'deny' ? 'Denied from minimal CLI.' : answer.slice(5).trim();
      currentSession = await deny(currentSession.id, approval.id, reason || 'Denied from minimal CLI.');
      printSessionSnapshot(currentSession);
      continue;
    }

    output.write('Type "approve" or "deny [reason]".\n');
  }

  return currentSession;
}

async function main(): Promise<void> {
  const options = parseArgs(argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('Missing DEEPSEEK_API_KEY. Copy .env.example to .env.local and fill in the key.');
  }

  const readline = createInterface({ input, output });

  try {
    const prompt = await resolvePrompt(options, readline);
    const model = env.DEEPSEEK_MODEL ?? 'deepseek-chat';
    const tokenizerDir = env.DEEPSEEK_TOKENIZER_DIR;
    const sessionId = options.sessionId ?? `cli-${Date.now()}`;
    const provider = new DeepSeekProvider({
      apiKey,
      model,
      ...(tokenizerDir ? { tokenizerDir } : {}),
    });

    const runtime = createRuntime({
      provider,
      model,
      rootDir: cwd(),
      maxSteps: options.maxSteps,
      systemPrompt: 'You are a precise coding agent. Keep tool_results adjacent to tool_calls.',
      hardConstraints: [
        'When the user names a specific workspace file, inspect that file directly before broad repository exploration.',
        'Prefer structured workspace tools such as read_file, edit_file, list_dir, and grep_search over bash for repository inspection.',
      ],
    });

    await runtime.engine.createSession(sessionId);
    await runtime.engine.submitUserInput(sessionId, prompt);
    await runtime.engine.confirmTurn(sessionId);

    let session = await runtime.engine.runTurn(sessionId, {
      extra: {
        thinking: { type: 'enabled' },
      },
    });

    printSessionSnapshot(session);

    session = await decideApproval(
      session,
      readline,
      (targetSessionId, approvalId) => runtime.engine.approvePendingToolCall(targetSessionId, approvalId),
      (targetSessionId, approvalId, reason) => runtime.engine.denyPendingToolCall(targetSessionId, approvalId, reason),
    );

    if (session.status === 'errored') {
      exit(1);
    }
  } finally {
    readline.close();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${message}\n`);
  exit(1);
});