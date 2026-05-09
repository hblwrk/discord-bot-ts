export type EarningsWhen = "before_open" | "after_close" | "during_session";

export interface EarningsEvent {
  ticker: string;
  when: EarningsWhen;
  date: string;
  importance: number;
  companyName?: string;
  marketCap?: number | null;
  marketCapText?: string;
  epsConsensus?: string;
  expectedMove?: number | null;
  expectedMoveActualDte?: number;
  expectedMoveExpiration?: string;
  expectedMoveUnderlyingPrice?: number | null;
  expectedMoveUnderlyingPriceIsRealtime?: boolean;
}

export type EarningsLoadStatus = "ok" | "error";

export type EarningsLoadResult = {
  events: EarningsEvent[];
  status: EarningsLoadStatus;
};

export const EARNINGS_MAX_MESSAGE_LENGTH = 1800;
export const EARNINGS_MAX_MESSAGES_TIMER = 8;
export const EARNINGS_MAX_MESSAGES_SLASH = 6;
export const EARNINGS_CONTINUATION_LABEL = "(Fortsetzung)";

export type EarningsMessageBatch = {
  messages: string[];
  truncated: boolean;
  totalEvents: number;
  includedEvents: number;
};

export type EarningsMessageOptions = {
  maxMessageLength?: number;
  maxMessages?: number;
  continuationLabel?: string;
  marketCapFilter?: "all" | "bluechips" | string;
  mostAnticipatedTickerSymbols?: ReadonlySet<string>;
};

export const earningsTruncationNote = "... weitere Earnings konnten wegen Discord-Limits nicht angezeigt werden.";
export const usEasternTimezone = "US/Eastern";
export const dateStampFormat = "YYYY-MM-DD";
export const maxEarningsDays = 10;
export const bluechipMinMarketCap = 50_000_000_000;
export const unknownValueLabel = "n/a";

export const earningsWhenByNasdaqTimeToken = new Map<string, EarningsWhen>([
  ["time-pre-market", "before_open"],
  ["time-after-hours", "after_close"],
  ["time-not-supplied", "during_session"],
]);

export const earningsWhenSortRankByWhen = new Map<EarningsWhen, number>([
  ["before_open", 0],
  ["during_session", 1],
  ["after_close", 2],
]);

export const earningsWhenLabelByWhen = new Map<EarningsWhen, string>([
  ["before_open", "Vor Handelsbeginn"],
  ["during_session", "Während der Handelszeiten oder unbekannter Zeitpunkt"],
  ["after_close", "Nach Handelsschluss"],
]);
