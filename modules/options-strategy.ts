import {
  getClosestDeltaContract,
  getOptionContractMidPrice,
  getOptionDeltaLookup,
  type OptionDeltaContract,
  type OptionDeltaCredentials,
  type OptionDeltaLookupDependencies,
  type OptionDeltaLookupResult,
} from "./options-delta.ts";
import {formatDecimal, formatOptionalPrice, formatSymbolWithUnderlyingPrice, getContractName} from "./options-format.ts";

export type OptionStrategyLookupRequest = {
  credentials: OptionDeltaCredentials;
  delta?: number;
  dte: number;
  symbol: string;
};

export type OptionStrategyLookupResult = {
  actualDte: number;
  call: OptionDeltaContract | null;
  expiration: string;
  midTotal: number | null;
  put: OptionDeltaContract | null;
  requestedDte: number;
  rolled: boolean;
  symbol: string;
  targetDelta: number;
  underlyingPrice: number | null;
  underlyingPriceIsRealtime: boolean;
};

const defaultStrangleDelta = 0.16;
const straddleDelta = 0.5;

function sumOptional(first: number | null, second: number | null): number | null {
  if (null === first || null === second) {
    return null;
  }

  return first + second;
}

function getSideContract(result: OptionDeltaLookupResult, side: "call" | "put"): OptionDeltaContract | null {
  const sideResult = result.sideResults.find(candidate => candidate.side === side);
  if (undefined === sideResult) {
    return null;
  }

  return getClosestDeltaContract(sideResult.brackets, result.targetDelta);
}

function toStrategyResult(result: OptionDeltaLookupResult): OptionStrategyLookupResult {
  const call = getSideContract(result, "call");
  const put = getSideContract(result, "put");
  return {
    actualDte: result.actualDte,
    call,
    expiration: result.expiration,
    midTotal: sumOptional(
      null === call ? null : getOptionContractMidPrice(call),
      null === put ? null : getOptionContractMidPrice(put),
    ),
    put,
    requestedDte: result.requestedDte,
    rolled: result.rolled,
    symbol: result.symbol,
    targetDelta: result.targetDelta,
    underlyingPrice: result.underlyingPrice,
    underlyingPriceIsRealtime: result.underlyingPriceIsRealtime,
  };
}

export async function getOptionStrangleLookup(
  request: OptionStrategyLookupRequest,
  dependencies: OptionDeltaLookupDependencies = {},
): Promise<OptionStrategyLookupResult> {
  const result = await getOptionDeltaLookup({
    credentials: request.credentials,
    delta: request.delta ?? defaultStrangleDelta,
    dte: request.dte,
    side: "both",
    symbol: request.symbol,
  }, dependencies);

  return toStrategyResult(result);
}

export async function getOptionStraddleLookup(
  request: Omit<OptionStrategyLookupRequest, "delta">,
  dependencies: OptionDeltaLookupDependencies = {},
): Promise<OptionStrategyLookupResult> {
  const result = await getOptionDeltaLookup({
    credentials: request.credentials,
    delta: straddleDelta,
    dte: request.dte,
    side: "both",
    symbol: request.symbol,
  }, dependencies);

  return toStrategyResult(result);
}

function formatExpiration(result: OptionStrategyLookupResult): string {
  return true === result.rolled
    ? `Expiry \`${result.expiration}\` (\`${result.actualDte}\` DTE, requested \`${result.requestedDte}\`)`
    : `Expiry \`${result.expiration}\` (\`${result.actualDte}\` DTE)`;
}

function formatLeg(label: string, contract: OptionDeltaContract | null): string {
  if (null === contract) {
    return `• ${label}: Keine passende Option gefunden.`;
  }

  const mid = getOptionContractMidPrice(contract);
  return [
    `• ${label}: \`${getContractName(contract)}\``,
    `Δ \`${formatDecimal(Math.abs(contract.delta), 3)}\``,
    `mid \`${formatOptionalPrice(mid)}\``,
  ].join(" | ");
}

function formatBreakevens(result: OptionStrategyLookupResult): string {
  if (null === result.put || null === result.call || null === result.midTotal) {
    return "Breakevens: `n/a`";
  }

  return `Breakevens: \`${formatDecimal(result.put.strike - result.midTotal)} / ${formatDecimal(result.call.strike + result.midTotal)}\``;
}

export function formatOptionStrangleLookupResult(result: OptionStrategyLookupResult): string {
  return [
    `${formatSymbolWithUnderlyingPrice(
      result.symbol,
      result.underlyingPrice,
      result.underlyingPriceIsRealtime,
    )} | Strangle | Δ target \`${formatDecimal(result.targetDelta, 2)}\` | ${formatExpiration(result)}`,
    formatLeg("Put", result.put),
    formatLeg("Call", result.call),
    `Mid credit: \`${formatOptionalPrice(result.midTotal)}\``,
    formatBreakevens(result),
  ].join("\n");
}

export function formatOptionStraddleLookupResult(result: OptionStrategyLookupResult): string {
  return [
    `${formatSymbolWithUnderlyingPrice(
      result.symbol,
      result.underlyingPrice,
      result.underlyingPriceIsRealtime,
    )} | ATM Straddle | ${formatExpiration(result)}`,
    formatLeg("Put", result.put),
    formatLeg("Call", result.call),
    `Mid debit: \`${formatOptionalPrice(result.midTotal)}\``,
  ].join("\n");
}

export function formatExpectedMoveLookupResult(result: OptionStrategyLookupResult): string {
  return [
    `${formatSymbolWithUnderlyingPrice(
      result.symbol,
      result.underlyingPrice,
      result.underlyingPriceIsRealtime,
    )} | Expected Move | ${formatExpiration(result)}`,
    `Move proxy: \`+/- ${formatOptionalPrice(result.midTotal)}\` | ATM straddle mid \`${formatOptionalPrice(result.midTotal)}\``,
    formatLeg("Put", result.put),
    formatLeg("Call", result.call),
  ].join("\n");
}
