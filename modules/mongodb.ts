import * as mongoDB from "mongodb";
import {readSecret} from "./secrets";
import {getLogger} from "./logging";

const logger = getLogger();

export const collections: {
  bans?: mongoDB.Collection;
} = {};

export async function connectToDatabase() {
  const connectionString = `mongodb+srv://${readSecret("mongodb_username")}:${readSecret("mongodb_password")}@${readSecret("mongodb_host")}`;

  const client: mongoDB.MongoClient = new mongoDB.MongoClient(connectionString);
  await client.connect();

  const db: mongoDB.Db = client.db(readSecret("mongodb_database"));

  const banCollection: mongoDB.Collection = db.collection("bans");

  collections.bans = banCollection;

  logger.log(
    "info",
    `Successfully connected to database: ${db.databaseName}.`,
  );
}

export async function addToDatabase() {
  const newBan: Ban = new Ban("123", "foo", 1234);
  newBan.user = "1234";
  const result = await collections.bans.insertOne(newBan);
  console.log(result);
}

export default class Ban {
  constructor(
    public user: string,
    public reason: string,
    public expiry: number,
    public id?: mongoDB.ObjectId,
  ) {}
}
