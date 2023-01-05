/* eslint-disable yoda */
/* eslint-disable import/extensions */
import axios, {type AxiosResponse} from "axios";
import {readSecret} from "./secrets";
import {getLogger} from "./logging";

const logger = getLogger();

export async function getTickers(index: string): Promise<Ticker[]> {
  const tickers = [];

  if ("sp500" === index.toLocaleLowerCase() || "all" === index.toLocaleLowerCase()) {
    try {
      const sp500Response: AxiosResponse = await axios.get("https://pkgstore.datahub.io/core/s-and-p-500-companies/constituents_json/data/297344d8dc0a9d86b8d107449c851cc8/constituents_json.json");

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
      const nasdaq100Response: AxiosResponse = await axios.get(`https://financialmodelingprep.com/api/v3/nasdaq_constituent?apikey=${readSecret("service_financialmodelingprep_apiKey")}`);

      if (1 < nasdaq100Response.data.length) {
        for (const element of nasdaq100Response.data) {
          const ticker = new Ticker();
          ticker.symbol = element.symbol;
          ticker.name = element.name;
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
  ticker.exchange = "russel1000";
  tickers.push(ticker);

  return tickers;
}

export class Ticker {
  private _symbol: string;
  private _name: string;
  private _exchange: string;

  public get symbol() {
    return this._symbol;
  }

  public set symbol(symbol: string) {
    this._symbol = symbol;
  }

  public get name() {
    return this._name;
  }

  public set name(name: string) {
    this._name = name;
  }

  public get exchange() {
    return this._exchange;
  }

  public set exchange(exchange: string) {
    this._exchange = exchange;
  }
}
