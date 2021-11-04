import https from "node:https";
import {Buffer} from "node:buffer";

export function getFromReuters(cb) {
  const data = [];
  const options = {
    hostname: "share.thomsonreuters.com",
    port: 443,
    path: "/assets/newsletters/Morning_News_Call/MNC_US.pdf",
    method: "GET",
  };

  const request = https.request(options, response => {
    response.on("data", chunk => {
      data.push(chunk);
    }).on("end", () => {
      const buffer: unknown = Buffer.concat(data);
      cb(buffer);
    });
  }).on("error", error => {
    console.log("Download error:", error);
  });
  request.end();
}
