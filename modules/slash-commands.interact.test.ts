import {ImageAsset, TextAsset, UserQuoteAsset} from "./assets.js";
import {interactSlashCommands} from "./slash-commands.js";
import {getCalendarEvents, getCalendarMessages} from "./calendar.js";
import {getEarningsMessages, getEarningsResult} from "./earnings.js";
import {createChatInputInteraction, createEventClient} from "./test-utils/discord-mocks.js";

jest.mock("./secrets.js", () => ({
  readSecret: jest.fn(() => ""),
}));

jest.mock("./logging.js", () => ({
  getLogger: () => ({
    log: jest.fn(),
  }),
  getDiscordLogger: () => ({
    log: jest.fn(),
  }),
}));

jest.mock("./calendar.js", () => ({
  CALENDAR_MAX_MESSAGE_LENGTH: 1800,
  CALENDAR_MAX_MESSAGES_SLASH: 6,
  getCalendarEvents: jest.fn(),
  getCalendarMessages: jest.fn(),
}));

jest.mock("./earnings.js", () => ({
  EARNINGS_MAX_MESSAGE_LENGTH: 1800,
  EARNINGS_MAX_MESSAGES_SLASH: 6,
  getEarningsResult: jest.fn(),
  getEarningsMessages: jest.fn(),
}));

const getCalendarEventsMock = getCalendarEvents as jest.MockedFunction<typeof getCalendarEvents>;
const getCalendarMessagesMock = getCalendarMessages as jest.MockedFunction<typeof getCalendarMessages>;
const getEarningsResultMock = getEarningsResult as jest.MockedFunction<typeof getEarningsResult>;
const getEarningsMessagesMock = getEarningsMessages as jest.MockedFunction<typeof getEarningsMessages>;

describe("interactSlashCommands", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getCalendarEventsMock.mockResolvedValue([]);
    getCalendarMessagesMock.mockReturnValue({
      messages: [],
      truncated: false,
      totalEvents: 0,
      includedEvents: 0,
      totalDays: 0,
      includedDays: 0,
    });
    getEarningsResultMock.mockResolvedValue({
      events: [],
      status: "ok",
    });
    getEarningsMessagesMock.mockReturnValue({
      messages: [],
      truncated: false,
      totalEvents: 0,
      includedEvents: 0,
    });
  });

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

  test("replies to lmgtfy command", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("lmgtfy");
    interaction.options.getString.mockImplementation(name => name === "search" ? "test search" : null);

    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      "Let me google that for you... <http://letmegooglethat.com/?q=test%20search>.",
    );
  });

  test("replies to google command", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("google");
    interaction.options.getString.mockImplementation(name => name === "search" ? "test search" : null);

    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(
      "Here you go: <https://www.google.com/search?q=test%20search>.",
    );
  });

  test("handles cryptodice reply failure without throwing", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("cryptodice");
    interaction.reply.mockRejectedValueOnce(new Error("send failed"));

    await expect(handler(interaction)).resolves.toBeUndefined();
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

  test("handles send failure for asset-backed text command", async () => {
    const {client, getHandler} = createEventClient();
    const textAsset = new TextAsset();
    textAsset.title = "hello";
    textAsset.response = "hello-response";
    (textAsset as any).trigger = ["hello"];

    interactSlashCommands(client, [textAsset], ["hello"], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("hello");
    interaction.reply.mockRejectedValueOnce(new Error("send failed"));

    await expect(handler(interaction)).resolves.toBeUndefined();
  });

  test("replies with temporary unavailable message when image asset content is missing", async () => {
    const {client, getHandler} = createEventClient();
    const imageAsset = new ImageAsset();
    imageAsset.title = "image";
    imageAsset.fileName = "image.png";
    imageAsset.text = "image text";
    (imageAsset as any).trigger = ["image"];

    interactSlashCommands(client, [imageAsset], ["image"], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("image");

    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.");
  });

  test("quote replies with fallback text when no quotes are available", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("quote");
    interaction.options.getString.mockImplementation(name => name === "who" ? "nobody" : null);

    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith("Keine passenden Zitate gefunden.");
  });

  test("quote replies with temporary unavailable message when quote file content is missing", async () => {
    const {client, getHandler} = createEventClient();
    const quoteAsset = new UserQuoteAsset();
    quoteAsset.user = "alice";
    quoteAsset.fileName = "quote.png";
    quoteAsset.fileContent = undefined;
    (quoteAsset as any).trigger = [];
    interactSlashCommands(client, [quoteAsset], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("quote");
    interaction.options.getString.mockImplementation(name => name === "who" ? "alice" : null);

    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.");
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

  test("handles whatis unavailable responses when reply itself fails", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [
      {
        name: "whatis_faq",
        title: "FAQ",
        text: "Answer",
        _fileName: "faq.png",
        fileName: "faq.png",
        fileContent: undefined,
      },
    ], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("whatis");
    interaction.options.getString.mockImplementation(name => name === "search" ? "whatis_faq" : null);
    interaction.reply.mockRejectedValueOnce(new Error("send failed"));

    await expect(handler(interaction)).resolves.toBeUndefined();
  });

  test("calendar replies with first chunk and follows up remaining chunks in order", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("calendar");
    getCalendarEventsMock.mockResolvedValue([]);
    getCalendarMessagesMock.mockReturnValue({
      messages: ["chunk-1", "chunk-2", "chunk-3"],
      truncated: false,
      totalEvents: 3,
      includedEvents: 3,
      totalDays: 2,
      includedDays: 2,
    });

    await handler(interaction);

    expect(getCalendarEventsMock).toHaveBeenCalledWith("", 0);
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "chunk-1",
      allowedMentions: {
        parse: [],
      },
    });
    expect(interaction.followUp).toHaveBeenNthCalledWith(1, {
      content: "chunk-2",
      allowedMentions: {
        parse: [],
      },
    });
    expect(interaction.followUp).toHaveBeenNthCalledWith(2, {
      content: "chunk-3",
      allowedMentions: {
        parse: [],
      },
    });
  });

  test("calendar keeps no-events fallback unchanged", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("calendar");
    getCalendarEventsMock.mockResolvedValue([]);
    getCalendarMessagesMock.mockReturnValue({
      messages: [],
      truncated: false,
      totalEvents: 0,
      includedEvents: 0,
      totalDays: 0,
      includedDays: 0,
    });

    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Heute passiert nichts wichtiges 😴.",
      allowedMentions: {
        parse: [],
      },
    });
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  test("earnings replies with first chunk and follows up remaining chunks in order", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("earnings");
    getEarningsResultMock.mockResolvedValue({
      events: [],
      status: "ok",
    });
    getEarningsMessagesMock.mockReturnValue({
      messages: ["earnings-1", "earnings-2"],
      truncated: false,
      totalEvents: 4,
      includedEvents: 4,
    });

    await handler(interaction);

    expect(getEarningsResultMock).toHaveBeenCalledWith(0, "today");
    expect(getEarningsMessagesMock).toHaveBeenCalledWith([], "all", [], {
      maxMessageLength: 1800,
      maxMessages: 6,
      marketCapFilter: "bluechips",
    });
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "earnings-1",
      allowedMentions: {
        parse: [],
      },
    });
    expect(interaction.followUp).toHaveBeenCalledWith({
      content: "earnings-2",
      allowedMentions: {
        parse: [],
      },
    });
  });

  test("earnings uses marketCapFilter=all when filter option is set to all", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("earnings");
    interaction.options.getString.mockImplementation(name => name === "filter" ? "all" : null);
    getEarningsResultMock.mockResolvedValue({
      events: [],
      status: "ok",
    });
    getEarningsMessagesMock.mockReturnValue({
      messages: [],
      truncated: false,
      totalEvents: 0,
      includedEvents: 0,
    });

    await handler(interaction);

    expect(getEarningsMessagesMock).toHaveBeenCalledWith([], "all", [], {
      maxMessageLength: 1800,
      maxMessages: 6,
      marketCapFilter: "all",
    });
  });

  test("earnings keeps no-events fallback unchanged", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("earnings");
    getEarningsResultMock.mockResolvedValue({
      events: [],
      status: "ok",
    });
    getEarningsMessagesMock.mockReturnValue({
      messages: [],
      truncated: false,
      totalEvents: 0,
      includedEvents: 0,
    });

    await handler(interaction);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Es stehen keine relevanten Quartalszahlen an.",
      allowedMentions: {
        parse: [],
      },
    });
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  test("earnings replies with error fallback when loading fails", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("earnings");
    getEarningsResultMock.mockResolvedValue({
      events: [],
      status: "error",
    });
    getEarningsMessagesMock.mockReturnValue({
      messages: [],
      truncated: false,
      totalEvents: 0,
      includedEvents: 0,
    });

    await handler(interaction);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Earnings konnten gerade nicht geladen werden. Bitte später erneut versuchen.",
      allowedMentions: {
        parse: [],
      },
    });
    expect(interaction.followUp).not.toHaveBeenCalled();
  });

  test("calendar coerces invalid range input path", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("calendar");
    interaction.options.getString.mockImplementation(name => name === "range" ? "abc" : null);
    getCalendarMessagesMock.mockReturnValue({
      messages: [],
      truncated: false,
      totalEvents: 0,
      includedEvents: 0,
      totalDays: 0,
      includedDays: 0,
    });

    await handler(interaction);

    expect(getCalendarEventsMock).toHaveBeenCalledWith("", -1);
  });

  test("calendar clamps range values larger than 31 days", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("calendar");
    interaction.options.getString.mockImplementation(name => name === "range" ? "50" : null);
    getCalendarMessagesMock.mockReturnValue({
      messages: [],
      truncated: false,
      totalEvents: 0,
      includedEvents: 0,
      totalDays: 0,
      includedDays: 0,
    });

    await handler(interaction);

    expect(getCalendarEventsMock).toHaveBeenCalledWith("", 30);
  });

  test("sara falls back when referenced media asset is missing", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("sara");
    interaction.options.getString.mockImplementation(name => name === "what" ? "yes" : null);

    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith("Sara möchte das nicht.");
  });

  test("sara replies with attachment when yes asset is present", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [{
      name: "sara-yes",
      fileName: "yes.png",
      fileContent: Buffer.from("yes"),
    }], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("sara");
    interaction.options.getString.mockImplementation(name => name === "what" ? "yes" : null);

    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      files: expect.any(Array),
    }));
  });

  test("sara replies with attachment when shrug asset is present", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [{
      name: "sara-shrug",
      fileName: "shrug.png",
      fileContent: Buffer.from("shrug"),
    }], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("sara");
    interaction.options.getString.mockImplementation(name => name === "what" ? "shrug" : null);

    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      files: expect.any(Array),
    }));
  });

  test("handles lmgtfy send failure without throwing", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("lmgtfy");
    interaction.options.getString.mockImplementation(name => name === "search" ? "test search" : null);
    interaction.reply.mockRejectedValueOnce(new Error("send failed"));

    await expect(handler(interaction)).resolves.toBeUndefined();
  });
});
