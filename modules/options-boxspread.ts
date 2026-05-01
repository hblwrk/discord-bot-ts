import {getWithRetry} from "./http-retry.ts";
import {
  getOptionContractsLookup,
  normalizeDte,
  OptionDeltaDataError,
  OptionDeltaInputError,
  type OptionContractsLookupResult,
  type OptionDeltaContract,
  type OptionDeltaCredentials,
  type OptionDeltaLookupDependencies,
} from "./options-delta.ts";
import {
  formatDecimal,
  formatSymbolWithUnderlyingPrice,
  getOptionContractMidPrice,
} from "./options-format.ts";

export type BoxSpreadDirection = "borrow" | "lend";

type SofrRate = {
  effectiveDate: string;
  percentRate: number;
};

type NewYorkFedSofrResponse = {
  refRates?: Array<{
    effectiveDate?: unknown;
    percentRate?: unknown;
    type?: unknown;
  }>;
};

export type BoxSpreadLookupRequest = {
  credentials: OptionDeltaCredentials;
  direction: BoxSpreadDirection;
  dte: number;
  notational: number;
};

export type BoxSpreadLookupDependencies = OptionDeltaLookupDependencies & {
  getOptionContractsLookupFn?: typeof getOptionContractsLookup;
  getSofrRateFn?: typeof getSofrRate;
};

type BoxSpreadMarket = {
  benchmarkName: string;
  currency: string;
  multiplier: number;
  preferredWidth: number;
  symbol: string;
};

type BoxSpreadPair = {
  contracts: number;
  lowerCall: OptionDeltaContract;
  lowerPut: OptionDeltaContract;
  lowerStrike: number;
  upperCall: OptionDeltaContract;
  upperPut: OptionDeltaContract;
  upperStrike: number;
  width: number;
};

type BoxSpreadLeg = {
  action: "Buy" | "Sell";
  contract: OptionDeltaContract;
  quantity: number;
};

export type BoxSpreadLookupResult = {
  actualDte: number;
  benchmarkName: string;
  cashToday: number;
  contracts: number;
  currency: string;
  direction: BoxSpreadDirection;
  expiration: string;
  financingAmount: number;
  impliedRate: number;
  legs: BoxSpreadLeg[];
  limitPrice: number;
  naturalCredit: number;
  naturalDebit: number;
  notational: number;
  rateDeltaToBenchmark: number;
  requestedDte: number;
  rolled: boolean;
  sofr: SofrRate;
  symbol: string;
  underlyingPrice: number | null;
  underlyingPriceIsRealtime: boolean;
  width: number;
};

const spxBoxSpreadMarket: BoxSpreadMarket = {
  benchmarkName: "SOFR",
  currency: "USD",
  multiplier: 100,
  preferredWidth: 1000,
  symbol: "SPX",
};
const sofrUrl = "https://markets.newyorkfed.org/read?productCode=50&eventCodes=520&limit=1&format=json";
const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longMonths = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const sofrCacheTtlMs = 15 * 60 * 1000;
let cachedSofrRate: {rate: SofrRate; updatedAt: number} | undefined;

function normalizeBoxSpreadDirection(direction: string): BoxSpreadDirection {
  if ("borrow" === direction || "lend" === direction) {
    return direction;
  }

  throw new OptionDeltaInputError("Direction must be borrow or lend.");
}

function normalizeBoxSpreadNotational(notational: number): number {
  if (false === Number.isFinite(notational) || notational <= 0) {
    throw new OptionDeltaInputError("Notational must be greater than 0.");
  }

  return Math.round(notational);
}

function isNearInteger(value: number): boolean {
  return Math.abs(value - Math.round(value)) < 1e-6;
}

function getContractMidPrice(contract: OptionDeltaContract): number {
  const mid = getOptionContractMidPrice(contract);
  if (null === mid) {
    throw new OptionDeltaDataError(`Missing bid/ask midpoint for ${contract.symbol}.`);
  }

  return mid;
}

function getBoxLimitPrice(pair: BoxSpreadPair): number {
  return getContractMidPrice(pair.lowerCall)
    - getContractMidPrice(pair.lowerPut)
    - getContractMidPrice(pair.upperCall)
    + getContractMidPrice(pair.upperPut);
}

function getRequiredQuotePrice(value: number | null, contract: OptionDeltaContract): number {
  if (null === value) {
    throw new OptionDeltaDataError(`Missing bid/ask quote for ${contract.symbol}.`);
  }

  return value;
}

function getNaturalCredit(pair: BoxSpreadPair): number {
  return getRequiredQuotePrice(pair.lowerCall.bid, pair.lowerCall)
    - getRequiredQuotePrice(pair.lowerPut.ask, pair.lowerPut)
    - getRequiredQuotePrice(pair.upperCall.ask, pair.upperCall)
    + getRequiredQuotePrice(pair.upperPut.bid, pair.upperPut);
}

function getNaturalDebit(pair: BoxSpreadPair): number {
  return getRequiredQuotePrice(pair.lowerCall.ask, pair.lowerCall)
    - getRequiredQuotePrice(pair.lowerPut.bid, pair.lowerPut)
    - getRequiredQuotePrice(pair.upperCall.bid, pair.upperCall)
    + getRequiredQuotePrice(pair.upperPut.ask, pair.upperPut);
}

function getContractByStrikeAndSide(
  contracts: OptionDeltaContract[],
  strike: number,
  optionType: OptionDeltaContract["optionType"],
): OptionDeltaContract | null {
  return contracts.find(contract => contract.strike === strike && contract.optionType === optionType) ?? null;
}

function hasUsableBidAsk(contract: OptionDeltaContract): boolean {
  return null !== contract.bid && null !== contract.ask;
}

function getBoxSpreadPairs(
  lookupResult: OptionContractsLookupResult,
  market: BoxSpreadMarket,
  notational: number,
): BoxSpreadPair[] {
  const strikes = [...new Set(lookupResult.contracts.map(contract => contract.strike))]
    .sort((first, second) => first - second);
  const pairs: BoxSpreadPair[] = [];

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
      const notationalPerContract = width * market.multiplier;
      const contracts = notational / notationalPerContract;
      if (false === isNearInteger(contracts) || contracts < 1) {
        continue;
      }

      const lowerCall = getContractByStrikeAndSide(lookupResult.contracts, lowerStrike, "call");
      const lowerPut = getContractByStrikeAndSide(lookupResult.contracts, lowerStrike, "put");
      const upperCall = getContractByStrikeAndSide(lookupResult.contracts, upperStrike, "call");
      const upperPut = getContractByStrikeAndSide(lookupResult.contracts, upperStrike, "put");
      if (
        null === lowerCall
          || null === lowerPut
          || null === upperCall
          || null === upperPut
          || false === hasUsableBidAsk(lowerCall)
          || false === hasUsableBidAsk(lowerPut)
          || false === hasUsableBidAsk(upperCall)
          || false === hasUsableBidAsk(upperPut)
      ) {
        continue;
      }

      pairs.push({
        contracts: Math.round(contracts),
        lowerCall,
        lowerPut,
        lowerStrike,
        upperCall,
        upperPut,
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

    if (null !== lookupResult.underlyingPrice) {
      const firstMidpointDistance = Math.abs(((first.lowerStrike + first.upperStrike) / 2) - lookupResult.underlyingPrice);
      const secondMidpointDistance = Math.abs(((second.lowerStrike + second.upperStrike) / 2) - lookupResult.underlyingPrice);
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

function getBoxSpreadLegs(pair: BoxSpreadPair, direction: BoxSpreadDirection): BoxSpreadLeg[] {
  if ("borrow" === direction) {
    return [
      {action: "Sell", contract: pair.lowerCall, quantity: pair.contracts},
      {action: "Buy", contract: pair.lowerPut, quantity: pair.contracts},
      {action: "Buy", contract: pair.upperCall, quantity: pair.contracts},
      {action: "Sell", contract: pair.upperPut, quantity: pair.contracts},
    ];
  }

  return [
    {action: "Buy", contract: pair.lowerCall, quantity: pair.contracts},
    {action: "Sell", contract: pair.lowerPut, quantity: pair.contracts},
    {action: "Sell", contract: pair.upperCall, quantity: pair.contracts},
    {action: "Buy", contract: pair.upperPut, quantity: pair.contracts},
  ];
}

function parseSofrRate(response: NewYorkFedSofrResponse): SofrRate {
  const rate = response.refRates?.find(candidate => "SOFR" === candidate.type);
  if (
    undefined === rate
      || "string" !== typeof rate.effectiveDate
      || "number" !== typeof rate.percentRate
      || false === Number.isFinite(rate.percentRate)
  ) {
    throw new OptionDeltaDataError("SOFR rate is unavailable.");
  }

  return {
    effectiveDate: rate.effectiveDate,
    percentRate: rate.percentRate,
  };
}

export async function getSofrRate(): Promise<SofrRate> {
  const now = Date.now();
  if (undefined !== cachedSofrRate && now - cachedSofrRate.updatedAt <= sofrCacheTtlMs) {
    return cachedSofrRate.rate;
  }

  const response = await getWithRetry<NewYorkFedSofrResponse>(sofrUrl);
  const rate = parseSofrRate(response.data);
  cachedSofrRate = {
    rate,
    updatedAt: now,
  };
  return rate;
}

export async function getBoxSpreadLookup(
  request: BoxSpreadLookupRequest,
  dependencies: BoxSpreadLookupDependencies = {},
): Promise<BoxSpreadLookupResult> {
  const direction = normalizeBoxSpreadDirection(request.direction);
  const dte = normalizeDte(request.dte);
  const notational = normalizeBoxSpreadNotational(request.notational);
  const getOptionContractsLookupFn = dependencies.getOptionContractsLookupFn ?? getOptionContractsLookup;
  const getSofrRateFn = dependencies.getSofrRateFn ?? getSofrRate;
  const [lookupResult, sofr] = await Promise.all([
    getOptionContractsLookupFn({
      credentials: request.credentials,
      dte,
      side: "both",
      symbol: spxBoxSpreadMarket.symbol,
    }, dependencies),
    getSofrRateFn(),
  ]);
  const pairs = getBoxSpreadPairs(lookupResult, spxBoxSpreadMarket, notational);
  const pair = pairs[0];
  if (undefined === pair) {
    throw new OptionDeltaDataError(`No SPX box spread found for ${notational.toLocaleString("en-US")} notational.`);
  }

  const limitPrice = getBoxLimitPrice(pair);
  const naturalCredit = getNaturalCredit(pair);
  const naturalDebit = getNaturalDebit(pair);
  if (false === Number.isFinite(limitPrice) || limitPrice <= 0) {
    throw new OptionDeltaDataError("Box spread limit price is unavailable.");
  }

  const cashToday = limitPrice * spxBoxSpreadMarket.multiplier * pair.contracts;
  const financingAmount = notational - cashToday;
  const impliedRate = ((notational / cashToday) - 1) * (360 / lookupResult.actualDte);

  return {
    actualDte: lookupResult.actualDte,
    benchmarkName: spxBoxSpreadMarket.benchmarkName,
    cashToday,
    contracts: pair.contracts,
    currency: spxBoxSpreadMarket.currency,
    direction,
    expiration: lookupResult.expiration,
    financingAmount,
    impliedRate,
    legs: getBoxSpreadLegs(pair, direction),
    limitPrice,
    naturalCredit,
    naturalDebit,
    notational,
    rateDeltaToBenchmark: impliedRate - (sofr.percentRate / 100),
    requestedDte: lookupResult.requestedDte,
    rolled: lookupResult.rolled,
    sofr,
    symbol: lookupResult.symbol,
    underlyingPrice: lookupResult.underlyingPrice,
    underlyingPriceIsRealtime: lookupResult.underlyingPriceIsRealtime,
    width: pair.width,
  };
}

function formatMoney(value: number): string {
  const roundedValue = Math.round(value);
  const sign = roundedValue < 0 ? "-" : "";
  return `${sign}$${Math.abs(roundedValue).toLocaleString("en-US")}`;
}

function getOrdinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) {
    return "th";
  }

  const lastDigit = day % 10;
  if (1 === lastDigit) return "st";
  if (2 === lastDigit) return "nd";
  if (3 === lastDigit) return "rd";
  return "th";
}

function parseExpirationDate(expiration: string): Date {
  const date = new Date(`${expiration}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) {
    throw new OptionDeltaDataError(`Invalid expiration date ${expiration}.`);
  }

  return date;
}

function formatLongExpirationDate(expiration: string): string {
  const date = parseExpirationDate(expiration);
  const month = longMonths[date.getUTCMonth()] ?? "";
  const day = date.getUTCDate();
  return `${month} ${day}${getOrdinalSuffix(day)}, ${date.getUTCFullYear()}`;
}

function formatTicketExpiration(expiration: string): string {
  const date = parseExpirationDate(expiration);
  const month = shortMonths[date.getUTCMonth()] ?? "";
  const day = date.getUTCDate().toString().padStart(2, "0");
  const year = date.getUTCFullYear().toString().slice(-2);
  return `${month}${day}'${year}`;
}

function formatStrike(strike: number): string {
  return strike.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    useGrouping: false,
  }).replace(/\.00$/, "");
}

function formatLeg(leg: BoxSpreadLeg): string {
  const optionType = "call" === leg.contract.optionType ? "Call" : "Put";
  return `${leg.action} ${leg.quantity} ${formatTicketExpiration(leg.contract.expirationDate)} ${formatStrike(leg.contract.strike)} ${optionType}`;
}

function formatSignedBasisPoints(value: number): string {
  const basisPoints = value * 10_000;
  const sign = basisPoints >= 0 ? "+" : "";
  return `${sign}${formatDecimal(basisPoints, 0)} bps`;
}

function formatRate(value: number): string {
  return `${formatDecimal(value * 100, 2)}%`;
}

function getExpirationText(result: BoxSpreadLookupResult): string {
  if (true === result.rolled) {
    return `Expiry \`${result.expiration}\` (\`${result.actualDte}\` DTE, requested \`${result.requestedDte}\`)`;
  }

  return `Expiry \`${result.expiration}\` (\`${result.actualDte}\` DTE)`;
}

export function formatBoxSpreadLookupResult(result: BoxSpreadLookupResult): string {
  const directionLabel = "borrow" === result.direction ? "Borrow" : "Lend";
  const rateLabel = "borrow" === result.direction ? "borrow" : "lending";
  const cashflowText = "borrow" === result.direction
    ? `Borrow \`${formatMoney(result.cashToday)}\` today, repay \`${formatMoney(result.notational)}\` for a cost of \`${formatMoney(result.financingAmount)}\` on ${formatLongExpirationDate(result.expiration)}`
    : `Lend \`${formatMoney(result.cashToday)}\` today, receive \`${formatMoney(result.notational)}\` for interest of \`${formatMoney(result.financingAmount)}\` on ${formatLongExpirationDate(result.expiration)}`;
  const limitSide = "borrow" === result.direction ? "credit" : "debit";

  return [
    `${formatSymbolWithUnderlyingPrice(
      result.symbol,
      result.underlyingPrice,
      result.underlyingPriceIsRealtime,
    )} | Box Spread | ${directionLabel} | ${getExpirationText(result)}`,
    cashflowText,
    `Implied ${rateLabel} rate: \`${formatRate(result.impliedRate)}\` | ${result.benchmarkName}: \`${formatDecimal(result.sofr.percentRate, 2)}%\` (${result.sofr.effectiveDate}) | Δ: \`${formatSignedBasisPoints(result.rateDeltaToBenchmark)}\``,
    `Limit: mid ${limitSide} \`${formatDecimal(result.limitPrice)}\` (\`${formatMoney(result.cashToday)}\`) | Width: \`${formatStrike(result.width)}\` | Contracts: \`${result.contracts}\``,
    `Market: natural credit \`${formatDecimal(result.naturalCredit)}\` / mid \`${formatDecimal(result.limitPrice)}\` / natural debit \`${formatDecimal(result.naturalDebit)}\``,
    "",
    "Example trade",
    ...result.legs.map(formatLeg),
  ].join("\n");
}
