import {plainToClass} from "class-transformer";
import yaml from "js-yaml";
import fs from "node:fs";
import {getFromDracoon} from "./dracoon-downloader";
import {getLogger} from "./logging";
import {readSecret} from "./secrets";

const directory = "./assets";
const fileExtension = ".yaml";
const logger = getLogger();

class BaseAsset {
  private _name: string;
  private _trigger: string;
  private _triggerRegex: string;

  public get name() {
    return this._name;
  }

  public set name(name: string) {
    this._name = name;
  }

  public get trigger() {
    return this._trigger;
  }

  public set trigger(trigger: string) {
    this._trigger = trigger;
  }

  public get triggerRegex() {
    return this._triggerRegex;
  }

  public set triggerRegex(triggerRegex: string) {
    this._triggerRegex = triggerRegex;
  }
}

export class MarketDataAsset extends BaseAsset {
  private _botToken: string;
  private _botTokenReference: string;
  private _botClientId: string;
  private _botClientIdReference: string;
  private _botName: string;
  private _id: number;
  private _suffix: string;
  private _unit: string;
  private _decimals: number;
  private _lastUpdate: number;
  private _order: number;

  public get botToken() {
    return this._botToken;
  }

  public set botToken(botToken: string) {
    this._botToken = botToken;
  }

  public get botTokenReference() {
    return this._botTokenReference;
  }

  public set botTokenReference(botTokenReference: string) {
    this._botTokenReference = botTokenReference;
  }

  public get botClientId() {
    return this._botClientId;
  }

  public set botClientId(botClientId: string) {
    this._botClientId = botClientId;
  }

  public get botClientIdReference() {
    return this._botClientIdReference;
  }

  public set botClientIdReference(botClientIdReference: string) {
    this._botClientIdReference = botClientIdReference;
  }

  public get botName() {
    return this._botName;
  }

  public set botName(botName: string) {
    this._botName = botName;
  }

  public get id() {
    return this._id;
  }

  public set id(id: number) {
    this._id = id;
  }

  public get suffix() {
    return this._suffix;
  }

  public set suffix(suffix: string) {
    this._suffix = suffix;
  }

  public get unit() {
    return this._unit;
  }

  public set unit(unit: string) {
    this._unit = unit;
  }

  public get decimals() {
    return this._decimals;
  }

  public set decimals(decimals: number) {
    this._decimals = decimals;
  }

  public get lastUpdate() {
    return this._lastUpdate;
  }

  public set lastUpdate(lastUpdate: number) {
    this._lastUpdate = lastUpdate;
  }

  public get order() {
    return this._order;
  }

  public set order(order: number) {
    this._order = order;
  }
}

export class RoleAsset extends BaseAsset {
  private _triggerReference: string;
  private _id: string;
  private _idReference: string;
  private _emoji: string;

  public get triggerReference() {
    return this._triggerReference;
  }

  public set triggerReference(triggerReference: string) {
    this._triggerReference = triggerReference;
  }

  public get id() {
    return this._id;
  }

  public set id(id: string) {
    this._id = id;
  }

  public get idReference() {
    return this._idReference;
  }

  public set idReference(idReference: string) {
    this._idReference = idReference;
  }

  public get emoji() {
    return this._emoji;
  }

  public set emoji(emoji: string) {
    this._emoji = emoji;
  }
}

export class UserAsset extends BaseAsset {
  private _title: string;

  public get title() {
    return this._title;
  }

  public set title(title: string) {
    this._title = title;
  }
}

export class UserQuoteAsset extends BaseAsset {
  private _user: string;
  private _fileName: string;
  private _title: string;
  private _location: string;
  private _locationId: string;
  private _fileContent: any;

  public get user() {
    return this._user;
  }

  public set user(user: string) {
    this._user = user;
  }

  public get fileName() {
    return this._fileName;
  }

  public set fileName(fileName: string) {
    this._fileName = fileName;
  }

  public get title() {
    return this._title;
  }

  public set title(title: string) {
    this._title = title;
  }

  public get location() {
    return this._location;
  }

  public set location(location: string) {
    this._location = location;
  }

  public get locationId() {
    return this._locationId;
  }

  public set locationId(locationId: string) {
    this._locationId = locationId;
  }

  public get fileContent() {
    return this._fileContent;
  }

  public set fileContent(buffer: any) {
    this._fileContent = buffer;
  }
}

export class ImageAsset extends BaseAsset {
  private _fileName: string;
  private _title: string;
  private _location: string;
  private _locationId: string;
  private _text: string;
  private _fileContent: any;

  public get fileName() {
    return this._fileName;
  }

  public set fileName(fileName: string) {
    this._fileName = fileName;
  }

  public get title() {
    return this._title;
  }

  public set title(title: string) {
    this._title = title;
  }

  public get location() {
    return this._location;
  }

  public set location(location: string) {
    this._location = location;
  }

  public get locationId() {
    return this._locationId;
  }

  public set locationId(locationId: string) {
    this._locationId = locationId;
  }

  public get text() {
    return this._text;
  }

  public set text(text: string) {
    this._text = text;
  }

  public get hasText() {
    return Boolean(this._text);
  }

  public get fileContent() {
    return this._fileContent;
  }

  public set fileContent(buffer: any) {
    this._fileContent = buffer;
  }
}

export class TextAsset extends BaseAsset {
  private _response: string;
  private _title: string;

  public get response() {
    return this._response;
  }

  public set response(response: string) {
    this._response = response;
  }

  public get title() {
    return this._title;
  }

  public set title(title: string) {
    this._title = title;
  }
}

export class EmojiAsset extends BaseAsset {
  private _response: string;

  public get response() {
    return this._response;
  }

  public set response(response: string) {
    this._response = response;
  }
}

export async function getGenericAssets() {
  const assetTypes = ["emoji", "image", "text", "user", "userquote"];
  const newAssets = [];
  for (const assetType of assetTypes) {
    const assets = await getAssets(assetType);
    for (const asset of assets) {
      newAssets.push(asset);
    }
  }

  return newAssets;
}

export async function getAssets(type: string): Promise<any[]> {
  try {
    const newAssets = [];
    const jsonObjects = yaml.load(fs.readFileSync(`${directory}/${type}${fileExtension}`, "utf-8"));
    for (const jsonObject of jsonObjects) {
      switch (type) {
        case "image": {
          const newAsset = plainToClass(ImageAsset, jsonObject);
          if (true === newAsset.hasOwnProperty("_location")) {
            if ("dracoon" === newAsset.location) {
              newAsset.fileContent = await getFromDracoon(readSecret("dracoon_password"), newAsset.locationId);
            }
          }

          newAssets.push(newAsset);
          break;
        }

        case "text": {
          const newAsset = plainToClass(TextAsset, jsonObject);
          newAssets.push(newAsset);
          break;
        }

        case "emoji": {
          const newAsset = plainToClass(EmojiAsset, jsonObject);
          newAssets.push(newAsset);
          break;
        }

        case "user": {
          const newAsset = plainToClass(UserAsset, jsonObject);
          newAssets.push(newAsset);
          break;
        }

        case "userquote": {
          const newAsset = plainToClass(UserQuoteAsset, jsonObject);
          if (true === newAsset.hasOwnProperty("_location")) {
            if ("dracoon" === newAsset.location) {
              newAsset.fileContent = await getFromDracoon(readSecret("dracoon_password"), newAsset.locationId);
            }
          }
          newAssets.push(newAsset);
          break;
        }

        case "whatis": {
          const newAsset = plainToClass(ImageAsset, jsonObject);
          if (true === newAsset.hasOwnProperty("_location")) {
            if ("dracoon" === newAsset.location) {
              newAsset.fileContent = await getFromDracoon(readSecret("dracoon_password"), newAsset.locationId);
            }
          }

          newAssets.push(newAsset);
          break;
        }

        case "marketdata": {
          const newAsset = plainToClass(MarketDataAsset, jsonObject);
          newAsset.botToken = readSecret(newAsset.botTokenReference);
          newAsset.botClientId = readSecret(newAsset.botClientIdReference);
          newAssets.push(newAsset);
          break;
        }

        case "role": {
          const newAsset = plainToClass(RoleAsset, jsonObject);
          newAsset.trigger = readSecret(newAsset.triggerReference);
          newAsset.id = readSecret(newAsset.idReference);
          newAssets.push(newAsset);
          break;
        }

        default: {
          break;
        }
      }
    }

    return newAssets;
  } catch (error: unknown) {
    logger.log(
      "error",
      error,
    );
  }
}

export function getAssetByName(name: string, assets: any) {
  for (const asset of assets) {
    if (name === asset.name) {
      return asset;
    }
  }
}
