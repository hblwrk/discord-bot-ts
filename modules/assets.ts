import {plainToInstance} from "class-transformer";
import yaml from "js-yaml";
import fs from "node:fs";
import {getFromDracoon} from "./dracoon-downloader.js";
import {getLogger} from "./logging.js";
import {readSecret} from "./secrets.js";

const directory = "./assets";
const fileExtension = ".yaml";
const logger = getLogger();

class BaseAsset {
  private _name = "";
  private _trigger: string[] = [];
  private _triggerRegex: unknown = "";

  public get name(): string {
    return this._name;
  }

  public set name(name: string) {
    this._name = name;
  }

  public get trigger(): string[] {
    return this._trigger;
  }

  public set trigger(trigger: unknown) {
    if (Array.isArray(trigger)) {
      this._trigger = trigger.filter((value): value is string => "string" === typeof value);
      return;
    }

    this._trigger = "string" === typeof trigger ? [trigger] : [];
  }

  public get triggerRegex(): unknown {
    return this._triggerRegex;
  }

  public set triggerRegex(triggerRegex: unknown) {
    this._triggerRegex = triggerRegex;
  }
}

export class MarketDataAsset extends BaseAsset {
  private _botToken = "";
  private _botTokenReference = "";
  private _botClientId = "";
  private _botClientIdReference = "";
  private _botName = "";
  private _id = 0;
  private _suffix = "";
  private _unit = "";
  private _marketHours = "";
  private _decimals = 0;
  private _lastUpdate = 0;
  private _order = 0;

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

  public get marketHours() {
    return this._marketHours;
  }

  public set marketHours(marketHours: string) {
    this._marketHours = marketHours;
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
  private _triggerReference = "";
  private _id = "";
  private _idReference = "";
  private _emoji = "";

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

export class CalendarReminderAsset extends BaseAsset {
  private _eventNameSubstrings: string[] = [];
  private _countryFlags: string[] = [];
  private _roleId = "";
  private _roleIdReference = "";
  private _minutesBefore = 0;

  public get eventNameSubstrings() {
    return this._eventNameSubstrings;
  }

  public set eventNameSubstrings(eventNameSubstrings: string[]) {
    this._eventNameSubstrings = eventNameSubstrings;
  }

  public get countryFlags() {
    return this._countryFlags;
  }

  public set countryFlags(countryFlags: string[]) {
    this._countryFlags = countryFlags;
  }

  public get roleId() {
    return this._roleId;
  }

  public set roleId(roleId: string) {
    this._roleId = roleId;
  }

  public get roleIdReference() {
    return this._roleIdReference;
  }

  public set roleIdReference(roleIdReference: string) {
    this._roleIdReference = roleIdReference;
  }

  public get minutesBefore() {
    return this._minutesBefore;
  }

  public set minutesBefore(minutesBefore: number) {
    this._minutesBefore = minutesBefore;
  }
}

export class EarningsReminderAsset extends BaseAsset {
  private _tickerSymbols: string[] = [];
  private _roleId = "";
  private _roleIdReference = "";

  public get tickerSymbols() {
    return this._tickerSymbols;
  }

  public set tickerSymbols(tickerSymbols: string[]) {
    this._tickerSymbols = tickerSymbols;
  }

  public get roleId() {
    return this._roleId;
  }

  public set roleId(roleId: string) {
    this._roleId = roleId;
  }

  public get roleIdReference() {
    return this._roleIdReference;
  }

  public set roleIdReference(roleIdReference: string) {
    this._roleIdReference = roleIdReference;
  }
}

export class UserAsset extends BaseAsset {
  private _title = "";

  public get title() {
    return this._title;
  }

  public set title(title: string) {
    this._title = title;
  }
}

export class UserQuoteAsset extends BaseAsset {
  private _user = "";
  private _fileName = "";
  private _title = "";
  private _location = "";
  private _locationId = "";
  private _fileContent: Buffer | undefined;

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

  public set fileContent(buffer: Buffer | undefined) {
    this._fileContent = buffer;
  }
}

export class ImageAsset extends BaseAsset {
  private _fileName = "";
  private _title = "";
  private _location = "";
  private _locationId = "";
  private _text = "";
  private _fileContent: Buffer | undefined;

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

  public set fileContent(buffer: Buffer | undefined) {
    this._fileContent = buffer;
  }
}

export class TextAsset extends BaseAsset {
  private _response = "";
  private _title = "";

  public get response(): string {
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
  private _response: string[] = [];

  public get response() {
    return this._response;
  }

  public set response(response: unknown) {
    if (Array.isArray(response)) {
      this._response = response.filter((value): value is string => "string" === typeof value);
      return;
    }

    this._response = "string" === typeof response ? [response] : [];
  }
}

export class PaywallAsset {
  private _name = "";
  private _domains: string[] = [];
  private _services: string[] = [];
  private _nofix = false;
  private _subdomainWildcard = false;

  public get name() {
    return this._name;
  }

  public set name(name: string) {
    this._name = name;
  }

  public get domains() {
    return this._domains;
  }

  public set domains(domains: string[]) {
    this._domains = domains;
  }

  public get services() {
    return this._services;
  }

  public set services(services: string[]) {
    this._services = services;
  }

  public get nofix() {
    return this._nofix;
  }

  public set nofix(nofix: boolean) {
    this._nofix = nofix;
  }

  public get subdomainWildcard() {
    return this._subdomainWildcard;
  }

  public set subdomainWildcard(subdomainWildcard: boolean) {
    this._subdomainWildcard = subdomainWildcard;
  }
}

async function populateDracoonAsset(type: string, asset: ImageAsset | UserQuoteAsset): Promise<void> {
  if (false === asset.hasOwnProperty("_location") || "dracoon" !== asset.location) {
    return;
  }

  try {
    asset.fileContent = await getFromDracoon(readSecret("dracoon_password"), asset.locationId);
  } catch (error: unknown) {
    (asset as any).downloadFailed = true;
    const assetId = asset.name ?? asset.fileName ?? asset.locationId ?? "unknown";
    logger.log(
      "warn",
      `Failed to download ${type} asset "${assetId}" from DRACOON: ${error}`,
    );
  }
}

export async function getGenericAssets() {
  const assetTypes = ["emoji", "image", "text", "user", "userquote"];
  const newAssets = [];
  for (const assetType of assetTypes) {
    const assets = await getAssets(assetType) ?? [];
    for (const asset of assets) {
      newAssets.push(asset);
    }
  }

  return newAssets;
}

export async function getAssets(type: string): Promise<any[]> {
  try {
    const newAssets = [];
    const yamlObjects = yaml.load(fs.readFileSync(`${directory}/${type}${fileExtension}`, "utf-8"));
    const jsonObjects = Array.isArray(yamlObjects) ? yamlObjects : [];
    for (const jsonObject of jsonObjects) {
      switch (type) {
        case "image": {
          const newAsset = plainToInstance(ImageAsset, jsonObject);
          await populateDracoonAsset(type, newAsset);
          newAssets.push(newAsset);
          break;
        }

        case "text": {
          const newAsset = plainToInstance(TextAsset, jsonObject);
          newAssets.push(newAsset);
          break;
        }

        case "emoji": {
          const newAsset = plainToInstance(EmojiAsset, jsonObject);
          newAssets.push(newAsset);
          break;
        }

        case "user": {
          const newAsset = plainToInstance(UserAsset, jsonObject);
          newAssets.push(newAsset);
          break;
        }

        case "userquote": {
          const newAsset = plainToInstance(UserQuoteAsset, jsonObject);
          await populateDracoonAsset(type, newAsset);
          newAssets.push(newAsset);
          break;
        }

        case "whatis": {
          const newAsset = plainToInstance(ImageAsset, jsonObject);
          await populateDracoonAsset(type, newAsset);
          newAssets.push(newAsset);
          break;
        }

        case "marketdata": {
          const newAsset = plainToInstance(MarketDataAsset, jsonObject);
          newAsset.botToken = readSecret(newAsset.botTokenReference);
          newAsset.botClientId = readSecret(newAsset.botClientIdReference);
          newAssets.push(newAsset);
          break;
        }

        case "role": {
          const newAsset = plainToInstance(RoleAsset, jsonObject);
          newAsset.trigger = readSecret(newAsset.triggerReference);
          newAsset.id = readSecret(newAsset.idReference);
          newAssets.push(newAsset);
          break;
        }

        case "calendarreminder": {
          const newAsset = plainToInstance(CalendarReminderAsset, jsonObject);
          newAsset.roleId = readSecret(newAsset.roleIdReference);
          newAssets.push(newAsset);
          break;
        }

        case "earningsreminder": {
          const newAsset = plainToInstance(EarningsReminderAsset, jsonObject);
          newAsset.roleId = readSecret(newAsset.roleIdReference);
          newAssets.push(newAsset);
          break;
        }

        case "paywall": {
          const newAsset = plainToInstance(PaywallAsset, jsonObject);
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
      `Error creating assets: ${error}`,
    );

    return [];
  }
}

export function getAssetByName(name: string, assets: any[]): any | undefined {
  for (const asset of assets) {
    if (name === asset.name) {
      return asset;
    }
  }

  return undefined;
}
