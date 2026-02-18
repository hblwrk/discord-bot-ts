import {TextAsset} from "./assets.js";
import {interactSlashCommands} from "./slash-commands.js";
import {getCalendarEvents, getCalendarMessages} from "./calendar.js";
import {getEarnings, getEarningsMessages} from "./earnings.js";
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
  getEarnings: jest.fn(),
  getEarningsMessages: jest.fn(),
}));

const getCalendarEventsMock = getCalendarEvents as jest.MockedFunction<typeof getCalendarEvents>;
const getCalendarMessagesMock = getCalendarMessages as jest.MockedFunction<typeof getCalendarMessages>;
const getEarningsMock = getEarnings as jest.MockedFunction<typeof getEarnings>;
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
    getEarningsMock.mockResolvedValue([]);
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
    getEarningsMock.mockResolvedValue([]);
    getEarningsMessagesMock.mockReturnValue({
      messages: ["earnings-1", "earnings-2"],
      truncated: false,
      totalEvents: 4,
      includedEvents: 4,
    });

    await handler(interaction);

    expect(getEarningsMock).toHaveBeenCalledWith(0, "today", "all");
    expect(interaction.reply).toHaveBeenCalledWith({
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

  test("earnings keeps no-events fallback unchanged", async () => {
    const {client, getHandler} = createEventClient();
    interactSlashCommands(client, [], [], [], []);

    const handler = getHandler("interactionCreate");
    const interaction = createChatInputInteraction("earnings");
    getEarningsMock.mockResolvedValue([]);
    getEarningsMessagesMock.mockReturnValue({
      messages: [],
      truncated: false,
      totalEvents: 0,
      includedEvents: 0,
    });

    await handler(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Es stehen keine relevanten Quartalszahlen an.",
      allowedMentions: {
        parse: [],
      },
    });
    expect(interaction.followUp).not.toHaveBeenCalled();
  });
});
