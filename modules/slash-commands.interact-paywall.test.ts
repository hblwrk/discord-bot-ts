import {beforeEach, describe, expect, test, vi} from "vitest";
import {type ChatInputCommandInteraction} from "discord.js";
import {
  PaywallLookupCapacityError,
  paywallLookupBusyMessage,
  type PaywallResult,
} from "./paywall.ts";
import type * as PaywallModule from "./paywall.ts";
import {handlePaywallSlashCommand} from "./slash-commands-interact-paywall.ts";
import {createChatInputInteraction} from "./test-utils/discord-mocks.ts";

const getPaywallLinksMock = vi.hoisted(() => vi.fn());

vi.mock("./paywall.ts", async importOriginal => {
  const actual = await importOriginal<typeof PaywallModule>();
  return {
    ...actual,
    getPaywallLinks: getPaywallLinksMock,
  };
});

type EditedEmbed = {
  toJSON: () => {
    description?: string;
    fields?: {name: string; value: string}[];
    title?: string;
  };
};

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

function createPaywallInteraction(url: string) {
  const interaction = createChatInputInteraction("paywall");
  interaction.options.getString.mockImplementation((name, required?: boolean) => {
    if ("url" === name && true === required) {
      return url;
    }

    return null;
  });
  return interaction;
}

function asChatInputInteraction(interaction: ReturnType<typeof createPaywallInteraction>): ChatInputCommandInteraction {
  return interaction as unknown as ChatInputCommandInteraction;
}

describe("handlePaywallSlashCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("ignores non-paywall commands", async () => {
    const interaction = createPaywallInteraction("https://example.com/article");

    await expect(handlePaywallSlashCommand(asChatInputInteraction(interaction), "calendar", [])).resolves.toBe(false);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(getPaywallLinksMock).not.toHaveBeenCalled();
  });

  test("rejects malformed URLs before deferring", async () => {
    const interaction = createPaywallInteraction("not a url");

    await expect(handlePaywallSlashCommand(asChatInputInteraction(interaction), "paywall", [])).resolves.toBe(true);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Ungültige URL. Bitte eine vollständige URL angeben (z.B. https://www.example.com/article).",
      ephemeral: true,
    });
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(getPaywallLinksMock).not.toHaveBeenCalled();
  });

  test("rejects private-network URLs before lookup", async () => {
    const interaction = createPaywallInteraction("http://127.0.0.1/admin");

    await expect(handlePaywallSlashCommand(asChatInputInteraction(interaction), "paywall", [])).resolves.toBe(true);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Ungültige URL. Bitte eine öffentliche http(s)-URL angeben.",
      ephemeral: true,
    });
    expect(getPaywallLinksMock).not.toHaveBeenCalled();
  });

  test("edits nofix embed for known unsupported domains", async () => {
    getPaywallLinksMock.mockResolvedValueOnce(paywallResult({
      nofix: true,
    }));
    const interaction = createPaywallInteraction("https://example.com/article");

    await expect(handlePaywallSlashCommand(asChatInputInteraction(interaction), "paywall", [])).resolves.toBe(true);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenNthCalledWith(1, {
      content: "Suche nach Paywall-Bypass für <https://example.com/article>... Das kann bis zu 60 Sekunden dauern.",
    });
    const finalPayload = interaction.editReply.mock.calls[1]![0] as {content: string; embeds: EditedEmbed[]};
    expect(finalPayload.content).toBe("https://example.com/article");
    expect(finalPayload.embeds[0]?.toJSON()).toEqual({
      title: "Paywall Bypass",
      description: "Für diese Seite ist leider kein Paywall-Bypass bekannt.",
    });
  });

  test("formats service results and passes requester id to lookup", async () => {
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
    const interaction = createPaywallInteraction("example.com/article");

    await expect(handlePaywallSlashCommand(asChatInputInteraction(interaction), "paywall", [])).resolves.toBe(true);

    expect(getPaywallLinksMock).toHaveBeenCalledWith("https://example.com/article", [], {
      requesterId: "user-id",
    });
    const finalPayload = interaction.editReply.mock.calls[1]![0] as {content: string; embeds: EditedEmbed[]};
    expect(finalPayload.content).toBe("https://example.com/article");
    expect(finalPayload.embeds[0]?.toJSON()).toEqual({
      title: "Paywall Bypass (unbekannte Seite)",
      description: "Unbekannte Seite — versuche allgemeine Services:",
      fields: [
        {
          name: "Ergebnisse",
          value: [
            "✅ **archive.today**: <https://archive.ph/newest/https://example.com/article>",
            "❓ **backup**: <https://backup.example/article>",
          ].join("\n"),
        },
      ],
    });
  });

  test("formats known service results and defaults missing assets to an empty list", async () => {
    getPaywallLinksMock.mockResolvedValueOnce(paywallResult({
      services: [
        {
          name: "archive.today",
          url: "https://archive.ph/newest/https://example.com/article",
          available: true,
        },
      ],
    }));
    const interaction = createPaywallInteraction("https://example.com/article");

    await expect(handlePaywallSlashCommand(asChatInputInteraction(interaction), "paywall")).resolves.toBe(true);

    expect(getPaywallLinksMock).toHaveBeenCalledWith("https://example.com/article", [], {
      requesterId: "user-id",
    });
    const finalPayload = interaction.editReply.mock.calls[1]![0] as {content: string; embeds: EditedEmbed[]};
    expect(finalPayload.content).toBe("https://example.com/article");
    expect(finalPayload.embeds[0]?.toJSON()).toEqual({
      title: "Paywall Bypass",
      fields: [
        {
          name: "Ergebnisse",
          value: "✅ **archive.today**: <https://archive.ph/newest/https://example.com/article>",
        },
      ],
    });
  });

  test("logs and completes when the final paywall edit fails", async () => {
    getPaywallLinksMock.mockResolvedValueOnce(paywallResult({
      services: [
        {
          name: "archive.today",
          url: "https://archive.ph/newest/https://example.com/article",
          available: true,
        },
      ],
    }));
    const interaction = createPaywallInteraction("https://example.com/article");
    interaction.editReply
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("edit failed"));

    await expect(handlePaywallSlashCommand(asChatInputInteraction(interaction), "paywall")).resolves.toBe(true);

    expect(interaction.editReply).toHaveBeenCalledTimes(2);
  });

  test("edits busy message when lookup capacity is exhausted", async () => {
    getPaywallLinksMock.mockRejectedValueOnce(new PaywallLookupCapacityError("requester"));
    const interaction = createPaywallInteraction("https://example.com/article");

    await expect(handlePaywallSlashCommand(asChatInputInteraction(interaction), "paywall", [])).resolves.toBe(true);

    expect(interaction.editReply).toHaveBeenLastCalledWith({
      content: paywallLookupBusyMessage,
    });
  });

  test("edits generic error message when lookup fails unexpectedly", async () => {
    getPaywallLinksMock.mockRejectedValueOnce(new Error("lookup failed"));
    const interaction = createPaywallInteraction("https://example.com/article");

    await expect(handlePaywallSlashCommand(asChatInputInteraction(interaction), "paywall", [])).resolves.toBe(true);

    expect(interaction.editReply).toHaveBeenLastCalledWith({
      content: "Fehler beim Verarbeiten der Anfrage. Bitte später erneut versuchen.",
    });
  });

  test("returns after failed defer without running lookup", async () => {
    const interaction = createPaywallInteraction("https://example.com/article");
    interaction.deferReply.mockRejectedValueOnce(new Error("defer failed"));

    await expect(handlePaywallSlashCommand(asChatInputInteraction(interaction), "paywall", [])).resolves.toBe(true);

    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(getPaywallLinksMock).not.toHaveBeenCalled();
  });
});
