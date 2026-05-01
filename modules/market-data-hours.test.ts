import moment from "moment-timezone";
import {describe, expect, test} from "vitest";
import {
  buildClosedMarketPresenceData,
  getClosedMarketNickname,
  getMarketPresenceData,
  isMarketOpen,
} from "./market-data-hours.ts";
import {type MarketDataAsset, type MarketHoursProfile} from "./market-data-types.ts";

function marketAsset(marketHours?: MarketHoursProfile): MarketDataAsset {
  const asset: MarketDataAsset = {
    botToken: "token",
    botClientId: "client-id",
    botName: "market bot",
    id: 1,
    suffix: "",
    unit: "",
    decimals: 2,
    lastUpdate: 0,
    order: 7,
  };
  if (undefined !== marketHours) {
    asset.marketHours = marketHours;
  }

  return asset;
}

function timestamp(localTime: string, timezone: string): number {
  return moment.tz(localTime, timezone).valueOf();
}

describe("market-data-hours", () => {
  test("marks crypto open for every session boundary", () => {
    const asset = marketAsset("crypto");

    expect(isMarketOpen(asset, timestamp("2026-05-02T12:00:00", "UTC"))).toBe(true);
    expect(isMarketOpen(asset, timestamp("2026-01-01T12:00:00", "UTC"))).toBe(true);
  });

  test.each([
    ["before cash open", "2026-05-01T09:29:00", false],
    ["during cash session", "2026-05-01T09:30:00", true],
    ["late cash grace window", "2026-05-01T16:14:00", true],
    ["after cash close", "2026-05-01T16:15:00", false],
    ["weekend", "2026-05-02T10:00:00", false],
    ["NYSE holiday", "2026-01-01T10:00:00", false],
  ])("maps US cash hours: %s", (_label, localTime, expectedOpen) => {
    expect(isMarketOpen(marketAsset("us_cash"), timestamp(localTime, "US/Eastern"))).toBe(expectedOpen);
  });

  test.each([
    ["regular session before daily break", "2026-05-01T16:59:00", true],
    ["Friday maintenance break", "2026-05-01T17:00:00", false],
    ["Saturday closed", "2026-05-02T12:00:00", false],
    ["Sunday before futures reopen", "2026-05-03T17:59:00", false],
    ["Sunday futures reopen", "2026-05-03T18:00:00", true],
    ["weekday after daily reopen", "2026-05-04T18:00:00", true],
  ])("maps US futures hours: %s", (_label, localTime, expectedOpen) => {
    expect(isMarketOpen(marketAsset("us_futures"), timestamp(localTime, "US/Eastern"))).toBe(expectedOpen);
  });

  test.each([
    ["Friday before close", "2026-05-01T16:59:00", true],
    ["Friday after close", "2026-05-01T17:00:00", false],
    ["Saturday closed", "2026-05-02T12:00:00", false],
    ["Sunday before open", "2026-05-03T16:59:00", false],
    ["Sunday open", "2026-05-03T17:00:00", true],
    ["weekday open", "2026-05-04T03:00:00", true],
  ])("maps forex hours: %s", (_label, localTime, expectedOpen) => {
    expect(isMarketOpen(marketAsset("forex"), timestamp(localTime, "US/Eastern"))).toBe(expectedOpen);
  });

  test.each([
    ["before EU cash open", "2026-05-01T08:59:00", false],
    ["EU cash open", "2026-05-01T09:00:00", true],
    ["EU cash before close", "2026-05-01T17:29:00", true],
    ["EU cash closed", "2026-05-01T17:30:00", false],
    ["EU weekend", "2026-05-02T12:00:00", false],
  ])("maps EU cash hours: %s", (_label, localTime, expectedOpen) => {
    expect(isMarketOpen(marketAsset("eu_cash"), timestamp(localTime, "Europe/Berlin"))).toBe(expectedOpen);
  });

  test("builds closed-market nickname and presence without losing asset ordering", () => {
    const asset = marketAsset("us_cash");

    expect(buildClosedMarketPresenceData()).toEqual({
      presence: "Market closed.",
      presenceStatus: "idle",
    });
    expect(getClosedMarketNickname(asset, "7🟩 123.45$")).toBe("7⬛ 123.45$");
    expect(getClosedMarketNickname(asset, "open")).toBe("7⬛");
    expect(getClosedMarketNickname(asset, "   ")).toBeNull();
    expect(getClosedMarketNickname(asset)).toBeNull();
  });

  test("returns closed presence outside market hours and live status while open", () => {
    const asset = marketAsset("us_cash");
    const closedTime = timestamp("2026-05-01T08:00:00", "US/Eastern");
    const openTime = timestamp("2026-05-01T10:00:00", "US/Eastern");

    expect(getMarketPresenceData(asset, "7🟩 123.45$", "+1.23%", 1.23, closedTime)).toEqual({
      nickname: "7⬛ 123.45$",
      presence: "Market closed.",
      presenceStatus: "idle",
    });
    expect(getMarketPresenceData(asset, "7🟥 121.00$", "-0.50%", -0.5, openTime)).toEqual({
      nickname: "7🟥 121.00$",
      presence: "-0.50%",
      presenceStatus: "dnd",
    });
    expect(getMarketPresenceData(asset, "7🟩 123.45$", "+1.23%", 1.23, openTime)).toEqual({
      nickname: "7🟩 123.45$",
      presence: "+1.23%",
      presenceStatus: "online",
    });
  });
});
