import {Buffer} from "node:buffer";
import moment from "moment-timezone";
import {getLogger} from "./logging.ts";
import {getWithRetry} from "./http-retry.ts";

const logger = getLogger();

export async function getMnc(): Promise<Buffer | undefined> {
  const todayDate = moment.tz("Europe/Berlin").format("MMDDYYYY");
  try {
    const getResponse = await getWithRetry<ArrayBuffer>(`https://share.refinitiv.com/assets/newsletters/Morning_News_Call/MNCGeneric_US_${todayDate}.pdf`, {
      responseType: "arraybuffer",
    });

    return Buffer.from(getResponse.data);
  } catch (error) {
    logger.log(
      "error",
      `Loading MNC failed: ${error}`,
    );
  }

  return undefined;
}
