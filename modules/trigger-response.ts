/* eslint-disable yoda */
/* eslint-disable import/extensions */
/* eslint-disable complexity */
import {AttachmentBuilder, EmbedBuilder} from "discord.js";
import validator from "validator";
import {getAssetByName, ImageAsset, TextAsset, UserAsset, UserQuoteAsset} from "./assets.js";
import {cryptodice} from "./crypto-dice.js";
import {lmgtfy} from "./lmgtfy.js";
import {getLogger} from "./logging.js";
import {getPaywallLinks, PaywallResult} from "./paywall.js";
import {assertSafeRequestUrl, UnsafeUrlError} from "./safe-http.js";
import {getRandomAssetByTriggerGroup} from "./random-asset.js";
import {getRandomQuote} from "./random-quote.js";

const logger = getLogger();
const noQuoteMessage = "Keine passenden Zitate gefunden.";
const unavailableMessage = "Dieser Inhalt ist gerade nicht verfügbar. Bitte später erneut versuchen.";

function getAssetLabel(asset: ImageAsset | UserQuoteAsset, fallback: string): string {
  return asset.name ?? asset.fileName ?? fallback;
}

async function sendUnavailableResponse(message, errorContext: string) {
  await message.channel.send(unavailableMessage).catch(error => {
    logger.log(
      "error",
      `${errorContext}: ${error}`,
    );
  });
}

async function sendBinaryAssetResponse(message, asset: ImageAsset | UserQuoteAsset, fallbackLabel: string) {
  const assetLabel = getAssetLabel(asset, fallbackLabel);
  if (!asset?.fileContent || !asset.fileName) {
    logger.log(
      "warn",
      `Asset ${assetLabel} is temporarily unavailable.`,
    );
    await sendUnavailableResponse(message, "Error sending unavailable-asset response");
    return;
  }

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
    return;
  }

  message.channel.send({files: [file]}).catch(error => {
    logger.log(
      "error",
      `Error sending response: ${error}`,
    );
  });
}

async function sendRandomQuoteResponse(message, assets: unknown[], username: string) {
  const randomQuote = getRandomQuote(username, assets);
  if (!randomQuote) {
    await message.channel.send(noQuoteMessage).catch(error => {
      logger.log(
        "error",
        `Error sending quote fallback response: ${error}`,
      );
    });
    return;
  }

  if (!randomQuote.fileContent || !randomQuote.fileName) {
    logger.log(
      "warn",
      `Quote asset for ${username} is temporarily unavailable.`,
    );
    await sendUnavailableResponse(message, "Error sending unavailable-quote response");
    return;
  }

  const file = new AttachmentBuilder(Buffer.from(randomQuote.fileContent), {name: randomQuote.fileName});
  await message.channel.send({files: [file]});
}

async function sendMatchedAssetResponse(message, asset: unknown, assets: unknown[], fallbackTrigger: string) {
  if (asset instanceof ImageAsset || asset instanceof UserQuoteAsset) {
    await sendBinaryAssetResponse(message, asset, fallbackTrigger);
    return;
  }

  if (asset instanceof TextAsset) {
    message.channel.send(asset.response).catch(error => {
      logger.log(
        "error",
        `Error sending response: ${error}`,
      );
    });
    return;
  }

  if (asset instanceof UserAsset) {
    await sendRandomQuoteResponse(message, assets, asset.name);
  }
}

export function addTriggerResponses(client, assets, assetCommandsWithPrefix, whatIsAssets, paywallAssets?) {
  // Message response to a trigger command (!command)
  client.on("messageCreate", async message => {
    if (true === message.author?.bot || Boolean(message.webhookId)) {
      return;
    }

    const messageContent: string = validator.escape(message.content);
    let matchedExactTrigger = false;
    if (assetCommandsWithPrefix.some(v => messageContent.includes(v))) {
      for (const asset of assets) {
        for (const trigger of asset.trigger) {
          if (`!${trigger}` === messageContent && 0 <= asset.trigger.length) {
            matchedExactTrigger = true;
            await sendMatchedAssetResponse(message, asset, assets, trigger);
          }
        }
      }
    }

    if (true === matchedExactTrigger) {
      return;
    }

    if ("!quote" === messageContent) {
      await sendRandomQuoteResponse(message, assets, "any");
      return;
    }

    const randomTriggerAsset = getRandomAssetByTriggerGroup(messageContent.slice(1), assets);
    if (randomTriggerAsset) {
      await sendMatchedAssetResponse(message, randomTriggerAsset, assets, messageContent.slice(1));
      return;
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

    if (messageContent.startsWith("!paywall")) {
      const url = messageContent.split("!paywall ")[1];
      if ("string" === typeof url && "" !== url.trim()) {
        const candidateUrl = url.trim().startsWith("http") ? url.trim() : `https://${url.trim()}`;
        let cleanUrl: string;
        try {
          cleanUrl = assertSafeRequestUrl(candidateUrl).toString();
        } catch (error: unknown) {
          if (error instanceof UnsafeUrlError) {
            await message.channel.send("Ungültige URL. Bitte eine öffentliche http(s)-URL angeben.").catch(sendError => {
              logger.log(
                "error",
                `Error sending paywall unsafe-URL response: ${sendError}`,
              );
            });
            return;
          }

          throw error;
        }

        const workingMessage = await message.channel.send(
          `Suche nach Paywall-Bypass für <${cleanUrl}>... Das kann bis zu 60 Sekunden dauern.`,
        ).catch(error => {
          logger.log(
            "error",
            `Error sending paywall working message: ${error}`,
          );
          return undefined;
        });

        try {
          const result: PaywallResult = await getPaywallLinks(cleanUrl, paywallAssets ?? []);

          if (true === result.nofix) {
            const noFixResponse = `Für diese Seite ist leider kein Paywall-Bypass bekannt.`;
            if (undefined !== workingMessage) {
              await workingMessage.edit(noFixResponse);
            } else {
              await message.channel.send(noFixResponse);
            }
          } else {
            const lines: string[] = [];
            if (true === result.isDefault) {
              lines.push("Unbekannte Seite — versuche allgemeine Services:\n");
            }

            for (const service of result.services) {
              if (true === service.available) {
                lines.push(`✅ **${service.name}**: <${service.url}>`);
              } else {
                lines.push(`❓ **${service.name}**: <${service.url}>`);
              }
            }

            const response = lines.join("\n");
            if (undefined !== workingMessage) {
              await workingMessage.edit(response);
            } else {
              await message.channel.send(response);
            }
          }
        } catch (error: unknown) {
          logger.log(
            "error",
            `Error processing paywall trigger: ${error}`,
          );
          const errorResponse = "Fehler beim Verarbeiten der Anfrage. Bitte später erneut versuchen.";
          if (undefined !== workingMessage) {
            await workingMessage.edit(errorResponse);
          } else {
            await message.channel.send(errorResponse);
          }
        }
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
