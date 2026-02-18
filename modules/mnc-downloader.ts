/* eslint-disable import/extensions */
import {Buffer} from "node:buffer";
import moment from "moment-timezone";
import {getLogger} from "./logging.js";
import {getWithRetry} from "./http-retry.js";

const logger = getLogger();

export async function getMnc() {
  let dataResponse;

  const todayDate = moment.tz("Europe/Berlin").format("MMDDYYYY");
  try {
    const getResponse = getWithRetry(`https://share.refinitiv.com/assets/newsletters/Morning_News_Call/MNCGeneric_US_${todayDate}.pdf`, {
      responseType: "arraybuffer",
    });

    dataResponse = Buffer.from((await getResponse).data, "binary");
  } catch (error) {
    logger.log(
      "error",
      `Loading MNC failed: ${error}`,
    );
  }

  return dataResponse;
}
