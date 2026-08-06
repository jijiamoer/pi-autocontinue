export interface MockMessage {
  message: Record<string, unknown>;
  options?: Record<string, unknown>;
}

export interface MockPi {
  handlers: Map<string, Array<(event: any, ctx: any) => any>>;
  commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
  tools: Array<Record<string, any>>;
  entries: Array<{ type: string; data: any }>;
  sentMessages: MockMessage[];
  activeTools: string[];
  api: Record<string, any>;
  fire(event: string, value: any, ctx: any): Promise<void>;
  command(name: string): { handler: (args: string, ctx: any) => Promise<void> };
  tool(name: string): Record<string, any>;
}

export function createMockPi(): MockPi {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, any>();
  const tools: Array<Record<string, any>> = [];
  const entries: Array<{ type: string; data: any }> = [];
  const sentMessages: MockMessage[] = [];
  const activeTools = ["read", "bash"];

  const api = {
    on(event: string, handler: (event: any, ctx: any) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name: string, definition: any) {
      commands.set(name, definition);
    },
    registerTool(tool: Record<string, any>) {
      tools.push(tool);
    },
    appendEntry(type: string, data: any) {
      entries.push({ type, data });
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(next: string[]) {
      activeTools.splice(0, activeTools.length, ...next);
    },
    sendMessage(message: Record<string, unknown>, options?: Record<string, unknown>) {
      sentMessages.push({ message, options });
    },
  };

  return {
    handlers,
    commands,
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
}

export interface MockContext {
  ctx: Record<string, any>;
  status: Map<string, unknown>;
  notifications: Array<{ message: string; level: string }>;
}

export function createMockContext(options: MockContextOptions = {}): MockContext {
  const status = new Map<string, unknown>();
  const notifications: Array<{ message: string; level: string }> = [];
  let idle = options.idle ?? true;
  const branch = options.branch ?? [
    {
      type: "message",
      message: { role: "user", content: "Existing user task" },
    },
  ];

  const ctx = {
    cwd: options.cwd ?? "/tmp/pi-autocontinue-test-missing",
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
    },
  };

  return { ctx, status, notifications };
}

export function stateEntry(data: Record<string, unknown>): any {
  return {
    type: "custom",
    customType: "autocontinue-state",
    data: {
      phase: "running",
      maxAttempts: 10,
      attemptsUsed: 0,
      startedAt: 1,
      templateSource: "built-in",
      ...data,
    },
  };
}
