/* eslint-disable yoda */
/* eslint-disable import/extensions */
import {getLogger} from "./logging.js";
import {getWithRetry} from "./http-retry.js";

const logger = getLogger();

export async function getTickers(index: string): Promise<Ticker[]> {
  const tickers = [];

  if ("sp500" === index.toLocaleLowerCase() || "all" === index.toLocaleLowerCase()) {
    try {
      const sp500Response = await getWithRetry("https://pkgstore.datahub.io/core/s-and-p-500-companies/constituents_json/data/297344d8dc0a9d86b8d107449c851cc8/constituents_json.json");

      if (1 < sp500Response.data.length) {
        for (const element of sp500Response.data) {
          const ticker = new Ticker();
          ticker.symbol = element.Symbol;
          ticker.name = element.Name;
          ticker.exchange = "sp500";
          tickers.push(ticker);
        }
      }
    } catch (error) {
      logger.log(
        "error",
        `Loading tickers failed: ${error}`,
      );
    }
  }

  if ("nasdaq100" === index.toLocaleLowerCase() || "all" === index.toLocaleLowerCase()) {
    try {
      const nasdaq100Response = await getWithRetry("https://yfiua.github.io/index-constituents/constituents-nasdaq100.json");

      if (1 < nasdaq100Response.data.length) {
        for (const element of nasdaq100Response.data) {
          const ticker = new Ticker();
          ticker.symbol = element.Symbol;
          ticker.name = element.Name;
          ticker.exchange = "nasdaq100";
          tickers.push(ticker);
        }
      }
    } catch (error) {
      logger.log(
        "error",
        `Loading tickers failed: ${error}`,
      );
    }
  }

  // May add this as "asset" if more additional tickers are required
  const ticker = new Ticker();
  ticker.symbol = "VIRT";
  ticker.name = "Virtu Financial, Inc.";
  ticker.exchange = "russell1000";
  tickers.push(ticker);

  return tickers;
}

export class Ticker {
  public symbol = "";
  public name = "";
  public exchange = "";
}
