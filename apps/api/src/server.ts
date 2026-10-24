import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import compress from "@fastify/compress";
import Fastify from "fastify";
import { withDbRetry } from "./db/client";
import { env } from "./env";
import { HttpError, registerErrorHandlers } from "./errors";
import { agentRoutes } from "./routes/agent";
import { alertRoutes } from "./routes/alerts";
import { geoRoutes } from "./routes/geo";
import { hazardsRoutes } from "./routes/hazards";
import { healthRoutes } from "./routes/health";
import { regionRoutes } from "./routes/regions";
import { replayRoutes } from "./routes/replay";
import { saintRoutes } from "./routes/saint";
import { stationRoutes } from "./routes/stations";
import { streamRoutes } from "./routes/stream";

export function buildServer(opts: { webRoot?: string; serveWeb?: boolean; publicDemo?: boolean } = {}) {
  // forceCloseConnections: open SSE clients would otherwise keep app.close() waiting on shutdown.
  const app = Fastify({ logger: true, forceCloseConnections: true });
  registerErrorHandlers(app);
  const publicDemo = opts.publicDemo ?? env.publicDemo;
  app.addHook("onRequest", async (req) => {
    if (publicDemo && req.url.split("?")[0].startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      throw new HttpError(403, "bad_request", "Operator actions are restricted on this public demo. Use the scripted walkthrough to explore the workflow.");
    }
  });
  // Every GET route (any workstream) is retried once on a transient MongoDB connection error.
  // Non-GET routes are never retried, so writes like alert approval can't happen twice.
  // The SSE stream hijacks its reply, so it is excluded.
  app.addHook("onRoute", (route) => {
    // Static handlers stream asynchronously and do not touch MongoDB.
    if (!route.url.startsWith("/api/")) return;
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
      await api.register(healthRoutes, { publicDemo });
      await api.register(streamRoutes);
      await api.register(regionRoutes);
      await api.register(geoRoutes);
      await api.register(hazardsRoutes);
      await api.register(stationRoutes);
      await api.register(replayRoutes);
      await api.register(saintRoutes);
      // C: regions, stations, readings, hazards, search, reports, replay, saint routes go here.
      // B: agent, alerts, voice routes go here.
      await api.register(agentRoutes);
      await api.register(alertRoutes);
    },
    { prefix: "/api" },
  );
  // In deployment Fastify serves the Vite build and API on the same origin.
  // Keep API-only development working before the web build exists.
  const webRoot = opts.webRoot ?? fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (opts.serveWeb !== false && existsSync(webRoot)) {
    app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
      cacheControl: false,
      setHeaders(res, path) {
        if (path.includes("/assets/")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        else res.setHeader("Cache-Control", "no-cache");
      },
    });
  }
  return app;
}
