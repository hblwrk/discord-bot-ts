/* eslint-disable max-depth */
import validator from "validator";
import {EmojiAsset} from "./assets";
import {getLogger} from "./logging";

const logger = getLogger();

export function addInlineResponses(client, assets, assetCommands) {
  // Message response to a message including with a trigger word
  client.on("messageCreate", async message => {
    const messageContent: string = validator.escape(message.content);
    // Triggers without prefix
    if (assetCommands.some(v => messageContent.toLowerCase().replaceAll(" ", "_").includes(v))) {
      for (const asset of assets) {
        for (const trigger of asset.trigger) {
          // This may show up as possible DoS (RegExp() called with a variable, CWE-185) in Semgrep. However it is safe since the variable is based on assets, which cannot be user-supplied.
          let triggerRex = new RegExp(`\\b${trigger}\\b`);
          // Special case for lines containing "wo" and one more word before or after
          if ("wo" === trigger) {
            triggerRex = new RegExp(asset.triggerRegex);
          }

          if (asset instanceof EmojiAsset && triggerRex.test(messageContent.toLowerCase())) {
            // Emoji reaction to a message
            for (const response of asset.response) {
              if (response.startsWith("custom:")) {
                const reactionEmoji = message.guild.emojis.cache.find(emoji => emoji.name === response.replace("custom:", ""));
                message.react(reactionEmoji).catch(error => {
                  logger.log(
                    "error",
                    `Error posting emoji reaction: ${error}`,
                  );
                });
              } else {
                message.react(response).catch(error => {
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
