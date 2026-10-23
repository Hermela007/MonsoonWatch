// Single shared MongoDB connection for the API and scripts.
import { MongoClient, type Db } from "mongodb";
import { env } from "../env";

let clientPromise: Promise<MongoClient> | null = null;

function connect(): Promise<MongoClient> {
  if (!env.mongodbUri) throw new Error("MONGODB_URI is not set. Copy .env.example to .env and fill it in.");
  if (env.mongodbUri.includes("<db_password>")) throw new Error("MONGODB_URI still contains <db_password>. Put your database password in .env.");
  if (!clientPromise) {
    const client = new MongoClient(env.mongodbUri, { appName: "monsoonwatch" });
    clientPromise = client.connect().catch((err) => {
      clientPromise = null; // allow a retry after a failed connect
      throw err;
    });
  }
  return clientPromise;
}

export async function getDb(): Promise<Db> {
  return (await connect()).db(env.mongodbDb);
}

export async function closeDb(): Promise<void> {
  if (!clientPromise) return;
  const client = await clientPromise;
  clientPromise = null;
  await client.close();
}
