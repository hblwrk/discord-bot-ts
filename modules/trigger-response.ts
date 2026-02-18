/* eslint-disable yoda */
/* eslint-disable import/extensions */
/* eslint-disable complexity */
import {AttachmentBuilder, EmbedBuilder} from "discord.js";
import validator from "validator";
import {getAssetByName, ImageAsset, TextAsset, UserAsset, UserQuoteAsset} from "./assets.js";
import {cryptodice} from "./crypto-dice.js";
import {lmgtfy} from "./lmgtfy.js";
import {getLogger} from "./logging.js";
import {getRandomQuote} from "./random-quote.js";

const logger = getLogger();
const noQuoteMessage = "Keine passenden Zitate gefunden.";

export function addTriggerResponses(client, assets, assetCommandsWithPrefix, whatIsAssets) {
  // Message response to a trigger command (!command)
  client.on("messageCreate", async message => {
    if (true === message.author?.bot || Boolean(message.webhookId)) {
      return;
    }

    const messageContent: string = validator.escape(message.content);
    if (assetCommandsWithPrefix.some(v => messageContent.includes(v))) {
      for (const asset of assets) {
        for (const trigger of asset.trigger) {
          if (`!${trigger}` === messageContent && 0 <= asset.trigger.length) {
            if (asset instanceof ImageAsset || asset instanceof UserQuoteAsset) {
              if (!asset?.fileContent || !asset.fileName) {
                logger.log(
                  "warn",
                  `Asset ${asset.name ?? asset.fileName ?? trigger} is temporarily unavailable.`,
                );
                await message.channel.send("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.").catch(error => {
                  logger.log(
                    "error",
                    `Error sending unavailable-asset response: ${error}`,
                  );
                });
                continue;
              }

              // Response with an image
              const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
              if (asset instanceof ImageAsset && asset.hasText) {
                const embed = new EmbedBuilder();
                embed.setImage(`attachment://${asset.fileName}`);
                embed.addFields(
                  {name: asset.title, value: asset.text},
                );
                message.channel.send({embeds: [embed], files: [file]}).catch(error => {
                  logger.log(
                    "error",
                    `Error sending response: ${error}`,
                  );
                });
              } else {
                message.channel.send({files: [file]}).catch(error => {
                  logger.log(
                    "error",
                    `Error sending response: ${error}`,
                  );
                });
              }
            } else if (asset instanceof TextAsset) {
              // Simple response to a message
              message.channel.send(asset.response).catch(error => {
                logger.log(
                  "error",
                  `Error sending response: ${error}`,
                );
              });
            } else if (asset instanceof UserAsset) {
              const randomQuote = getRandomQuote(asset.name, assets);
              if (!randomQuote) {
                await message.channel.send(noQuoteMessage).catch(error => {
                  logger.log(
                    "error",
                    `Error sending quote fallback response: ${error}`,
                  );
                });
                continue;
              }

              if (!randomQuote.fileContent || !randomQuote.fileName) {
                logger.log(
                  "warn",
                  `Quote asset for ${asset.name} is temporarily unavailable.`,
                );
                await message.channel.send("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.").catch(error => {
                  logger.log(
                    "error",
                    `Error sending unavailable-quote response: ${error}`,
                  );
                });
                continue;
              }

              const file = new AttachmentBuilder(Buffer.from(randomQuote.fileContent), {name: randomQuote.fileName});
              await message.channel.send({files: [file]});
            }
          }
        }
      }
    }

    if ("!cryptodice" === messageContent) {
      message.channel.send(`Rolling the crypto dice... ${cryptodice()}.`).catch(error => {
        logger.log(
          "error",
          `Error sending cryptodice response: ${error}`,
        );
      });
    }

    if (messageContent.startsWith("!lmgtfy")) {
      const search = messageContent.split("!lmgtfy ")[1];
      if ("string" === typeof search) {
        message.channel.send(`Let me google that for you... ${lmgtfy(search)}.`).catch(error => {
          logger.log(
            "error",
            `Error sending lmgtfy response: ${error}`,
          );
        });
      }
    }

    if (messageContent.startsWith("!whatis")) {
      const search = messageContent.split("!whatis ")[1];
      for (const asset of whatIsAssets) {
        if (asset.name === `whatis_${search}`) {
          const embed = new EmbedBuilder();
          embed.addFields(
            {name: asset.title, value: asset.text},
          );

          if (true === Object.prototype.hasOwnProperty.call(asset, "_fileName")) {
            if (!asset?.fileContent || !asset.fileName) {
              logger.log(
                "warn",
                `Whatis asset ${asset.name} is temporarily unavailable.`,
              );
              message.channel.send("Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.").catch(error => {
                logger.log(
                  "error",
                  `Error sending whatis response: ${error}`,
                );
              });
              continue;
            }

            const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
            embed.setImage(`attachment://${asset.fileName}`);
            message.channel.send({embeds: [embed], files: [file]}).catch(error => {
              logger.log(
                "error",
                `Error sending whatis response: ${error}`,
              );
            });
          } else {
            message.channel.send({embeds: [embed]}).catch(error => {
              logger.log(
                "error",
                `Error sending whatis response: ${error}`,
              );
            });
          }
        }
      }
    }

    if (messageContent.startsWith("!sara")) {
      const search = messageContent.split("!sara ")[1];
      if ("string" === typeof search) {
        if ("yes" === search.toLowerCase()) {
          const asset = getAssetByName("sara-yes", assets);
          if (!asset?.fileContent || !asset.fileName) {
            message.channel.send("Sara möchte das nicht.").catch(error => {
              logger.log(
                "error",
                `Error sending sara response: ${error}`,
              );
            });
            return;
          }

          const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
          await message.channel.send({files: [file]}).catch(error => {
            logger.log(
              "error",
              `Error sending sara response: ${error}`,
            );
          });
        } else if ("shrug" === search.toLowerCase()) {
          const asset = getAssetByName("sara-shrug", assets);
          if (!asset?.fileContent || !asset.fileName) {
            message.channel.send("Sara möchte das nicht.").catch(error => {
              logger.log(
                "error",
                `Error sending sara response: ${error}`,
              );
            });
            return;
          }

          const file = new AttachmentBuilder(Buffer.from(asset.fileContent), {name: asset.fileName});
          await message.channel.send({files: [file]}).catch(error => {
            logger.log(
              "error",
              `Error sending sara response: ${error}`,
            );
          });
        } else {
          message.channel.send("Sara möchte das nicht.").catch(error => {
            logger.log(
              "error",
              `Error sending sara response: ${error}`,
            );
          });
        }
      }
    }
  });
}
