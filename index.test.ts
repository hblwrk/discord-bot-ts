const startBotMock = jest.fn();
const loggerMock = {
  level: "info",
  log: jest.fn(),
};

jest.mock("./modules/startup-orchestrator.js", () => ({
  startBot: startBotMock,
}));

jest.mock("./modules/logging.js", () => ({
  getLogger: () => loggerMock,
}));

describe("index bootstrap", () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  test("delegates startup to orchestrator", async () => {
    startBotMock.mockResolvedValue(undefined);

    await import("./index.js");
    await new Promise(resolve => {
      setImmediate(resolve);
    });

    expect(loggerMock.log).toHaveBeenCalledWith(
      "info",
      "Started with loglevel: info",
    );
    expect(loggerMock.log).toHaveBeenCalledWith(
      "info",
      "Healthcheck port: 11312",
    );
    expect(startBotMock).toHaveBeenCalledWith({
      logger: loggerMock,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  test("exits process when startup fails", async () => {
    startBotMock.mockRejectedValueOnce(new Error("boom"));

    await import("./index.js");
    await new Promise(resolve => {
      setImmediate(resolve);
    });

    expect(loggerMock.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Error starting up:"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test("logs process warnings through logger", async () => {
    startBotMock.mockResolvedValue(undefined);

    await import("./index.js");
    await new Promise(resolve => {
      setImmediate(resolve);
    });

    const warning = new Error("Possible AsyncEventEmitter memory leak detected.");
    warning.name = "MaxListenersExceededWarning";
    (warning as any).code = "MAX_LISTENERS_EXCEEDED";
    (warning as any).type = "error";
    (warning as any).count = 11;
    (warning as any).emitter = {
      constructor: {
        name: "WebSocketShard",
      },
    };

    process.emit("warning", warning);

    expect(loggerMock.log).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({
        source: "process-warning",
        warning_name: "MaxListenersExceededWarning",
        warning_code: "MAX_LISTENERS_EXCEEDED",
        warning_type: "error",
        warning_listener_count: 11,
        warning_emitter: "WebSocketShard",
        warning_message: "Possible AsyncEventEmitter memory leak detected.",
      }),
    );
  });
});
