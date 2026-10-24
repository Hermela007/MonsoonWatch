// Loads the repo-root .env (if present) and exposes typed config.
// Variables already set in the shell win over .env, so `MOCK=1 pnpm dev` works.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

export const env = {
  port: Number(process.env.PORT || process.env.API_PORT || 8787),
  publicDemo: process.env.PUBLIC_DEMO === "1",
  mock: process.env.MOCK === "1",
  regionId: process.env.REGION_ID || "kelantan",
  mongodbUri: process.env.MONGODB_URI || "",
  mongodbDb: process.env.MONGODB_DB || "monsoonwatch",
  // Atlas Stream Processing workspace (no credentials in it: `pnpm db:stream` reuses MONGODB_URI's user).
  streamProcessingUri: process.env.STREAM_PROCESSING_URI || "",
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  voyageApiKey: process.env.VOYAGE_API_KEY || "",
};
