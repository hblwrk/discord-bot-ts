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

export class User extends BaseAsset {
  title: string;

  getTitle() {
    return this.title;
  }
}

export class UserQuoteAsset extends BaseAsset {
  user: string;
  fileName: string;
  title: string;
  location: string;
  locationId: string;

  getUser() {
    return this.user;
  }

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

export class ImageAsset extends BaseAsset {
  fileName: string;
  title: string;
  location: string;
  locationId: string;
  text: string;
  hastext: boolean;

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

  getText() {
    return this.text;
  }

  hasText() {
    return Boolean(this.text);
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
      switch (type) {
        case "image": {
          newAsset = plainToClass(ImageAsset, jsonObject);
          break;
        }

        case "text": {
          newAsset = plainToClass(TextAsset, jsonObject);
          break;
        }

        case "emoji": {
          newAsset = plainToClass(EmojiAsset, jsonObject);
          break;
        }

        case "user": {
          newAsset = plainToClass(User, jsonObject);
          break;
        }

        case "userquote": {
          newAsset = plainToClass(UserQuoteAsset, jsonObject);
          break;
        }

        default: {
          break;
        }
      }

      newAssets.push(newAsset);
    }

    return newAssets;
  } catch (error: unknown) {
    console.log(error);
  }
}
