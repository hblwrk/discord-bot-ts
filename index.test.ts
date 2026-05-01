import type {MockInstance} from "vitest";
import {afterEach, beforeEach, describe, expect, test, vi} from "vitest";

const {loggerMock, startBotMock} = vi.hoisted(() => ({
  loggerMock: {
    level: "info",
    log: vi.fn(),
  },
  startBotMock: vi.fn(),
}));
const warningHandlerSymbol = Symbol.for("hblwrk.discord-bot-ts.warning-handler");
type ProcessWarningWithMetadata = Error & {
  code?: string;
  count?: number;
  emitter?: {
    constructor?: {
      name?: string;
    };
  };
  type?: string;
};

vi.mock("./modules/startup-orchestrator.ts", () => ({
  startBot: startBotMock,
}));

vi.mock("./modules/logging.ts", () => ({
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

    await import("./index.ts");
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

    await import("./index.ts");
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

    await import("./index.ts");
    await new Promise(resolve => {
      setImmediate(resolve);
    });

    const warning: ProcessWarningWithMetadata = new Error("Possible AsyncEventEmitter memory leak detected.");
    warning.name = "MaxListenersExceededWarning";
    warning.code = "MAX_LISTENERS_EXCEEDED";
    warning.type = "error";
    warning.count = 11;
    warning.emitter = {
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
