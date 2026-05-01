import {
  type OptionDeltaBracket,
  type OptionDeltaContract,
  type OptionDeltaLookupResult,
  type OptionDeltaSide,
} from "./options-delta.ts";

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
    return `${label}: Keine passende Option gefunden.`;
  }

  const mid = getOptionContractMidPrice(contract);
  const spreadPercent = getOptionContractSpreadPercent(contract);
  const liquidityNote = null !== spreadPercent && 0.2 < spreadPercent ? " | `wide spread`" : "";
  return [
    `${label}: \`${getContractName(contract)}\``,
    `strike \`${formatDecimal(contract.strike).replace(/\.00$/, "")}\``,
    `delta \`${formatDecimal(Math.abs(contract.delta), 3)}\``,
    `bid/mid/ask \`${formatOptionalPrice(contract.bid)} / ${formatOptionalPrice(mid)} / ${formatOptionalPrice(contract.ask)}\``,
    `spread \`${formatOptionalPercent(spreadPercent)}\`${liquidityNote}`,
    `size \`${formatOptionalSize(contract.bidSize)} x ${formatOptionalSize(contract.askSize)}\``,
    `IV \`${formatOptionalPercent(contract.iv)}\``,
  ].join(" | ");
}

function formatSideTitle(side: OptionDeltaSide): string {
  return "call" === side ? "Calls" : "Puts";
}

export function formatOptionDeltaLookupResult(result: OptionDeltaLookupResult): string {
  const expirationText = true === result.rolled
    ? `Expiry \`${result.expiration}\` (\`${result.actualDte}\` DTE, requested \`${result.requestedDte}\`)`
    : `Expiry \`${result.expiration}\` (\`${result.actualDte}\` DTE)`;
  const lines = [
    `**\`${result.symbol}\` target delta \`${formatDecimal(result.targetDelta, 2)}\` | ${expirationText}**`,
  ];

  for (const sideResult of result.sideResults) {
    lines.push(`**${formatSideTitle(sideResult.side)}**`);
    lines.push(formatContractLine("Below target", sideResult.brackets.below));
    lines.push(formatContractLine("Above target", sideResult.brackets.above));
  }

  return lines.join("\n");
}
