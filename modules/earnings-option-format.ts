import {type EarningsEvent} from "./earnings-types.ts";
import {formatOptionalPrice} from "./options-format.ts";

function getExpectedMoveDteText(expectedMoveActualDte: number | undefined): string {
  if ("number" !== typeof expectedMoveActualDte || false === Number.isFinite(expectedMoveActualDte)) {
    return "";
  }

  return ` (\`${Math.round(expectedMoveActualDte)}\` DTE)`;
}

export function getFormattedExpectedMoveUnderlyingPriceText(earningsEvent: EarningsEvent): string {
  if (
    "number" !== typeof earningsEvent.expectedMoveUnderlyingPrice
      || false === Number.isFinite(earningsEvent.expectedMoveUnderlyingPrice)
      || earningsEvent.expectedMoveUnderlyingPrice < 0
  ) {
    return "";
  }

  return ` 📈 Last: \`$${formatOptionalPrice(earningsEvent.expectedMoveUnderlyingPrice)}\``;
}

export function getFormattedExpectedMoveText(earningsEvent: EarningsEvent): string {
  if ("number" !== typeof earningsEvent.expectedMove || false === Number.isFinite(earningsEvent.expectedMove) || earningsEvent.expectedMove < 0) {
    return "";
  }

  return ` 🎯 Move: \`+/- ${formatOptionalPrice(earningsEvent.expectedMove)}\`${getExpectedMoveDteText(earningsEvent.expectedMoveActualDte)}`;
}
