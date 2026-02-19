import {TextAsset, UserQuoteAsset} from "./assets.js";
import {getRandomQuote} from "./random-quote.js";

describe("getRandomQuote", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createQuote(user: string, fileName: string) {
    const quote = new UserQuoteAsset();
    quote.user = user;
    quote.fileName = fileName;
    quote.fileContent = Buffer.from(fileName);
    return quote;
  }

  test("returns undefined when no matching quote exists", () => {
    const otherAsset = new TextAsset();
    otherAsset.response = "hello";

    const quote = getRandomQuote("alice", [otherAsset]);

    expect(quote).toBeUndefined();
  });

  test("filters quotes by username", () => {
    const aliceQuote = createQuote("alice", "alice-1.png");
    const bobQuote = createQuote("bob", "bob-1.png");

    const quote = getRandomQuote("alice", [aliceQuote, bobQuote]);

    expect(quote).toBe(aliceQuote);
  });

  test("includes all quotes when username is any", () => {
    const aliceQuote = createQuote("alice", "alice-1.png");
    const bobQuote = createQuote("bob", "bob-1.png");
    jest.spyOn(Math, "random").mockReturnValue(0.99);

    const quote = getRandomQuote("any", [aliceQuote, bobQuote]);

    expect(quote).toBe(bobQuote);
  });
});
