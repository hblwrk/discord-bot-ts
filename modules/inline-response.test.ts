import {EmojiAsset} from "./assets.js";
import {addInlineResponses} from "./inline-response.js";
import {createEventClient, createMessage} from "./test-utils/discord-mocks.js";

describe("addInlineResponses", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function createEmojiAsset(trigger: string, response: unknown[], triggerRegex = "") {
    const asset = new EmojiAsset();
    (asset as any).trigger = [trigger];
    (asset as any).response = response;
    (asset as any).triggerRegex = triggerRegex;
    return asset;
  }

  test("ignores bot-authored messages", async () => {
    const {client, getHandler} = createEventClient();
    const asset = createEmojiAsset("party", ["\ud83d\ude00"]);

    addInlineResponses(client, [asset], ["party"]);

    const handler = getHandler("messageCreate");
    const message = createMessage("party now");
    (message as any).author = {bot: true};

    await handler(message);

    expect(message.react).not.toHaveBeenCalled();
  });

  test("ignores webhook messages", async () => {
    const {client, getHandler} = createEventClient();
    const asset = createEmojiAsset("party", ["\ud83d\ude00"]);

    addInlineResponses(client, [asset], ["party"]);

    const handler = getHandler("messageCreate");
    const message = createMessage("party now");
    (message as any).webhookId = "webhook-1";

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

  test("handles reaction failures without crashing", async () => {
    const {client, getHandler} = createEventClient();
    const asset = createEmojiAsset("party", ["\ud83d\ude00"]);

    addInlineResponses(client, [asset], ["party"]);

    const handler = getHandler("messageCreate");
    const message = createMessage("party now");
    message.react.mockRejectedValue(new Error("react failed"));

    await expect(handler(message)).resolves.toBeUndefined();
    await Promise.resolve();
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

    await expect(handler(message)).resolves.toBeUndefined();
    await Promise.resolve();
  });
});
