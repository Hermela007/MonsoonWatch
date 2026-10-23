// `pnpm db:ping` — checks that .env can reach Atlas.
import { env } from "../env";
import { closeDb, getDb } from "./client";

const safe = (text: string) => (env.mongodbUri ? text.replaceAll(env.mongodbUri, "<MONGODB_URI>") : text);

try {
  const db = await getDb();
  await db.command({ ping: 1 });
  const info = await db.admin().command({ buildInfo: 1 });
  console.log(`✅ Connected to Atlas — MongoDB ${info.version}, database "${env.mongodbDb}"`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`❌ Could not connect: ${safe(message)}`);
  if (/auth/i.test(message)) console.error("   → Check the password in .env (Atlas → Database & Network Access).");
  if (/timed out|ECONNREFUSED|ENOTFOUND|whitelist|IP/i.test(message)) console.error("   → Check Network Access allows your IP (0.0.0.0/0 for the weekend).");
  process.exitCode = 1;
} finally {
  await closeDb();
}
