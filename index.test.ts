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
});
