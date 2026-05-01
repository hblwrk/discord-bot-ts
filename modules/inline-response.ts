import {EmojiAsset} from "./assets.ts";
import {getLogger} from "./logging.ts";

const logger = getLogger();
const triggerBoundaryRegex = "[^\\p{L}\\p{N}_-]";

type InlineResponseAsset = {
  response?: unknown;
  trigger: string[];
  triggerRegex?: unknown;
};

type InlineResponseMessage = {
  author?: {
    bot?: boolean;
  };
  content: string;
  guild: {
    emojis: {
      cache: {
        find: (predicate: (emoji: {name: string | null}) => boolean) => unknown;
      };
    };
  };
  react: (emoji: unknown) => Promise<unknown>;
  webhookId?: string | null;
};

type InlineResponseClient = {
  on: (eventName: "messageCreate", handler: (message: InlineResponseMessage) => Promise<void>) => void;
};

function escapeRegexValue(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getSpecialTriggerRegex(triggerRegex: unknown): RegExp | null {
  if ("string" === typeof triggerRegex && "" !== triggerRegex) {
    return new RegExp(triggerRegex, "u");
  }

  if (Array.isArray(triggerRegex) && "string" === typeof triggerRegex[0] && "" !== triggerRegex[0]) {
    return new RegExp(triggerRegex[0], "u");
  }

  return null;
}

function getTriggerRegex(trigger: string, triggerRegex: unknown): RegExp {
  if ("wo" === trigger) {
    const specialRegex = getSpecialTriggerRegex(triggerRegex);
    if (specialRegex) {
      return specialRegex;
    }
  }

  const escapedTrigger = escapeRegexValue(trigger);
  return new RegExp(`(?:^|${triggerBoundaryRegex})${escapedTrigger}(?:$|${triggerBoundaryRegex})`, "u");
}

function isEmojiResponse(response: unknown): response is string[] {
  return Array.isArray(response) && response.every(value => "string" === typeof value);
}

export function addInlineResponses(client: InlineResponseClient, assets: InlineResponseAsset[], assetCommands: string[]) {
  // Message response to a message including with a trigger word
  client.on("messageCreate", async message => {
    if (true === message.author?.bot || Boolean(message.webhookId)) {
      return;
    }

    const messageContent: string = message.content.toLowerCase();
    // Triggers without prefix
    if (assetCommands.some((v: string) => messageContent.replaceAll(" ", "_").includes(v))) {
      for (const asset of assets) {
        for (const trigger of asset.trigger) {
          // This may show up as possible DoS (RegExp() called with a variable, CWE-185) in Semgrep. However it is safe since the variable is based on assets, which cannot be user-supplied.
          const triggerRex = getTriggerRegex(trigger, asset.triggerRegex);

          if (asset instanceof EmojiAsset && isEmojiResponse(asset.response) && triggerRex.test(messageContent)) {
            // Emoji reaction to a message
            for (const response of asset.response) {
              if (response.startsWith("custom:")) {
                const reactionEmoji = message.guild.emojis.cache.find(emoji => emoji.name === response.replace("custom:", ""));
                message.react(reactionEmoji).catch((error: unknown) => {
                  logger.log(
                    "error",
                    `Error posting emoji reaction: ${error}`,
                  );
                });
              } else {
                message.react(response).catch((error: unknown) => {
                  logger.log(
                    "error",
                    `Error posting emoji reaction: ${error}`,
                  );
                });
              }
            }
          }
        }
      }
    }
  });
}
