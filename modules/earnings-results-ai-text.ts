import {htmlToText} from "./earnings-results-format.ts";

const maxAiFilingTextLength = 10_000;
const aiRelevantContextBeforeLines = 2;
const aiRelevantContextAfterLines = 4;

export function getRelevantEarningsFilingText(html: string): string {
  const lines = htmlToText(html)
    .split("\n")
    .map(line => line.replace(/\s*\|\s*/g, " | ").replace(/\s+/g, " ").trim())
    .filter(line => line.length >= 3);
  if (0 === lines.length) {
    return "";
  }

  const selectedLineIndexes = new Set<number>();
  for (const [lineIndex, line] of lines.entries()) {
    if (false === isAiRelevantLine(line)) {
      continue;
    }

    for (
      let index = Math.max(0, lineIndex - aiRelevantContextBeforeLines);
      index <= Math.min(lines.length - 1, lineIndex + aiRelevantContextAfterLines);
      index++
    ) {
      selectedLineIndexes.add(index);
    }
  }

  const selectedLines = [...selectedLineIndexes]
    .sort((first, second) => first - second)
    .map(lineIndex => lines[lineIndex])
    .filter((line): line is string => undefined !== line);
  const selectedText = selectedLines.join("\n").trim();
  return truncateAiText("" === selectedText ? lines.join("\n") : selectedText);
}

function isAiRelevantLine(line: string): boolean {
  return /\b(?:earnings|results?|revenue|sales|net\s+income|net\s+earnings|eps|per\s+share|guidance|outlook|forecast|quarter|fiscal)\b/i.test(line);
}

function truncateAiText(value: string): string {
  if (value.length <= maxAiFilingTextLength) {
    return value;
  }

  const truncatedValue = value.slice(0, maxAiFilingTextLength);
  const lastLineBreak = truncatedValue.lastIndexOf("\n");
  const excerpt = lastLineBreak > 0
    ? truncatedValue.slice(0, lastLineBreak)
    : truncatedValue;
  return `${excerpt.trimEnd()}\n[truncated]`;
}
