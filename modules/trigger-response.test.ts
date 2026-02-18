import {ImageAsset, TextAsset} from "./assets.js";
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
});
