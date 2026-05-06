import moment from "moment-timezone";
import {describe, expect, test, vi} from "vitest";
import {
  clearEarningsWhispersWeeklyTickerCache,
  extractEarningsWhispersWeeklyStatusUrls,
  extractEarningsWhispersWeeklyTickers,
  loadEarningsWhispersWeeklyTickers,
} from "./earnings-whispers.ts";

function xReaderUrl(url: string): string {
  return `https://r.jina.ai/http://${url}`;
}

describe("Earnings Whispers weekly tickers", () => {
  test.each([
    {
      now: "2026-01-14 08:05",
      sourceText: "#earnings for the week of January 12, 2026 earningswhispers.com/calendar $TSM $JPM $DAL $WFC $MS $GS $C $BLK $BAC $JBHT $HOMB $RF $STT $PNC $SIFY $BK $BOKF $FHN $INFY $CNXC $FUL $MTB $WIT $BBCP $IIIN $CODI $RFIL $PXED $BSVN $UCB",
      tickers: ["TSM", "JPM", "DAL", "WFC", "MS", "GS", "C", "BLK", "BAC", "JBHT", "HOMB", "RF", "STT", "PNC", "SIFY", "BK", "BOKF", "FHN", "INFY", "CNXC", "FUL", "MTB", "WIT", "BBCP", "IIIN", "CODI", "RFIL", "PXED", "BSVN", "UCB"],
    },
    {
      now: "2026-02-25 08:05",
      sourceText: "#earnings for the week of February 23, 2026 earningswhispers.com/calendar $NVDA $CRWV $HIMS $TTD $RKLB $CRM $AMC $SNOW $DELL $INOD $MARA $OPK $SOUN $MELI $ZS $CIFR $QBTS $AXON $CAVA $DUOL $IONQ $HUT $CODI $BWXT $TJX $CELH $NVTS $ZETA $VST $WGS $WULF $KTOS $WDAY $HD $INTU $KEYS $SNPS",
      tickers: ["NVDA", "CRWV", "HIMS", "TTD", "RKLB", "CRM", "AMC", "SNOW", "DELL", "INOD", "MARA", "OPK", "SOUN", "MELI", "ZS", "CIFR", "QBTS", "AXON", "CAVA", "DUOL", "IONQ", "HUT", "CODI", "BWXT", "TJX", "CELH", "NVTS", "ZETA", "VST", "WGS", "WULF", "KTOS", "WDAY", "HD", "INTU", "KEYS", "SNPS"],
    },
    {
      now: "2026-03-18 08:05",
      sourceText: "#earnings for the week of March 16, 2026 earningswhispers.com/calendar $MU $BABA $RCAT $OKLO $LULU $PL $DLTR $ACN $FDX $GIS $LUNR $DOCU $SMTC $WSM $AGRO $ARCO $M $FLY $VNET $FIVE $CAL $ALVO $ATAT $AVAH $HQY $SAIC $BEKE $CATX $CSIQ $CTMX $DLO $JBL $DRI $XPEV $PLBY $PRSO $FPS $IDN",
      tickers: ["MU", "BABA", "RCAT", "OKLO", "LULU", "PL", "DLTR", "ACN", "FDX", "GIS", "LUNR", "DOCU", "SMTC", "WSM", "AGRO", "ARCO", "M", "FLY", "VNET", "FIVE", "CAL", "ALVO", "ATAT", "AVAH", "HQY", "SAIC", "BEKE", "CATX", "CSIQ", "CTMX", "DLO", "JBL", "DRI", "XPEV", "PLBY", "PRSO", "FPS", "IDN"],
    },
    {
      now: "2026-04-13 08:05",
      sourceText: "#earnings for the week of April 13, 2026 earningswhispers.com/calendar $NFLX $TSM $GS $JPM $ASML $BLK $MS $BAC",
      tickers: ["NFLX", "TSM", "GS", "JPM", "ASML", "BLK", "MS", "BAC"],
    },
    {
      now: "2026-04-27 08:05",
      sourceText: "Image: eWhispers's tweet photo. #earnings for the week of April 27, 2026 https://t.co/My2Eq16qS8 $MSFT $AMZN $AAPL $META $SNDK $SOFI $GOOGL $HOOD",
      tickers: ["MSFT", "AMZN", "AAPL", "META", "SNDK", "SOFI", "GOOGL", "HOOD"],
    },
    {
      now: "2026-05-06 08:05",
      sourceText: "[#earnings](https://x.com/hashtag/earnings?src=hashtag_click) for the week of May 4, 2026 [https://earningswhispers.com/calendar](https://t.co/My2Eq16qS8) [$PLTR](https://x.com/search?q=%24PLTR&src=cashtag_click) [$AMD](https://x.com/search?q=%24AMD&src=cashtag_click) [$SHOP](https://x.com/search?q=%24SHOP&src=cashtag_click)",
      tickers: ["PLTR", "AMD", "SHOP"],
    },
  ])("extracts real weekly X post shapes from the past four months", ({now, sourceText, tickers}) => {
    expect(extractEarningsWhispersWeeklyTickers(
      sourceText,
      moment.tz(now, "YYYY-MM-DD HH:mm", "US/Eastern"),
    )).toEqual(new Set(tickers));
  });

  test("defaults direct ticker extraction to the current US week", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-06T12:00:00-04:00"));

      expect(extractEarningsWhispersWeeklyTickers(
        "#earnings for the week of May 4, 2026 https://earningswhispers.com/calendar $PLTR $AMD",
      )).toEqual(new Set(["PLTR", "AMD"]));
    } finally {
      vi.useRealTimers();
    }
  });

  test("ignores adjacent weekly posts and non-weekly earnings posts", () => {
    const sourceText = `
      Earnings Whispers @eWhispers
      #earnings for the week of April 20, 2026 https://earningswhispers.com/calendar $NFLX $TSLA
      Earnings Whispers @eWhispers
      #earnings for the week of April 27, 2026 https://t.co/example $MSFT $AMZN $BRK-B $GOOGL
      Earnings Whispers @eWhispers
      #earnings before the open on Friday, May 1, 2026 $CVX $XOM
    `;

    expect(extractEarningsWhispersWeeklyTickers(
      sourceText,
      moment.tz("2026-05-01 08:05", "YYYY-MM-DD HH:mm", "US/Eastern"),
    )).toEqual(new Set(["MSFT", "AMZN", "BRK.B", "GOOGL"]));
  });

  test("extracts the matching X status URL from the profile reader source", () => {
    const sourceText = `
      [May 1](https://x.com/eWhispers/status/2050210540614570491)
      [#earnings](https://x.com/hashtag/earnings?src=hashtag_click) for the week of May 4, 2026
      [$PLTR](https://x.com/search?q=%24PLTR&src=cashtag_click)

      [Apr 24](https://x.com/eWhispers/status/2047673188462448771)
      [#earnings](https://x.com/hashtag/earnings?src=hashtag_click) for the week of April 27, 2026
      [$MSFT](https://x.com/search?q=%24MSFT&src=cashtag_click)
    `;

    expect(extractEarningsWhispersWeeklyStatusUrls(
      sourceText,
      moment.tz("2026-05-06 12:00", "YYYY-MM-DD HH:mm", "US/Eastern"),
    )).toEqual(["https://x.com/eWhispers/status/2050210540614570491"]);
  });

  test("loads and caches weekly tickers from the matching X status post", async () => {
    clearEarningsWhispersWeeklyTickerCache();
    const getWithRetryFn = vi.fn()
      .mockResolvedValueOnce({
        data: [
          "[May 1](https://x.com/eWhispers/status/2050210540614570491)",
          "[#earnings](https://x.com/hashtag/earnings?src=hashtag_click) for the week of May 4, 2026",
          "[$PLTR](https://x.com/search?q=%24PLTR&src=cashtag_click)",
          "[$AMD](https://x.com/search?q=%24AMD&src=cashtag_click)",
          "Show more",
        ].join("\n"),
      })
      .mockResolvedValueOnce({
        data: "#earnings for the week of May 4, 2026\n\nhttps://www.earningswhispers.com/calendar\n\n$PLTR $AMD $SHOP $SARO",
      });
    const logger = {
      log: vi.fn(),
    };
    const options = {
      getWithRetryFn,
      logger,
      now: moment.tz("2026-05-06 12:00", "YYYY-MM-DD HH:mm", "US/Eastern"),
    };

    await expect(loadEarningsWhispersWeeklyTickers(options)).resolves.toEqual(new Set(["PLTR", "AMD", "SHOP", "SARO"]));
    await expect(loadEarningsWhispersWeeklyTickers(options)).resolves.toEqual(new Set(["PLTR", "AMD", "SHOP", "SARO"]));

    expect(getWithRetryFn).toHaveBeenCalledWith(
      xReaderUrl("https://x.com/eWhispers"),
      expect.any(Object),
      expect.any(Object),
    );
    expect(getWithRetryFn).toHaveBeenCalledWith(
      xReaderUrl("https://x.com/eWhispers/status/2050210540614570491"),
      expect.any(Object),
      expect.any(Object),
    );
    expect(getWithRetryFn).toHaveBeenCalledTimes(2);
  });
});
