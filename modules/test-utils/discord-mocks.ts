import {vi} from "vitest";

type RegisteredEventHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type AcceptedEventHandler = (...args: never[]) => unknown | Promise<unknown>;
type EventRegistrar = <Handler extends AcceptedEventHandler>(eventName: string, handler: Handler) => EventClient;
type EventClient = {
  on: EventRegistrar;
  once: EventRegistrar;
};

export function createEventClient() {
  const handlers = new Map<string, RegisteredEventHandler>();

  const client = {} as EventClient;
  client.on = vi.fn((eventName: string, handler: AcceptedEventHandler) => {
    handlers.set(eventName, handler as unknown as RegisteredEventHandler);
    return client;
  });
  client.once = vi.fn((eventName: string, handler: AcceptedEventHandler) => {
    handlers.set(eventName, handler as unknown as RegisteredEventHandler);
    return client;
  });

  return {
    client,
    handlers,
    getHandler<Handler extends RegisteredEventHandler = RegisteredEventHandler>(eventName: string): Handler {
      const handler = handlers.get(eventName);
      if (!handler) {
        throw new Error(`Missing handler for ${eventName}.`);
      }

      return handler as Handler;
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
    author: undefined as {bot?: boolean; id?: string} | undefined,
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
    webhookId: undefined as string | null | undefined,
  };
}
