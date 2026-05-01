import {
  type OptionDeltaBracket,
  type OptionDeltaContract,
  type OptionDeltaLookupResult,
  type OptionDeltaSide,
} from "./options-delta.ts";

type FormattedDeltaBracketEntry = {
  contract: OptionDeltaContract | null;
  label: string;
};

export function formatDecimal(value: number, digits = 2): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

export function formatOptionalPrice(value: number | null): string {
  if (null === value) {
    return "n/a";
  }

  return formatDecimal(value);
}

export function formatSymbolWithUnderlyingPrice(
  symbol: string,
  underlyingPrice: number | null,
  underlyingPriceIsRealtime: boolean,
): string {
  const realtimeNote = true === underlyingPriceIsRealtime ? "" : " (market closed)";
  return `\`${symbol}\` @ \`${formatOptionalPrice(underlyingPrice)}\`${realtimeNote}`;
}

export function formatOptionalSize(value: number | null): string {
  if (null === value) {
    return "n/a";
  }

  return Math.round(value).toLocaleString("en-US", {
    maximumFractionDigits: 0,
  });
}

export function formatOptionalPercent(value: number | null): string {
  if (null === value) {
    return "n/a";
  }

  return `${formatDecimal(value * 100, 1)}%`;
}

export function getOptionContractMidPrice(contract: OptionDeltaContract): number | null {
  if (null !== contract.bid && null !== contract.ask) {
    return (contract.bid + contract.ask) / 2;
  }

  return null;
}

export function getOptionContractSpreadPercent(contract: OptionDeltaContract): number | null {
  const mid = getOptionContractMidPrice(contract);
  if (null === mid || 0 >= mid || null === contract.bid || null === contract.ask) {
    return null;
  }

  return (contract.ask - contract.bid) / mid;
}

export function getClosestDeltaContract(bracket: OptionDeltaBracket, targetDelta: number): OptionDeltaContract | null {
  if (null === bracket.below) {
    return bracket.above;
  }

  if (null === bracket.above) {
    return bracket.below;
  }

  const belowDistance = Math.abs(Math.abs(bracket.below.delta) - targetDelta);
  const aboveDistance = Math.abs(Math.abs(bracket.above.delta) - targetDelta);
  return belowDistance <= aboveDistance ? bracket.below : bracket.above;
}

export function getContractName(contract: OptionDeltaContract): string {
  const suffix = "call" === contract.optionType ? "C" : "P";
  return `${formatDecimal(contract.strike).replace(/\.00$/, "")}${suffix}`;
}

function formatContractLine(label: string, contract: OptionDeltaContract | null): string {
  if (null === contract) {
    return `• ${label}: Keine passende Option gefunden.`;
  }

  const mid = getOptionContractMidPrice(contract);
  const spreadPercent = getOptionContractSpreadPercent(contract);
  const liquidityNote = null !== spreadPercent && 0.2 < spreadPercent ? " | `wide spread`" : "";
  const headline = [
    `• ${label}: \`${getContractName(contract)}\``,
    `Δ \`${formatDecimal(Math.abs(contract.delta), 3)}\``,
    `mid \`${formatOptionalPrice(mid)}\``,
  ].join(" | ");
  const details = [
    `bid/ask \`${formatOptionalPrice(contract.bid)} / ${formatOptionalPrice(contract.ask)}\``,
    `spread \`${formatOptionalPercent(spreadPercent)}\`${liquidityNote}`,
    `size \`${formatOptionalSize(contract.bidSize)} x ${formatOptionalSize(contract.askSize)}\``,
    `IV \`${formatOptionalPercent(contract.iv)}\``,
  ].join(" | ");
  return `${headline}\n  ${details}`;
}

function getFormattedDeltaBracketEntries(bracket: OptionDeltaBracket): FormattedDeltaBracketEntry[] {
  const entries: FormattedDeltaBracketEntry[] = [
    {
      contract: bracket.below,
      label: "Δ ≤ target",
    },
    {
      contract: bracket.above,
      label: "Δ ≥ target",
    },
  ];
  const entriesWithContracts = entries
    .filter(entry => null !== entry.contract)
    .sort((first, second) => {
      const firstContract = first.contract;
      const secondContract = second.contract;
      if (null === firstContract || null === secondContract) {
        return 0;
      }

      return firstContract.strike - secondContract.strike;
    });
  const entriesWithoutContracts = entries.filter(entry => null === entry.contract);
  return [...entriesWithContracts, ...entriesWithoutContracts];
}

function formatSideTitle(side: OptionDeltaSide): string {
  return "call" === side ? "Calls" : "Puts";
}

export function formatOptionDeltaLookupResult(result: OptionDeltaLookupResult): string {
  const expirationText = true === result.rolled
    ? `Expiry \`${result.expiration}\` (\`${result.actualDte}\` DTE, requested \`${result.requestedDte}\`)`
    : `Expiry \`${result.expiration}\` (\`${result.actualDte}\` DTE)`;
  const lines = [
    `${formatSymbolWithUnderlyingPrice(
      result.symbol,
      result.underlyingPrice,
      result.underlyingPriceIsRealtime,
    )} | Δ target \`${formatDecimal(result.targetDelta, 2)}\` | ${expirationText}`,
  ];

  for (const sideResult of result.sideResults) {
    lines.push(`**${formatSideTitle(sideResult.side)}**`);
    for (const entry of getFormattedDeltaBracketEntries(sideResult.brackets)) {
      lines.push(formatContractLine(entry.label, entry.contract));
    }
  }

  return lines.join("\n");
}
