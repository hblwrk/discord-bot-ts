import type {Mock, MockedFunction} from "vitest";
import type {Client} from "discord.js";
import {clownboard} from "./clownboard.ts";
import {describe, expect, test, vi} from "vitest";

type EventHandler = (...args: unknown[]) => Promise<void>;
type ClownboardTestClient = {
  on: MockedFunction<(eventName: string, handler: EventHandler) => ClownboardTestClient>;
  channels: {
    cache: {
      get: Mock;
    };
  };
};
type TestEmbed = {
  footer?: {
    text: string;
  };
};
type TestClownboardMessage = {
  embeds: TestEmbed[];
  edit?: Mock;
  delete?: Mock;
};
type ExistingClownboardMessage = TestClownboardMessage & {
  edit: Mock;
  delete: Mock;
};
type SentClownboardPayload = {
  content?: string;
  embeds?: {
    toJSON: () => {
      author?: {
        icon_url?: string;
        name?: string;
      };
      description?: string;
      fields?: {inline?: boolean; name: string; value: string}[];
      footer?: {
        text?: string;
      };
      image?: {
        url?: string;
      };
    };
  }[];
};

function createExistingMessage(): ExistingClownboardMessage {
  return {
    embeds: [{footer: {text: "source-message-id"}}],
    delete: vi.fn().mockResolvedValue(undefined),
    edit: vi.fn().mockResolvedValue(undefined),
  };
}

function createMessages(existingMessage?: TestClownboardMessage) {
  const storedMessages = [
    {embeds: [{footer: {text: "different-message-id"}}]},
    ...(existingMessage ? [existingMessage] : []),
  ];

  return {
    find: vi.fn((predicate: (message: TestClownboardMessage) => boolean) => storedMessages.find(predicate)),
  };
}

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

function createReaction(count: number, attachment?: {url: string}) {
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
        first: () => attachment,
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

function getSentPayload(clownboardChannel: {send: Mock}): SentClownboardPayload {
  return clownboardChannel.send.mock.calls[0]![0] as SentClownboardPayload;
}

describe("clownboard", () => {
  test("posts to clownboard when threshold is reached", async () => {
    const messages = createMessages();
    const clownboardChannel = {
      messages: {
        fetch: vi.fn().mockResolvedValue(messages),
      },
      send: vi.fn().mockResolvedValue(undefined),
    };

    const {client, getHandler} = createClientWithHandlers(clownboardChannel);
    clownboard(client as unknown as Client, "clownboard-channel-id");

    const handler = getHandler("messageReactionAdd");
    await handler(createReaction(10), {id: "user-1"});

    expect(clownboardChannel.messages.fetch).toHaveBeenCalledWith({limit: 100});
    const payload = getSentPayload(clownboardChannel);
    expect(payload.content).toBe("🤡 **10** #source-channel");
    expect(payload.embeds?.[0]?.toJSON()).toEqual({
      author: {
        name: "user#0001",
        icon_url: "https://avatar.example",
      },
      description: "content",
      footer: {
        text: "source-message-id",
      },
      fields: [{
        name: "Source",
        value: "[Jump!](https://discord.example/jump)",
        inline: true,
      }],
    });
  });

  test("updates existing clownboard message when reaction is added again", async () => {
    const existingMessage = createExistingMessage();
    const messages = createMessages(existingMessage);
    const clownboardChannel = {
      messages: {
        fetch: vi.fn().mockResolvedValue(messages),
      },
      send: vi.fn().mockResolvedValue(undefined),
    };

    const {client, getHandler} = createClientWithHandlers(clownboardChannel);
    clownboard(client as unknown as Client, "clownboard-channel-id");

    const handler = getHandler("messageReactionAdd");
    await handler(createReaction(12), {id: "user-1"});

    expect(existingMessage.edit).toHaveBeenCalledWith("🤡 **12** #source-channel");
    expect(clownboardChannel.send).not.toHaveBeenCalled();
  });

  test("posts attachment embeds to clownboard", async () => {
    const messages = createMessages();
    const clownboardChannel = {
      messages: {
        fetch: vi.fn().mockResolvedValue(messages),
      },
      send: vi.fn().mockResolvedValue(undefined),
    };
    const reaction = createReaction(10, {url: "https://cdn.example/image.png"});

    const {client, getHandler} = createClientWithHandlers(clownboardChannel);
    clownboard(client as unknown as Client, "clownboard-channel-id");

    const handler = getHandler("messageReactionAdd");
    await handler(reaction, {id: "user-1"});

    const payload = getSentPayload(clownboardChannel);
    expect(payload.content).toBe("🤡 **10** #source-channel");
    expect(payload.embeds?.[0]?.toJSON()).toEqual({
      author: {
        name: "user#0001",
        icon_url: "https://avatar.example",
      },
      description: "content",
      footer: {
        text: "source-message-id",
      },
      image: {
        url: "https://cdn.example/image.png",
      },
      fields: [{
        name: "Source",
        value: "[Jump!](https://discord.example/jump)",
        inline: true,
      }],
    });
  });

  test("schedules delete when reaction count drops to threshold", async () => {
    vi.useFakeTimers();

    const existingMessage = createExistingMessage();
    const messages = createMessages(existingMessage);
    const clownboardChannel = {
      messages: {
        fetch: vi.fn().mockResolvedValue(messages),
      },
      send: vi.fn().mockResolvedValue(undefined),
    };

    const {client, getHandler} = createClientWithHandlers(clownboardChannel);
    clownboard(client as unknown as Client, "clownboard-channel-id");

    const handler = getHandler("messageReactionRemove");
    await handler(createReaction(9), {id: "user-1"});

    expect(existingMessage.delete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2500);
    expect(existingMessage.delete).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  test("updates existing clownboard message when reaction remains above threshold", async () => {
    const existingMessage = createExistingMessage();
    const messages = createMessages(existingMessage);
    const clownboardChannel = {
      messages: {
        fetch: vi.fn().mockResolvedValue(messages),
      },
      send: vi.fn().mockResolvedValue(undefined),
    };

    const {client, getHandler} = createClientWithHandlers(clownboardChannel);
    clownboard(client as unknown as Client, "clownboard-channel-id");

    const handler = getHandler("messageReactionRemove");
    await handler(createReaction(10), {id: "user-1"});

    expect(existingMessage.edit).toHaveBeenCalledWith("🤡 **10** #source-channel");
    expect(existingMessage.delete).not.toHaveBeenCalled();
  });
});
