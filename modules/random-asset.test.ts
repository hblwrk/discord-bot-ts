import {ImageAsset, TextAsset, UserQuoteAsset} from "./assets.js";
import {getRandomAsset, getRandomAssetByTriggerGroup} from "./random-asset.js";
import * as secureRandom from "./secure-random.js";

describe("getRandomAsset", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("returns undefined for an empty pool", () => {
    expect(getRandomAsset([])).toBeUndefined();
  });

  test("returns a random item from the pool", () => {
    jest.spyOn(secureRandom, "getSecureRandomIndex").mockReturnValue(1);

    expect(getRandomAsset(["first", "second"])).toBe("second");
  });
});

describe("getRandomAssetByTriggerGroup", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("returns undefined when no grouped trigger exists", () => {
    const imageAsset = new ImageAsset();
    imageAsset.fileName = "betrug-01.jpg";
    (imageAsset as any).trigger = ["betrug"];

    expect(getRandomAssetByTriggerGroup("betrug", [imageAsset])).toBeUndefined();
  });

  test("selects a random asset from numbered trigger groups", () => {
    jest.spyOn(secureRandom, "getSecureRandomIndex").mockReturnValue(1);
    const firstImage = new ImageAsset();
    firstImage.fileName = "betrug-01.jpg";
    (firstImage as any).trigger = ["betrug 1"];
    const secondText = new TextAsset();
    secondText.response = "second";
    (secondText as any).trigger = ["betrug 2"];
    const unrelatedQuote = new UserQuoteAsset();
    unrelatedQuote.fileName = "quote.png";
    (unrelatedQuote as any).trigger = ["quote sara 1"];

    expect(getRandomAssetByTriggerGroup("betrug", [firstImage, secondText, unrelatedQuote])).toBe(secondText);
  });
});
