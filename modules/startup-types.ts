import {type Client} from "discord.js";
import {type getAssets, type getGenericAssets} from "./assets.js";
import {type clownboard} from "./clownboard.js";
import {type startEarningsResultWatcher} from "./earnings-results.js";
import {type runHealthCheck} from "./health-check.js";
import {type addInlineResponses} from "./inline-response.js";
import {type updateMarketData} from "./market-data.js";
import {type roleManager} from "./role-manager.js";
import {type readSecret} from "./secrets.js";
import {type defineSlashCommands, type interactSlashCommands} from "./slash-commands.js";
import {type StartupStateSnapshot} from "./startup-state.js";
import {type getTickers, type Ticker} from "./tickers.js";
import {type startMncTimers, type startNyseTimers, type startOtherTimers} from "./timers.js";
import {type addTriggerResponses} from "./trigger-response.js";

export type Logger = {
  level?: string;
  log: (level: string, message: any) => void;
};

export type StartupDependencies = {
  logger: Logger;
  createClient: () => Client;
  readSecret: typeof readSecret;
  runHealthCheck: typeof runHealthCheck;
  startNyseTimers: typeof startNyseTimers;
  startMncTimers: typeof startMncTimers;
  startOtherTimers: typeof startOtherTimers;
  startEarningsResultWatcher: typeof startEarningsResultWatcher;
  updateMarketData: typeof updateMarketData;
  defineSlashCommands: typeof defineSlashCommands;
  interactSlashCommands: typeof interactSlashCommands;
  addInlineResponses: typeof addInlineResponses;
  addTriggerResponses: typeof addTriggerResponses;
  getGenericAssets: typeof getGenericAssets;
  getAssets: typeof getAssets;
  getTickers: typeof getTickers;
  roleManager: typeof roleManager;
  clownboard: typeof clownboard;
  setTimeoutFn: typeof setTimeout;
  clearTimeoutFn: typeof clearTimeout;
  loginTimeoutMs: number;
  warmupMaxAttempts: number;
  warmupInitialRetryDelayMs: number;
  warmupMaxRetryDelayMs: number;
  slashCommandDebounceMs: number;
  assetRecoveryRetryMs: number;
  assetRecoveryMaxRetryMs: number;
};

export type StartupOptions = Partial<StartupDependencies>;

export type StartupRuntime = {
  client: Client;
  getStartupState: () => StartupStateSnapshot;
};

export type SharedStartupData = {
  assets: any[];
  whatIsAssets: any[];
  userAssets: any[];
  roleAssets: any[];
  calendarReminderAssets: any[];
  earningsReminderAssets: any[];
  paywallAssets: any[];
  tickers: Ticker[];
  assetCommands: string[];
  assetCommandsWithPrefix: string[];
};

export type ErrorLogDetails = {
  discord_error_message?: string;
  error_name?: string;
  error_message: string;
  error_stack?: string;
};
