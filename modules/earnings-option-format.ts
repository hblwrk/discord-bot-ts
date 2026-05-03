import {type EarningsEvent} from "./earnings-types.ts";
import {formatOptionalPercent, formatOptionalPrice} from "./options-format.ts";

function getExpectedMoveDetailsText(earningsEvent: EarningsEvent): string {
  const details: string[] = [];
  const underlyingPrice = earningsEvent.expectedMoveUnderlyingPrice;
  if (
    "number" === typeof underlyingPrice
      && Number.isFinite(underlyingPrice)
      && underlyingPrice > 0
      && "number" === typeof earningsEvent.expectedMove
  ) {
    details.push(formatOptionalPercent(earningsEvent.expectedMove / underlyingPrice));
  }

  if ("number" === typeof earningsEvent.expectedMoveActualDte && true === Number.isFinite(earningsEvent.expectedMoveActualDte)) {
    details.push(`${Math.round(earningsEvent.expectedMoveActualDte)} DTE`);
  }

  if (0 === details.length) {
    return "";
  }

  return ` (${details.join(", ")})`;
}

export function getFormattedExpectedMoveUnderlyingPriceText(earningsEvent: EarningsEvent): string {
  const underlyingPrice = earningsEvent.expectedMoveUnderlyingPrice;
  if (
    "number" !== typeof underlyingPrice
      || false === Number.isFinite(underlyingPrice)
      || underlyingPrice <= 0
  ) {
    return "";
  }

  return ` 📈 Last: \`$${formatOptionalPrice(underlyingPrice)}\``;
}

export function getFormattedExpectedMoveText(earningsEvent: EarningsEvent): string {
  if ("number" !== typeof earningsEvent.expectedMove || false === Number.isFinite(earningsEvent.expectedMove) || earningsEvent.expectedMove < 0) {
    return "";
  }

  return ` 🎯 Move: \`± $${formatOptionalPrice(earningsEvent.expectedMove)}${getExpectedMoveDetailsText(earningsEvent)}\``;
}
