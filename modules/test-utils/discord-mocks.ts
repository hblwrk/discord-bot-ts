import type {MockedFunction} from "vitest";

type EventHandler = (...args: any[]) => unknown | Promise<unknown>;
type EventClient = {
  on: MockedFunction<(eventName: string, handler: EventHandler) => EventClient>;
  once: MockedFunction<(eventName: string, handler: EventHandler) => EventClient>;
};

export function createEventClient() {
  const handlers = new Map<string, EventHandler>();

  const client = {} as EventClient;
  client.on = vi.fn((eventName: string, handler: EventHandler) => {
    handlers.set(eventName, handler);
    return client;
  });
  client.once = vi.fn((eventName: string, handler: EventHandler) => {
    handlers.set(eventName, handler);
    return client;
  });

  return {
    client,
    handlers,
    getHandler(eventName: string) {
      const handler = handlers.get(eventName);
      if (!handler) {
        throw new Error(`Missing handler for ${eventName}.`);
      }

      return handler;
    },
  };
}

export function createChatInputInteraction(commandName: string) {
  return {
    commandName,
    isChatInputCommand: vi.fn(() => true),
    options: {
      getString: vi.fn((_name?: string): string | null => null),
      getNumber: vi.fn((_name?: string): number | null => null),
      getInteger: vi.fn((_name?: string): number | null => null),
    },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    user: {
      id: "user-id",
      username: "user-name",
    },
    channel: "#general",
  };
}

export function createMessage(content: string) {
  return {
    content,
    channel: {
      send: vi.fn().mockResolvedValue(undefined),
    },
    guild: {
      emojis: {
        cache: {
          find: vi.fn(),
        },
      },
    },
    react: vi.fn().mockResolvedValue(undefined),
  };
}
