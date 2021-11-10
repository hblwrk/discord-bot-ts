import axios from "axios";
import {Buffer} from "node:buffer";

export async function getMnc() {
  const getResponse = axios.get("https://share.thomsonreuters.com/assets/newsletters/Morning_News_Call/MNC_US.pdf", {
    responseType: "arraybuffer",
  });

  const dataResponse = Buffer.from((await getResponse).data, "binary");

  return dataResponse;
}
