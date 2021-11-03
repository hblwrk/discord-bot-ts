import {plainToClass} from "class-transformer";
import yaml from "js-yaml";
import fs from "node:fs";

const directory = "./assets";
const fileExtension = ".yaml";

export class Asset {
  name: string;
  type: string;
  fileName: string;
  title: string;
  location: string;
  locationId: string;

  getName() {
    return this.name;
  }

  getType() {
    return this.type;
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

export function getAssets(type: string) {
  try {
    const newAssets = [];
    const jsonObjects = yaml.load(fs.readFileSync(`${directory}/${type}${fileExtension}`, "utf-8"));
    for (const jsonObject of jsonObjects) {
      const newAsset = plainToClass(Asset, jsonObject);
      newAsset.type = type;
      newAssets.push(newAsset);
    }
    return newAssets;
  } catch (error: unknown) {
    console.log(error);
  }
}
