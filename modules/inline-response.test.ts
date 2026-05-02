import {EmojiAsset, TextAsset} from "./assets.ts";
import {addInlineResponses} from "./inline-response.ts";
import {createEventClient, createMessage} from "./test-utils/discord-mocks.ts";
import {beforeEach, describe, expect, test, vi} from "vitest";

const loggerMock = vi.hoisted(() => ({
  log: vi.fn(),
}));

vi.mock("./logging.ts", () => ({
  getLogger: () => loggerMock,
}));

describe("addInlineResponses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createEmojiAsset(trigger: string, response: unknown[], triggerRegex = "") {
    const asset = new EmojiAsset();
    asset.trigger = [trigger];
    asset.response = response;
    asset.triggerRegex = triggerRegex;
    return asset;
  }

  test("ignores bot-authored messages", async () => {
    const {client, getHandler} = createEventClient();
    const asset = createEmojiAsset("party", ["\ud83d\ude00"]);

    addInlineResponses(client, [asset], ["party"]);

    const handler = getHandler("messageCreate");
    const message = createMessage("party now");
    message.author = {bot: true};

    await handler(message);

    expect(message.react).not.toHaveBeenCalled();
  });

  test("ignores webhook messages", async () => {
    const {client, getHandler} = createEventClient();
    const asset = createEmojiAsset("party", ["\ud83d\ude00"]);

    addInlineResponses(client, [asset], ["party"]);

    const handler = getHandler("messageCreate");
    const message = createMessage("party now");
    message.webhookId = "webhook-1";

    await handler(message);

    expect(message.react).not.toHaveBeenCalled();
  });

  test("reacts with unicode emoji on trigger match", async () => {
    const {client, getHandler} = createEventClient();
    const asset = createEmojiAsset("party", ["\ud83d\ude00"]);

    addInlineResponses(client, [asset], ["party"]);

    const handler = getHandler("messageCreate");
    const message = createMessage("party now");

    await handler(message);

    expect(message.react).toHaveBeenCalledWith("\ud83d\ude00");
  });

  test("reacts when trigger is followed by punctuation", async () => {
    const {client, getHandler} = createEventClient();
    const asset = createEmojiAsset("flash", ["\u26a1"]);

    addInlineResponses(client, [asset], ["flash"]);

    const handler = getHandler("messageCreate");
    const message = createMessage("flash!");

    await handler(message);

    expect(message.react).toHaveBeenCalledWith("\u26a1");
  });

  test("reacts with resolved custom emoji when response uses custom: prefix", async () => {
    const {client, getHandler} = createEventClient();
    const asset = createEmojiAsset("party", ["custom:wave"]);

    addInlineResponses(client, [asset], ["party"]);

    const handler = getHandler("messageCreate");
    const message = createMessage("party now");
    const customEmoji = {id: "1", name: "wave"};
    message.guild.emojis.cache.find.mockImplementation(predicate => {
      const emojis = [customEmoji, {id: "2", name: "other"}];
      return emojis.find(predicate);
    });

    await handler(message);

    expect(message.guild.emojis.cache.find).toHaveBeenCalledTimes(1);
    expect(message.react).toHaveBeenCalledWith(customEmoji);
  });

  test("uses triggerRegex for wo trigger special case", async () => {
    const {client, getHandler} = createEventClient();
    const asset = createEmojiAsset("wo", ["\ud83d\ude4c"], "\\bwo\\b\\?");

    addInlineResponses(client, [asset], ["wo"]);

    const handler = getHandler("messageCreate");
    const message = createMessage("wo?");

    await handler(message);

    expect(message.react).toHaveBeenCalledWith("\ud83d\ude4c");
  });

  test("uses first array triggerRegex for wo trigger special case", async () => {
    const {client, getHandler} = createEventClient();
    const asset = createEmojiAsset("wo", ["\ud83d\ude4c"], ["\\bwo\\b!"] as unknown as string);

    addInlineResponses(client, [asset], ["wo"]);

    const handler = getHandler("messageCreate");
    const message = createMessage("wo!");

    await handler(message);

    expect(message.react).toHaveBeenCalledWith("\ud83d\ude4c");
  });

  test("falls back to normal wo trigger matching when special regex is empty", async () => {
    const {client, getHandler} = createEventClient();
    const asset = createEmojiAsset("wo", ["\ud83d\ude4c"], [] as unknown as string);

    addInlineResponses(client, [asset], ["wo"]);

    const handler = getHandler("messageCreate");
    const message = createMessage("wo now");

    await handler(message);

    expect(message.react).toHaveBeenCalledWith("\ud83d\ude4c");
  });


  test("does not react when command token, asset type, response, or trigger boundary do not match", async () => {
    const {client, getHandler} = createEventClient();
    const emojiAsset = createEmojiAsset("party", [123]);
    const textAsset = new TextAsset();
    textAsset.trigger = ["party"];

    addInlineResponses(client, [
      emojiAsset,
      textAsset,
      createEmojiAsset("cash", ["💵"]),
    ], ["party", "cash"]);

    const handler = getHandler("messageCreate");
    const noCommandMessage = createMessage("nothing here");
    await handler(noCommandMessage);
    expect(noCommandMessage.react).not.toHaveBeenCalled();

    const invalidResponseMessage = createMessage("party now");
    await handler(invalidResponseMessage);
    expect(invalidResponseMessage.react).not.toHaveBeenCalled();

    const boundaryMessage = createMessage("cashflow");
    await handler(boundaryMessage);
    expect(boundaryMessage.react).not.toHaveBeenCalled();
  });

  test("handles reaction failures without crashing", async () => {
    const {client, getHandler} = createEventClient();
    const asset = createEmojiAsset("party", ["\ud83d\ude00"]);

    addInlineResponses(client, [asset], ["party"]);

    const handler = getHandler("messageCreate");
    const message = createMessage("party now");
    message.react.mockRejectedValue(new Error("react failed"));

    handler(message);
    await Promise.resolve();

    expect(loggerMock.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Error posting emoji reaction"),
    );
  });

  test("handles custom emoji reaction failures without crashing", async () => {
    const {client, getHandler} = createEventClient();
    const asset = createEmojiAsset("party", ["custom:wave"]);

    addInlineResponses(client, [asset], ["party"]);

    const handler = getHandler("messageCreate");
    const message = createMessage("party now");
    message.guild.emojis.cache.find.mockImplementation(predicate => {
      const emojis = [{id: "1", name: "wave"}];
      return emojis.find(predicate);
    });
    message.react.mockRejectedValue(new Error("custom react failed"));

    handler(message);
    await Promise.resolve();

    expect(loggerMock.log).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Error posting emoji reaction"),
    );
  });
});
