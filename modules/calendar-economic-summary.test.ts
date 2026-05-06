import {describe, expect, test, vi} from "vitest";
import {CalendarEvent} from "./calendar.ts";
import {getCalendarOfficialSummary} from "./calendar-economic-summary.ts";

function createCalendarEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const event = new CalendarEvent();
  event.date = "2026-05-06";
  event.time = "20:00";
  event.country = "🇺🇸";
  event.name = "FOMC Statement";
  Object.assign(event, overrides);
  return event;
}

describe("calendar-economic-summary", () => {
  test("summarizes FOMC statement text from the dated Federal Reserve source", async () => {
    const logger = {
      log: vi.fn(),
    };
    const getWithRetryFn = vi.fn().mockResolvedValue({
      data: "<html><body><main><h1>FOMC Statement</h1><p>Inflation remains elevated and the Committee is attentive to labor market risks.</p></main></body></html>",
    });
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(JSON.stringify({
      summaryMarkdown: "The Fed emphasized elevated inflation and labor-market risks. Policy remains data dependent.",
    }));

    const summary = await getCalendarOfficialSummary([createCalendarEvent()], {
      callAiProviderJsonFn,
      getWithRetryFn,
      logger,
    });

    expect(getWithRetryFn).toHaveBeenCalledWith(
      "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260506a.htm",
      expect.objectContaining({
        responseType: "text",
      }),
      expect.objectContaining({
        maxAttempts: 2,
      }),
    );
    expect(callAiProviderJsonFn.mock.calls[0]?.[0]).toContain("Inflation remains elevated");
    expect(summary).toEqual({
      name: "Federal Reserve",
      summaryMarkdown: "The Fed emphasized elevated inflation and labor-market risks. Policy remains data dependent.",
      url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260506a.htm",
    });
  });

  test("strips script-like blocks and decodes official source entities once", async () => {
    const logger = {
      log: vi.fn(),
    };
    const getWithRetryFn = vi.fn().mockResolvedValue({
      data: [
        "<script>remove me</script\t\n bar>",
        "<style>remove styles</style malformed>",
        "<noscript>remove fallback</noscript >",
        "<p>A&nbsp;&amp;&quot;&apos;&rsquo;&lsquo;&rdquo;&ldquo;&ndash;&mdash;&#65;&#x42;&#9999999999;</p>",
      ].join(""),
    });
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(JSON.stringify({
      summaryMarkdown: "Decoded source summary.",
    }));

    await getCalendarOfficialSummary([createCalendarEvent()], {
      callAiProviderJsonFn,
      getWithRetryFn,
      logger,
    });

    const prompt = callAiProviderJsonFn.mock.calls[0]?.[0] ?? "";
    expect(prompt).not.toContain("remove me");
    expect(prompt).not.toContain("remove styles");
    expect(prompt).not.toContain("remove fallback");
    expect(prompt).toContain("A &\"'''\"\"--AB&#9999999999;");
  });

  test("uses authoritative release pages for macro events with no metric fields", async () => {
    const logger = {
      log: vi.fn(),
    };
    const getWithRetryFn = vi.fn().mockResolvedValue({
      data: "Total nonfarm payroll employment increased.",
    });
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(JSON.stringify({
      summaryMarkdown: "Payroll growth was the main topic.",
    }));

    const summary = await getCalendarOfficialSummary([createCalendarEvent({
      name: "Nonfarm Payrolls",
      time: "14:30",
    })], {
      callAiProviderJsonFn,
      getWithRetryFn,
      logger,
    });

    expect(getWithRetryFn.mock.calls[0]?.[0]).toBe("https://www.bls.gov/news.release/empsit.nr0.htm");
    expect(summary?.name).toBe("U.S. Bureau of Labor Statistics");
    expect(summary?.summaryMarkdown).toBe("Payroll growth was the main topic.");
  });

  test("maps configured alert events to official release sources", async () => {
    const logger = {
      log: vi.fn(),
    };
    const getWithRetryFn = vi.fn().mockResolvedValue({
      data: "Official source text.",
    });
    const callAiProviderJsonFn = vi.fn().mockResolvedValue(JSON.stringify({
      summaryMarkdown: "Official release summary.",
    }));

    await getCalendarOfficialSummary([createCalendarEvent({name: "Consumer Price Index (CPI)"})], {
      callAiProviderJsonFn,
      getWithRetryFn,
      logger,
    });
    await getCalendarOfficialSummary([createCalendarEvent({name: "Producer Price Index (PPI)"})], {
      callAiProviderJsonFn,
      getWithRetryFn,
      logger,
    });
    await getCalendarOfficialSummary([createCalendarEvent({name: "GDP q/q"})], {
      callAiProviderJsonFn,
      getWithRetryFn,
      logger,
    });

    expect(getWithRetryFn.mock.calls.map(call => call[0])).toEqual([
      "https://www.bls.gov/news.release/cpi.nr0.htm",
      "https://www.bls.gov/news.release/ppi.nr0.htm",
      "https://www.bea.gov/data/gdp/gross-domestic-product",
    ]);
  });

  test("returns undefined when official source loading fails", async () => {
    const logger = {
      log: vi.fn(),
    };
    const getWithRetryFn = vi.fn().mockRejectedValue(new Error("network"));
    const callAiProviderJsonFn = vi.fn();

    const summary = await getCalendarOfficialSummary([createCalendarEvent({
      name: "Consumer Price Index (CPI)",
    })], {
      callAiProviderJsonFn,
      getWithRetryFn,
      logger,
    });

    expect(summary).toBeUndefined();
    expect(callAiProviderJsonFn).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledWith("warn", expect.stringContaining("Loading official calendar source failed"));
  });

  test("returns undefined for invalid AI summary responses", async () => {
    const logger = {
      log: vi.fn(),
    };
    const getWithRetryFn = vi.fn().mockResolvedValue({
      data: "Official source text.",
    });
    const callAiProviderJsonFn = vi.fn()
      .mockResolvedValueOnce("not-json")
      .mockResolvedValueOnce(JSON.stringify({summaryMarkdown: ""}));

    await expect(getCalendarOfficialSummary([createCalendarEvent()], {
      callAiProviderJsonFn,
      getWithRetryFn,
      logger,
    })).resolves.toBeUndefined();
    await expect(getCalendarOfficialSummary([createCalendarEvent()], {
      callAiProviderJsonFn,
      getWithRetryFn,
      logger,
    })).resolves.toBeUndefined();

    expect(logger.log).toHaveBeenCalledWith("warn", "AI calendar official source summary returned invalid JSON.");
  });

  test("returns undefined when there is no official source match", async () => {
    const logger = {
      log: vi.fn(),
    };
    const getWithRetryFn = vi.fn();
    const callAiProviderJsonFn = vi.fn();

    const summary = await getCalendarOfficialSummary([createCalendarEvent({
      name: "Existing Home Sales",
    })], {
      callAiProviderJsonFn,
      getWithRetryFn,
      logger,
    });

    expect(summary).toBeUndefined();
    expect(getWithRetryFn).not.toHaveBeenCalled();
    expect(callAiProviderJsonFn).not.toHaveBeenCalled();
  });
});
