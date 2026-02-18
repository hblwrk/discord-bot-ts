import {ImageAsset, TextAsset, UserAsset} from "./assets.js";
import {addTriggerResponses} from "./trigger-response.js";
import {createEventClient, createMessage} from "./test-utils/discord-mocks.js";

describe("addTriggerResponses", () => {
  test("sends plain text for text assets", async () => {
    const {client, getHandler} = createEventClient();
    const textAsset = new TextAsset();
    textAsset.title = "hello";
    textAsset.response = "hello response";
    (textAsset as any).trigger = ["hello"];

    addTriggerResponses(client, [textAsset], ["!hello"], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!hello");

    await handler(message);

    expect(message.channel.send).toHaveBeenCalledWith("hello response");
  });

  test("sends attachment and embed for image assets with text", async () => {
    const {client, getHandler} = createEventClient();
    const imageAsset = new ImageAsset();
    imageAsset.title = "image";
    imageAsset.fileName = "image.png";
    imageAsset.fileContent = Buffer.from("file");
    imageAsset.text = "image text";
    (imageAsset as any).trigger = ["image"];

    addTriggerResponses(client, [imageAsset], ["!image"], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!image");

    await handler(message);

    expect(message.channel.send).toHaveBeenCalledWith(expect.objectContaining({
      embeds: expect.any(Array),
      files: expect.any(Array),
    }));
  });

  test("replies with temporary unavailable message when image asset content is missing", async () => {
    const {client, getHandler} = createEventClient();
    const imageAsset = new ImageAsset();
    imageAsset.title = "image";
    imageAsset.fileName = "image.png";
    imageAsset.text = "image text";
    (imageAsset as any).trigger = ["image"];

    addTriggerResponses(client, [imageAsset], ["!image"], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!image");
    await handler(message);

    expect(message.channel.send).toHaveBeenCalledWith("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.");
  });

  test("replies to cryptodice trigger messages", async () => {
    const {client, getHandler} = createEventClient();

    addTriggerResponses(client, [], [], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!cryptodice");

    await handler(message);

    expect(message.channel.send).toHaveBeenCalledTimes(1);
    const reply = message.channel.send.mock.calls[0][0];
    expect(reply.startsWith("Rolling the crypto dice... ")).toBe(true);
  });

  test("sends a fallback response when no quote asset exists for a user trigger", async () => {
    const {client, getHandler} = createEventClient();
    const userAsset = new UserAsset();
    userAsset.name = "missing-user";
    (userAsset as any).trigger = ["missing-user"];

    addTriggerResponses(client, [userAsset], ["!missing-user"], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!missing-user");
    await handler(message);

    expect(message.channel.send).toHaveBeenCalledWith("Keine passenden Zitate gefunden.");
  });

  test("replies with temporary unavailable message when whatis attachment is missing", async () => {
    const {client, getHandler} = createEventClient();

    addTriggerResponses(client, [], [], [
      {
        name: "whatis_faq",
        title: "FAQ",
        text: "Answer",
        _fileName: "faq.png",
        fileName: "faq.png",
        fileContent: undefined,
      },
    ]);

    const handler = getHandler("messageCreate");
    const message = createMessage("!whatis faq");
    await handler(message);

    expect(message.channel.send).toHaveBeenCalledWith("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.");
  });
});
