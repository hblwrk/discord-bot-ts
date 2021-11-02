import {plainToClass} from "class-transformer";

import yaml from "js-yaml";
import fs from "node:fs";

const directory = "./assets";

export class Asset {
  name: string;
  fileName: string;
  title: string;
  location: string;
  locationId: string;

  getName() {
    return this.name;
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
    const assetFiles = fs.readdirSync(directory).filter(file => file.endsWith(".yaml"));
    console.log(assetFiles);
    let assets = {};
    assetFiles.forEach(element => {
      yaml.load(fs.readFileSync(`${directory}/${element}`, 'utf8')).then((assets: Object[]) => {
        const realAssets = plainToClass(Asset, assets)
      });
    });
    console.log(assets);
  } catch (error) {
    console.log(error);
  }
}
