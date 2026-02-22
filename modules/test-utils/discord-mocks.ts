type EventHandler = (...args: any[]) => unknown | Promise<unknown>;

export function createEventClient() {
  const handlers = new Map<string, EventHandler>();

  const client = {
    on: jest.fn((eventName: string, handler: EventHandler) => {
      handlers.set(eventName, handler);
      return client;
    }),
    once: jest.fn((eventName: string, handler: EventHandler) => {
      handlers.set(eventName, handler);
      return client;
    }),
  };

  return {
    client,
    handlers,
    getHandler(eventName: string) {
      return handlers.get(eventName);
    },
  };
}

export function createChatInputInteraction(commandName: string) {
  return {
    commandName,
    isChatInputCommand: jest.fn(() => true),
    options: {
      getString: jest.fn((_name?: string) => null),
      getNumber: jest.fn((_name?: string) => null),
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
