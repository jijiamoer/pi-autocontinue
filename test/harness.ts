export interface MockMessage {
  message: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export interface MockPi {
  handlers: Map<string, Array<(event: any, ctx: any) => any>>;
  commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
  entryRenderers: Map<string, (...args: any[]) => any>;
  messageRenderers: Map<string, (...args: any[]) => any>;
  tools: Array<Record<string, any>>;
  entries: Array<{ type: string; data: any }>;
  sentMessages: MockMessage[];
  activeTools: string[];
  api: Record<string, any>;
  fire(event: string, value: any, ctx: any): Promise<void>;
  command(name: string): { handler: (args: string, ctx: any) => Promise<void> };
  tool(name: string): Record<string, any>;
}

function createEntryAppender(branch: any[]) {
  return (entry: Record<string, unknown>) => {
    const sequence = branch.length + 1;
    const normalized = {
      id: `e${sequence.toString(16).padStart(7, "0")}`,
      parentId: branch.at(-1)?.id ?? null,
      timestamp: new Date(sequence * 1000).toISOString(),
      ...entry,
    };
    branch.push(normalized);
    return normalized;
  };
}

export function createMockPi(branch: any[] = []): MockPi {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, any>();
  const entryRenderers = new Map<string, (...args: any[]) => any>();
  const messageRenderers = new Map<string, (...args: any[]) => any>();
  const tools: Array<Record<string, any>> = [];
  const entries: Array<{ type: string; data: any }> = [];
  const sentMessages: MockMessage[] = [];
  const activeTools = ["read", "bash"];
  const appendBranchEntry = createEntryAppender(branch);

  const api = {
    on(event: string, handler: (event: any, ctx: any) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
    registerEntryRenderer(type: string, renderer: (...args: any[]) => any) {
      entryRenderers.set(type, renderer);
    },
    registerMessageRenderer(type: string, renderer: (...args: any[]) => any) {
      messageRenderers.set(type, renderer);
    },
    registerTool(tool: Record<string, any>) {
      tools.push(tool);
    },
    appendEntry(type: string, data: any) {
      entries.push({ type, data });
      appendBranchEntry({ type: "custom", customType: type, data });
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(next: string[]) {
      activeTools.splice(0, activeTools.length, ...next);
    },
    sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
      sentMessages.push({ message, options });
      appendBranchEntry({
        type: "custom_message",
        customType: message.customType,
        content: message.content,
        display: message.display,
        details: message.details,
      });
    },
  };

  return {
    handlers,
    commands,
    entryRenderers,
    messageRenderers,
    tools,
    entries,
    sentMessages,
    activeTools,
    api,
    async fire(event, value, ctx) {
      for (const handler of handlers.get(event) ?? []) await handler(value, ctx);
    },
    command: (name) => commands.get(name),
    tool: (name) => tools.find((tool) => tool.name === name) as Record<string, any>,
  };
}

export interface MockContextOptions {
  cwd?: string;
  branch?: any[];
  trusted?: boolean;
  idle?: boolean;
  contextWindow?: number;
}

export interface MockContext {
  ctx: Record<string, any>;
  status: Map<string, unknown>;
  notifications: Array<{ message: string; level: string }>;
  branch: any[];
  appendAssistant(message?: Record<string, unknown>): any;
}

export function createMockContext(options: MockContextOptions = {}): MockContext {
  const status = new Map<string, unknown>();
  const notifications: Array<{ message: string; level: string }> = [];
  let idle = options.idle ?? true;
  const initialBranch = options.branch ?? [
    {
      type: "message",
      message: { role: "user", content: "Existing user task", timestamp: 1 },
    },
  ];
  const branch: any[] = [];
  const appendBranchEntry = createEntryAppender(branch);
  for (const entry of initialBranch) appendBranchEntry(entry);

  const ctx = {
    cwd: options.cwd ?? "/tmp/pi-autocontinue-test-missing",
    model: { contextWindow: options.contextWindow ?? 200_000 },
    isProjectTrusted: () => options.trusted ?? true,
    isIdle: () => idle,
    setIdle(value: boolean) {
      idle = value;
    },
    ui: {
      setStatus(id: string, value: unknown) {
        if (value === undefined) status.delete(id);
        else status.set(id, value);
      },
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
    sessionManager: {
      getBranch: () => branch,
      getLeafId: () => branch.at(-1)?.id ?? null,
      getSessionId: () => "mock-session",
    },
  };

  return {
    ctx,
    status,
    notifications,
    branch,
    appendAssistant(message: Record<string, unknown> = {}) {
      return appendBranchEntry({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Progress" }],
          api: "openai-responses",
          provider: "test",
          model: "test-model",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
          ...message,
        },
      });
    },
  };
}

export function stateEntry(data: Record<string, unknown>): any {
  return {
    type: "custom",
    customType: "autocontinue-state",
    data: {
      version: 2,
      cycleId: "test-cycle",
      phase: "running",
      maxAttempts: 10,
      attemptsUsed: 0,
      recoveryAttemptsUsed: 0,
      startedAt: 1,
      templateSource: "built-in",
      ...data,
    },
  };
}
