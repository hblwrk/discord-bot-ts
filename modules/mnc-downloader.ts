import {Buffer} from "node:buffer";
import axios from "axios";
import moment from "moment-timezone";

export async function getMnc() {
  const todayDate = moment.tz("Europe/Berlin").format("MMDDYYYY");
  const getResponse = axios.get(`https://share.refinitiv.com/assets/newsletters/Morning_News_Call/MNCGeneric_US_${todayDate}.pdf`, {
    responseType: "arraybuffer",
  });

  const dataResponse = Buffer.from((await getResponse).data, "binary");

  return dataResponse;
}
