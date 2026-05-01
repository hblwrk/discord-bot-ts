type EventHandler = (...args: any[]) => unknown | Promise<unknown>;
type EventClient = {
  on: jest.MockedFunction<(eventName: string, handler: EventHandler) => EventClient>;
  once: jest.MockedFunction<(eventName: string, handler: EventHandler) => EventClient>;
};

export function createEventClient() {
  const handlers = new Map<string, EventHandler>();

  const client = {} as EventClient;
  client.on = jest.fn((eventName: string, handler: EventHandler) => {
    handlers.set(eventName, handler);
    return client;
  });
  client.once = jest.fn((eventName: string, handler: EventHandler) => {
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
    isChatInputCommand: jest.fn(() => true),
    options: {
      getString: jest.fn((_name?: string): string | null => null),
      getNumber: jest.fn((_name?: string): number | null => null),
      getInteger: jest.fn((_name?: string): number | null => null),
    },
    deferReply: jest.fn().mockResolvedValue(undefined),
    editReply: jest.fn().mockResolvedValue(undefined),
    reply: jest.fn().mockResolvedValue(undefined),
    followUp: jest.fn().mockResolvedValue(undefined),
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
      send: jest.fn().mockResolvedValue(undefined),
    },
    guild: {
      emojis: {
        cache: {
          find: jest.fn(),
        },
      },
    },
    react: jest.fn().mockResolvedValue(undefined),
  };
}
