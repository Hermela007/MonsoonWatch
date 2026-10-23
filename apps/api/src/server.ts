import Fastify from "fastify";
import { healthRoutes } from "./routes/health";
import { streamRoutes } from "./routes/stream";

export function buildServer() {
  const app = Fastify({ logger: true });
  app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(streamRoutes);
      // C: regions, stations, readings, hazards, search, reports, replay, saint routes go here.
      // B: agent, alerts, voice routes go here.
    },
    { prefix: "/api" },
  );
  return app;
}
