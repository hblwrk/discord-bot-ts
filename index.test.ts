import type {MockInstance} from "vitest";

const {loggerMock, startBotMock} = vi.hoisted(() => ({
  loggerMock: {
    level: "info",
    log: vi.fn(),
  },
  startBotMock: vi.fn(),
}));
const warningHandlerSymbol = Symbol.for("hblwrk.discord-bot-ts.warning-handler");

vi.mock("./modules/startup-orchestrator.js", () => ({
  startBot: startBotMock,
}));

vi.mock("./modules/logging.js", () => ({
  getLogger: () => loggerMock,
}));

describe("index bootstrap", () => {
  let exitSpy: MockInstance;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
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

    const warningHandler = (process as NodeJS.Process & {
      [warningHandlerSymbol]?: (processWarning: Error) => void;
    })[warningHandlerSymbol];
    expect(warningHandler).toEqual(expect.any(Function));
    warningHandler?.(warning);

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
