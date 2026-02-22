import {
  CALENDAR_CONTINUATION_LABEL,
  CALENDAR_MAX_MESSAGE_LENGTH,
  CalendarEvent,
  getCalendarMessages,
} from "./calendar.js";

function createCalendarEvent(date: string, time: string, name: string, country = "🇺🇸"): CalendarEvent {
  const calendarEvent = new CalendarEvent();
  calendarEvent.date = date;
  calendarEvent.time = time;
  calendarEvent.country = country;
  calendarEvent.name = name;
  return calendarEvent;
}

describe("getCalendarMessages", () => {
  test("returns one message for a single day when content fits", () => {
    const calendarEvents: CalendarEvent[] = [
      createCalendarEvent("2025-03-03", "10:00", "Event A"),
      createCalendarEvent("2025-03-03", "12:00", "Event B"),
    ];

    const batch = getCalendarMessages(calendarEvents, {
      maxMessageLength: 1800,
      maxMessages: 6,
      keepDayTogether: true,
    });

    expect(batch.messages).toHaveLength(1);
    expect(batch.truncated).toBe(false);
    expect(batch.totalEvents).toBe(2);
    expect(batch.includedEvents).toBe(2);
    expect(batch.messages[0]).toContain("Wichtige Termine:");
    expect(batch.messages[0]).toContain("Wichtige Termine:\n\n**Montag, 3. März 2025**");
    expect(batch.messages[0]).toContain("Event A");
    expect(batch.messages[0]).toContain("Event B");
  });

  test("chunks by day boundaries across multiple days", () => {
    const dayOneEvents: CalendarEvent[] = [
      createCalendarEvent("2025-03-03", "09:00", "Day1-Event1"),
      createCalendarEvent("2025-03-03", "10:00", "Day1-Event2"),
    ];
    const dayTwoEvents: CalendarEvent[] = [
      createCalendarEvent("2025-03-04", "11:00", "Day2-Event1"),
      createCalendarEvent("2025-03-04", "12:00", "Day2-Event2"),
    ];
    const firstDayLength = getCalendarMessages(dayOneEvents).messages[0].length;
    const secondDayLength = getCalendarMessages(dayTwoEvents).messages[0].length;
    const maxMessageLength = Math.max(firstDayLength, secondDayLength) + 5;

    const batch = getCalendarMessages([...dayOneEvents, ...dayTwoEvents], {
      maxMessageLength,
      maxMessages: 6,
      keepDayTogether: true,
    });

    expect(batch.messages).toHaveLength(2);
    expect(batch.messages[0]).toContain("Day1-Event1");
    expect(batch.messages[0]).toContain("Day1-Event2");
    expect(batch.messages[0]).not.toContain("Day2-Event1");
    expect(batch.messages[1]).toContain("Day2-Event1");
    expect(batch.messages[1]).toContain("Day2-Event2");
  });

  test("does not split same-day events when the full day fits in an empty message", () => {
    const firstDayEvents: CalendarEvent[] = [
      createCalendarEvent("2025-03-03", "08:00", "Day1-Event"),
    ];
    const secondDayEvents: CalendarEvent[] = [
      createCalendarEvent("2025-03-04", "09:00", "Day2-Event1"),
      createCalendarEvent("2025-03-04", "10:00", "Day2-Event2"),
    ];
    const secondDayLength = getCalendarMessages(secondDayEvents).messages[0].length;
    const maxMessageLength = secondDayLength + 5;

    const batch = getCalendarMessages([...firstDayEvents, ...secondDayEvents], {
      maxMessageLength,
      maxMessages: 6,
      keepDayTogether: true,
    });

    expect(batch.messages).toHaveLength(2);
    expect(batch.messages[0]).toContain("Day1-Event");
    expect(batch.messages[0]).not.toContain("Day2-Event1");
    expect(batch.messages[1]).toContain("Day2-Event1");
    expect(batch.messages[1]).toContain("Day2-Event2");
    expect(batch.messages[1]).not.toContain(CALENDAR_CONTINUATION_LABEL);
  });

  test("splits oversized single-day content with continuation headers", () => {
    const calendarEvents: CalendarEvent[] = [];
    for (let index = 0; index < 16; index++) {
      calendarEvents.push(createCalendarEvent("2025-03-03", `1${Math.floor(index / 2)}:${index % 2}0`, `Event ${index} ${"X".repeat(60)}`));
    }

    const batch = getCalendarMessages(calendarEvents, {
      maxMessageLength: 220,
      maxMessages: 12,
      keepDayTogether: true,
    });

    expect(batch.messages.length).toBeGreaterThan(1);
    expect(batch.messages[0]).toContain("Event 0");
    expect(batch.messages[1]).toContain(CALENDAR_CONTINUATION_LABEL);
    expect(batch.includedEvents).toBe(16);
    expect(batch.totalEvents).toBe(16);
    for (const message of batch.messages) {
      expect(message.length).toBeLessThanOrEqual(220);
    }
  });

  test("sets truncation metadata and note when maxMessages is reached", () => {
    const calendarEvents: CalendarEvent[] = [];
    for (let day = 1; day <= 10; day++) {
      calendarEvents.push(
        createCalendarEvent(`2025-03-${String(day).padStart(2, "0")}`, "09:00", `Event-${day}-${"X".repeat(40)}`),
      );
    }

    const batch = getCalendarMessages(calendarEvents, {
      maxMessageLength: 120,
      maxMessages: 3,
      keepDayTogether: true,
    });

    expect(batch.truncated).toBe(true);
    expect(batch.messages).toHaveLength(3);
    expect(batch.includedEvents).toBeLessThan(batch.totalEvents);
    expect(batch.messages[2]).toContain("... weitere Termine konnten wegen Discord-Limits nicht angezeigt werden.");
  });

  test("keeps each chunk at or below the default Discord-safe message length", () => {
    const calendarEvents: CalendarEvent[] = [];
    for (let day = 1; day <= 12; day++) {
      for (let eventIndex = 0; eventIndex < 7; eventIndex++) {
        calendarEvents.push(
          createCalendarEvent(
            `2025-04-${String(day).padStart(2, "0")}`,
            `${String(8 + eventIndex).padStart(2, "0")}:00`,
            `Event-${day}-${eventIndex}-${"X".repeat(80)}`,
          ),
        );
      }
    }

    const batch = getCalendarMessages(calendarEvents, {
      maxMessageLength: CALENDAR_MAX_MESSAGE_LENGTH,
      maxMessages: 20,
      keepDayTogether: true,
    });

    for (const message of batch.messages) {
      expect(message.length).toBeLessThanOrEqual(CALENDAR_MAX_MESSAGE_LENGTH);
    }
  });

  test("handles 1799/1800/1801 boundary lengths against a max length of 1800", () => {
    function getNameLengthForRenderedLength(targetLength: number): number {
      for (let nameLength = 0; nameLength < 4000; nameLength++) {
        const event = createCalendarEvent("2025-05-01", "12:00", "X".repeat(nameLength));
        const renderedLength = getCalendarMessages([event], {
          maxMessageLength: 5000,
          maxMessages: 4,
          keepDayTogether: true,
        }).messages[0].length;
        if (renderedLength === targetLength) {
          return nameLength;
        }
      }

      throw new Error(`Could not build event content with rendered length ${targetLength}.`);
    }

    const event1799 = createCalendarEvent("2025-05-01", "12:00", "X".repeat(getNameLengthForRenderedLength(1799)));
    const event1800 = createCalendarEvent("2025-05-01", "12:00", "X".repeat(getNameLengthForRenderedLength(1800)));
    const event1801 = createCalendarEvent("2025-05-01", "12:00", "X".repeat(getNameLengthForRenderedLength(1801)));

    const batch1799 = getCalendarMessages([event1799], {
      maxMessageLength: 1800,
      maxMessages: 2,
      keepDayTogether: true,
    });
    const batch1800 = getCalendarMessages([event1800], {
      maxMessageLength: 1800,
      maxMessages: 2,
      keepDayTogether: true,
    });
    const batch1801 = getCalendarMessages([event1801], {
      maxMessageLength: 1800,
      maxMessages: 2,
      keepDayTogether: true,
    });

    expect(batch1799.truncated).toBe(false);
    expect(batch1800.truncated).toBe(true);
    expect(batch1801.truncated).toBe(true);
    expect(batch1799.messages[0].length).toBe(1799);
    expect(batch1800.messages[0].length).toBeLessThanOrEqual(1800);
    expect(batch1801.messages[0].length).toBeLessThanOrEqual(1800);
  });

  test("handles multiple days when one day is extremely large", () => {
    const calendarEvents: CalendarEvent[] = [
      createCalendarEvent("2025-06-01", "09:00", "Day1-Event"),
      createCalendarEvent("2025-06-03", "10:00", "Day3-Event"),
    ];
    for (let index = 0; index < 14; index++) {
      calendarEvents.push(createCalendarEvent("2025-06-02", "11:00", `Huge-Day-Event-${index}-${"Y".repeat(60)}`));
    }

    const batch = getCalendarMessages(calendarEvents, {
      maxMessageLength: 220,
      maxMessages: 30,
      keepDayTogether: true,
    });

    expect(batch.messages.length).toBeGreaterThan(2);
    expect(batch.messages.join("\n")).toContain("Day1-Event");
    expect(batch.messages.join("\n")).toContain("Day3-Event");
    expect(batch.messages.some(message => message.includes(CALENDAR_CONTINUATION_LABEL))).toBe(true);
  });
});
