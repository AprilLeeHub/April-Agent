import { createRuntime, DeepSeekProvider, smallModelSummaryConfig } from '../dist/src/index.js';

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error('Missing DEEPSEEK_API_KEY. Copy .env.example to .env.local and fill in the key.');
  process.exit(1);
}

const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
const tokenizerDir = process.env.DEEPSEEK_TOKENIZER_DIR;
const prompt = process.argv.slice(2).join(' ') || 'Read package.json and summarize this project.';
const sessionId = `demo-${Date.now()}`;

const provider = new DeepSeekProvider({
  apiKey,
  model,
  ...(tokenizerDir ? { tokenizerDir } : {}),
});

const runtime = createRuntime({
  provider,
  model,
  rootDir: process.cwd(),
  maxSteps: 6,
  systemPrompt: 'You are a precise coding agent. Keep tool_results adjacent to tool_calls.',
  summary: {
    config: {
      ...smallModelSummaryConfig,
      model,
    },
  },
});

await runtime.engine.createSession(sessionId);
await runtime.engine.submitUserInput(sessionId, prompt);
await runtime.engine.confirmTurn(sessionId);

const session = await runtime.engine.runTurn(sessionId, {
  extra: {
    thinking: { type: 'enabled' },
  },
});

const tailMessages = session.messages.slice(-6).map((message) => {
  if (message.role === 'tool') {
    return {
      role: message.role,
      toolName: message.toolName,
      text: message.content.text,
      metadata: message.content.metadata,
    };
  }

  return {
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
  };
});

const tokenEvents = runtime.observability
  .list(sessionId)
  .filter((event) => event.decision === 'llm.request' || event.decision === 'llm.response')
  .map((event) => ({
    decision: event.decision,
    state: event.state,
    message: event.message,
    metadata: event.metadata,
  }));

const compressionEvents = runtime.observability
  .list(sessionId)
  .filter((event) => event.decision === 'compression.micro' || event.decision === 'compression.summary')
  .map((event) => ({
    decision: event.decision,
    state: event.state,
    message: event.message,
    metadata: event.metadata,
  }));

console.log(JSON.stringify({
  sessionId,
  status: session.status,
  terminationReason: session.terminationReason,
  ...(session.lastError ? { lastError: session.lastError } : {}),
  ...(session.errorMessage ? { errorMessage: session.errorMessage } : {}),
  pendingApprovals: session.pendingApprovals,
  tokenUsage: tokenEvents,
  compression: compressionEvents,
  tailMessages,
}, null, 2));

if (session.status === 'awaiting_approval') {
  console.error('The run paused for approval. Inspect pendingApprovals and approve or deny from your host application.');
}