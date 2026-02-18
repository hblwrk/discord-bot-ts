import {TextAsset} from "./assets.js";
import {interactSlashCommands} from "./slash-commands.js";
import {createChatInputInteraction, createEventClient} from "./test-utils/discord-mocks.js";

jest.mock("./secrets.js", () => ({
  readSecret: jest.fn(() => ""),
}));

describe("interactSlashCommands", () => {
  test("ignores non chat-input interactions", async () => {
    const {client, getHandler} = createEventClient();

    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = {
      isChatInputCommand: jest.fn(() => false),
      reply: jest.fn(),
    };

    await handler(interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
  });

  test("replies to 8ball with embed payload", async () => {
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0);
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("8ball");
    interaction.options.getString.mockImplementation(name => name === "frage" ? "Ist das gut?" : null);

    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledTimes(1);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      embeds: expect.any(Array),
    }));

    randomSpy.mockRestore();
  });

  test("replies to asset-backed text command", async () => {
    const {client, getHandler} = createEventClient();
    const textAsset = new TextAsset();
    textAsset.title = "hello";
    textAsset.response = "hello-response";
    (textAsset as any).trigger = ["hello"];

    interactSlashCommands(client, [textAsset], ["hello"], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("hello");

    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith("hello-response");
  });

  test("replies to whatis with embed and attachment payload", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [
      {
        name: "whatis_faq",
        title: "FAQ",
        text: "Answer",
        _fileName: "faq.png",
        fileName: "faq.png",
        fileContent: Buffer.from("test"),
      },
    ], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("whatis");
    interaction.options.getString.mockImplementation(name => name === "search" ? "whatis_faq" : null);

    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      embeds: expect.any(Array),
      files: expect.any(Array),
    }));
  });
});
