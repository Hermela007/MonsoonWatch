import Fastify from "fastify";
import { registerErrorHandlers } from "./errors";
import { healthRoutes } from "./routes/health";
import { regionRoutes } from "./routes/regions";
import { stationRoutes } from "./routes/stations";
import { streamRoutes } from "./routes/stream";

export function buildServer() {
  const app = Fastify({ logger: true });
  registerErrorHandlers(app);
  app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(streamRoutes);
      await api.register(regionRoutes);
      await api.register(stationRoutes);
      // C: regions, stations, readings, hazards, search, reports, replay, saint routes go here.
      // B: agent, alerts, voice routes go here.
    },
    { prefix: "/api" },
  );
  return app;
}
