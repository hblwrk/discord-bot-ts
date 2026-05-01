import {type EarningsEvent} from "./earnings-types.ts";
import {formatOptionalPrice} from "./options-format.ts";

function getExpectedMoveDteText(expectedMoveActualDte: number | undefined): string {
  if ("number" !== typeof expectedMoveActualDte || false === Number.isFinite(expectedMoveActualDte)) {
    return "";
  }

  return ` (\`${Math.round(expectedMoveActualDte)}\` DTE)`;
}

export function getFormattedExpectedMoveText(earningsEvent: EarningsEvent): string {
  if ("number" !== typeof earningsEvent.expectedMove || false === Number.isFinite(earningsEvent.expectedMove) || earningsEvent.expectedMove < 0) {
    return "";
  }

  const expirationText = "string" === typeof earningsEvent.expectedMoveExpiration && "" !== earningsEvent.expectedMoveExpiration.trim()
    ? ` Exp \`${earningsEvent.expectedMoveExpiration.trim()}\`${getExpectedMoveDteText(earningsEvent.expectedMoveActualDte)}`
    : "";
  return ` 🎯 Move: \`+/- ${formatOptionalPrice(earningsEvent.expectedMove)}\`${expirationText}`;
}
