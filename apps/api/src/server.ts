import compress from "@fastify/compress";
import Fastify from "fastify";
import { withDbRetry } from "./db/client";
import { registerErrorHandlers } from "./errors";
import { agentRoutes } from "./routes/agent";
import { alertRoutes } from "./routes/alerts";
import { geoRoutes } from "./routes/geo";
import { healthRoutes } from "./routes/health";
import { regionRoutes } from "./routes/regions";
import { stationRoutes } from "./routes/stations";
import { streamRoutes } from "./routes/stream";

export function buildServer() {
  // forceCloseConnections: open SSE clients would otherwise keep app.close() waiting on shutdown.
  const app = Fastify({ logger: true, forceCloseConnections: true });
  registerErrorHandlers(app);
  // Every GET route (any workstream) is retried once on a transient MongoDB connection error.
  // Non-GET routes are never retried, so writes like alert approval can't happen twice.
  // The SSE stream hijacks its reply, so it is excluded.
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!methods.every((m) => m === "GET" || m === "HEAD") || route.url.endsWith("/stream")) return;
    const handler = route.handler;
    route.handler = function (req, reply) {
      return withDbRetry(
        async () => handler.call(this, req, reply),
        (err) => req.log.warn({ err }, "transient MongoDB error — retrying once"),
      );
    };
  });
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
      await api.register(agentRoutes);
      await api.register(alertRoutes);
    },
    { prefix: "/api" },
  );
  return app;
}
