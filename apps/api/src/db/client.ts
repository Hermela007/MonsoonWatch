// Single shared MongoDB connection for the API and scripts.
import { MongoClient, type Db } from "mongodb";
import { env } from "../env";

let clientPromise: Promise<MongoClient> | null = null;

function connect(): Promise<MongoClient> {
  if (!env.mongodbUri) throw new Error("MONGODB_URI is not set. Copy .env.example to .env and fill it in.");
  if (env.mongodbUri.includes("<db_password>")) throw new Error("MONGODB_URI still contains <db_password>. Put your database password in .env.");
  if (!clientPromise) {
    const client = new MongoClient(env.mongodbUri, {
      appName: "monsoonwatch",
      // Close idle pooled connections ourselves before Atlas/the network drops them silently
      // (seen as a one-off 500 after the API sat idle).
      maxIdleTimeMS: 60_000,
      serverSelectionTimeoutMS: 10_000,
      retryReads: true,
      retryWrites: true,
    });
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

const TRANSIENT_NAMES = new Set([
  "MongoNetworkError",
  "MongoNetworkTimeoutError",
  "MongoServerSelectionError",
  "MongoPoolClearedError",
  "MongoTopologyClosedError",
]);

/** True for connection-level errors that are safe to retry (not query or validation errors). */
export function isTransientDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const labelled = err as Error & { hasErrorLabel?: (label: string) => boolean };
  return (
    TRANSIENT_NAMES.has(err.name) ||
    labelled.hasErrorLabel?.("RetryableReadError") === true ||
    labelled.hasErrorLabel?.("ResetPool") === true
  );
}

/** Run `fn`; if it fails with a transient connection error, wait briefly and try exactly once more. */
export async function withDbRetry<T>(fn: () => Promise<T>, onRetry?: (err: unknown) => void): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isTransientDbError(err)) throw err;
    onRetry?.(err);
    await new Promise((r) => setTimeout(r, 250));
    return fn();
  }
}
