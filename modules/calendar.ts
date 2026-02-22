/* eslint-disable import/extensions */
/* eslint-disable max-depth */
/* eslint-disable @typescript-eslint/no-unnecessary-boolean-literal-compare */
/* eslint-disable yoda */
/* eslint-disable complexity */
import moment from "moment-timezone";
import {getLogger} from "./logging.js";
import {postWithRetry} from "./http-retry.js";

const logger = getLogger();
const calendarTitle = "Wichtige Termine:";
const calendarTruncationNote = "... weitere Termine konnten wegen Discord-Limits nicht angezeigt werden.";
const europeBerlinTimezone = "Europe/Berlin";
const countryByCalendarCode = new Map<number, string>([
  [999, "🇪🇺"],
  [840, "🇺🇸"],
  [826, "🇬🇧"],
  [724, "🇪🇸"],
  [392, "🇯🇵"],
  [380, "🇮🇹"],
  [276, "🇩🇪"],
  [250, "🇫🇷"],
  [0, "🌍"],
]);

export const CALENDAR_MAX_MESSAGE_LENGTH = 1800;
export const CALENDAR_MAX_MESSAGES_TIMER = 8;
export const CALENDAR_MAX_MESSAGES_SLASH = 6;
export const CALENDAR_CONTINUATION_LABEL = "(Fortsetzung)";

export type CalendarMessageBatch = {
  messages: string[];
  truncated: boolean;
  totalEvents: number;
  includedEvents: number;
  totalDays: number;
  includedDays: number;
};

export type CalendarMessageOptions = {
  maxMessageLength?: number;
  maxMessages?: number;
  keepDayTogether?: boolean;
  continuationLabel?: string;
  title?: string;
};

type CalendarDayBlock = {
  date: string;
  friendlyDate: string;
  lines: string[];
};

type CalendarMessageChunk = {
  content: string;
  eventCount: number;
  dayKeys: Set<string>;
};

function getCalendarRangeInBerlin(startDay: string, range: number): {startDate: moment.Moment; endDate: moment.Moment} {
  const effectiveStartDay = "" === startDay
    ? moment.tz(europeBerlinTimezone).format("YYYY-MM-DD")
    : startDay;

  let startDate: moment.Moment = moment(effectiveStartDay).tz(europeBerlinTimezone).set({
    hour: 0,
    minute: 0,
    second: 0,
  });
  if (startDate.day() === 6) {
    startDate = moment(startDate).day(8);
  } else if (startDate.day() === 0) {
    startDate = moment(startDate).day(1);
  }

  let endDate = moment(startDate).set({
    hour: 23,
    minute: 59,
    second: 59,
  });
  if (0 !== range) {
    endDate = moment(endDate).add(range, "days");
  }

  return {
    startDate,
    endDate,
  };
}

function getCountryFlag(countryCode: number): string {
  return countryByCalendarCode.get(countryCode) ?? "🌍";
}

export async function getCalendarEvents(startDay: string, range: number): Promise<CalendarEvent[]> {
  const {startDate, endDate} = getCalendarRangeInBerlin(startDay, range);

  const calendarEvents = [];

  try {
    const calendarResponse = await postWithRetry(
      "https://www.mql5.com/en/economic-calendar/content",
      `date_mode=0&from=${moment(startDate).format("YYYY-MM-DD")}T00%3A00%3A00&to=${moment(endDate).format("YYYY-MM-DD")}T23%3A59%3A59&importance=12&currencies=15`,
      {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/74.0.3729.169 Safari/537.36",
        },
      },
    );

    if (1 < calendarResponse.data.length) {
      for (const element of calendarResponse.data) {
        const calendarEvent = new CalendarEvent();

        // Source data does not contain timezone info, guess its UTC...
        const eventDate: moment.Moment = moment.utc(element.FullDate).tz(europeBerlinTimezone);

        if (true === moment(eventDate).isSameOrBefore(endDate) && true === moment(eventDate).isSameOrAfter(startDate)) {
          const country = getCountryFlag(element.Country);
          const eventDeDate: string = moment.utc(element.FullDate).clone().tz(europeBerlinTimezone).format("YYYY-MM-DD");
          const eventDeTime: string = moment.utc(element.FullDate).clone().tz(europeBerlinTimezone).format("HH:mm");

          calendarEvent.date = eventDeDate;
          calendarEvent.time = eventDeTime;
          calendarEvent.country = country;
          calendarEvent.name = element.EventName;
          calendarEvents.push(calendarEvent);
        }
      }
    }
  } catch (error) {
    logger.log(
      "error",
      `Loading calendar failed: ${error}`,
    );
  }

  return calendarEvents;
}

export function getCalendarMessages(
  calendarEvents: CalendarEvent[],
  options: CalendarMessageOptions = {},
): CalendarMessageBatch {
  const maxMessageLength = options.maxMessageLength ?? CALENDAR_MAX_MESSAGE_LENGTH;
  const maxMessages = options.maxMessages ?? Number.POSITIVE_INFINITY;
  const continuationLabel = options.continuationLabel ?? CALENDAR_CONTINUATION_LABEL;
  const title = options.title ?? calendarTitle;
  const keepDayTogether = false !== options.keepDayTogether;

  if (0 === calendarEvents.length) {
    return {
      messages: [],
      truncated: false,
      totalEvents: 0,
      includedEvents: 0,
      totalDays: 0,
      includedDays: 0,
    };
  }

  const dayBlocks = getCalendarDayBlocks(calendarEvents);
  const chunks: CalendarMessageChunk[] = [];
  let currentChunk = getEmptyCalendarMessageChunk(0, title);
  let contentTruncated = false;

  for (const dayBlock of dayBlocks) {
    const fullDayBlockText = getDayBlockText(dayBlock, false, continuationLabel);

    if (true === canAppendToChunk(currentChunk, fullDayBlockText, maxMessageLength)) {
      appendToChunk(currentChunk, fullDayBlockText, dayBlock.lines.length, dayBlock.date);
      continue;
    }

    if (0 < currentChunk.eventCount) {
      chunks.push(cloneChunk(currentChunk));
      currentChunk = getEmptyCalendarMessageChunk(chunks.length, title);
    }

    if (true === canAppendToChunk(currentChunk, fullDayBlockText, maxMessageLength)) {
      appendToChunk(currentChunk, fullDayBlockText, dayBlock.lines.length, dayBlock.date);
      continue;
    }

    // If one day does not fit into a single message, split it by lines.
    let lineIndex = 0;
    let continuation = false;
    while (lineIndex < dayBlock.lines.length) {
      const header = getDayHeader(dayBlock.friendlyDate, continuationLabel, continuation);
      const lines: string[] = [];

      while (lineIndex < dayBlock.lines.length) {
        const candidateLines = [...lines, dayBlock.lines[lineIndex]];
        const candidatePart = getDayText(header, candidateLines);
        if (canAppendToChunk(currentChunk, candidatePart, maxMessageLength)) {
          lines.push(dayBlock.lines[lineIndex]);
          lineIndex++;
        } else {
          break;
        }
      }

      if (0 === lines.length) {
        const headerText = `\n${header}\n`;
        const availableLineLength = maxMessageLength - getAppendedChunkText(currentChunk, headerText).length - 1;
        if (availableLineLength <= 0 && 0 < currentChunk.eventCount) {
          chunks.push(cloneChunk(currentChunk));
          currentChunk = getEmptyCalendarMessageChunk(chunks.length, title);
          continue;
        }

        const rawLine = dayBlock.lines[lineIndex];
        const truncatedLine = truncateLine(rawLine, Math.max(availableLineLength, 1));
        lines.push(truncatedLine);
        lineIndex++;
        if (truncatedLine !== rawLine) {
          contentTruncated = true;
        }
      }

      const partText = getDayText(header, lines);
      appendToChunk(currentChunk, partText, lines.length, dayBlock.date);

      if (lineIndex < dayBlock.lines.length) {
        chunks.push(cloneChunk(currentChunk));
        currentChunk = getEmptyCalendarMessageChunk(chunks.length, title);
        continuation = true;
      }
    }

    if (false === keepDayTogether) {
      // Intentionally no-op for now: this option keeps API flexibility without changing default behavior.
    }
  }

  if (0 < currentChunk.eventCount) {
    chunks.push(cloneChunk(currentChunk));
  }

  let truncatedByMessageCount = false;
  let visibleChunks = chunks;
  if (visibleChunks.length > maxMessages) {
    truncatedByMessageCount = true;
    visibleChunks = visibleChunks.slice(0, maxMessages);
  }

  const messages = visibleChunks.map(chunk => chunk.content.trimEnd());
  const includedEvents = visibleChunks.reduce((sum, chunk) => sum + chunk.eventCount, 0);
  const includedDayKeys = new Set<string>();
  for (const chunk of visibleChunks) {
    for (const dayKey of chunk.dayKeys) {
      includedDayKeys.add(dayKey);
    }
  }

  if (true === truncatedByMessageCount && 0 < messages.length) {
    messages[messages.length - 1] = appendTruncationNote(messages[messages.length - 1], maxMessageLength);
  }

  return {
    messages,
    truncated: true === contentTruncated || true === truncatedByMessageCount,
    totalEvents: calendarEvents.length,
    includedEvents,
    totalDays: dayBlocks.length,
    includedDays: includedDayKeys.size,
  };
}

export function getCalendarText(calendarEvents: CalendarEvent[]): string {
  const batch = getCalendarMessages(calendarEvents, {
    maxMessageLength: CALENDAR_MAX_MESSAGE_LENGTH,
    maxMessages: 1,
    keepDayTogether: true,
    continuationLabel: CALENDAR_CONTINUATION_LABEL,
  });

  if (0 < batch.messages.length) {
    return batch.messages[0];
  }

  return "none";
}

export class CalendarEvent {
  private _date: string;
  private _time: string;
  private _country: string;
  private _name: string;

  public get date() {
    return this._date;
  }

  public set date(date: string) {
    this._date = date;
  }

  public get time() {
    return this._time;
  }

  public set time(time: string) {
    this._time = time;
  }

  public get country() {
    return this._country;
  }

  public set country(country: string) {
    this._country = country;
  }

  public get name() {
    return this._name;
  }

  public set name(name: string) {
    this._name = name;
  }
}

function getCalendarDayBlocks(calendarEvents: CalendarEvent[]): CalendarDayBlock[] {
  moment.locale("de");
  const dayBlocksByDate = new Map<string, CalendarDayBlock>();
  const sortedEvents = [...calendarEvents].sort((first, second) => {
    const firstKey = `${first.date}|${first.time}|${first.name}`;
    const secondKey = `${second.date}|${second.time}|${second.name}`;
    return firstKey.localeCompare(secondKey);
  });

  for (const event of sortedEvents) {
    const dayBlock = dayBlocksByDate.get(event.date) ?? {
      date: event.date,
      friendlyDate: moment(event.date).format("dddd, Do MMMM YYYY"),
      lines: [],
    };

    dayBlock.lines.push(`\`${event.time}\` ${event.country} ${event.name}`);
    dayBlocksByDate.set(event.date, dayBlock);
  }

  return [...dayBlocksByDate.values()];
}

function getDayText(dayHeader: string, lines: string[]): string {
  return `\n${dayHeader}\n${lines.join("\n")}\n`;
}

function getDayHeader(friendlyDate: string, continuationLabel: string, continuation: boolean): string {
  if (false === continuation) {
    return `**${friendlyDate}**`;
  }

  return `**${friendlyDate} ${continuationLabel}**`;
}

function getDayBlockText(dayBlock: CalendarDayBlock, continuation: boolean, continuationLabel: string): string {
  const dayHeader = getDayHeader(dayBlock.friendlyDate, continuationLabel, continuation);
  return getDayText(dayHeader, dayBlock.lines);
}

function getEmptyCalendarMessageChunk(messageIndex: number, title: string): CalendarMessageChunk {
  const prefix = 0 === messageIndex && 0 < title.length ? `${title}\n` : "";
  return {
    content: prefix,
    eventCount: 0,
    dayKeys: new Set<string>(),
  };
}

function getAppendedChunkText(chunk: CalendarMessageChunk, text: string): string {
  if ("" === chunk.content) {
    return text;
  }

  if (chunk.content.endsWith("\n")) {
    return `${chunk.content}${text}`;
  }

  return `${chunk.content}\n${text}`;
}

function canAppendToChunk(chunk: CalendarMessageChunk, text: string, maxMessageLength: number): boolean {
  return getAppendedChunkText(chunk, text).length <= maxMessageLength;
}

function appendToChunk(chunk: CalendarMessageChunk, text: string, eventCount: number, dayKey: string) {
  chunk.content = getAppendedChunkText(chunk, text);
  chunk.eventCount += eventCount;
  chunk.dayKeys.add(dayKey);
}

function cloneChunk(chunk: CalendarMessageChunk): CalendarMessageChunk {
  return {
    content: chunk.content,
    eventCount: chunk.eventCount,
    dayKeys: new Set(chunk.dayKeys),
  };
}

function truncateLine(line: string, maxLength: number): string {
  if (line.length <= maxLength) {
    return line;
  }

  if (maxLength <= 3) {
    return line.slice(0, maxLength);
  }

  return `${line.slice(0, maxLength - 3)}...`;
}

function appendTruncationNote(content: string, maxMessageLength: number): string {
  const suffix = `\n${calendarTruncationNote}`;
  if (content.length + suffix.length <= maxMessageLength) {
    return `${content}${suffix}`;
  }

  const messageLengthWithoutSuffix = maxMessageLength - suffix.length;
  if (messageLengthWithoutSuffix <= 0) {
    return calendarTruncationNote.slice(0, maxMessageLength);
  }

  const trimmedContent = content.slice(0, messageLengthWithoutSuffix).trimEnd();
  return `${trimmedContent}${suffix}`;
}
