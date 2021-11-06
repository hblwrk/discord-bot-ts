import axios from "axios";

export async function getFromDracoon(secret: string, downloadToken: string) {
  const data = JSON.stringify({
    password: secret,
  });
  const config = {
    headers: {
      "Content-Type": "application/json",
    },
  };
  const urlResponse = await axios.post(`https://dracoon.team/api/v4/public/shares/downloads/${downloadToken}`, data, config);
  const getResponse = axios.get(urlResponse.data.downloadUrl, {
    responseType: "arraybuffer",
  });
  const dataResponse = Buffer.from((await getResponse).data, "binary");

  return dataResponse;
}
