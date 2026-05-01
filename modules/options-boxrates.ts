import {
  createOptionDeltaLookupClient,
  getOptionChainLookup,
  getSelectedOptionContractsLookup,
  OptionDeltaDataError,
  OptionDeltaInputError,
  type ChainExpiration,
  type OptionContractSelection,
  type OptionDeltaContract,
  type OptionDeltaCredentials,
  type OptionDeltaLookupClient,
  type OptionDeltaLookupDependencies,
  type OptionSelectedContractsLookupResult,
} from "./options-delta.ts";
import {
  formatDecimal,
  formatSymbolWithUnderlyingPrice,
  getOptionContractMidPrice,
} from "./options-format.ts";
import {getSofrRate} from "./options-boxspread.ts";

export type BoxRatesLookupRequest = {
  credentials: OptionDeltaCredentials;
  months?: number;
  notational?: number;
};

export type BoxRatesLookupDependencies = OptionDeltaLookupDependencies & {
  getOptionChainLookupFn?: typeof getOptionChainLookup;
  getSelectedOptionContractsLookupFn?: typeof getSelectedOptionContractsLookup;
  getSofrRateFn?: typeof getSofrRate;
};

type SofrRate = Awaited<ReturnType<typeof getSofrRate>>;

type BoxRatesMarket = {
  benchmarkName: string;
  multiplier: number;
  preferredWidth: number;
  symbol: string;
};

type BoxRateStrikePair = {
  contracts: number;
  expiration: ChainExpiration;
  lowerStrike: number;
  upperStrike: number;
  width: number;
};

type BoxRateContractPair = BoxRateStrikePair & {
  lowerCall: OptionDeltaContract;
  lowerPut: OptionDeltaContract;
  upperCall: OptionDeltaContract;
  upperPut: OptionDeltaContract;
};

export type BoxRateRow = {
  actualDte: number;
  borrowRate: number;
  contracts: number;
  expiration: string;
  lendRate: number;
  lowerStrike: number;
  midRate: number;
  rateDeltaToBenchmark: number;
  upperStrike: number;
};

export type BoxRatesLookupResult = {
  benchmarkName: string;
  notational: number;
  rows: BoxRateRow[];
  sofr: SofrRate;
  symbol: string;
  underlyingPrice: number | null;
  underlyingPriceIsRealtime: boolean;
};

const spxBoxRatesMarket: BoxRatesMarket = {
  benchmarkName: "SOFR",
  multiplier: 100,
  preferredWidth: 1000,
  symbol: "SPX",
};
const boxRateCandidatesPerExpiration = 5;
const maxDisplayedNaturalBandBps = 1000;
const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function normalizeNotational(notational: number): number {
  if (false === Number.isFinite(notational) || notational <= 0) {
    throw new OptionDeltaInputError("Notational must be greater than 0.");
  }

  return Math.round(notational);
}

function normalizeMonths(months: number | undefined): number {
  if (undefined === months) {
    return 12;
  }

  if (false === Number.isInteger(months) || months < 1 || months > 24) {
    throw new OptionDeltaInputError("Months must be an integer from 1 to 24.");
  }

  return months;
}

function parseExpirationDate(expiration: string): Date {
  const date = new Date(`${expiration}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) {
    throw new OptionDeltaDataError(`Invalid expiration date ${expiration}.`);
  }

  return date;
}

function isThirdFriday(expiration: ChainExpiration): boolean {
  const date = parseExpirationDate(expiration.expirationDate);
  const day = date.getUTCDate();
  return 5 === date.getUTCDay() && day >= 15 && day <= 21;
}

function selectMonthlyExpirations(expirations: ChainExpiration[], nowMs: number, months: number): ChainExpiration[] {
  const todayUtc = new Date(nowMs);
  const startOfTodayMs = Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate());
  const expirationsByMonth = new Map<string, ChainExpiration[]>();

  for (const expiration of expirations) {
    if (expiration.daysToExpiration <= 0 || parseExpirationDate(expiration.expirationDate).valueOf() < startOfTodayMs) {
      continue;
    }

    const monthKey = expiration.expirationDate.slice(0, 7);
    expirationsByMonth.set(monthKey, [...(expirationsByMonth.get(monthKey) ?? []), expiration]);
  }

  return [...expirationsByMonth.entries()]
    .sort(([firstMonth], [secondMonth]) => firstMonth.localeCompare(secondMonth))
    .slice(0, months)
    .flatMap(([, monthExpirations]) => {
      const selectedExpiration = [...monthExpirations].sort((first, second) => {
        const firstThirdFriday = isThirdFriday(first);
        const secondThirdFriday = isThirdFriday(second);
        if (firstThirdFriday !== secondThirdFriday) {
          return true === firstThirdFriday ? -1 : 1;
        }

        return first.expirationDate.localeCompare(second.expirationDate);
      })[0];

      return undefined === selectedExpiration ? [] : [selectedExpiration];
    });
}

function isNearInteger(value: number): boolean {
  return Math.abs(value - Math.round(value)) < 1e-6;
}

function hasCompleteChainStrike(strike: ChainExpiration["strikes"][number]): boolean {
  return null !== strike.callStreamerSymbol
    && null !== strike.callSymbol
    && null !== strike.putStreamerSymbol
    && null !== strike.putSymbol;
}

function getStrikePairs(
  expiration: ChainExpiration,
  market: BoxRatesMarket,
  notational: number,
  underlyingPrice: number | null,
): BoxRateStrikePair[] {
  const strikes = expiration.strikes
    .filter(hasCompleteChainStrike)
    .map(strike => strike.strike)
    .sort((first, second) => first - second);
  const pairs: BoxRateStrikePair[] = [];

  for (let lowerIndex = 0; lowerIndex < strikes.length; lowerIndex++) {
    const lowerStrike = strikes[lowerIndex];
    if (undefined === lowerStrike) {
      continue;
    }

    for (let upperIndex = lowerIndex + 1; upperIndex < strikes.length; upperIndex++) {
      const upperStrike = strikes[upperIndex];
      if (undefined === upperStrike) {
        continue;
      }

      const width = upperStrike - lowerStrike;
      const contracts = notational / (width * market.multiplier);
      if (false === isNearInteger(contracts) || contracts < 1) {
        continue;
      }

      pairs.push({
        contracts: Math.round(contracts),
        expiration,
        lowerStrike,
        upperStrike,
        width,
      });
    }
  }

  return pairs.sort((first, second) => {
    const firstWidthDistance = Math.abs(first.width - market.preferredWidth);
    const secondWidthDistance = Math.abs(second.width - market.preferredWidth);
    if (firstWidthDistance !== secondWidthDistance) {
      return firstWidthDistance - secondWidthDistance;
    }

    if (null !== underlyingPrice) {
      const firstMidpointDistance = Math.abs(((first.lowerStrike + first.upperStrike) / 2) - underlyingPrice);
      const secondMidpointDistance = Math.abs(((second.lowerStrike + second.upperStrike) / 2) - underlyingPrice);
      if (firstMidpointDistance !== secondMidpointDistance) {
        return firstMidpointDistance - secondMidpointDistance;
      }
    }

    if (first.contracts !== second.contracts) {
      return first.contracts - second.contracts;
    }

    return first.lowerStrike - second.lowerStrike;
  });
}

function getSelections(pairs: BoxRateStrikePair[]): OptionContractSelection[] {
  return pairs.flatMap(pair => [
    {expiration: pair.expiration, side: "call", strike: pair.lowerStrike},
    {expiration: pair.expiration, side: "put", strike: pair.lowerStrike},
    {expiration: pair.expiration, side: "call", strike: pair.upperStrike},
    {expiration: pair.expiration, side: "put", strike: pair.upperStrike},
  ]);
}

function getContract(
  contracts: OptionDeltaContract[],
  expirationDate: string,
  strike: number,
  optionType: OptionDeltaContract["optionType"],
): OptionDeltaContract | null {
  return contracts.find(contract => {
    return contract.expirationDate === expirationDate
      && contract.strike === strike
      && contract.optionType === optionType
      && null !== contract.bid
      && null !== contract.ask;
  }) ?? null;
}

function getContractPair(contracts: OptionDeltaContract[], strikePair: BoxRateStrikePair): BoxRateContractPair | null {
  const expirationDate = strikePair.expiration.expirationDate;
  const lowerCall = getContract(contracts, expirationDate, strikePair.lowerStrike, "call");
  const lowerPut = getContract(contracts, expirationDate, strikePair.lowerStrike, "put");
  const upperCall = getContract(contracts, expirationDate, strikePair.upperStrike, "call");
  const upperPut = getContract(contracts, expirationDate, strikePair.upperStrike, "put");
  if (null === lowerCall || null === lowerPut || null === upperCall || null === upperPut) {
    return null;
  }

  return {
    ...strikePair,
    lowerCall,
    lowerPut,
    upperCall,
    upperPut,
  };
}

function getRequiredQuotePrice(value: number | null, contract: OptionDeltaContract): number {
  if (null === value) {
    throw new OptionDeltaDataError(`Missing bid/ask quote for ${contract.symbol}.`);
  }

  return value;
}

function getContractMidPrice(contract: OptionDeltaContract): number {
  const mid = getOptionContractMidPrice(contract);
  if (null === mid) {
    throw new OptionDeltaDataError(`Missing bid/ask midpoint for ${contract.symbol}.`);
  }

  return mid;
}

function getNaturalCredit(pair: BoxRateContractPair): number {
  return getRequiredQuotePrice(pair.lowerCall.bid, pair.lowerCall)
    - getRequiredQuotePrice(pair.lowerPut.ask, pair.lowerPut)
    - getRequiredQuotePrice(pair.upperCall.ask, pair.upperCall)
    + getRequiredQuotePrice(pair.upperPut.bid, pair.upperPut);
}

function getNaturalDebit(pair: BoxRateContractPair): number {
  return getRequiredQuotePrice(pair.lowerCall.ask, pair.lowerCall)
    - getRequiredQuotePrice(pair.lowerPut.bid, pair.lowerPut)
    - getRequiredQuotePrice(pair.upperCall.bid, pair.upperCall)
    + getRequiredQuotePrice(pair.upperPut.ask, pair.upperPut);
}

function getMidPrice(pair: BoxRateContractPair): number {
  return getContractMidPrice(pair.lowerCall)
    - getContractMidPrice(pair.lowerPut)
    - getContractMidPrice(pair.upperCall)
    + getContractMidPrice(pair.upperPut);
}

function getAnnualizedRate(notational: number, cashToday: number, actualDte: number): number | null {
  if (false === Number.isFinite(cashToday) || cashToday <= 0 || actualDte <= 0) {
    return null;
  }

  return ((notational / cashToday) - 1) * (360 / actualDte);
}

function getRateRow(
  pair: BoxRateContractPair,
  market: BoxRatesMarket,
  sofr: SofrRate,
  notational: number,
): BoxRateRow | null {
  const actualDte = pair.expiration.daysToExpiration;
  const contractsMultiplier = market.multiplier * pair.contracts;
  const lendRate = getAnnualizedRate(notational, getNaturalDebit(pair) * contractsMultiplier, actualDte);
  const midRate = getAnnualizedRate(notational, getMidPrice(pair) * contractsMultiplier, actualDte);
  const borrowRate = getAnnualizedRate(notational, getNaturalCredit(pair) * contractsMultiplier, actualDte);
  if (null === lendRate || null === midRate || null === borrowRate) {
    return null;
  }

  return {
    actualDte,
    borrowRate,
    contracts: pair.contracts,
    expiration: pair.expiration.expirationDate,
    lendRate,
    lowerStrike: pair.lowerStrike,
    midRate,
    rateDeltaToBenchmark: midRate - (sofr.percentRate / 100),
    upperStrike: pair.upperStrike,
  };
}

function getNaturalBandBps(row: BoxRateRow): number {
  return (row.borrowRate - row.lendRate) * 10_000;
}

function isDisplayableNaturalBand(row: BoxRateRow): boolean {
  return row.lendRate > 0
    && row.borrowRate > row.lendRate
    && getNaturalBandBps(row) <= maxDisplayedNaturalBandBps;
}

function compareRateRows(first: BoxRateRow, second: BoxRateRow): number {
  const firstWide = false === isDisplayableNaturalBand(first);
  const secondWide = false === isDisplayableNaturalBand(second);
  if (firstWide !== secondWide) {
    return true === firstWide ? 1 : -1;
  }

  const naturalBandDifference = getNaturalBandBps(first) - getNaturalBandBps(second);
  if (0 !== naturalBandDifference) {
    return naturalBandDifference;
  }

  return first.lowerStrike - second.lowerStrike;
}

function selectBestRateRows(rows: BoxRateRow[]): BoxRateRow[] {
  const rowsByExpiration = new Map<string, BoxRateRow>();
  for (const row of rows) {
    const existingRow = rowsByExpiration.get(row.expiration);
    if (undefined === existingRow || compareRateRows(row, existingRow) < 0) {
      rowsByExpiration.set(row.expiration, row);
    }
  }

  return [...rowsByExpiration.values()].sort((first, second) => first.expiration.localeCompare(second.expiration));
}

function getSharedClientDependencies(
  dependencies: BoxRatesLookupDependencies,
): BoxRatesLookupDependencies {
  if (undefined !== dependencies.clientFactory) {
    return dependencies;
  }

  let client: OptionDeltaLookupClient | undefined;
  return {
    ...dependencies,
    clientFactory: normalizedCredentials => {
      client ??= createOptionDeltaLookupClient(normalizedCredentials);
      return client;
    },
  };
}

export async function getBoxRatesLookup(
  request: BoxRatesLookupRequest,
  dependencies: BoxRatesLookupDependencies = {},
): Promise<BoxRatesLookupResult> {
  const months = normalizeMonths(request.months);
  const notational = normalizeNotational(request.notational ?? 100_000);
  const sharedClientDependencies = getSharedClientDependencies(dependencies);
  const getOptionChainLookupFn = dependencies.getOptionChainLookupFn ?? getOptionChainLookup;
  const getSelectedOptionContractsLookupFn = dependencies.getSelectedOptionContractsLookupFn ?? getSelectedOptionContractsLookup;
  const getSofrRateFn = dependencies.getSofrRateFn ?? getSofrRate;
  const marketDataDependencies = {
    ...sharedClientDependencies,
    marketDataTimeoutMs: dependencies.marketDataTimeoutMs ?? 10_000,
  };
  const [chainResult, sofr] = await Promise.all([
    getOptionChainLookupFn({
      credentials: request.credentials,
      symbol: spxBoxRatesMarket.symbol,
    }, sharedClientDependencies),
    getSofrRateFn(),
  ]);
  const underlyingLookup = await getSelectedOptionContractsLookupFn({
    credentials: request.credentials,
    selections: [],
    symbol: spxBoxRatesMarket.symbol,
  }, marketDataDependencies);
  const monthlyExpirations = selectMonthlyExpirations(
    chainResult.expirations,
    (dependencies.now ?? Date.now)(),
    months,
  );
  const strikePairs = monthlyExpirations.flatMap(expiration => {
    return getStrikePairs(expiration, spxBoxRatesMarket, notational, underlyingLookup.underlyingPrice)
      .slice(0, boxRateCandidatesPerExpiration);
  });
  if (0 === strikePairs.length) {
    throw new OptionDeltaDataError(`No SPX monthly box spreads found for ${notational.toLocaleString("en-US")} notational.`);
  }

  const selectedContractsLookup: OptionSelectedContractsLookupResult = await getSelectedOptionContractsLookupFn({
    credentials: request.credentials,
    selections: getSelections(strikePairs),
    symbol: spxBoxRatesMarket.symbol,
  }, marketDataDependencies);
  const rowCandidates = strikePairs.flatMap(strikePair => {
    const pair = getContractPair(selectedContractsLookup.contracts, strikePair);
    if (null === pair) {
      return [];
    }

    const row = getRateRow(pair, spxBoxRatesMarket, sofr, notational);
    return null === row ? [] : [row];
  });
  const rows = selectBestRateRows(rowCandidates);
  if (0 === rows.length) {
    throw new OptionDeltaDataError("SPX box rate market data is unavailable.");
  }

  return {
    benchmarkName: spxBoxRatesMarket.benchmarkName,
    notational,
    rows,
    sofr,
    symbol: chainResult.symbol,
    underlyingPrice: selectedContractsLookup.underlyingPrice ?? underlyingLookup.underlyingPrice,
    underlyingPriceIsRealtime: selectedContractsLookup.underlyingPriceIsRealtime,
  };
}

function formatMoney(value: number): string {
  const roundedValue = Math.round(value);
  const sign = roundedValue < 0 ? "-" : "";
  return `${sign}$${Math.abs(roundedValue).toLocaleString("en-US")}`;
}

function formatRate(value: number): string {
  return `${formatDecimal(value * 100, 2)}%`;
}

function formatSignedBasisPoints(value: number): string {
  const basisPoints = value * 10_000;
  const sign = basisPoints >= 0 ? "+" : "";
  return `${sign}${formatDecimal(basisPoints, 0)} bps`;
}

function formatStrike(strike: number): string {
  return strike.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    useGrouping: false,
  }).replace(/\.00$/, "");
}

function formatShortExpirationMonth(expiration: string): string {
  const date = parseExpirationDate(expiration);
  const month = shortMonths[date.getUTCMonth()] ?? "";
  const year = date.getUTCFullYear().toString().slice(-2);
  return `${month}${year}`;
}

function formatBoxRateRow(row: BoxRateRow): string {
  return [
    `\`${formatShortExpirationMonth(row.expiration)}\``,
    `\`${row.actualDte} DTE\``,
    `\`${formatStrike(row.lowerStrike)}/${formatStrike(row.upperStrike)} x${row.contracts}\``,
    `Mid \`${formatRate(row.midRate)}\``,
    true === isDisplayableNaturalBand(row)
      ? `Mkt \`${formatRate(row.lendRate)}-${formatRate(row.borrowRate)}\``
      : "Mkt `wide`",
    `Δ \`${formatSignedBasisPoints(row.rateDeltaToBenchmark)}\``,
  ].join(" | ");
}

export function formatBoxRatesLookupResult(result: BoxRatesLookupResult): string {
  return [
    "Boxspread rates für die nächsten 12 Monate",
    `${formatSymbolWithUnderlyingPrice(
      result.symbol,
      result.underlyingPrice,
      result.underlyingPriceIsRealtime,
    )} | Notational \`${formatMoney(result.notational)}\` | ${result.benchmarkName}: \`${formatDecimal(result.sofr.percentRate, 2)}%\` (${result.sofr.effectiveDate})`,
    ...result.rows.map(formatBoxRateRow),
  ].join("\n");
}
