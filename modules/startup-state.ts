import {getLogger} from "./logging.js";

export type RemoteWarmupStatus = "idle" | "warming" | "ready" | "degraded";
export type WarmupTaskStatus = "idle" | "running" | "success" | "failed";

export type StartupStateSnapshot = {
  alive: boolean;
  ready: boolean;
  discordLoggedIn: boolean;
  handlersAttached: boolean;
  remoteWarmupStatus: RemoteWarmupStatus;
  lastError: string | null;
  startedAt: string;
  readyAt: string | null;
  phaseDurationsMs: Record<string, number>;
  warmupTasks: Record<string, WarmupTaskStatus>;
};

type StartupState = {
  alive: boolean;
  ready: boolean;
  discordLoggedIn: boolean;
  handlersAttached: boolean;
  remoteWarmupStatus: RemoteWarmupStatus;
  lastError: string | null;
  startedAt: string;
  readyAt: string | null;
  phaseDurationsMs: Record<string, number>;
  warmupTasks: Record<string, WarmupTaskStatus>;
};

type StartupLogger = {
  log: (level: string, message: any) => void;
};

function toErrorString(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

export function createStartupState(logger: StartupLogger = getLogger()) {
  const state: StartupState = {
    alive: true,
    ready: false,
    discordLoggedIn: false,
    handlersAttached: false,
    remoteWarmupStatus: "idle",
    lastError: null,
    startedAt: new Date().toISOString(),
    readyAt: null,
    phaseDurationsMs: {},
    warmupTasks: {},
  };

  function refreshReadiness() {
    if (false === state.ready && true === state.discordLoggedIn && true === state.handlersAttached) {
      state.ready = true;
      state.readyAt = new Date().toISOString();
      logger.log(
        "info",
        {
          startup_phase: "phase-a",
          message: "Startup readiness reached.",
        },
      );
    }
  }

  function startPhase(phaseName: string): () => void {
    const startedAt = Date.now();
    logger.log(
      "info",
      {
        startup_phase: phaseName,
        message: "Starting startup phase.",
      },
    );

    return () => {
      const durationMs = Date.now() - startedAt;
      state.phaseDurationsMs = {
        ...state.phaseDurationsMs,
        [phaseName]: durationMs,
      };
      logger.log(
        "info",
        {
          startup_phase: phaseName,
          duration_ms: durationMs,
          message: "Startup phase completed.",
        },
      );
    };
  }

  function markHandlersAttached() {
    state.handlersAttached = true;
    refreshReadiness();
  }

  function markDiscordLoggedIn() {
    state.discordLoggedIn = true;
    refreshReadiness();
  }

  function setRemoteWarmupStatus(status: RemoteWarmupStatus) {
    state.remoteWarmupStatus = status;
  }

  function setLastError(error: unknown | null) {
    if (null === error) {
      state.lastError = null;
      return;
    }

    state.lastError = toErrorString(error);
  }

  function markWarmupTask(task: string, status: WarmupTaskStatus) {
    state.warmupTasks = {
      ...state.warmupTasks,
      [task]: status,
    };
  }

  function getSnapshot(): StartupStateSnapshot {
    return {
      ...state,
      phaseDurationsMs: {
        ...state.phaseDurationsMs,
      },
      warmupTasks: {
        ...state.warmupTasks,
      },
    };
  }

  return {
    startPhase,
    markHandlersAttached,
    markDiscordLoggedIn,
    setRemoteWarmupStatus,
    setLastError,
    markWarmupTask,
    getSnapshot,
  };
}
