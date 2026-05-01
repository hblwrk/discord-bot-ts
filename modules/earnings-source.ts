/* eslint-disable max-depth */
/* eslint-disable complexity */
/* eslint-disable unicorn/prefer-ternary */
/* eslint-disable @typescript-eslint/no-unnecessary-boolean-literal-compare */
/* eslint-disable yoda */
/* eslint-disable import/extensions */
import moment from "moment-timezone";
import {getWithRetry} from "./http-retry.js";
import {getLogger} from "./logging.js";
import {
  dateStampFormat,
  earningsWhenByNasdaqTimeToken,
  maxEarningsDays,
  type EarningsEvent,
  type EarningsLoadResult,
  type EarningsLoadStatus,
  type EarningsWhen,
  unknownValueLabel,
  usEasternTimezone,
} from "./earnings-types.js";
import {
  formatMarketCapUsdShort,
  getNormalizedString,
  getNumericValueFromNasdaqCapString,
} from "./earnings-utils.js";

const logger = getLogger();

type NasdaqEarningsRow = {
  symbol?: string;
  name?: string;
  time?: string;
  marketCap?: string | number;
  marketcap?: string | number;
  mktCap?: string | number;
  epsForecast?: string | number;
  epsConsensus?: string | number;
  consensusEPS?: string | number;
  consensusEps?: string | number;
  eps?: string | number;
};

type NasdaqEarningsResponse = {
  data?: {
    rows?: NasdaqEarningsRow[];
  };
  status?: {
    rCode?: number;
    bCodeMessage?: string | null;
    developerMessage?: string | null;
  };
  message?: string | null;
};

const nasdaqEarningsEndpoint = "https://api.nasdaq.com/api/calendar/earnings";
const nasdaqRequestHeaders = {
  "User-Agent": "Mozilla/5.0",
  "Accept": "application/json, text/plain, */*",
  "Referer": "https://www.nasdaq.com/",
};

export async function getEarnings(
  days: number,
  date: "today" | "tomorrow" | string
): Promise<EarningsEvent[]> {
  const earningsResult = await getEarningsResult(days, date);
  return earningsResult.events;
}

export async function getEarningsResult(
  days: number,
  date: "today" | "tomorrow" | string
): Promise<EarningsLoadResult> {
  const usEasternTime = getCurrentUsEasternTime();
  const isMultiDayRangeRequest = false === (null === days || 0 === days);
  const {dateFromStamp, dateToStamp} = resolveRequestedDateRange(days, date, usEasternTime);

  const earningsEvents: EarningsEvent[] = [];
  let status: EarningsLoadStatus = "ok";

  const dateStamps = getDateStampsInRange(
    dateFromStamp,
    dateToStamp,
    {
      skipWeekends: isMultiDayRangeRequest,
    }
  );
  const settledRequests = await Promise.allSettled(
    dateStamps.map(dateStamp => loadNasdaqEarnings(dateStamp))
  );
  let successfulRequestCount = 0;

  for (const [requestIndex, settledRequest] of settledRequests.entries()) {
    const dateStamp = dateStamps[requestIndex];
    if ("fulfilled" === settledRequest.status) {
      successfulRequestCount++;
      appendNasdaqEarningsEvents(
        earningsEvents,
        settledRequest.value,
        dateStamp
      );
      continue;
    }

    logger.log(
      "error",
      `Loading Nasdaq earnings failed for ${dateStamp}: ${settledRequest.reason}`
    );
  }

  if (0 === successfulRequestCount) {
    status = "error";
    logger.log(
      "error",
      `Loading earnings failed: Nasdaq requests were unsuccessful for ${getDateRangeLabel(dateFromStamp, dateToStamp)}.`
    );
  } else {
    logger.log(
      "info",
      `Loaded ${earningsEvents.length} earnings from Nasdaq for ${getDateRangeLabel(dateFromStamp, dateToStamp)}.`
    );
  }

  return {
    events: earningsEvents,
    status,
  };
}

function getCurrentUsEasternTime(): moment.Moment {
  return moment.tz(usEasternTimezone).set({
    // Testing
    /*
    year: 2022,
    month: 1,
    date: 3,
    hour: 9,
    minute: 30,
    second: 0,
    */
  });
}

function resolveRequestedDateRange(
  days: number,
  date: "today" | "tomorrow" | string,
  usEasternTime: moment.Moment
): {dateFromStamp: string; dateToStamp: string} {
  if (null === days || 0 === days) {
    if ("today" === date || null === date) {
      const dateStamp = getUsEasternTradingDayOnOrAfter(usEasternTime).format(dateStampFormat);
      return {
        dateFromStamp: dateStamp,
        dateToStamp: dateStamp,
      };
    }

    if ("tomorrow" === date) {
      const dateStamp = addUsEasternTradingDays(usEasternTime, 1).format(dateStampFormat);
      return {
        dateFromStamp: dateStamp,
        dateToStamp: dateStamp,
      };
    }

    const dateStamp = getUsEasternDateStampFromInput(date);
    return {
      dateFromStamp: dateStamp,
      dateToStamp: dateStamp,
    };
  }

  let normalizedDays = Math.trunc(days);
  if (normalizedDays < 1) {
    normalizedDays = 1;
  }
  if (maxEarningsDays < normalizedDays) {
    normalizedDays = maxEarningsDays;
  }

  const dateFromStamp = addUsEasternTradingDays(usEasternTime, 1).format(dateStampFormat);
  const dateToStamp = addUsEasternTradingDays(usEasternTime, normalizedDays).format(dateStampFormat);
  return {
    dateFromStamp,
    dateToStamp,
  };
}

function getUsEasternTradingDayOnOrAfter(date: moment.Moment): moment.Moment {
  const tradingDay = moment(date).tz(usEasternTimezone).startOf("day");
  while (true === isUsEasternWeekend(tradingDay)) {
    tradingDay.add(1, "day");
  }

  return tradingDay;
}

function addUsEasternTradingDays(date: moment.Moment, tradingDays: number): moment.Moment {
  const cursor = moment(date).tz(usEasternTimezone).startOf("day");
  let addedTradingDays = 0;

  while (addedTradingDays < tradingDays) {
    cursor.add(1, "day");
    if (true === isUsEasternWeekend(cursor)) {
      continue;
    }

    addedTradingDays++;
  }

  return cursor;
}

function isUsEasternWeekend(date: moment.Moment): boolean {
  return date.day() === 0 || date.day() === 6;
}

function getUsEasternDateStampFromInput(dateInput: string): string {
  const normalizedDateInput = dateInput.trim();

  const dateOnly = moment.tz(
    normalizedDateInput,
    dateStampFormat,
    true,
    usEasternTimezone
  );
  if (true === dateOnly.isValid()) {
    return dateOnly.format(dateStampFormat);
  }

  const inputContainsExplicitTimezone = /(?:[zZ]|[+-]\d{2}(?::?\d{2})?)$/.test(normalizedDateInput);
  if (true === inputContainsExplicitTimezone) {
    const parsedWithOffset = moment.parseZone(normalizedDateInput, moment.ISO_8601, true);
    if (true === parsedWithOffset.isValid()) {
      return parsedWithOffset.tz(usEasternTimezone).format(dateStampFormat);
    }
  }

  const parsedInUsEastern = moment.tz(normalizedDateInput, moment.ISO_8601, true, usEasternTimezone);
  if (true === parsedInUsEastern.isValid()) {
    return parsedInUsEastern.format(dateStampFormat);
  }

  return moment.tz(normalizedDateInput, usEasternTimezone).format(dateStampFormat);
}

async function loadNasdaqEarnings(
  dateStamp: string
): Promise<NasdaqEarningsResponse> {
  const query = new URLSearchParams({
    date: dateStamp,
  });
  const response = await getWithRetry<NasdaqEarningsResponse>(
    `${nasdaqEarningsEndpoint}?${query.toString()}`,
    {
      headers: nasdaqRequestHeaders,
    }
  );

  if (
    "number" === typeof response.data?.status?.rCode &&
    response.data.status.rCode !== 200
  ) {
    throw new Error(
      `Nasdaq response failed with status code ${response.data.status.rCode}.`
    );
  }

  if ("object" !== typeof response.data || null === response.data) {
    throw new Error("Nasdaq returned a non-JSON response.");
  }

  return response.data;
}

function getDateStampsInRange(
  dateFromStamp: string,
  dateToStamp: string,
  options: {
    skipWeekends?: boolean;
  } = {}
): string[] {
  const skipWeekends = options.skipWeekends ?? false;
  const dateStamps: string[] = [];
  const cursor = moment.tz(dateFromStamp, usEasternTimezone).startOf("day");
  const end = moment.tz(dateToStamp, usEasternTimezone).startOf("day");

  while (true === cursor.isSameOrBefore(end, "day")) {
    if (false === skipWeekends || false === isUsEasternWeekend(cursor)) {
      dateStamps.push(cursor.format(dateStampFormat));
    }
    cursor.add(1, "day");
  }

  return dateStamps;
}

function getDateRangeLabel(dateFromStamp: string, dateToStamp: string): string {
  if (dateFromStamp === dateToStamp) {
    return dateFromStamp;
  }

  return `${dateFromStamp} to ${dateToStamp}`;
}

function appendNasdaqEarningsEvents(
  earningsEvents: EarningsEvent[],
  nasdaqResponse: NasdaqEarningsResponse,
  dateStamp: string
) {
  if (!Array.isArray(nasdaqResponse.data?.rows)) {
    return;
  }

  for (const row of nasdaqResponse.data.rows) {
    const ticker = getNormalizedString(row.symbol);
    if (null === ticker) {
      continue;
    }

    const companyName = getNormalizedString(row.name) ?? "";
    const marketCap = getNasdaqMarketCap(row);
    const epsConsensus = getNasdaqEpsConsensus(row);

    earningsEvents.push({
      ticker,
      date: dateStamp,
      importance: 1,
      when: getEarningsWhenFromNasdaqTimeToken(row.time),
      companyName,
      marketCap: marketCap.value,
      marketCapText: marketCap.text,
      epsConsensus,
    });
  }
}

function getEarningsWhenFromNasdaqTimeToken(timeToken: unknown): EarningsWhen {
  if ("string" !== typeof timeToken) {
    return "during_session";
  }

  const normalizedTimeToken = timeToken.trim().toLowerCase();
  return earningsWhenByNasdaqTimeToken.get(normalizedTimeToken) ?? "during_session";
}

function getNasdaqMarketCap(row: NasdaqEarningsRow): {value: number | null; text: string} {
  const rawValue = row.marketCap ?? row.marketcap ?? row.mktCap;
  if ("number" === typeof rawValue && Number.isFinite(rawValue) && rawValue >= 0) {
    return {
      value: rawValue,
      text: formatMarketCapUsdShort(rawValue),
    };
  }

  const normalizedRawValue = getNormalizedString(rawValue);
  if (null === normalizedRawValue) {
    return {
      value: null,
      text: unknownValueLabel,
    };
  }

  const marketCapSortValue = getNumericValueFromNasdaqCapString(normalizedRawValue);
  if (null === marketCapSortValue) {
    return {
      value: null,
      text: unknownValueLabel,
    };
  }

  return {
    value: marketCapSortValue,
    text: formatMarketCapUsdShort(marketCapSortValue),
  };
}

function getNasdaqEpsConsensus(row: NasdaqEarningsRow): string {
  const valueCandidates = [
    row.epsForecast,
    row.epsConsensus,
    row.consensusEPS,
    row.consensusEps,
    row.eps,
  ];
  for (const valueCandidate of valueCandidates) {
    if ("number" === typeof valueCandidate && Number.isFinite(valueCandidate)) {
      return String(valueCandidate);
    }

    const normalizedString = getNormalizedString(valueCandidate);
    if (null === normalizedString) {
      continue;
    }

    if (unknownValueLabel === normalizedString.toLowerCase() || "--" === normalizedString) {
      continue;
    }

    return normalizedString;
  }

  return unknownValueLabel;
}
