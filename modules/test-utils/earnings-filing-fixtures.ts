import {readFileSync, readdirSync} from "node:fs";
import {gunzipSync} from "node:zlib";

const fixtureDirectory = "modules/test-fixtures/earnings-filings";
const fixtureSuffix = ".txt.gz";

export const listEarningsFilingFixtures = (): string[] => readdirSync(fixtureDirectory)
  .filter(name => name.endsWith(fixtureSuffix))
  .map(name => name.slice(0, -fixtureSuffix.length))
  .sort();

export const readEarningsFilingFixture = (ticker: string): string => gunzipSync(
  readFileSync(`${fixtureDirectory}/${ticker}${fixtureSuffix}`),
).toString("utf8");
