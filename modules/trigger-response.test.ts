import {ImageAsset, TextAsset, UserAsset, UserQuoteAsset} from "./assets.ts";
import {
  PaywallLookupCapacityError,
  paywallLookupBusyMessage,
  type PaywallResult,
} from "./paywall.ts";
import type * as PaywallModule from "./paywall.ts";
import {addTriggerResponses} from "./trigger-response.ts";
import {createEventClient, createMessage} from "./test-utils/discord-mocks.ts";
import {beforeEach, describe, expect, test, vi} from "vitest";

const getPaywallLinksMock = vi.hoisted(() => vi.fn());

vi.mock("./paywall.ts", async importOriginal => {
  const actual = await importOriginal<typeof PaywallModule>();
  return {
    ...actual,
    getPaywallLinks: getPaywallLinksMock,
  };
});

type SentAttachment = {
  attachment?: Buffer;
  name?: string;
};
type SentEmbed = {
  toJSON: () => {
    fields?: {name: string; value: string}[];
    image?: {
      url?: string;
    };
  };
};
type SentPayload = {
  embeds?: SentEmbed[];
  files?: SentAttachment[];
};

function getFirstPayload(message: ReturnType<typeof createMessage>): SentPayload {
  return message.channel.send.mock.calls[0]![0] as SentPayload;
}

function paywallResult(overrides: Partial<PaywallResult> = {}): PaywallResult {
  return {
    originalUrl: "https://example.com/article",
    nofix: false,
    isDefault: false,
    headline: "Article headline",
    services: [],
    ...overrides,
  };
}

describe("addTriggerResponses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("sends plain text for text assets", async () => {
    const {client, getHandler} = createEventClient();
    const textAsset = new TextAsset();
    textAsset.title = "hello";
    textAsset.response = "hello response";
    textAsset.trigger = ["hello"];

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
    imageAsset.trigger = ["image"];

    addTriggerResponses(client, [imageAsset], ["!image"], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!image");

    await handler(message);

    const payload = getFirstPayload(message);
    expect(payload.files?.[0]?.name).toBe("image.png");
    expect(payload.files?.[0]?.attachment).toEqual(Buffer.from("file"));
    expect(payload.embeds?.[0]?.toJSON()).toEqual({
      image: {
        url: "attachment://image.png",
      },
      fields: [{
        name: "image",
        value: "image text",
      }],
    });
  });

  test("replies with temporary unavailable message when image asset content is missing", async () => {
    const {client, getHandler} = createEventClient();
    const imageAsset = new ImageAsset();
    imageAsset.title = "image";
    imageAsset.fileName = "image.png";
    imageAsset.text = "image text";
    imageAsset.trigger = ["image"];

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
    const reply = message.channel.send.mock.calls[0]![0];
    expect(reply.startsWith("Rolling the crypto dice... ")).toBe(true);
  });

  test("replies to lmgtfy trigger messages", async () => {
    const {client, getHandler} = createEventClient();
    addTriggerResponses(client, [], [], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!lmgtfy test query");

    await handler(message);

    expect(message.channel.send).toHaveBeenCalledWith(
      "Let me google that for you... <http://letmegooglethat.com/?q=test%20query>.",
    );
  });

  test("sends a fallback response when no quote asset exists for a user trigger", async () => {
    const {client, getHandler} = createEventClient();
    const userAsset = new UserAsset();
    userAsset.name = "missing-user";
    userAsset.trigger = ["missing-user"];

    addTriggerResponses(client, [userAsset], ["!missing-user"], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!missing-user");
    await handler(message);

    expect(message.channel.send).toHaveBeenCalledWith("Keine passenden Zitate gefunden.");
  });

  test("sends a quote attachment when quote asset exists for user trigger", async () => {
    const {client, getHandler} = createEventClient();
    const userAsset = new UserAsset();
    userAsset.name = "alice";
    userAsset.trigger = ["alice"];

    const userQuoteAsset = new UserQuoteAsset();
    userQuoteAsset.user = "alice";
    userQuoteAsset.fileName = "quote.png";
    userQuoteAsset.fileContent = Buffer.from("quote");
    userQuoteAsset.trigger = [];

    addTriggerResponses(client, [userAsset, userQuoteAsset], ["!alice"], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!alice");
    await handler(message);

    const payload = getFirstPayload(message);
    expect(payload.files?.[0]?.name).toBe("quote.png");
    expect(payload.files?.[0]?.attachment).toEqual(Buffer.from("quote"));
  });

  test("sends a random quote attachment for bare quote trigger", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.99);
    const {client, getHandler} = createEventClient();
    const aliceQuote = new UserQuoteAsset();
    aliceQuote.user = "alice";
    aliceQuote.fileName = "quote-alice.png";
    aliceQuote.fileContent = Buffer.from("alice");
    aliceQuote.trigger = [];
    const bobQuote = new UserQuoteAsset();
    bobQuote.user = "bob";
    bobQuote.fileName = "quote-bob.png";
    bobQuote.fileContent = Buffer.from("bob");
    bobQuote.trigger = [];

    addTriggerResponses(client, [aliceQuote, bobQuote], [], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!quote");
    await handler(message);

    const payload = getFirstPayload(message);
    expect(["quote-alice.png", "quote-bob.png"]).toContain(payload.files?.[0]?.name);
    randomSpy.mockRestore();
  });

  test("sends a fallback response for bare quote trigger when no quotes exist", async () => {
    const {client, getHandler} = createEventClient();

    addTriggerResponses(client, [], [], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!quote");
    await handler(message);

    expect(message.channel.send).toHaveBeenCalledWith("Keine passenden Zitate gefunden.");
  });

  test("sends a random attachment for grouped image triggers like betrug", async () => {
    const {client, getHandler} = createEventClient();
    const imageAsset = new ImageAsset();
    imageAsset.name = "betrug 1";
    imageAsset.fileName = "betrug-01.jpg";
    imageAsset.fileContent = Buffer.from("betrug-1");
    imageAsset.trigger = ["betrug 1"];

    addTriggerResponses(client, [imageAsset], [], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!betrug");
    await handler(message);

    const payload = getFirstPayload(message);
    expect(payload.files?.[0]?.name).toBe("betrug-01.jpg");
    expect(payload.files?.[0]?.attachment).toEqual(Buffer.from("betrug-1"));
  });

  test("sends unavailable response for grouped image trigger when the chosen asset is missing", async () => {
    const {client, getHandler} = createEventClient();
    const imageAsset = new ImageAsset();
    imageAsset.name = "betrug 1";
    imageAsset.fileName = "betrug-01.jpg";
    imageAsset.fileContent = undefined;
    imageAsset.trigger = ["betrug 1"];

    addTriggerResponses(client, [imageAsset], [], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!betrug");
    await handler(message);

    expect(message.channel.send).toHaveBeenCalledWith("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.");
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

  test("replies with whatis embed and attachment when available", async () => {
    const {client, getHandler} = createEventClient();

    addTriggerResponses(client, [], [], [
      {
        name: "whatis_faq",
        title: "FAQ",
        text: "Answer",
        _fileName: "faq.png",
        fileName: "faq.png",
        fileContent: Buffer.from("file"),
      },
    ]);

    const handler = getHandler("messageCreate");
    const message = createMessage("!whatis faq");
    await handler(message);

    const payload = getFirstPayload(message);
    expect(payload.files?.[0]?.name).toBe("faq.png");
    expect(payload.files?.[0]?.attachment).toEqual(Buffer.from("file"));
    expect(payload.embeds?.[0]?.toJSON()).toEqual({
      image: {
        url: "attachment://faq.png",
      },
      fields: [{
        name: "FAQ",
        value: "Answer",
      }],
    });
  });

  test("replies with whatis embed-only when no attachment exists", async () => {
    const {client, getHandler} = createEventClient();

    addTriggerResponses(client, [], [], [
      {
        name: "whatis_faq",
        title: "FAQ",
        text: "Answer",
      },
    ]);

    const handler = getHandler("messageCreate");
    const message = createMessage("!whatis faq");
    await handler(message);

    const payload = getFirstPayload(message);
    expect(payload.files).toBeUndefined();
    expect(payload.embeds?.[0]?.toJSON()).toEqual({
      fields: [{
        name: "FAQ",
        value: "Answer",
      }],
    });
  });

  test("paywall normalizes URLs, edits the working message, and formats service availability", async () => {
    getPaywallLinksMock.mockResolvedValueOnce(paywallResult({
      isDefault: true,
      services: [
        {
          name: "archive.today",
          url: "https://archive.ph/newest/https://example.com/article",
          available: true,
        },
        {
          name: "backup",
          url: "https://backup.example/article",
          available: false,
        },
      ],
    }));
    const {client, getHandler} = createEventClient();
    addTriggerResponses(client, [], [], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!paywall example.com/article");
    const edit = vi.fn().mockResolvedValue(undefined);
    message.author = {
      id: "requester-id",
    };
    message.channel.send.mockResolvedValueOnce({
      edit,
    });

    await handler(message);

    expect(message.channel.send).toHaveBeenCalledWith(
      "Suche nach Paywall-Bypass für <https://example.com/article>... Das kann bis zu 60 Sekunden dauern.",
    );
    expect(getPaywallLinksMock).toHaveBeenCalledWith("https://example.com/article", [], {
      requesterId: "requester-id",
    });
    expect(edit).toHaveBeenCalledWith([
      "Unbekannte Seite — versuche allgemeine Services:\n",
      "✅ **archive.today**: <https://archive.ph/newest/https://example.com/article>",
      "❓ **backup**: <https://backup.example/article>",
    ].join("\n"));
  });

  test("paywall rejects unsafe private-network URLs before lookup", async () => {
    const {client, getHandler} = createEventClient();
    addTriggerResponses(client, [], [], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!paywall http://127.0.0.1/admin");

    await handler(message);

    expect(message.channel.send).toHaveBeenCalledWith("Ungültige URL. Bitte eine öffentliche http(s)-URL angeben.");
    expect(getPaywallLinksMock).not.toHaveBeenCalled();
  });

  test("paywall edits busy fallback when lookup capacity is exhausted", async () => {
    getPaywallLinksMock.mockRejectedValueOnce(new PaywallLookupCapacityError("global"));
    const {client, getHandler} = createEventClient();
    addTriggerResponses(client, [], [], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!paywall https://example.com/article");
    const edit = vi.fn().mockResolvedValue(undefined);
    message.channel.send.mockResolvedValueOnce({
      edit,
    });

    await handler(message);

    expect(edit).toHaveBeenCalledWith(paywallLookupBusyMessage);
  });

  test("paywall edits nofix fallback when no bypass is known", async () => {
    getPaywallLinksMock.mockResolvedValueOnce(paywallResult({
      nofix: true,
      services: [],
    }));
    const {client, getHandler} = createEventClient();
    addTriggerResponses(client, [], [], []);

    const handler = getHandler("messageCreate");
    const message = createMessage("!paywall https://example.com/article");
    const edit = vi.fn().mockResolvedValue(undefined);
    message.channel.send.mockResolvedValueOnce({
      edit,
    });

    await handler(message);

    expect(edit).toHaveBeenCalledWith("Für diese Seite ist leider kein Paywall-Bypass bekannt.");
  });

  test("replies with sara attachment for yes and shrug", async () => {
    const {client, getHandler} = createEventClient();
    const saraYesAsset = new ImageAsset();
    saraYesAsset.name = "sara-yes";
    saraYesAsset.fileName = "yes.png";
    saraYesAsset.fileContent = Buffer.from("yes");
    saraYesAsset.trigger = [];
    const saraShrugAsset = new ImageAsset();
    saraShrugAsset.name = "sara-shrug";
    saraShrugAsset.fileName = "shrug.png";
    saraShrugAsset.fileContent = Buffer.from("shrug");
    saraShrugAsset.trigger = [];

    addTriggerResponses(client, [saraYesAsset, saraShrugAsset], [], []);

    const handler = getHandler("messageCreate");

    const yesMessage = createMessage("!sara yes");
    await handler(yesMessage);
    const yesPayload = getFirstPayload(yesMessage);
    expect(yesPayload.files?.[0]?.name).toBe("yes.png");
    expect(yesPayload.files?.[0]?.attachment).toEqual(Buffer.from("yes"));

    const shrugMessage = createMessage("!sara shrug");
    await handler(shrugMessage);
    const shrugPayload = getFirstPayload(shrugMessage);
    expect(shrugPayload.files?.[0]?.name).toBe("shrug.png");
    expect(shrugPayload.files?.[0]?.attachment).toEqual(Buffer.from("shrug"));
  });

  test("replies with sara fallback when requested assets are missing", async () => {
    const {client, getHandler} = createEventClient();

    addTriggerResponses(client, [], [], []);

    const handler = getHandler("messageCreate");

    const yesMessage = createMessage("!sara yes");
    await handler(yesMessage);
    expect(yesMessage.channel.send).toHaveBeenCalledWith("Sara möchte das nicht.");

    const shrugMessage = createMessage("!sara shrug");
    await handler(shrugMessage);
    expect(shrugMessage.channel.send).toHaveBeenCalledWith("Sara möchte das nicht.");
  });
});
