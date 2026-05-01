import {ImageAsset, TextAsset, UserQuoteAsset} from "./assets.ts";
import {getRandomAsset, getRandomAssetByTriggerGroup} from "./random-asset.ts";
import {describe, expect, test} from "vitest";

describe("getRandomAsset", () => {
  test("returns undefined for an empty pool", () => {
    expect(getRandomAsset([])).toBeUndefined();
  });

  test("returns a random item from the pool", () => {
    expect(getRandomAsset(["first", "second"], () => 1)).toBe("second");
  });
});

describe("getRandomAssetByTriggerGroup", () => {
  test("returns undefined when no grouped trigger exists", () => {
    const imageAsset = new ImageAsset();
    imageAsset.fileName = "betrug-01.jpg";
    (imageAsset as any).trigger = ["betrug"];

    expect(getRandomAssetByTriggerGroup("betrug", [imageAsset])).toBeUndefined();
  });

  test("selects a random asset from numbered trigger groups", () => {
    const firstImage = new ImageAsset();
    firstImage.fileName = "betrug-01.jpg";
    (firstImage as any).trigger = ["betrug 1"];
    const secondText = new TextAsset();
    secondText.response = "second";
    (secondText as any).trigger = ["betrug 2"];
    const unrelatedQuote = new UserQuoteAsset();
    unrelatedQuote.fileName = "quote.png";
    (unrelatedQuote as any).trigger = ["quote sara 1"];

    expect(getRandomAssetByTriggerGroup("betrug", [firstImage, secondText, unrelatedQuote], () => 1)).toBe(secondText);
  });
});
