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
    return this.getType;
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

  getlocationId() {
    return this.locationId;
  }
}

export function getAssets() {
  try {
    const assetFiles = fs.readdirSync(directory).filter(file => file.endsWith(fileExtension));
    let newAssets = [];
    for (const element of assetFiles) {
      const jsonObjects = yaml.load(fs.readFileSync(`${directory}/${element}`, "utf-8"));
      for (const jsonObject of jsonObjects) {
        const newAsset = plainToClass(Asset, jsonObject);
        newAsset.type = element.replace(fileExtension, "");
        newAssets.push(newAsset);
      }
    }
    return newAssets;
  } catch (error: unknown) {
    console.log(error);
  }
}
