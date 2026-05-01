import type {Mock, MockedFunction} from "vitest";
import {clownboard} from "./clownboard.js";

type EventHandler = (...args: unknown[]) => Promise<void>;
type ClownboardTestClient = {
  on: MockedFunction<(eventName: string, handler: EventHandler) => ClownboardTestClient>;
  channels: {
    cache: {
      get: Mock;
    };
  };
};

function createClientWithHandlers(clownboardChannel: unknown) {
  const handlers = new Map<string, EventHandler>();

  const client = {} as ClownboardTestClient;
  client.on = vi.fn((eventName: string, handler: EventHandler) => {
    handlers.set(eventName, handler);
    return client;
  });
  client.channels = {
    cache: {
      get: vi.fn(() => clownboardChannel),
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
    fetch: vi.fn().mockResolvedValue(undefined),
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
      fetch: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("clownboard", () => {
  test("posts to clownboard when threshold is reached", async () => {
    const messages = {find: vi.fn(() => undefined)};
    const clownboardChannel = {
      messages: {
        fetch: vi.fn().mockResolvedValue(messages),
      },
      send: vi.fn().mockResolvedValue(undefined),
    };

    const {client, getHandler} = createClientWithHandlers(clownboardChannel);
    clownboard(client as any, "clownboard-channel-id");

    const handler = getHandler("messageReactionAdd");
    await handler(createReaction(10), {id: "user-1"});

    expect(clownboardChannel.messages.fetch).toHaveBeenCalledWith({limit: 100});
    expect(clownboardChannel.send).toHaveBeenCalledTimes(1);
  });

  test("schedules delete when reaction count drops to threshold", async () => {
    vi.useFakeTimers();

    const existingMessage = {
      delete: vi.fn().mockResolvedValue(undefined),
      edit: vi.fn().mockResolvedValue(undefined),
    };
    const messages = {find: vi.fn(() => existingMessage)};
    const clownboardChannel = {
      messages: {
        fetch: vi.fn().mockResolvedValue(messages),
      },
      send: vi.fn().mockResolvedValue(undefined),
    };

    const {client, getHandler} = createClientWithHandlers(clownboardChannel);
    clownboard(client as any, "clownboard-channel-id");

    const handler = getHandler("messageReactionRemove");
    await handler(createReaction(9), {id: "user-1"});

    expect(existingMessage.delete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2500);
    expect(existingMessage.delete).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
