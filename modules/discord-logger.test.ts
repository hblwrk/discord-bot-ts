const readSecretMock = jest.fn();

jest.mock("./secrets.js", () => ({
  readSecret: readSecretMock,
}));

import DiscordTransport from "./discord-logger.js";

describe("DiscordTransport", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    readSecretMock.mockReturnValue("logging-channel");
  });

  function createInfo() {
    return {
      message: "log message",
      timestamp: "2025-01-01T00:00:00.000Z",
      username: "alice",
      channel: "general",
    };
  }

  test("reads logging channel ID during construction", () => {
    const client = {
      channels: {
        cache: {
          get: jest.fn(),
        },
      },
    };

    const transport = new DiscordTransport({client});

    expect(transport.channelId).toBe("logging-channel");
    expect(readSecretMock).toHaveBeenCalledWith("hblwrk_channel_logging_ID");
  });

  test("emits logged event, invokes callback, and sends embed to a text channel", async () => {
    const sendMock = jest.fn().mockResolvedValue(undefined);
    const client = {
      channels: {
        cache: {
          get: jest.fn(() => ({
            isTextBased: () => true,
            send: sendMock,
          })),
        },
      },
    };

    const transport = new DiscordTransport({client});
    const callback = jest.fn();
    const loggedHandler = jest.fn();
    transport.on("logged", loggedHandler);

    const info = createInfo();
    transport.log(info, callback);

    expect(callback).toHaveBeenCalledTimes(1);

    await new Promise(resolve => {
      setImmediate(resolve);
    });

    expect(loggedHandler).toHaveBeenCalledWith(info);
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      embeds: expect.any(Array),
    }));
  });

  test("does not send when channel does not exist", async () => {
    const getMock = jest.fn(() => undefined);
    const client = {
      channels: {
        cache: {
          get: getMock,
        },
      },
    };

    const transport = new DiscordTransport({client});
    transport.log(createInfo(), jest.fn());

    await new Promise(resolve => {
      setImmediate(resolve);
    });

    expect(getMock).toHaveBeenCalledWith("logging-channel");
  });

  test("does not send when channel is not text-based", async () => {
    const sendMock = jest.fn().mockResolvedValue(undefined);
    const client = {
      channels: {
        cache: {
          get: jest.fn(() => ({
            isTextBased: () => false,
            send: sendMock,
          })),
        },
      },
    };

    const transport = new DiscordTransport({client});
    transport.log(createInfo(), jest.fn());

    await new Promise(resolve => {
      setImmediate(resolve);
    });

    expect(sendMock).not.toHaveBeenCalled();
  });

  test("logs to console when channel send fails", async () => {
    const sendError = new Error("send failed");
    const sendMock = jest.fn().mockRejectedValue(sendError);
    const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const client = {
      channels: {
        cache: {
          get: jest.fn(() => ({
            isTextBased: () => true,
            send: sendMock,
          })),
        },
      },
    };

    const transport = new DiscordTransport({client});
    transport.log(createInfo(), jest.fn());

    await new Promise(resolve => {
      setImmediate(resolve);
    });
    await Promise.resolve();

    expect(consoleSpy).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Error posting to logging channel:"),
    );

    consoleSpy.mockRestore();
  });
});
