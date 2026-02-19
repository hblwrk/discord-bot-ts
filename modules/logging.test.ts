import {getDiscordLogger, getLogger} from "./logging.js";
import {readSecret} from "./secrets.js";

jest.mock("./secrets.js", () => ({
  readSecret: jest.fn(),
}));

const mockedReadSecret = readSecret as jest.MockedFunction<typeof readSecret>;
const originalLoglevel = process.env.LOGLEVEL;

describe("getLogger loglevel switching", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.LOGLEVEL;
  });

  afterAll(() => {
    if (undefined === originalLoglevel) {
      delete process.env.LOGLEVEL;
    } else {
      process.env.LOGLEVEL = originalLoglevel;
    }
  });

  test("defaults to info if no valid override exists", () => {
    mockedReadSecret.mockImplementation(() => {
      throw new Error("missing secret");
    });

    const logger = getLogger();

    expect(logger.level).toBe("info");
  });

  test("uses loglevel from secret", () => {
    mockedReadSecret.mockReturnValue("debug");

    const logger = getLogger();

    expect(mockedReadSecret).toHaveBeenCalledWith("loglevel");
    expect(logger.level).toBe("debug");
  });

  test("uses LOGLEVEL environment value over secret", () => {
    process.env.LOGLEVEL = "warn";
    mockedReadSecret.mockReturnValue("debug");

    const logger = getLogger();

    expect(mockedReadSecret).not.toHaveBeenCalled();
    expect(logger.level).toBe("warn");
  });

  test("builds a discord logger with Discord transport", () => {
    mockedReadSecret.mockImplementation(secretName => {
      if ("loglevel" === secretName) {
        return "info";
      }

      if ("hblwrk_channel_logging_ID" === secretName) {
        return "123456";
      }

      return "";
    });

    const logger = getDiscordLogger({channels: {cache: {get: jest.fn()}}});

    expect(logger.level).toBe("info");
    expect(logger.transports).toHaveLength(1);
  });
});
