import {createStartupState} from "./startup-state.js";

describe("createStartupState", () => {
  const logger = {
    log: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2025-01-01T10:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("returns initial snapshot defaults", () => {
    const state = createStartupState(logger);
    const snapshot = state.getSnapshot();

    expect(snapshot.alive).toBe(true);
    expect(snapshot.ready).toBe(false);
    expect(snapshot.discordLoggedIn).toBe(false);
    expect(snapshot.handlersAttached).toBe(false);
    expect(snapshot.remoteWarmupStatus).toBe("idle");
    expect(snapshot.lastError).toBeNull();
    expect(snapshot.readyAt).toBeNull();
    expect(snapshot.startedAt).toBe("2025-01-01T10:00:00.000Z");
    expect(snapshot.phaseDurationsMs).toEqual({});
    expect(snapshot.warmupTasks).toEqual({});
  });

  test("marks ready only after both discord login and handlers are attached", () => {
    const state = createStartupState(logger);

    state.markDiscordLoggedIn();
    expect(state.getSnapshot().ready).toBe(false);

    jest.setSystemTime(new Date("2025-01-01T10:00:03.000Z"));
    state.markHandlersAttached();

    const snapshot = state.getSnapshot();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.discordLoggedIn).toBe(true);
    expect(snapshot.handlersAttached).toBe(true);
    expect(snapshot.readyAt).toBe("2025-01-01T10:00:03.000Z");
    expect(logger.log).toHaveBeenCalledWith(
      "info",
      {
        startup_phase: "phase-a",
        message: "Startup readiness reached.",
      },
    );
  });

  test("records phase timing and logs phase start and completion", () => {
    const state = createStartupState(logger);
    const finishPhase = state.startPhase("warmup");

    jest.advanceTimersByTime(75);
    finishPhase();

    const snapshot = state.getSnapshot();
    expect(snapshot.phaseDurationsMs.warmup).toBe(75);
    expect(logger.log).toHaveBeenCalledWith(
      "info",
      {
        startup_phase: "warmup",
        message: "Starting startup phase.",
      },
    );
    expect(logger.log).toHaveBeenCalledWith(
      "info",
      {
        startup_phase: "warmup",
        duration_ms: 75,
        message: "Startup phase completed.",
      },
    );
  });

  test("converts and resets last error", () => {
    const state = createStartupState(logger);

    state.setLastError(new Error("boom"));
    expect(state.getSnapshot().lastError).toContain("boom");

    state.setLastError("plain-error");
    expect(state.getSnapshot().lastError).toBe("plain-error");

    state.setLastError(null);
    expect(state.getSnapshot().lastError).toBeNull();
  });

  test("merges warmup task updates and snapshots are defensive copies", () => {
    const state = createStartupState(logger);

    state.markWarmupTask("assets", "running");
    state.markWarmupTask("tickers", "failed");

    const snapshot = state.getSnapshot();
    expect(snapshot.warmupTasks).toEqual({
      assets: "running",
      tickers: "failed",
    });

    snapshot.warmupTasks.assets = "success";
    snapshot.phaseDurationsMs.fake = 123;

    const secondSnapshot = state.getSnapshot();
    expect(secondSnapshot.warmupTasks.assets).toBe("running");
    expect(secondSnapshot.phaseDurationsMs.fake).toBeUndefined();
  });
});
