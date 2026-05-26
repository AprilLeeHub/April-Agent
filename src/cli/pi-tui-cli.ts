/**
 * Summary: Optional pi-tui-powered terminal UI with Markdown message cards,
 * approval overlays, and a live status sidebar for the agent runtime.
 */

import { argv, cwd, env, exit, stderr } from 'node:process';

import type {
  Component,
  DefaultTextStyle,
  MarkdownTheme,
  OverlayHandle,
  SelectItem,
  SelectListTheme,
} from '@earendil-works/pi-tui';

import type { AgentSession, PendingToolApproval } from '../types/index.js';
import { createRuntime } from '../runtime/create-runtime.js';
import { DeepSeekProvider } from '../llm/deepseek.js';
import {
  buildPiTuiSidebarSnapshot,
  buildSidebarMarkdown,
  formatApprovalForPiTui,
  formatMessageForPiTui,
} from './pi-tui-state.js';
import { loadPiTuiModule } from './pi-tui-support.js';

interface CliOptions {
  help: boolean;
  prompt?: string;
  sessionId?: string;
  maxSteps: number;
}

interface LoaderComponent extends Component {
  start(): void;
  stop(): void;
  setMessage(message: string): void;
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
  console.log([
    'April Agent pi-tui CLI',
    '',
    'Usage:',
    '  npm run demo:tui --',
    '  npm run demo:tui -- --session demo-1 --max-steps 8',
    '  npm run demo:tui -- "Read package.json and summarize this project."',
    '',
    'Requirements:',
    '  - Node >= 22.19.0',
    '  - npm install @earendil-works/pi-tui',
    '',
    'Slash commands inside the TUI:',
    '  /clear',
    '  /quit',
    '',
    'Approvals are handled in an overlay modal instead of /approve and /deny commands.',
  ].join('\n'));
}

function paint(code: string, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function foreground(code: number): (text: string) => string {
  return (text) => paint(`38;5;${code}`, text);
}

function background(code: number): (text: string) => string {
  return (text) => paint(`48;5;${code}`, text);
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

  const ui = await loadPiTuiModule();
  const {
    Box,
    Container,
    Input,
    Loader,
    Markdown,
    ProcessTerminal,
    SelectList,
    TUI,
    Text,
    matchesKey,
    truncateToWidth,
    visibleWidth,
  } = ui;

  const model = env.DEEPSEEK_MODEL ?? 'deepseek-chat';
  const tokenizerDir = env.DEEPSEEK_TOKENIZER_DIR;
  const sessionId = options.sessionId ?? `tui-${Date.now()}`;
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
    memory: {},
  });

  await runtime.engine.createSession(sessionId);

  const markdownTheme: MarkdownTheme = {
    heading: foreground(117),
    link: foreground(81),
    linkUrl: foreground(109),
    code: foreground(221),
    codeBlock: foreground(252),
    codeBlockBorder: foreground(240),
    quote: foreground(151),
    quoteBorder: foreground(72),
    hr: foreground(240),
    listBullet: foreground(117),
    bold: (text) => paint('1', text),
    italic: (text) => paint('3', text),
    strikethrough: (text) => paint('9', text),
    underline: (text) => paint('4', text),
    codeBlockIndent: '  ',
  };
  const roleTextStyles: Record<'user' | 'assistant' | 'tool' | 'system', DefaultTextStyle> = {
    user: { color: foreground(255) },
    assistant: { color: foreground(252) },
    tool: { color: foreground(252) },
    system: { color: foreground(250) },
  };
  const roleBackgrounds = {
    user: background(24),
    assistant: background(22),
    tool: background(237),
    system: background(239),
  } as const;
  const panelBackground = background(235);
  const approvalBackground = background(52);
  const selectListTheme: SelectListTheme = {
    selectedPrefix: (text) => paint('1;38;5;117', text),
    selectedText: (text) => paint('1;38;5;255', text),
    description: foreground(247),
    scrollInfo: foreground(240),
    noMatch: foreground(210),
  };

  // SplitPane keeps the chat feed and the status sidebar visible side-by-side on wide terminals.
  class SplitPane implements Component {
    constructor(
      private readonly left: Component,
      private readonly right: Component,
      private readonly sidebarWidth = 38,
    ) {}

    invalidate(): void {
      this.left.invalidate();
      this.right.invalidate();
    }

    render(width: number): string[] {
      if (width < 100) {
        return [
          ...this.left.render(width),
          '',
          ...this.right.render(width),
        ];
      }

      const separator = paint('38;5;240', ' │ ');
      const separatorWidth = visibleWidth(separator);
      const rightWidth = Math.min(this.sidebarWidth, Math.max(28, Math.floor(width * 0.34)));
      const leftWidth = Math.max(24, width - rightWidth - separatorWidth);
      const leftLines = this.left.render(leftWidth);
      const rightLines = this.right.render(rightWidth);
      const lineCount = Math.max(leftLines.length, rightLines.length);

      return Array.from({ length: lineCount }, (_, index) => {
        const leftLine = truncateToWidth(leftLines[index] ?? '', leftWidth, '', true);
        const rightLine = truncateToWidth(rightLines[index] ?? '', rightWidth, '', true);
        return `${leftLine}${separator}${rightLine}`;
      });
    }
  }

  // SidebarPanel projects runtime settings, memory hits, and the latest tool state into a stable side rail.
  class SidebarPanel implements Component {
    private readonly frame = new Box(1, 1, panelBackground);
    private readonly title = new Text(paint('1;38;5;117', 'Runtime Overview'), 0, 0);
    private readonly overview = new Markdown('', 0, 0, markdownTheme, { color: foreground(252) });
    private readonly events = new Markdown('', 0, 0, markdownTheme, { color: foreground(250) });

    constructor() {
      this.frame.addChild(this.title);
      this.frame.addChild(this.overview);
      this.frame.addChild(this.events);
    }

    setSnapshot(snapshot: ReturnType<typeof buildPiTuiSidebarSnapshot>): void {
      const sections = buildSidebarMarkdown(snapshot);
      this.overview.setText(sections.overview);
      this.events.setText(sections.recentEvents);
      this.invalidate();
    }

    invalidate(): void {
      this.frame.invalidate();
    }

    render(width: number): string[] {
      return this.frame.render(width);
    }
  }

  // ApprovalOverlay wraps the pending approval into a modal selector so users do not need slash commands.
  class ApprovalOverlay implements Component {
    private readonly frame = new Box(1, 1, approvalBackground);
    private readonly title = new Text(paint('1;38;5;255', 'Approval Required'), 0, 0);
    private readonly detail = new Markdown('', 0, 0, markdownTheme, { color: foreground(255) });
    private readonly hint = new Text(paint('38;5;224', 'Use ↑/↓ and Enter to resolve this tool call.'), 0, 0);
    private readonly actions: InstanceType<typeof SelectList>;

    constructor(
      approval: PendingToolApproval,
      onApprove: () => void,
      onDeny: () => void,
    ) {
      const items: SelectItem[] = [
        {
          value: 'approve',
          label: 'Approve',
          description: 'Execute the blocked tool call and continue reasoning.',
        },
        {
          value: 'deny',
          label: 'Deny',
          description: 'Reject the blocked tool call with the default deny reason.',
        },
      ];
      this.actions = new SelectList(items, items.length, selectListTheme);
      this.actions.onSelect = (item) => {
        if (item.value === 'approve') {
          onApprove();
          return;
        }

        onDeny();
      };
      // Escape 只关闭选择，不直接做 destructive 操作；真正的决策仍由 Enter 明确触发。
      this.actions.onCancel = () => undefined;

      this.detail.setText(formatApprovalForPiTui(approval));
      this.frame.addChild(this.title);
      this.frame.addChild(this.detail);
      this.frame.addChild(this.hint);
      this.frame.addChild(this.actions);
    }

    invalidate(): void {
      this.frame.invalidate();
    }

    handleInput(data: string): void {
      this.actions.handleInput(data);
    }

    render(width: number): string[] {
      return this.frame.render(width);
    }
  }

  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const header = new Text(
    paint('1;38;5;117', 'April Agent TUI') + '\n' + paint('38;5;244', 'Commands: /clear, /quit · approvals appear as a modal'),
    0,
    0,
  );
  const feed = new Container();
  const sidebar = new SidebarPanel();
  const mainLayout = new SplitPane(feed, sidebar);
  const promptLabel = new Text(paint('38;5;111', 'Prompt'), 0, 0);
  const promptInput = new Input();

  let currentSession: AgentSession | undefined;
  let activeLoader: LoaderComponent | undefined;
  let approvalOverlayHandle: OverlayHandle | undefined;
  let approvalOverlayId: string | undefined;
  let liveRefreshTimer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  const renderedMessageIds = new Set<string>();

  tui.addChild(header);
  tui.addChild(mainLayout);
  tui.addChild(promptLabel);
  tui.addChild(promptInput);
  tui.setFocus(promptInput);

  const refreshSidebar = () => {
    const snapshot = buildPiTuiSidebarSnapshot({
      model,
      busy,
      memoryEnabled: true,
      events: runtime.observability.list(sessionId),
      ...(currentSession ? { session: currentSession } : {}),
    });
    sidebar.setSnapshot(snapshot);
  };

  const showInfoCard = (message: string) => {
    const card = new Box(1, 1, roleBackgrounds.system);
    card.addChild(new Text(paint('1;38;5;255', 'Info'), 0, 0));
    card.addChild(new Markdown(message, 0, 0, markdownTheme, roleTextStyles.system));
    feed.addChild(card);
    tui.requestRender();
  };

  const createMessageCard = (message: AgentSession['messages'][number]): Component => {
    const formatted = formatMessageForPiTui(message);
    const card = new Box(1, 1, roleBackgrounds[formatted.kind]);
    card.addChild(new Text(paint('1;38;5;255', formatted.title), 0, 0));
    card.addChild(new Markdown(formatted.markdown, 0, 0, markdownTheme, roleTextStyles[formatted.kind]));
    return card;
  };

  const syncSessionMessages = (session: AgentSession) => {
    for (const message of session.messages) {
      if (message.role === 'system' || renderedMessageIds.has(message.id)) {
        continue;
      }

      renderedMessageIds.add(message.id);
      feed.addChild(createMessageCard(message));
    }

    tui.requestRender();
  };

  const clearFeed = () => {
    feed.clear();
    renderedMessageIds.clear();
    if (activeLoader) {
      activeLoader.stop();
      activeLoader = undefined;
    }
    tui.requestRender();
  };

  const removeLoader = () => {
    if (!activeLoader) {
      return;
    }

    activeLoader.stop();
    feed.removeChild(activeLoader);
    activeLoader = undefined;
    tui.requestRender();
  };

  const showLoader = (message: string) => {
    removeLoader();
    activeLoader = new Loader(tui, foreground(117), foreground(244), message) as LoaderComponent;
    feed.addChild(activeLoader);
    activeLoader.start();
    tui.requestRender();
  };

  const hideApprovalOverlay = () => {
    approvalOverlayHandle?.hide();
    approvalOverlayHandle = undefined;
    approvalOverlayId = undefined;
  };

  const stopLiveRefresh = () => {
    if (!liveRefreshTimer) {
      return;
    }

    clearInterval(liveRefreshTimer);
    liveRefreshTimer = undefined;
  };

  const syncApprovalOverlay = (
    onApprove: () => void,
    onDeny: () => void,
  ) => {
    if (busy) {
      hideApprovalOverlay();
      return;
    }

    const approval = currentSession?.pendingApprovals[0];
    if (!approval) {
      hideApprovalOverlay();
      tui.setFocus(promptInput);
      return;
    }

    if (approvalOverlayId === approval.id) {
      return;
    }

    hideApprovalOverlay();
    const overlay = new ApprovalOverlay(approval, onApprove, onDeny);
    approvalOverlayHandle = tui.showOverlay(overlay, {
      width: '62%',
      minWidth: 48,
      maxHeight: '60%',
      anchor: 'center',
      margin: 2,
    });
    approvalOverlayHandle.focus();
    approvalOverlayId = approval.id;
  };

  const refreshUi = (
    onApprove: () => void,
    onDeny: () => void,
  ) => {
    refreshSidebar();
    syncApprovalOverlay(onApprove, onDeny);
    tui.requestRender();
  };

  const startLiveRefresh = (
    onApprove: () => void,
    onDeny: () => void,
  ) => {
    stopLiveRefresh();
    liveRefreshTimer = setInterval(() => {
      refreshUi(onApprove, onDeny);
    }, 120);
  };

  const runTurn = async (prompt: string) => {
    await runtime.engine.submitUserInput(sessionId, prompt);
    await runtime.engine.confirmTurn(sessionId);
    currentSession = await runtime.engine.runTurn(sessionId, {
      extra: {
        thinking: { type: 'enabled' },
      },
    });
  };

  const approvePending = async () => {
    const approval = currentSession?.pendingApprovals[0];
    if (!currentSession || !approval) {
      showInfoCard('No pending approval to resolve.');
      return;
    }

    currentSession = await runtime.engine.approvePendingToolCall(sessionId, approval.id, {
      extra: {
        thinking: { type: 'enabled' },
      },
    });
  };

  const denyPending = async () => {
    const approval = currentSession?.pendingApprovals[0];
    if (!currentSession || !approval) {
      showInfoCard('No pending approval to resolve.');
      return;
    }

    currentSession = await runtime.engine.denyPendingToolCall(sessionId, approval.id, 'Denied from pi-tui overlay.', {
      extra: {
        thinking: { type: 'enabled' },
      },
    });
  };

  const executeTurn = async (action: () => Promise<void>, loaderMessage: string) => {
    if (busy) {
      showInfoCard('The agent is still working. Wait for the current turn to finish.');
      return;
    }

    busy = true;
    hideApprovalOverlay();
    showLoader(loaderMessage);
    refreshUi(() => { void resolveApproval('approve'); }, () => { void resolveApproval('deny'); });
    startLiveRefresh(() => { void resolveApproval('approve'); }, () => { void resolveApproval('deny'); });

    try {
      await action();
      if (currentSession) {
        syncSessionMessages(currentSession);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showInfoCard(`Execution failed\n\n${message}`);
    } finally {
      busy = false;
      stopLiveRefresh();
      removeLoader();
      refreshUi(() => { void resolveApproval('approve'); }, () => { void resolveApproval('deny'); });
      if (!currentSession?.pendingApprovals.length) {
        tui.setFocus(promptInput);
      }
    }
  };

  const resolveApproval = async (decision: 'approve' | 'deny') => {
    await executeTurn(
      () => decision === 'approve' ? approvePending() : denyPending(),
      decision === 'approve' ? 'Approving tool call...' : 'Denying tool call...',
    );
  };

  const handleSubmit = async (value: string) => {
    const trimmed = value.trim();
    promptInput.setValue('');
    tui.requestRender();

    if (!trimmed) {
      return;
    }

    if (trimmed === '/quit') {
      stopLiveRefresh();
      tui.stop();
      exit(0);
    }

    if (trimmed === '/clear') {
      clearFeed();
      refreshUi(() => { void resolveApproval('approve'); }, () => { void resolveApproval('deny'); });
      return;
    }

    await executeTurn(() => runTurn(trimmed), 'Agent is thinking...');
  };

  promptInput.onSubmit = (value: string) => {
    void handleSubmit(value);
  };

  tui.addInputListener((data: string) => {
    if (matchesKey(data, 'ctrl+c')) {
      stopLiveRefresh();
      tui.stop();
      exit(0);
    }

    return undefined;
  });

  refreshUi(() => { void resolveApproval('approve'); }, () => { void resolveApproval('deny'); });
  tui.start();
  if (options.prompt) {
    void handleSubmit(options.prompt);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`${message}\n`);
  exit(1);
});