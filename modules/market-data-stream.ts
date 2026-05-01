import {type MarketStreamEvent} from "./market-data-types.ts";

const maxLoggedPayloadLength = 500;

export function normalizeEventData(rawData: unknown): string | null {
  if ("string" === typeof rawData) {
    return rawData;
  }

  if (Buffer.isBuffer(rawData)) {
    return rawData.toString("utf8");
  }

  if (rawData instanceof ArrayBuffer) {
    return Buffer.from(rawData).toString("utf8");
  }

  return null;
}

export function parseStreamEvent(rawMessage: string): MarketStreamEvent | null {
  const rawEventData = extractStreamEventPayload(rawMessage);
  if (null === rawEventData) {
    return null;
  }

  const pid = parseNumericValue(rawEventData["pid"]);
  const lastNumeric = parseNumericValue(rawEventData["last_numeric"]);
  const priceChange = parseNumericValue(rawEventData["pc"]);
  const percentageChange = parseNumericValue(rawEventData["pcp"]);

  if ([pid, lastNumeric, priceChange, percentageChange].every(Number.isFinite)) {
    return {
      pid,
      lastNumeric,
      priceChange,
      percentageChange,
    };
  }

  return null;
}

export function isPotentialMarketDataPayload(rawMessage: string): boolean {
  const normalizedMessage = rawMessage.toLowerCase();

  return normalizedMessage.includes("pid-")
    || normalizedMessage.includes("last_numeric")
    || normalizedMessage.includes("\"pid\"")
    || normalizedMessage.includes("\\\"pid\\\"");
}

export function getPayloadLogPreview(rawMessage: string): string {
  const normalizedWhitespace = rawMessage
    .replace(/\s+/g, " ")
    .trim();

  if (normalizedWhitespace.length <= maxLoggedPayloadLength) {
    return normalizedWhitespace;
  }

  return `${normalizedWhitespace.slice(0, maxLoggedPayloadLength)}...`;
}

function extractStreamEventPayload(rawMessage: string): Record<string, unknown> | null {
  const frameCandidates = unwrapSocketFrames(rawMessage);

  for (const frameCandidate of frameCandidates) {
    const payload = parsePayloadCandidate(frameCandidate, 0);
    if (null !== payload) {
      return payload;
    }
  }

  return null;
}

function unwrapSocketFrames(rawMessage: string): string[] {
  const trimmedMessage = rawMessage.trim();
  if (false === trimmedMessage.startsWith("a[")) {
    return [trimmedMessage];
  }

  try {
    const parsedFrames: unknown = JSON.parse(trimmedMessage.slice(1));
    if (Array.isArray(parsedFrames)) {
      return parsedFrames
        .map(frame => {
          if ("string" === typeof frame) {
            return frame.trim();
          }

          if ("object" === typeof frame && null !== frame) {
            return JSON.stringify(frame);
          }

          return null;
        })
        .filter((frame): frame is string => "string" === typeof frame && "" !== frame);
    }
  } catch {
    // Ignore malformed frame envelope and let parser continue with raw text.
  }

  return [trimmedMessage];
}

function parsePayloadCandidate(candidate: string, depth: number): Record<string, unknown> | null {
  if (depth > 6) {
    return null;
  }

  const trimmedCandidate = candidate.trim();
  if ("" === trimmedCandidate) {
    return null;
  }

  if (trimmedCandidate.startsWith("a[")) {
    const unwrappedFrames = unwrapSocketFrames(trimmedCandidate);
    for (const unwrappedFrame of unwrappedFrames) {
      if (unwrappedFrame !== trimmedCandidate) {
        const parsedUnwrappedFrame = parsePayloadCandidate(unwrappedFrame, depth + 1);
        if (null !== parsedUnwrappedFrame) {
          return parsedUnwrappedFrame;
        }
      }
    }
  }

  const parsedCandidate = tryParseJsonValue(trimmedCandidate);
  if (null !== parsedCandidate) {
    if ("string" === typeof parsedCandidate) {
      const parsedStringPayload = parsePayloadCandidate(parsedCandidate, depth + 1);
      if (null !== parsedStringPayload) {
        return parsedStringPayload;
      }
    } else if (Array.isArray(parsedCandidate)) {
      for (const frameCandidate of parsedCandidate) {
        if ("string" === typeof frameCandidate) {
          const parsedFrameCandidate = parsePayloadCandidate(frameCandidate, depth + 1);
          if (null !== parsedFrameCandidate) {
            return parsedFrameCandidate;
          }
        } else if ("object" === typeof frameCandidate && null !== frameCandidate) {
          const parsedFrameCandidate = parsePayloadCandidate(JSON.stringify(frameCandidate), depth + 1);
          if (null !== parsedFrameCandidate) {
            return parsedFrameCandidate;
          }
        }
      }
    } else {
      const parsedObjectCandidate = parsedCandidate as Record<string, unknown>;
      if ("string" === typeof parsedObjectCandidate["message"]) {
        const parsedMessage = parsePayloadCandidate(parsedObjectCandidate["message"], depth + 1);
        if (null !== parsedMessage) {
          return parsedMessage;
        }
      }

      if (true === hasStreamEventFields(parsedObjectCandidate)) {
        return parsedObjectCandidate;
      }
    }
  }

  const delimiterPosition = trimmedCandidate.lastIndexOf("::");
  if (-1 !== delimiterPosition) {
    const parsedAfterDelimiter = parsePayloadCandidate(trimmedCandidate.slice(delimiterPosition + 2), depth + 1);
    if (null !== parsedAfterDelimiter) {
      return parsedAfterDelimiter;
    }
  }

  const extractedObject = extractJsonObject(trimmedCandidate);
  if (null !== extractedObject && extractedObject !== trimmedCandidate) {
    const extractedPayload = parsePayloadCandidate(extractedObject, depth + 1);
    if (null !== extractedPayload) {
      return extractedPayload;
    }
  }

  return null;
}

function tryParseJsonValue(candidate: string): unknown | null {
  try {
    return JSON.parse(candidate);
  } catch {
    // Ignore malformed payloads and let caller continue.
  }

  return null;
}

function hasStreamEventFields(candidate: Record<string, unknown>): boolean {
  return "pid" in candidate && "last_numeric" in candidate && "pc" in candidate && "pcp" in candidate;
}

function extractJsonObject(candidate: string): string | null {
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (-1 === firstBrace || -1 === lastBrace || lastBrace <= firstBrace) {
    return null;
  }

  return candidate.slice(firstBrace, lastBrace + 1);
}

function parseNumericValue(value: unknown): number {
  if ("number" === typeof value) {
    return Number.isFinite(value) ? value : Number.NaN;
  }

  if ("string" === typeof value) {
    const normalizedValue = value
      .replaceAll(",", "")
      .trim()
      .replace(/%$/, "");

    if ("" === normalizedValue) {
      return Number.NaN;
    }

    const parsedValue = Number(normalizedValue);
    if (Number.isFinite(parsedValue)) {
      return parsedValue;
    }

    const parsedFloat = Number.parseFloat(normalizedValue);
    if (Number.isFinite(parsedFloat)) {
      return parsedFloat;
    }
  }

  return Number.NaN;
}
