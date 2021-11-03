import {plainToClass} from "class-transformer";
import yaml from "js-yaml";
import fs from "node:fs";

const directory = "./assets";
const fileExtension = ".yaml";

class BaseAsset {
  name: string;
  trigger: string;

  getName() {
    return this.name;
  }

  getTrigger() {
    return this.trigger;
  }
}

export class ImageAsset extends BaseAsset {
  fileName: string;
  title: string;
  location: string;
  locationId: string;

  getFileName() {
    return this.fileName;
  }

  getTitle() {
    return this.title;
  }

  getLocation() {
    return this.location;
  }

  getLocationId() {
    return this.locationId;
  }
}

export class TextAsset extends BaseAsset {
  response: string;
  title: string;

  getResponse() {
    return this.response;
  }

  getTitle() {
    return this.title;
  }
}

export class EmojiAsset extends BaseAsset {
  response: string;

  getResponse() {
    return this.response;
  }
}

export function getAssets(type: string) {
  try {
    const newAssets = [];
    const jsonObjects = yaml.load(fs.readFileSync(`${directory}/${type}${fileExtension}`, "utf-8"));
    for (const jsonObject of jsonObjects) {
      let newAsset = {};
      if ("image" === type) {
        newAsset = plainToClass(ImageAsset, jsonObject);
      } else if ("text" === type) {
        newAsset = plainToClass(TextAsset, jsonObject);
      } else if ("emoji" === type) {
        newAsset = plainToClass(EmojiAsset, jsonObject);
      }

      newAssets.push(newAsset);
    }
    return newAssets;
  } catch (error: unknown) {
    console.log(error);
  }
}
