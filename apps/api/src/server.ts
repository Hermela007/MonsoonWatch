import compress from "@fastify/compress";
import Fastify from "fastify";
import { registerErrorHandlers } from "./errors";
import { geoRoutes } from "./routes/geo";
import { healthRoutes } from "./routes/health";
import { regionRoutes } from "./routes/regions";
import { stationRoutes } from "./routes/stations";
import { streamRoutes } from "./routes/stream";

export function buildServer() {
  const app = Fastify({ logger: true });
  registerErrorHandlers(app);
  // gzip/brotli for big JSON (/regions/:id/geo is ~30 MB raw). SSE is unaffected: /stream hijacks the reply.
  app.register(compress, { threshold: 1024 });
  app.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(streamRoutes);
      await api.register(regionRoutes);
      await api.register(geoRoutes);
      await api.register(stationRoutes);
      // C: regions, stations, readings, hazards, search, reports, replay, saint routes go here.
      // B: agent, alerts, voice routes go here.
    },
    { prefix: "/api" },
  );
  return app;
}
