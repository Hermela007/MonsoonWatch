import type { FastifyInstance } from "fastify";
import { env } from "../env";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ ok: true, mock: env.mock, regionId: env.regionId }));
}
