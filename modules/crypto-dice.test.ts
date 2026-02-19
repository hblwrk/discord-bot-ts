import {cryptodice} from "./crypto-dice.js";

describe("cryptodice", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("returns an integer between 1 and 100", () => {
    const value = cryptodice();

    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(1);
    expect(value).toBeLessThanOrEqual(100);
  });

  test("returns 1 when Math.random is 0", () => {
    jest.spyOn(Math, "random").mockReturnValue(0);

    expect(cryptodice()).toBe(1);
  });

  test("returns 100 when Math.random is near 1", () => {
    jest.spyOn(Math, "random").mockReturnValue(0.999999);

    expect(cryptodice()).toBe(100);
  });
});
