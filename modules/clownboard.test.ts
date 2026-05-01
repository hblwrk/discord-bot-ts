import {clownboard} from "./clownboard.js";

type EventHandler = (...args: unknown[]) => Promise<void>;
type ClownboardTestClient = {
  on: jest.MockedFunction<(eventName: string, handler: EventHandler) => ClownboardTestClient>;
  channels: {
    cache: {
      get: jest.Mock;
    };
  };
};

function createClientWithHandlers(clownboardChannel: unknown) {
  const handlers = new Map<string, EventHandler>();

  const client = {} as ClownboardTestClient;
  client.on = jest.fn((eventName: string, handler: EventHandler) => {
    handlers.set(eventName, handler);
    return client;
  });
  client.channels = {
    cache: {
      get: jest.fn(() => clownboardChannel),
    },
  };

  return {
    client,
    getHandler(eventName: string) {
      const handler = handlers.get(eventName);
      if (!handler) {
        throw new Error(`Missing handler for ${eventName}.`);
      }

      return handler;
    },
  };
}

function createReaction(count: number) {
  return {
    emoji: {name: "🤡"},
    count,
    fetch: jest.fn().mockResolvedValue(undefined),
    message: {
      id: "source-message-id",
      channel: {
        id: "source-channel-id",
        toString: () => "#source-channel",
      },
      attachments: {
        first: () => undefined,
      },
      author: {
        tag: "user#0001",
        displayAvatarURL: () => "https://avatar.example",
      },
      content: "content",
      url: "https://discord.example/jump",
      partial: false,
      fetch: jest.fn().mockResolvedValue(undefined),
    },
  };
}

describe("clownboard", () => {
  test("posts to clownboard when threshold is reached", async () => {
    const messages = {find: jest.fn(() => undefined)};
    const clownboardChannel = {
      messages: {
        fetch: jest.fn().mockResolvedValue(messages),
      },
      send: jest.fn().mockResolvedValue(undefined),
    };

    const {client, getHandler} = createClientWithHandlers(clownboardChannel);
    clownboard(client as any, "clownboard-channel-id");

    const handler = getHandler("messageReactionAdd");
    await handler(createReaction(10), {id: "user-1"});

    expect(clownboardChannel.messages.fetch).toHaveBeenCalledWith({limit: 100});
    expect(clownboardChannel.send).toHaveBeenCalledTimes(1);
  });

  test("schedules delete when reaction count drops to threshold", async () => {
    jest.useFakeTimers();

    const existingMessage = {
      delete: jest.fn().mockResolvedValue(undefined),
      edit: jest.fn().mockResolvedValue(undefined),
    };
    const messages = {find: jest.fn(() => existingMessage)};
    const clownboardChannel = {
      messages: {
        fetch: jest.fn().mockResolvedValue(messages),
      },
      send: jest.fn().mockResolvedValue(undefined),
    };

    const {client, getHandler} = createClientWithHandlers(clownboardChannel);
    clownboard(client as any, "clownboard-channel-id");

    const handler = getHandler("messageReactionRemove");
    await handler(createReaction(9), {id: "user-1"});

    expect(existingMessage.delete).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2500);
    expect(existingMessage.delete).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });
});
