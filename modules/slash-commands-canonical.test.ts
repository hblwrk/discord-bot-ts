import {describe, expect, test} from "vitest";
import {
  computeSlashRegistrationDiff,
  getSlashCommandNamesFromPayload,
  getSlashCommandPayloadHash,
  hasSlashRegistrationMismatch,
} from "./slash-commands-canonical.ts";

describe("slash-commands-canonical", () => {
  test("normalizes command names, options, choices and unsupported payload shapes", () => {
    const payload = [
      {
        name: "beta",
        description: "Beta",
        options: [{
          type: "3",
          name: "symbol",
          description: "Symbol",
          required: true,
          autocomplete: true,
          min_value: 1,
          max_value: 10,
          min_length: 2,
          max_length: 5,
          channel_types: ["0", 11],
          choices: [
            {name: "A", value: "a"},
            "bad-choice",
          ],
          options: [
            {type: 4, name: "nested", description: "Nested"},
            "bad-option",
          ],
        }],
      },
      {
        name: "alpha",
        description: "Alpha",
      },
      "bad-command",
    ];

    expect(getSlashCommandNamesFromPayload(payload)).toEqual(["alpha", "beta"]);
    expect(getSlashCommandNamesFromPayload("not-array")).toEqual([]);
    expect(getSlashCommandPayloadHash(payload)).toContain("\"min_value\":1");
    expect(getSlashCommandPayloadHash(payload)).toContain("\"channel_types\":[0,11]");
    expect(getSlashCommandPayloadHash(payload)).toContain("\"name\":\"\"");
  });

  test("computes missing, unexpected, changed and truncated registration diff", () => {
    const expected = [
      {name: "alpha", description: "Alpha"},
      {name: "beta", description: "Beta"},
    ];
    const returned = [
      {name: "beta", description: "Changed"},
      {name: "gamma", description: "Gamma"},
    ];

    const diff = computeSlashRegistrationDiff(expected, returned);

    expect(diff).toEqual({
      expectedCommandNames: ["alpha", "beta"],
      returnedCommandNames: ["beta", "gamma"],
      missingCommandNames: ["alpha"],
      unexpectedCommandNames: ["gamma"],
      changedCommandNames: ["beta"],
      truncated: false,
    });
    expect(hasSlashRegistrationMismatch(diff)).toBe(true);

    expect(computeSlashRegistrationDiff(expected, [])).toMatchObject({
      missingCommandNames: ["alpha", "beta"],
      truncated: true,
    });
    expect(hasSlashRegistrationMismatch(computeSlashRegistrationDiff(expected, expected))).toBe(false);
  });
});
