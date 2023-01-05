/* eslint-disable import/extensions */
import {Buffer} from "node:buffer";
import axios from "axios";
import moment from "moment-timezone";
import {getLogger} from "./logging";

const logger = getLogger();

export async function getMnc() {
  let dataResponse;

  const todayDate = moment.tz("Europe/Berlin").format("MMDDYYYY");
  try {
    const getResponse = axios.get(`https://share.refinitiv.com/assets/newsletters/Morning_News_Call/MNCGeneric_US_${todayDate}.pdf`, {
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
